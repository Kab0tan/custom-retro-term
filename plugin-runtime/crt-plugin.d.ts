/**
 * CRT Terminal plugin API, version 1.
 * Versioning: `apiVersion` in the manifest picks the runtime. A newer app keeps running older
 * supported versions unchanged; an unsupported version fails to load with a clear message.
 *
 * A plugin is a folder <plugins>/<id>/ with a manifest.json and an ES module that exports `mount(ctx)`.
 * <plugins> is %APPDATA%\crt-terminal\plugins (Windows), ~/Library/Application Support/crt-terminal/plugins
 * (macOS) or ~/.config/crt-terminal/plugins (Linux). It runs in a sandboxed iframe: no Node, no app internals, no network.
 * Everything it can do is on `ctx`. Guide: docs/plugin-api.md.
 *
 * Use with JSDoc in plain JS:  /** @param {import('./crt-plugin').PluginContext} ctx *\/
 */

export type DataTopic = 'cpu' | 'memory' | 'network' | 'temperature' | 'log' | 'connections' | 'devices' | 'audio'

export type SettingSpec =
  | { key: string; label: string; type: 'number'; default: number; min: number; max: number; step?: number }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | { key: string; label: string; type: 'select'; default: string; options: Array<{ value: string; label: string }> }

/** manifest.json */
export interface PluginManifest {
  /** Lowercase letters, digits, dashes. Must equal the folder name. */
  id: string
  name: string
  version: string
  /** Must be 1. */
  apiVersion: 1
  description?: string
  /** Module to load, relative to the folder, e.g. "index.js". */
  entry: string
  /** Panel title when the plugin is put in a slot. */
  defaultTitle?: string
  /** Data topics the plugin may subscribe to. Subscribing to anything else throws. */
  data: DataTopic[]
  /** Hosts `ctx.fetch` may reach: exact names or "*.example.com". Shown to the user in Settings. */
  permissions?: { network?: string[] }
  /** Oldest CRT Terminal version the plugin works with. */
  minAppVersion?: string
  /** User-editable settings, shown in Settings → Plugins. */
  settings: SettingSpec[]
}

// ------------------------------------------------------------------ data payloads
export interface CpuData {
  /** Busy fraction 0..1 per logical core. */
  cores: number[]
  total: number
  model: string
}
export interface MemoryData {
  totalBytes: number
  usedBytes: number
}
export type NetworkData =
  | { available: true; rxBytesPerSec: number; txBytesPerSec: number; interfaces: Array<{ name: string; rxBytesPerSec: number; txBytesPerSec: number }> }
  | { available: false; reason: string }
export type TemperatureData = { available: true; zones: Array<{ name: string; celsius: number }> } | { available: false; reason: string }
export interface LogData {
  entries: Array<{ time: number; level: 'critical' | 'error' | 'warning' | 'info'; source: string; message: string }>
  /** Replace what you have instead of appending. */
  reset?: boolean
}
export type ConnectionsData =
  | { available: true; connections: Array<{ remoteAddress: string; remotePort: number; localPort: number }> }
  | { available: false; reason: string }
export interface DeviceInfo {
  id: string
  name: string
  bus: 'usb' | 'bluetooth' | 'display' | 'network'
  /** Short connector label: USB, BT, HDMI, DP, LAN, WI-FI… */
  port: string
  kind: 'keyboard' | 'mouse' | 'input' | 'gamepad' | 'audio' | 'storage' | 'camera' | 'phone' | 'printer' | 'serial' | 'network' | 'display' | 'other'
  /** False for a paired Bluetooth device that isn't connected right now. */
  connected: boolean
  /** 0..100, when the device reports it. */
  battery?: number
  /** Resolution, link speed or capacity, when known. */
  detail?: string
}
/** Every 5 s. USB hubs and controllers are left out. */
export type DevicesData =
  | { available: true; host: { name: string; os: string; cores: number; memoryBytes: number }; devices: DeviceInfo[] }
  | { available: false; reason: string }
/** ~30 updates/s while subscribed. Needs the user's consent: see `requestPermission('audio')`. */
export type AudioData =
  | { available: true; sampleRate: number; wave: Float32Array; spectrum: Float32Array; minDb: number; maxDb: number }
  | { available: false; reason: 'not-allowed' | 'unavailable'; message: string }

export interface DataMap {
  cpu: CpuData
  memory: MemoryData
  network: NetworkData
  temperature: TemperatureData
  log: LogData
  connections: ConnectionsData
  devices: DevicesData
  audio: AudioData
}

// ------------------------------------------------------------------ theme
export interface PhosphorTokens {
  id: 'amber' | 'green' | 'cyan'
  name: string
  base: string
  bright: string
  dim: string
  faint: string
  hover: string
  background: string
  panel: string
  popup: string
  field: string
  /** 0..1 RGB, handy for WebGL. */
  rgb: [number, number, number]
}
export interface PluginTheme {
  colorScheme: 'phosphor' | 'campbell'
  phosphor: PhosphorTokens
  /** UI chrome colours (follow the colour scheme). Use `fg`/`dim` for text. */
  chrome: { bg: string; fg: string; dim: string; hover: string; border: string; accent: string; panel: string; popup: string; field: string }
  fonts: { mono: string; ui: string }
  /** Also applied to :root, e.g. var(--phosphor), var(--chrome-fg), var(--font-mono). */
  cssVariables: Record<string, string>
}

export type Unsubscribe = () => void

export interface PluginContext {
  readonly apiVersion: 1
  /** Your root element. It fills the panel; watch its size with `onResize`. */
  readonly el: HTMLElement
  readonly panel: { id: string; title: string }
  readonly manifest: PluginManifest
  readonly theme: PluginTheme
  onTheme(cb: (theme: PluginTheme) => void): Unsubscribe
  /** Current settings (defaults applied, validated against the manifest). */
  readonly settings: Record<string, unknown>
  onSettings(cb: (settings: Record<string, unknown>) => void): Unsubscribe
  /** Persist one of your own settings (validated against the manifest). */
  setSetting(key: string, value: unknown): void
  onTitle(cb: (title: string) => void): Unsubscribe
  subscribe<T extends DataTopic>(topic: T, cb: (data: DataMap[T]) => void): Unsubscribe
  /**
   * Frame loop. Capped by the user's plugin frame-rate setting and stopped while the panel is
   * paused (window hidden, or unfocused if the user chose so). `t` and `dt` are in seconds.
   */
  animate(cb: (t: number, dt: number) => void): Unsubscribe
  readonly paused: boolean
  onResize(cb: (width: number, height: number) => void): Unsubscribe
  readonly size: { width: number; height: number }
  /**
   * HTTPS request to a host listed in the manifest's `permissions.network` (anything else is
   * refused). Text bodies only, 2 MB max, 15 s timeout, redirects not followed. The plugin page has
   * no other network access.
   */
  fetch(url: string, init?: { method?: 'GET' | 'POST' | 'HEAD'; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean
    status: number
    statusText: string
    headers: { 'content-type': string }
    text(): Promise<string>
    json(): Promise<any>
  }>
  /** Ask the user for a capability. Resolves true when granted. Currently: 'audio'. */
  requestPermission(name: 'audio'): Promise<boolean>
  log(...args: unknown[]): void
}

/** What `mount` may return. All optional. */
export interface PluginInstance {
  /** Called after theme or settings changes (the `on*` callbacks fire too). */
  update?(change: { theme?: PluginTheme; settings?: Record<string, unknown> }): void
  /** Called when the panel goes away. Subscriptions are cleaned up for you. */
  unmount?(): void
}

export type Mount = (ctx: PluginContext) => PluginInstance | void | Promise<PluginInstance | void>
