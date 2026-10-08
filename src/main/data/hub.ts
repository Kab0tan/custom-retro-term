import os from 'node:os'
import { ipcMain, type WebContents } from 'electron'
import {
  isDataTopic,
  type CpuPayload,
  type DataTopic,
  type LogEntry,
  type LogLevel,
  type MemoryPayload,
  type NetworkPayload,
  type TemperaturePayload,
  type TopicPayloads
} from '@shared/data'
import { Sampler, type DataSampler, type SamplerJob, type SamplerMessage } from './sampler'
import { PosixSampler } from './posixSampler'
import { devicesPayload, fromWindows, type RawDevices } from './devices'

/**
 * Data hub: panels subscribe to topics; a topic's collector runs only while at least one
 * *visible* subscriber exists (hidden pages unsubscribe themselves, minimised windows are
 * skipped here), so an unwatched panel costs nothing.
 */

const LOG_BACKLOG = 200
const LOG_FLUSH_MS = 500

type Stop = () => void

const subs = new Map<DataTopic, Set<WebContents>>()
const last = new Map<DataTopic, unknown>()
const running = new Map<DataTopic, Stop>()
const wasVisible = new Map<WebContents, boolean>()
const logBacklog: LogEntry[] = []
let isVisible: (wc: WebContents) => boolean = () => true

// ------------------------------------------------------------------ delivery
function send<T extends DataTopic>(wc: WebContents, topic: T, payload: TopicPayloads[T]): void {
  if (!wc.isDestroyed()) wc.send('data:update', topic, payload)
}

function publish<T extends DataTopic>(topic: T, payload: TopicPayloads[T]): void {
  if (topic !== 'log') last.set(topic, payload)
  for (const wc of subs.get(topic) ?? []) if (isVisible(wc)) send(wc, topic, payload)
}

/** What a (re)joining subscriber gets straight away: the latest value, or the whole log backlog. */
function sendCurrent(wc: WebContents, topic: DataTopic): void {
  if (topic === 'log') send(wc, 'log', { entries: [...logBacklog], reset: true })
  else if (last.has(topic)) send(wc, topic, last.get(topic) as TopicPayloads[typeof topic])
}

// ------------------------------------------------------------------ collectors
function cpuTimes(): Array<{ idle: number; total: number }> {
  return os.cpus().map(({ times: t }) => ({ idle: t.idle, total: t.user + t.nice + t.sys + t.irq + t.idle }))
}

function startCpu(): Stop {
  let prev = cpuTimes()
  const model = os.cpus()[0]?.model.trim() ?? ''
  const timer = setInterval(() => {
    const cur = cpuTimes()
    const cores = cur.map((c, i) => {
      const dTotal = c.total - (prev[i]?.total ?? 0)
      return dTotal > 0 ? Math.min(1, Math.max(0, 1 - (c.idle - (prev[i]?.idle ?? 0)) / dTotal)) : 0
    })
    prev = cur
    const total = cores.reduce((a, b) => a + b, 0) / (cores.length || 1)
    publish<'cpu'>('cpu', { cores, total, model } satisfies CpuPayload)
  }, 1000)
  return () => clearInterval(timer)
}

function startMemory(): Stop {
  const tick = (): void => {
    const totalBytes = os.totalmem()
    publish<'memory'>('memory', { totalBytes, usedBytes: totalBytes - os.freemem() } satisfies MemoryPayload)
  }
  tick()
  const timer = setInterval(tick, 2000)
  return () => clearInterval(timer)
}

// Log entries are batched so a burst of events is one message.
let logPending: LogEntry[] = []
let logTimer: NodeJS.Timeout | null = null
function pushLog(entries: LogEntry[]): void {
  if (!entries.length) return
  logBacklog.push(...entries)
  if (logBacklog.length > LOG_BACKLOG) logBacklog.splice(0, logBacklog.length - LOG_BACKLOG)
  logPending.push(...entries)
  logTimer ??= setTimeout(() => {
    logTimer = null
    const batch = logPending
    logPending = []
    publish<'log'>('log', { entries: batch })
  }, LOG_FLUSH_MS)
}

const EVENT_LEVELS: Record<number, LogLevel> = { 1: 'critical', 2: 'error', 3: 'warning' }

// ------------------------------------------------------------------ PowerShell-backed topics
const sampler: DataSampler = process.platform === 'win32' ? new Sampler(onSample) : new PosixSampler(onSample)

const NO_TEMPERATURE: Record<string, string> = {
  win32: 'No temperature sensor is readable without administrator rights on this PC.',
  darwin: 'macOS does not expose temperatures to apps without extra tools.',
  linux: 'No thermal zone found in /sys/class/thermal.'
}

function onSample(m: SamplerMessage): void {
  if (m.t === 'net') {
    const interfaces = ((m.interfaces as Array<{ name: string; rx: number; tx: number }>) ?? []).map((i) => ({
      name: String(i.name),
      rxBytesPerSec: Number(i.rx) || 0,
      txBytesPerSec: Number(i.tx) || 0
    }))
    const payload: NetworkPayload = {
      available: true,
      interfaces,
      rxBytesPerSec: interfaces.reduce((a, i) => a + i.rxBytesPerSec, 0),
      txBytesPerSec: interfaces.reduce((a, i) => a + i.txBytesPerSec, 0)
    }
    publish('network', payload)
  } else if (m.t === 'temp') {
    const zones = ((m.zones as Array<{ name: string; celsius: number; cpu?: boolean }>) ?? []).filter((z) =>
      Number.isFinite(z.celsius)
    )
    const payload: TemperaturePayload = zones.length
      ? { available: true, zones: zones.map((z) => ({ name: String(z.name), celsius: Number(z.celsius), cpu: z.cpu === true })) }
      : { available: false, reason: NO_TEMPERATURE[process.platform] ?? 'No temperature sensor found.' }
    publish('temperature', payload)
  } else if (m.t === 'events') {
    const entries = ((m.entries as Array<{ time: number; level: number; source: string; message: string }>) ?? []).map(
      (e): LogEntry => ({
        time: Number(e.time) || Date.now(),
        level: EVENT_LEVELS[e.level] ?? 'info',
        source: String(e.source ?? 'System'),
        message: String(e.message ?? '')
      })
    )
    pushLog(entries)
  } else if (m.t === 'conns') {
    const connections = ((m.list as Array<{ ip: string; port: number; lport: number }>) ?? []).map((c) => ({
      remoteAddress: String(c.ip),
      remotePort: Number(c.port) || 0,
      localPort: Number(c.lport) || 0
    }))
    publish('connections', { available: true, connections })
  } else if (m.t === 'devices') {
    const raw: RawDevices = process.platform === 'win32' ? fromWindows(m) : { devices: (m.devices as RawDevices['devices']) ?? [], monitors: [] }
    publish('devices', devicesPayload(raw))
  } else if (m.t === 'error' && m.job === 'events') {
    // Only the log source failed (e.g. no permission to read the journal): say so in the log.
    pushLog([{ time: Date.now(), level: 'warning', source: 'crt-terminal', message: `System log unavailable: ${String(m.message)}` }])
  } else if (m.t === 'error' && m.job === 'devices') {
    publish('devices', { available: false, reason: `Device scan failed (${String(m.message)}).` })
  } else if (m.t === 'error') {
    const reason = `System data source unavailable (${String(m.message)}).`
    if (running.has('network')) publish('network', { available: false, reason })
    if (running.has('temperature')) publish('temperature', { available: false, reason })
    if (running.has('connections')) publish('connections', { available: false, reason })
    if (running.has('devices')) publish('devices', { available: false, reason })
  }
}

/** Topics collected in-process start/stop functions; PowerShell ones map to sampler jobs. */
const LOCAL: Partial<Record<DataTopic, () => Stop>> = {
  cpu: startCpu,
  memory: startMemory
}
const SAMPLER_JOBS: Partial<Record<DataTopic, SamplerJob>> = {
  network: 'net',
  temperature: 'temp',
  log: 'events',
  connections: 'conns',
  devices: 'devices'
}

// ------------------------------------------------------------------ demand
function refresh(): void {
  const active = new Set<DataTopic>()
  for (const [topic, set] of subs) {
    for (const wc of [...set]) {
      if (wc.isDestroyed()) {
        set.delete(wc)
        continue
      }
      const visible = isVisible(wc)
      if (visible) active.add(topic)
      // Coming back from minimised: catch up at once instead of waiting for the next tick.
      if (visible && wasVisible.get(wc) === false) sendCurrent(wc, topic)
    }
  }
  for (const wc of new Set([...subs.values()].flatMap((s) => [...s]))) wasVisible.set(wc, isVisible(wc))

  for (const [topic, stop] of running) {
    if (!active.has(topic)) {
      stop()
      running.delete(topic)
    }
  }
  for (const topic of active) {
    if (running.has(topic)) continue
    const start = LOCAL[topic]
    running.set(topic, start ? start() : () => {})
  }
  sampler.setJobs([...active].map((t) => SAMPLER_JOBS[t]).filter((j): j is SamplerJob => !!j))
}

/** Windows we already listen to for 'destroyed': one listener per window, not per subscription. */
const tracked = new WeakSet<WebContents>()

function subscribe(wc: WebContents, topic: DataTopic): void {
  let set = subs.get(topic)
  if (!set) subs.set(topic, (set = new Set()))
  set.add(wc)
  if (!tracked.has(wc)) {
    tracked.add(wc)
    wc.once('destroyed', refresh)
  }
  sendCurrent(wc, topic)
  refresh()
}

function unsubscribe(wc: WebContents, topic: DataTopic): void {
  subs.get(topic)?.delete(wc)
  refresh()
}

export function initDataHub(opts: { isVisible: (wc: WebContents) => boolean }): void {
  isVisible = opts.isVisible
  ipcMain.on('data:subscribe', (e, topic: unknown) => isDataTopic(topic) && subscribe(e.sender, topic))
  ipcMain.on('data:unsubscribe', (e, topic: unknown) => isDataTopic(topic) && unsubscribe(e.sender, topic))
  // Catches windows being minimised/restored without wiring every window event.
  setInterval(refresh, 2000)
}

export function stopDataHub(): void {
  for (const stop of running.values()) stop()
  running.clear()
  sampler.stop()
}
