import os from 'node:os'
import { screen } from 'electron'
import type { Device, DeviceBus, DeviceKind, DevicesPayload } from '@shared/data'

/**
 * The `devices` topic. Platform samplers report USB, Bluetooth and network devices plus the
 * connector of each monitor; displays themselves (name, resolution) come from Electron, which
 * knows them on every platform.
 */
export interface RawDevices {
  devices: Device[]
  /** Monitor name → connector label (HDMI, DP…), matched to Electron's display labels. */
  monitors: Array<{ name: string; port: string }>
}

// ------------------------------------------------------------------ formatting
/** Drive capacity the way vendors print it (decimal units): 2000396321280 → "2 TB". */
export function formatCapacity(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000
    i++
  }
  return `${Number(bytes.toFixed(bytes < 10 ? 1 : 0))} ${units[i]}`
}

export function formatLinkSpeed(bitsPerSec: number): string {
  return bitsPerSec >= 1e9 ? `${Number((bitsPerSec / 1e9).toFixed(1))} Gb/s` : `${Math.round(bitsPerSec / 1e6)} Mb/s`
}

// ------------------------------------------------------------------ classification
/** Best guess from a product name, for sources that give nothing better (English names only). */
export function kindFromName(name: string): DeviceKind | null {
  const n = name.toLowerCase()
  if (/controller|gamepad|joystick|dualsense|dualshock|xbox|joy-con/.test(n)) return 'gamepad'
  if (/keyboard|\bkeys\b/.test(n)) return 'keyboard'
  if (/mouse|trackball|trackpad/.test(n)) return 'mouse'
  if (/receiver|unifying|lightspeed/.test(n)) return 'input'
  if (/headphone|headset|earbud|buds|airpods|speaker|soundbar|audio|\bmic/.test(n)) return 'audio'
  if (/camera|webcam|facetime/.test(n)) return 'camera'
  if (/iphone|ipad|android|pixel|galaxy|phone/.test(n)) return 'phone'
  if (/printer/.test(n)) return 'printer'
  if (/disk|drive|ssd|storage|flash|card reader/.test(n)) return 'storage'
  return null
}

/** Windows container categories ("Input.Keyboard", "Communication.Headset.Bluetooth"…). */
function kindFromCategory(category: string): DeviceKind | null {
  const c = category.toLowerCase()
  if (c.includes('input.keyboard')) return 'keyboard'
  if (c.includes('input.mouse')) return 'mouse'
  if (/input\.(gaming|gamepad|joystick)/.test(c)) return 'gamepad'
  if (c.includes('input.')) return 'input'
  if (/headset|headphone|speaker|audio|multimedia/.test(c)) return 'audio'
  if (c.includes('phone')) return 'phone'
  if (c.includes('printer')) return 'printer'
  return null
}

// ------------------------------------------------------------------ Windows
interface WinUsb {
  id: string
  name: string
  fallback: string
  svc: string
  classes: string[]
  size: number
  ok: boolean
}
interface WinBt {
  id: string
  name: string
  connected: boolean
  battery: number
  category: string
}
interface WinNet {
  id: string
  name: string
  desc: string
  type: string
  speed: number
}

/** WmiMonitorConnectionParams.VideoOutputTechnology */
const VIDEO_PORTS: Record<number, string> = { 0: 'VGA', 4: 'DVI', 5: 'HDMI', 10: 'DP', 11: 'DP', 15: 'WIRELESS', 2147483648: 'BUILT-IN' }

const VIRTUAL_NIC = /virtual|hyper-v|vpn|tap-|tunnel|vmware|virtualbox|loopback|npcap|miniport|bluetooth|wsl|docker|zerotier|tailscale|wireguard/i

/**
 * Kind of a USB device from its driver and the device classes of its functions (children with
 * the same VID/PID). Class names are locale-independent, unlike Windows' device names.
 * null = not worth showing: hubs, the Bluetooth radio, vendor-only HID (RGB/fan controllers).
 */
function usbKind(svc: string, classes: string[], name: string): DeviceKind | null {
  const has = (c: string): boolean => classes.some((x) => x.toLowerCase() === c)
  const s = svc.toLowerCase()
  if (s.startsWith('usbhub') || s === 'bthusb') return null
  const hint = kindFromName(name)
  if (hint === 'gamepad') return 'gamepad'
  if (s === 'uaspstor' || s === 'usbstor' || has('diskdrive')) return 'storage'
  if (has('xnacomposite') || has('xboxcomposite')) return 'gamepad'
  if (has('media') || has('audioendpoint')) return 'audio'
  if (has('camera') || has('image')) return 'camera'
  if (has('wpd')) return 'phone'
  if (has('printer')) return 'printer'
  if (has('net')) return 'network'
  if (has('ports')) return 'serial'
  if (has('keyboard') && has('mouse')) return 'input'
  if (has('keyboard')) return 'keyboard'
  if (has('mouse')) return 'mouse'
  if (has('hidclass')) return hint
  return hint ?? 'other'
}

export function fromWindows(m: Record<string, unknown>): RawDevices {
  const devices: Device[] = []
  for (const u of (m.usb as WinUsb[] | undefined) ?? []) {
    const name = String(u.name || u.fallback || 'USB device').trim()
    const kind = usbKind(String(u.svc ?? ''), (u.classes ?? []).map(String), name)
    if (!kind) continue
    const size = Number(u.size) || 0
    devices.push({ id: String(u.id), name, bus: 'usb', port: 'USB', kind, connected: u.ok !== false, detail: size > 0 ? formatCapacity(size) : undefined })
  }

  // A Bluetooth device is several nodes (Classic, LE, hands-free…): merge them by address.
  const byMac = new Map<string, { name: string; connected: boolean; battery: number; category: string }>()
  for (const b of (m.bt as WinBt[] | undefined) ?? []) {
    const id = String(b.id)
    const dev = /DEV_([0-9A-F]{12})/i.exec(id)
    const mac = (dev?.[1] ?? /&([0-9A-F]{12})(?:_C[0-9A-F]+)?$/i.exec(id)?.[1])?.toUpperCase()
    if (!mac) continue
    const e = byMac.get(mac) ?? { name: '', connected: false, battery: -1, category: '' }
    if (dev && !e.name) e.name = String(b.name ?? '').trim() // the hands-free node's name has a suffix
    e.connected ||= b.connected === true
    const battery = Number(b.battery)
    if (Number.isFinite(battery)) e.battery = Math.max(e.battery, battery)
    if (!e.category && b.category && b.category !== 'Unknown') e.category = String(b.category)
    byMac.set(mac, e)
  }
  for (const [mac, e] of byMac) {
    if (!e.name) continue
    devices.push({
      id: `bt:${mac}`,
      name: e.name,
      bus: 'bluetooth',
      port: 'BT',
      kind: kindFromCategory(e.category) ?? kindFromName(e.name) ?? 'other',
      connected: e.connected,
      battery: e.battery >= 0 ? Math.min(100, e.battery) : undefined
    })
  }

  for (const n of (m.nets as WinNet[] | undefined) ?? []) {
    if (VIRTUAL_NIC.test(String(n.desc)) || /^vEthernet/i.test(String(n.name))) continue
    const speed = Number(n.speed) || 0
    devices.push({
      id: `net:${n.id}`,
      name: String(n.name),
      bus: 'network',
      port: /wireless/i.test(String(n.type)) ? 'WI-FI' : 'LAN',
      kind: 'network',
      connected: true,
      detail: speed > 0 ? formatLinkSpeed(speed) : undefined
    })
  }

  const monitors = ((m.monitors as Array<{ name: string; tech: number }> | undefined) ?? []).map((x) => ({
    name: String(x.name ?? ''),
    port: VIDEO_PORTS[Number(x.tech)] ?? 'DISPLAY'
  }))
  return { devices, monitors }
}

// ------------------------------------------------------------------ displays + host
/**
 * Physical pixels from DIPs × scale factor, which is off by a pixel or two when the DIP size was
 * rounded (1154 × 1.665 = 1921.5): snap to the nearest multiple of 8 or 10 when one is that close.
 */
function physical(dip: number, scale: number): number {
  const v = dip * scale
  if (Math.abs(v - Math.round(v)) < 0.01) return Math.round(v)
  const candidates = [Math.round(v / 8) * 8, Math.round(v / 10) * 10].filter((c) => Math.abs(c - v) <= 3)
  return candidates.sort((a, b) => Math.abs(a - v) - Math.abs(b - v))[0] ?? Math.round(v)
}

function displays(monitors: RawDevices['monitors']): Device[] {
  return screen.getAllDisplays().map((d, i) => {
    const name = d.label?.trim() || (d.internal ? 'Built-in display' : `Display ${i + 1}`)
    const mon = monitors.find((m) => m.name && m.name.toLowerCase() === name.toLowerCase())
    return {
      id: `display:${d.id}`,
      name,
      bus: 'display',
      port: mon?.port ?? (d.internal ? 'BUILT-IN' : 'DISPLAY'),
      kind: 'display',
      connected: true,
      detail: `${physical(d.size.width, d.scaleFactor)}×${physical(d.size.height, d.scaleFactor)}`
    }
  })
}

const OS_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

function osName(): string {
  const base = OS_NAMES[process.platform] ?? process.platform
  if (process.platform !== 'win32') return base
  const build = Number(os.release().split('.')[2]) || 0
  return build >= 22000 ? `${base} 11` : `${base} 10`
}

const BUS_ORDER: DeviceBus[] = ['usb', 'bluetooth', 'display', 'network']

export function devicesPayload(raw: RawDevices): DevicesPayload {
  const devices = [...raw.devices.filter((d) => d.bus !== 'display'), ...displays(raw.monitors)]
  devices.sort((a, b) => BUS_ORDER.indexOf(a.bus) - BUS_ORDER.indexOf(b.bus))
  return {
    available: true,
    host: { name: os.hostname(), os: osName(), cores: os.cpus().length, memoryBytes: os.totalmem() },
    devices
  }
}
