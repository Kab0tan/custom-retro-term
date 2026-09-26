/**
 * Data topics published by the main-process data hub (src/main/data/) to panels.
 * A panel subscribes to a topic and receives its payload at the topic's rate; collectors
 * run only while some visible panel is subscribed.
 */
export type DataTopic = 'cpu' | 'memory' | 'network' | 'temperature' | 'log' | 'connections' | 'devices'

export const DATA_TOPICS: readonly DataTopic[] = ['cpu', 'memory', 'network', 'temperature', 'log', 'connections', 'devices']

export const isDataTopic = (v: unknown): v is DataTopic => (DATA_TOPICS as readonly unknown[]).includes(v)

export interface CpuPayload {
  /** Busy fraction 0..1 per logical core, since the previous sample. */
  cores: number[]
  total: number
  model: string
}

export interface MemoryPayload {
  totalBytes: number
  usedBytes: number
}

export interface NetworkInterfaceRate {
  name: string
  rxBytesPerSec: number
  txBytesPerSec: number
}

export type NetworkPayload =
  | { available: true; rxBytesPerSec: number; txBytesPerSec: number; interfaces: NetworkInterfaceRate[] }
  | { available: false; reason: string }

/**
 * Windows exposes CPU die temperature only to admin tools; what's readable without admin
 * is ACPI thermal zones (often the motherboard, sometimes a fixed value), or nothing.
 */
export type TemperaturePayload =
  | { available: true; zones: Array<{ name: string; celsius: number }> }
  | { available: false; reason: string }

export type LogLevel = 'critical' | 'error' | 'warning' | 'info'

export interface LogEntry {
  /** ms since epoch */
  time: number
  level: LogLevel
  source: string
  message: string
}

/**
 * Windows System event log entries (real data only). New entries since the last update;
 * the first update after subscribing carries the backlog.
 */
export interface LogPayload {
  entries: LogEntry[]
  /** Replace what you have (subscribe, or back from minimised) instead of appending. */
  reset?: boolean
}

/** Established TCP connections to non-loopback addresses. */
export type ConnectionsPayload =
  | { available: true; connections: Array<{ remoteAddress: string; remotePort: number; localPort: number }> }
  | { available: false; reason: string }

export type DeviceBus = 'usb' | 'bluetooth' | 'display' | 'network'

export type DeviceKind =
  | 'keyboard'
  | 'mouse'
  | 'input'
  | 'gamepad'
  | 'audio'
  | 'storage'
  | 'camera'
  | 'phone'
  | 'printer'
  | 'serial'
  | 'network'
  | 'display'
  | 'other'

export interface Device {
  id: string
  name: string
  bus: DeviceBus
  /** Short connector label for display: USB, BT, HDMI, DP, LAN, WI-FI… */
  port: string
  kind: DeviceKind
  /** False for a paired Bluetooth device that isn't connected right now. */
  connected: boolean
  /** 0..100, when the device reports it. */
  battery?: number
  /** Resolution, link speed or capacity, when known. */
  detail?: string
}

/**
 * External devices: USB (hubs and controllers left out), paired Bluetooth, displays and
 * physical network links, plus a summary of the machine they hang off.
 */
export type DevicesPayload =
  | { available: true; host: { name: string; os: string; cores: number; memoryBytes: number }; devices: Device[] }
  | { available: false; reason: string }

/**
 * System audio analysis (computed in the UI, not the hub): pushed ~30×/s while subscribed and allowed.
 * `wave` is the time-domain signal (-1..1), `spectrum` the frequency magnitudes in dB.
 */
export type AudioPayload =
  | { available: true; sampleRate: number; wave: Float32Array; spectrum: Float32Array; minDb: number; maxDb: number }
  | { available: false; reason: 'not-allowed' | 'unavailable'; message: string }

export interface TopicPayloads {
  cpu: CpuPayload
  memory: MemoryPayload
  network: NetworkPayload
  temperature: TemperaturePayload
  log: LogPayload
  connections: ConnectionsPayload
  devices: DevicesPayload
}
