import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DataSampler, SamplerJob, SamplerMessage } from './sampler'
import { readPosixDevices } from './posixDevices'

/**
 * macOS / Linux counterpart of the PowerShell sampler: same jobs, same messages.
 * - net:    Linux /proc/net/dev; macOS `netstat -ibn`
 * - temp:   Linux /sys/class/thermal; macOS: not available without extra tools
 * - events: Linux `journalctl -k -f` (kernel log); macOS `log stream` (kernel process)
 * - conns:  Linux /proc/net/tcp{,6}; macOS `netstat -anp tcp`
 * - devices: see posixDevices.ts
 */
const IS_MAC = process.platform === 'darwin'

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((ok) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => ok(err ? '' : out)))

// ------------------------------------------------------------------ network
async function readCounters(): Promise<Map<string, [number, number]>> {
  const out = new Map<string, [number, number]>()
  if (IS_MAC) {
    // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll: the <Link#n> row has the totals.
    for (const line of (await run('netstat', ['-ibn'])).split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10 || !f[2]?.startsWith('<Link') || f[0].startsWith('lo')) continue
      const n = f.length === 11 ? 0 : -1 // the Address column is empty for some interfaces
      out.set(f[0], [Number(f[6 + n]) || 0, Number(f[9 + n]) || 0])
    }
  } else if (existsSync('/proc/net/dev')) {
    for (const line of readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const [name, rest] = line.split(':')
      if (!rest || name.trim() === 'lo') continue
      const f = rest.trim().split(/\s+/).map(Number)
      out.set(name.trim(), [f[0] || 0, f[8] || 0])
    }
  }
  return out
}

// ------------------------------------------------------------------ temperature
function readThermal(): Array<{ name: string; celsius: number }> {
  if (IS_MAC || !existsSync('/sys/class/thermal')) return []
  const zones: Array<{ name: string; celsius: number }> = []
  for (const d of readdirSync('/sys/class/thermal')) {
    if (!d.startsWith('thermal_zone')) continue
    try {
      const milli = Number(readFileSync(join('/sys/class/thermal', d, 'temp'), 'utf8'))
      const type = readFileSync(join('/sys/class/thermal', d, 'type'), 'utf8').trim()
      if (milli > 0) zones.push({ name: type || d, celsius: Math.round(milli / 100) / 10 })
    } catch {
      // Unreadable zone; skip.
    }
  }
  return zones
}

// ------------------------------------------------------------------ connections
function hexToIp(hex: string): string {
  if (hex.length === 8) {
    // IPv4, little-endian.
    return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.')
  }
  // IPv6: four little-endian 32-bit words.
  const words = hex.match(/.{8}/g) ?? []
  const bytes = words.flatMap((w) => [6, 4, 2, 0].map((i) => w.slice(i, i + 2)))
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push(parseInt(bytes[i] + bytes[i + 1], 16).toString(16))
  const v6 = groups.join(':')
  return v6.startsWith('0:0:0:0:0:ffff:') ? hexToIp(hex.slice(24)) : v6
}

const isLoopback = (ip: string): boolean => ip.startsWith('127.') || ip === '0:0:0:0:0:0:0:1' || ip === '::1'

async function readConnections(): Promise<Array<{ ip: string; port: number; lport: number }>> {
  const list: Array<{ ip: string; port: number; lport: number }> = []
  if (IS_MAC) {
    // Proto Recv-Q Send-Q Local Foreign (state); addresses end in .port
    for (const line of (await run('netstat', ['-anp', 'tcp'])).split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 6 || f[5] !== 'ESTABLISHED') continue
      const split = (a: string): [string, number] => {
        const i = a.lastIndexOf('.')
        return [a.slice(0, i), Number(a.slice(i + 1))]
      }
      const [, lport] = split(f[3])
      const [ip, port] = split(f[4])
      if (!isLoopback(ip)) list.push({ ip, port, lport })
    }
  } else {
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
        const f = line.trim().split(/\s+/)
        if (f.length < 4 || f[3] !== '01') continue // 01 = ESTABLISHED
        const [, lport] = f[1].split(':')
        const [rhex, rport] = f[2].split(':')
        const ip = hexToIp(rhex)
        if (!isLoopback(ip)) list.push({ ip, port: parseInt(rport, 16), lport: parseInt(lport, 16) })
      }
    }
  }
  return list.slice(0, 256)
}

// ------------------------------------------------------------------ system log stream
/** Hub level codes: 1 critical, 2 error, 3 warning, 4 info. */
function journalLevel(priority: number): number {
  return priority <= 2 ? 1 : priority === 3 ? 2 : priority === 4 ? 3 : 4
}

function startLogStream(emit: (m: SamplerMessage) => void): ChildProcessWithoutNullStreams {
  const proc = IS_MAC
    ? spawn('log', ['stream', '--style', 'ndjson', '--level', 'default', '--predicate', 'process == "kernel"'])
    : spawn('journalctl', ['-k', '-f', '-n', '40', '-o', 'json', '--no-pager'])
  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    const entries = []
    for (const line of lines) {
      try {
        const j = JSON.parse(line) as Record<string, string>
        if (IS_MAC) {
          if (!j.eventMessage) continue
          const t = j.messageType
          entries.push({
            time: Date.parse(j.timestamp) || Date.now(),
            level: t === 'Fault' ? 1 : t === 'Error' ? 2 : 4,
            source: (j.subsystem || j.processImagePath || 'kernel').split('/').pop(),
            message: String(j.eventMessage).split('\n')[0].slice(0, 300)
          })
        } else {
          entries.push({
            time: Math.round(Number(j.__REALTIME_TIMESTAMP) / 1000) || Date.now(),
            level: journalLevel(Number(j.PRIORITY ?? 6)),
            source: j.SYSLOG_IDENTIFIER || 'kernel',
            message: String(j.MESSAGE ?? '').split('\n')[0].slice(0, 300)
          })
        }
      } catch {
        // Not a JSON line (e.g. the "Filtering the log data" banner on macOS).
      }
    }
    if (entries.length) emit({ t: 'events', entries })
  })
  proc.on('error', (err) => emit({ t: 'error', job: 'events', message: `${IS_MAC ? 'log stream' : 'journalctl'}: ${err.message}` }))
  // journalctl prints "No journal files were opened due to insufficient permissions" and exits.
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (msg: string) => {
    if (/permission|not permitted|insufficient/i.test(msg)) emit({ t: 'error', job: 'events', message: msg.trim().split(/\r?\n/)[0] })
  })
  return proc
}

// ------------------------------------------------------------------ sampler
export class PosixSampler implements DataSampler {
  private jobs = new Set<SamplerJob>()
  private timer: NodeJS.Timeout | null = null
  private logProc: ChildProcessWithoutNullStreams | null = null
  private prev = new Map<string, [number, number]>()
  private prevAt = 0
  private tick = 0
  private scanningDevices = false

  constructor(private onMessage: (m: SamplerMessage) => void) {}

  setJobs(jobs: SamplerJob[]): void {
    this.jobs = new Set(jobs)
    if (this.jobs.has('events') && !this.logProc) this.logProc = startLogStream(this.onMessage)
    if (!this.jobs.has('events') && this.logProc) {
      this.logProc.kill()
      this.logProc = null
    }
    const needsTimer = ['net', 'temp', 'conns', 'devices'].some((j) => this.jobs.has(j as SamplerJob))
    if (needsTimer && !this.timer) this.timer = setInterval(() => void this.sample(), 1000)
    if (!needsTimer && this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.prev.clear()
    }
  }

  stop(): void {
    this.setJobs([])
  }

  private async sample(): Promise<void> {
    const i = this.tick++
    if (this.jobs.has('net')) {
      const now = Date.now()
      const cur = await readCounters()
      const dt = this.prevAt ? (now - this.prevAt) / 1000 : 0
      if (dt > 0) {
        const interfaces = [...cur].map(([name, [rx, tx]]) => {
          const [prx, ptx] = this.prev.get(name) ?? [rx, tx]
          return { name, rx: Math.max(0, (rx - prx) / dt), tx: Math.max(0, (tx - ptx) / dt) }
        })
        this.onMessage({ t: 'net', interfaces })
      }
      this.prev = cur
      this.prevAt = now
    }
    if (this.jobs.has('temp') && i % 5 === 0) this.onMessage({ t: 'temp', zones: readThermal() })
    if (this.jobs.has('conns') && i % 2 === 0) this.onMessage({ t: 'conns', list: await readConnections() })
    // system_profiler is slow on macOS: scan less often there, and never two scans at once.
    if (this.jobs.has('devices') && i % (IS_MAC ? 10 : 5) === 0 && !this.scanningDevices) {
      this.scanningDevices = true
      readPosixDevices()
        .then((raw) => this.jobs.has('devices') && this.onMessage({ t: 'devices', ...raw }))
        .catch((err: Error) => this.onMessage({ t: 'error', job: 'devices', message: err.message }))
        .finally(() => (this.scanningDevices = false))
    }
  }
}
