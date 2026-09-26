import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Device, DeviceKind } from '@shared/data'
import { formatCapacity, formatLinkSpeed, kindFromName, type RawDevices } from './devices'

/**
 * Devices on macOS and Linux, same shape as the Windows sampler's.
 * - Linux: USB from /sys/bus/usb, Bluetooth from `bluetoothctl`, links from /sys/class/net
 * - macOS: USB and Bluetooth from `system_profiler -json`, links from `networksetup`
 * Every source is optional: a missing tool just means no devices of that kind.
 */
const run = (cmd: string, args: string[], timeout = 4000): Promise<string> =>
  new Promise((ok) => execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => ok(err ? '' : out)))

const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

const listDir = (path: string): string[] => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

const ipv4 = (iface: string): string | undefined =>
  os.networkInterfaces()[iface]?.find((a) => a.family === 'IPv4' && !a.internal)?.address

// ------------------------------------------------------------------ Linux
const USB_BASE = '/sys/bus/usb/devices'

/** Capacity of a USB drive: the block device somewhere below its interfaces. */
function linuxBlockSize(dir: string, depth = 0): number {
  if (depth > 6) return 0
  const entries = listDir(dir)
  if (entries.includes('block')) {
    const dev = listDir(join(dir, 'block'))[0]
    return dev ? (Number(readText(join(dir, 'block', dev, 'size'))) || 0) * 512 : 0
  }
  for (const e of entries) {
    if (!/^(\d+-[\d.]+:|host|target|\d+:\d+:\d+:\d+)/.test(e)) continue
    const size = linuxBlockSize(join(dir, e), depth + 1)
    if (size) return size
  }
  return 0
}

/** USB interface classes: 01 audio, 02/0a CDC, 03 HID (protocol 1 keyboard, 2 mouse), 07 printer, 08 storage, 0e video, e0 wireless. */
function linuxUsbKind(dir: string, dev: string, name: string): DeviceKind | null {
  const ifaces = listDir(dir).filter((n) => n.startsWith(`${dev}:`))
  const cls = ifaces.map((i) => ({
    c: readText(join(dir, i, 'bInterfaceClass')).toLowerCase(),
    sub: readText(join(dir, i, 'bInterfaceSubClass')).toLowerCase(),
    proto: readText(join(dir, i, 'bInterfaceProtocol')).toLowerCase(),
    tty: existsSync(join(dir, i, 'tty')) || listDir(join(dir, i)).some((n) => n.startsWith('ttyUSB'))
  }))
  const has = (c: string): boolean => cls.some((x) => x.c === c)
  const hint = kindFromName(name)
  if (hint === 'gamepad') return hint
  if (has('e0')) return null // Bluetooth radio
  if (has('08')) return 'storage'
  if (has('01')) return 'audio'
  if (has('0e')) return 'camera'
  if (has('07')) return 'printer'
  if (cls.some((x) => x.c === '02' && (x.sub === '06' || x.sub === '0d'))) return 'network'
  if (cls.some((x) => x.tty) || has('02')) return 'serial'
  const kb = cls.some((x) => x.c === '03' && x.proto === '01')
  const mouse = cls.some((x) => x.c === '03' && x.proto === '02')
  if (kb && mouse) return 'input'
  if (kb) return 'keyboard'
  if (mouse) return 'mouse'
  if (has('03')) return hint
  return hint ?? 'other'
}

function linuxUsb(): Device[] {
  if (!existsSync(USB_BASE)) return []
  const out: Device[] = []
  for (const dev of readdirSync(USB_BASE)) {
    if (dev.includes(':') || dev.startsWith('usb')) continue // interfaces, root hubs
    const dir = join(USB_BASE, dev)
    if (readText(join(dir, 'bDeviceClass')) === '09') continue // hub
    if (readText(join(dir, 'removable')) === 'fixed') continue // built into the machine (webcam, fingerprint…)
    const vid = readText(join(dir, 'idVendor'))
    const pid = readText(join(dir, 'idProduct'))
    const name = readText(join(dir, 'product')) || readText(join(dir, 'manufacturer')) || `USB ${vid}:${pid}`
    const kind = linuxUsbKind(dir, dev, name)
    if (!kind) continue
    const size = kind === 'storage' ? linuxBlockSize(dir) : 0
    out.push({ id: `usb:${dev}`, name, bus: 'usb', port: 'USB', kind, connected: true, detail: size ? formatCapacity(size) : undefined })
  }
  return out
}

const BLUEZ_ICONS: Record<string, DeviceKind> = {
  'input-keyboard': 'keyboard',
  'input-mouse': 'mouse',
  'input-gaming': 'gamepad',
  'input-tablet': 'input',
  'audio-headset': 'audio',
  'audio-headphones': 'audio',
  'audio-card': 'audio',
  phone: 'phone',
  printer: 'printer',
  'camera-video': 'camera'
}

async function linuxBluetooth(): Promise<Device[]> {
  let list = await run('bluetoothctl', ['devices', 'Paired'])
  if (!list.trim()) list = await run('bluetoothctl', ['paired-devices']) // BlueZ < 5.65
  const out: Device[] = []
  for (const line of list.split('\n')) {
    const m = /^Device ([0-9A-F:]{17}) (.+)$/i.exec(line.trim())
    if (!m) continue
    const info = await run('bluetoothctl', ['info', m[1]])
    const icon = /Icon: (\S+)/.exec(info)?.[1] ?? ''
    const battery = /Battery Percentage: \S+ \((\d+)\)/.exec(info)?.[1]
    out.push({
      id: `bt:${m[1].toUpperCase()}`,
      name: m[2].trim(),
      bus: 'bluetooth',
      port: 'BT',
      kind: BLUEZ_ICONS[icon] ?? kindFromName(m[2]) ?? 'other',
      connected: /Connected: yes/.test(info),
      battery: battery ? Number(battery) : undefined
    })
  }
  return out
}

function linuxNetwork(): Device[] {
  const base = '/sys/class/net'
  if (!existsSync(base)) return []
  const out: Device[] = []
  for (const iface of readdirSync(base)) {
    const dir = join(base, iface)
    if (!existsSync(join(dir, 'device')) || readText(join(dir, 'operstate')) !== 'up') continue // virtual or down
    const wifi = existsSync(join(dir, 'wireless'))
    const mbps = Number(readText(join(dir, 'speed')))
    out.push({
      id: `net:${iface}`,
      name: iface,
      bus: 'network',
      port: wifi ? 'WI-FI' : 'LAN',
      kind: 'network',
      connected: true,
      detail: mbps > 0 ? formatLinkSpeed(mbps * 1e6) : ipv4(iface)
    })
  }
  return out
}

// ------------------------------------------------------------------ macOS
interface SpUsbItem {
  _name?: string
  _items?: SpUsbItem[]
  Media?: Array<{ size?: string }>
  [key: string]: unknown
}

function macUsbItems(items: SpUsbItem[] | undefined, out: Device[]): void {
  for (const it of items ?? []) {
    const name = String(it._name ?? '').trim()
    const isBus = !('vendor_id' in it || 'USBDeviceKeyVendorID' in it)
    if (name && !isBus && !/hub/i.test(name)) {
      const storage = Array.isArray(it.Media) && it.Media.length > 0
      const kind: DeviceKind = storage ? 'storage' : (kindFromName(name) ?? 'other')
      out.push({
        id: `usb:${String(it.location_id ?? it.USBDeviceKeyLocationID ?? name)}`,
        name,
        bus: 'usb',
        port: 'USB',
        kind,
        connected: true,
        detail: storage ? it.Media?.[0]?.size : undefined
      })
    }
    macUsbItems(it._items, out)
  }
}

async function macUsb(): Promise<Device[]> {
  const out: Device[] = []
  // macOS 14+ lists devices under SPUSBHostDataType; older versions under SPUSBDataType.
  for (const type of ['SPUSBHostDataType', 'SPUSBDataType']) {
    try {
      const json = JSON.parse((await run('system_profiler', ['-json', type], 15000)) || '{}') as Record<string, SpUsbItem[]>
      macUsbItems(json[type], out)
    } catch {
      // Unknown data type on this macOS version.
    }
    if (out.length) break
  }
  return out
}

const MAC_BT_KINDS: Record<string, DeviceKind> = {
  keyboard: 'keyboard',
  mouse: 'mouse',
  trackpad: 'mouse',
  gamepad: 'gamepad',
  headphones: 'audio',
  headset: 'audio',
  speaker: 'audio',
  phone: 'phone'
}

async function macBluetooth(): Promise<Device[]> {
  const out: Device[] = []
  try {
    const json = JSON.parse((await run('system_profiler', ['-json', 'SPBluetoothDataType'], 15000)) || '{}') as {
      SPBluetoothDataType?: Array<Record<string, Array<Record<string, Record<string, string>>>>>
    }
    const root = json.SPBluetoothDataType?.[0] ?? {}
    for (const [key, connected] of [
      ['device_connected', true],
      ['device_not_connected', false]
    ] as const) {
      for (const entry of root[key] ?? []) {
        for (const [name, info] of Object.entries(entry)) {
          const minor = String(info.device_minorType ?? '').toLowerCase()
          const battery = parseInt(info.device_batteryLevelMain ?? info.device_batteryLevel ?? '', 10)
          out.push({
            id: `bt:${info.device_address ?? name}`,
            name,
            bus: 'bluetooth',
            port: 'BT',
            kind: MAC_BT_KINDS[minor] ?? kindFromName(name) ?? 'other',
            connected,
            battery: Number.isFinite(battery) ? battery : undefined
          })
        }
      }
    }
  } catch {
    // No Bluetooth, or the output format changed.
  }
  return out
}

async function macNetwork(): Promise<Device[]> {
  const out: Device[] = []
  const text = await run('networksetup', ['-listallhardwareports'])
  for (const block of text.split(/\n\s*\n/)) {
    const port = /Hardware Port: (.+)/.exec(block)?.[1]?.trim() ?? ''
    const iface = /Device: (\S+)/.exec(block)?.[1]
    if (!iface || /bridge|bluetooth|thunderbolt/i.test(port)) continue
    const ip = ipv4(iface)
    if (!ip) continue // not connected
    const wifi = /wi-?fi|airport/i.test(port)
    out.push({ id: `net:${iface}`, name: port || iface, bus: 'network', port: wifi ? 'WI-FI' : 'LAN', kind: 'network', connected: true, detail: ip })
  }
  return out
}

// ------------------------------------------------------------------ entry
export async function readPosixDevices(): Promise<RawDevices> {
  const parts =
    process.platform === 'darwin'
      ? await Promise.all([macUsb(), macBluetooth(), macNetwork()])
      : await Promise.all([Promise.resolve(linuxUsb()), linuxBluetooth(), Promise.resolve(linuxNetwork())])
  return { devices: parts.flat(), monitors: [] }
}
