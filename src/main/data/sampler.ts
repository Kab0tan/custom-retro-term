import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

/**
 * Windows data Node can't read directly (network counters, thermal zones, the event log, devices) comes
 * from one long-lived PowerShell process that prints a JSON line per sample. It starts when a topic
 * that needs it is subscribed and takes job-list changes on stdin, so minimising a window pauses it
 * instead of restarting it; after IDLE_EXIT_MS with nothing to do it exits.
 *
 * Everything it calls is locale-independent (.NET / CIM class names), because performance
 * counter names are translated on non-English Windows ("Interface réseau", …).
 */
export type SamplerJob = 'net' | 'temp' | 'events' | 'conns' | 'devices'

export interface SamplerMessage {
  t: SamplerJob | 'error'
  [key: string]: unknown
}

/** What the hub needs from a platform sampler (PowerShell on Windows, PosixSampler elsewhere). */
export interface DataSampler {
  setJobs(jobs: SamplerJob[]): void
  stop(): void
}

/** How long the process may sit paused (no jobs) before it exits. */
const IDLE_EXIT_MS = 5 * 60_000

/**
 * Devices, every 30 s. Only class names, service names, IDs and property keys are compared, never
 * display names, which are translated. USB names are the product strings the devices report
 * (cached per device); Bluetooth connection state and battery are read each time.
 * Kept in String.raw so the regexes and paths need no double escaping.
 */
const DEVICES_SCRIPT = String.raw`
$usbCache = @{}
$diskCache = @{}
$K_CONNECTED = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
$K_BATTERY = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
function Get-Devices {
  $all = @(Get-CimInstance -ClassName Win32_PnPEntity)
  $roots = @(); $btNodes = @(); $fn = @{}
  foreach ($d in $all) {
    $id = [string]$d.DeviceID
    if ($id -match '^USB\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})\\') { $roots += $d; $k = $Matches[1] }
    elseif ($id -match '^(?:USB|HID)\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})[&\\]') { $k = $Matches[1] }
    else {
      if ($id -match '^(BTHENUM\\DEV_|BTHLE\\DEV_|BTHENUM\\\{0000111E-)') { $btNodes += $d }
      continue
    }
    if (-not $fn.ContainsKey($k)) { $fn[$k] = @() }
    if ($d.PNPClass) { $fn[$k] += [string]$d.PNPClass }
  }
  $new = @($roots | Where-Object { -not $usbCache.ContainsKey($_.DeviceID) })
  foreach ($r in $new) { $usbCache[$r.DeviceID] = @{ name = ''; svc = ''; container = '' } }
  if ($new.Count) {
    foreach ($p in ($new | Get-PnpDeviceProperty -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc', 'DEVPKEY_Device_Service', 'DEVPKEY_Device_ContainerId')) {
      $e = $usbCache[$p.InstanceId]
      if (-not $e -or $null -eq $p.Data) { continue }
      switch ($p.KeyName) {
        'DEVPKEY_Device_BusReportedDeviceDesc' { $e.name = [string]$p.Data }
        'DEVPKEY_Device_Service' { $e.svc = [string]$p.Data }
        'DEVPKEY_Device_ContainerId' { $e.container = ([string]$p.Data).ToLower() }
      }
    }
  }
  # Drive capacity: a disk shares its container with the USB device it sits behind.
  $sizes = @{}
  $disks = @(Get-CimInstance -ClassName Win32_DiskDrive)
  $newDisks = @($disks | Where-Object { -not $diskCache.ContainsKey($_.PNPDeviceID) })
  foreach ($d in $newDisks) { $diskCache[$d.PNPDeviceID] = '' }
  foreach ($d in $newDisks) {
    $p = Get-PnpDeviceProperty -InstanceId $d.PNPDeviceID -KeyName 'DEVPKEY_Device_ContainerId'
    if ($p.Data) { $diskCache[$d.PNPDeviceID] = ([string]$p.Data).ToLower() }
  }
  foreach ($d in $disks) { if ($diskCache[$d.PNPDeviceID] -and $d.Size) { $sizes[$diskCache[$d.PNPDeviceID]] = [int64]$d.Size } }
  $usb = @()
  foreach ($r in $roots) {
    $e = $usbCache[$r.DeviceID]
    $k = ([regex]::Match($r.DeviceID, 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}', 'IgnoreCase')).Value.ToUpper()
    $size = 0
    if ($e.container -and $sizes.ContainsKey($e.container)) { $size = $sizes[$e.container] }
    $usb += [pscustomobject]@{ id = $r.DeviceID; name = $e.name; fallback = [string]$r.Name; svc = $e.svc; classes = @($fn[$k] | Select-Object -Unique); size = $size; ok = ($r.Status -eq 'OK') }
  }
  $bt = @()
  if ($btNodes.Count) {
    $props = @{}
    foreach ($p in ($btNodes | Get-PnpDeviceProperty -KeyName $K_CONNECTED, $K_BATTERY, 'DEVPKEY_DeviceContainer_Category')) {
      if ($null -eq $p.Data) { continue }
      if (-not $props.ContainsKey($p.InstanceId)) { $props[$p.InstanceId] = @{} }
      $props[$p.InstanceId][$p.KeyName] = $p.Data
    }
    foreach ($n in $btNodes) {
      $pp = $props[$n.DeviceID]
      if (-not $pp) { $pp = @{} }
      $battery = -1
      if ($null -ne $pp[$K_BATTERY]) { $battery = [int]$pp[$K_BATTERY] }
      $bt += [pscustomobject]@{ id = $n.DeviceID; name = [string]$n.Name; connected = ($pp[$K_CONNECTED] -eq $true); battery = $battery; category = (@($pp['DEVPKEY_DeviceContainer_Category']) -join ',') }
    }
  }
  $monitors = @()
  $tech = @{}
  foreach ($c in (Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams)) { $tech[$c.InstanceName] = [int64]$c.VideoOutputTechnology }
  foreach ($m in (Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID)) {
    $name = (($m.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '')
    $t = -1
    if ($tech.ContainsKey($m.InstanceName)) { $t = $tech[$m.InstanceName] }
    $monitors += [pscustomobject]@{ name = $name; tech = $t }
  }
  $nets = @()
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -ne 'Up') { continue }
    $type = [string]$n.NetworkInterfaceType
    if ($type -notmatch 'Ethernet|Wireless') { continue }
    $nets += [pscustomobject]@{ id = $n.Id; name = $n.Name; desc = $n.Description; type = $type; speed = [int64]$n.Speed }
  }
  Emit @{ t = 'devices'; usb = $usb; bt = $bt; monitors = $monitors; nets = $nets }
}
`

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }
${DEVICES_SCRIPT}

function Get-Events($after) {
  $out = @()
  foreach ($e in (Get-WinEvent -LogName System -MaxEvents 40 | Where-Object { $_.RecordId -gt $after } | Sort-Object RecordId)) {
    $msg = ''
    if ($e.Message) { $msg = ($e.Message -split "\`r?\`n")[0] }
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
    $out += [pscustomobject]@{ id = $e.RecordId; time = [int64]($e.TimeCreated.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds; level = [int]$e.Level; source = $e.ProviderName; message = $msg }
  }
  ,$out
}

# The job list arrives on stdin, one comma-separated line per change (empty = paused).
# stdin closing means the app is gone.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$read = $stdin.ReadLineAsync()
$jobs = @()
$due = @{}
# A job runs when on and due, then every $every seconds; a (re)enabled job runs at once.
function Due($job, $every) {
  if ($jobs -notcontains $job -or ($due.ContainsKey($job) -and $i -lt $due[$job])) { return $false }
  $due[$job] = $i + $every
  $true
}

$lastRecord = 0
$noTemp = $false
$prev = @{}
$prevTime = [DateTime]::UtcNow
$i = 0
while ($true) {
  while ($read.IsCompleted) {
    $line = $read.Result
    if ($null -eq $line) { exit }
    $next = @($line.Trim() -split ',' | Where-Object { $_ })
    foreach ($j in $next) {
      if ($jobs -notcontains $j) { $due.Remove($j); if ($j -eq 'net') { $prev = @{} } }
    }
    $jobs = $next
    $read = $stdin.ReadLineAsync()
  }
  if ($jobs -contains 'net') {
    $now = [DateTime]::UtcNow
    $dt = [Math]::Max(0.001, ($now - $prevTime).TotalSeconds)
    $prevTime = $now
    $hadPrev = $prev.Count -gt 0
    $ifs = @()
    foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($n.OperationalStatus -ne 'Up' -or $n.NetworkInterfaceType -eq 'Loopback' -or $n.NetworkInterfaceType -eq 'Tunnel') { continue }
      $s = $n.GetIPStatistics()
      $rx = 0; $tx = 0
      if ($prev.ContainsKey($n.Id)) {
        $rx = [Math]::Max(0, ($s.BytesReceived - $prev[$n.Id][0]) / $dt)
        $tx = [Math]::Max(0, ($s.BytesSent - $prev[$n.Id][1]) / $dt)
      }
      $prev[$n.Id] = @($s.BytesReceived, $s.BytesSent)
      $ifs += [pscustomobject]@{ name = $n.Name; rx = [Math]::Round($rx); tx = [Math]::Round($tx) }
    }
    if ($hadPrev) { Emit @{ t = 'net'; interfaces = $ifs } }
  }
  # Thermal zones usually need admin; once none is readable, stop asking.
  if (-not $noTemp -and (Due 'temp' 30)) {
    $zones = @()
    foreach ($z in (Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation)) {
      $k = if ($z.HighPrecisionTemperature) { $z.HighPrecisionTemperature / 10 } else { $z.Temperature }
      if ($k -gt 0) { $zones += [pscustomobject]@{ name = $z.Name; celsius = [Math]::Round($k - 273.15, 1) } }
    }
    Emit @{ t = 'temp'; zones = $zones }
    if (-not $zones.Count) { $noTemp = $true }
  }
  if (Due 'conns' 2) {
    $list = @()
    foreach ($c in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpConnections()) {
      if ($c.State -ne 'Established' -or [System.Net.IPAddress]::IsLoopback($c.RemoteEndPoint.Address)) { continue }
      $list += [pscustomobject]@{ ip = $c.RemoteEndPoint.Address.ToString(); port = $c.RemoteEndPoint.Port; lport = $c.LocalEndPoint.Port }
      if ($list.Count -ge 256) { break }
    }
    Emit @{ t = 'conns'; list = $list }
  }
  if (Due 'devices' 30) { Get-Devices }
  # The first run sends the recent backlog; later ones only what's new (also after a pause).
  if (Due 'events' 30) {
    $ev = Get-Events $lastRecord
    if ($ev.Count) {
      $lastRecord = ($ev | Measure-Object -Property id -Maximum).Maximum
      Emit @{ t = 'events'; entries = $ev }
    }
  }
  $i++
  Start-Sleep -Milliseconds 1000
}
`

export class Sampler implements DataSampler {
  private proc: ChildProcessWithoutNullStreams | null = null
  /** Job line last sent to the process. */
  private sent = ''
  private idleTimer: NodeJS.Timeout | null = null
  /** When the process last died on its own; it isn't respawned for a while. */
  private failedAt = 0
  /** No thermal zone was readable; not asked for again this session. */
  private noTemp = false

  constructor(private onMessage: (m: SamplerMessage) => void) {}

  /** Run exactly these jobs. None = pause; the process exits after IDLE_EXIT_MS paused. */
  setJobs(jobs: SamplerJob[]): void {
    const line = [...new Set(jobs)].filter((j) => j !== 'temp' || !this.noTemp).sort().join(',')
    if (!this.proc && (!line || Date.now() - this.failedAt < 30_000)) return
    const proc = this.proc ?? this.spawn()
    if (line === this.sent) return
    this.sent = line
    proc.stdin.write(line + '\n')
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = line ? null : setTimeout(() => this.stop(), IDLE_EXIT_MS)
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.sent = ''
    if (!this.proc) return
    this.proc.removeAllListeners()
    this.proc.kill()
    this.proc = null
  }

  private spawn(): ChildProcessWithoutNullStreams {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const proc = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true
    })
    this.proc = proc
    this.sent = ''
    let buf = ''
    proc.stdin.on('error', () => {}) // the process died; 'exit' reports it
    proc.stderr.resume() // unread, it would fill up and block the script
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let m: SamplerMessage
        try {
          m = JSON.parse(line) as SamplerMessage
        } catch {
          continue // stray non-JSON output
        }
        if (m.t === 'temp' && !(m.zones as unknown[] | undefined)?.length) this.noTemp = true
        this.onMessage(m)
      }
    })
    const died = (message: string): void => {
      if (this.proc !== proc) return
      this.proc = null
      this.sent = ''
      this.failedAt = Date.now()
      this.onMessage({ t: 'error', message })
    }
    proc.on('error', (err) => died(err.message))
    proc.on('exit', (code) => died(`sampler exited (${code})`))
    return proc
  }
}
