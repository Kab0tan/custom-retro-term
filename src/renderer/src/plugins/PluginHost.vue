<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DataTopic } from '@shared/data'
import { coerceSetting, PLUGIN_API_VERSION, resolveSettings, type PluginManifest } from '@shared/plugins'
import type { Settings } from '@shared/settings'
import { subscribe as subscribeData } from '../data/bus'
import { useLayout } from '../layout/context'
import { setSettings } from '../settingsWriter'
import { subscribeAudio } from './audio'
import { findPlugin, isEnabled } from './store'
import { pluginTheme } from './theme'

/**
 * Hosts one plugin panel. The plugin runs in a sandboxed iframe (its own origin, no preload,
 * no network): it reaches the app only through the messages handled here, which are exactly the
 * public API in plugin-runtime/crt-plugin.d.ts. If it throws, or stops answering pings (an
 * infinite loop), it's torn down and the panel shows the error; the rest of the app carries on.
 */
const props = defineProps<{ panelId: string; pluginId: string; title: string; settings: Settings }>()
const layout = useLayout()

type State = 'loading' | 'running' | 'error' | 'hung' | 'missing' | 'invalid' | 'disabled'
const state = ref<State>('loading')
const errorText = ref('')
const errorPhase = ref('')
const errorStack = ref('')
const devMode = computed(() => props.settings.pluginDevMode)
const container = ref<HTMLElement>()

const info = computed(() => findPlugin(props.pluginId))
const manifest = computed<PluginManifest | null>(() => info.value?.manifest ?? null)
const enabled = computed(() => isEnabled(props.settings, props.pluginId))
const resolved = computed(() => (manifest.value ? resolveSettings(manifest.value, props.settings.plugins[props.pluginId]?.settings) : {}))

// ---------------------------------------------------------------- page state shared with plugins
const visible = ref(document.visibilityState === 'visible')
const focused = ref(document.hasFocus())
const onVisibility = (): void => void (visible.value = document.visibilityState === 'visible')
const onFocus = (): void => void (focused.value = true)
const onBlur = (): void => {
  focused.value = document.hasFocus()
  // A click inside the plugin moves keyboard focus into its iframe; hand it back to the shell.
  setTimeout(() => {
    if (iframe && document.activeElement === iframe) layout.focusTerminal()
  }, 0)
}
const policy = computed(() => ({
  paused: !visible.value || (!focused.value && props.settings.crt.pauseWhenUnfocused),
  fps: props.settings.pluginFps
}))

// ---------------------------------------------------------------- the frame
let iframe: HTMLIFrameElement | null = null
let port: MessagePort | null = null
const subscriptions = new Map<string, () => void>()
let watchdog: number | null = null
let lastPong = 0
let pingSeq = 0
let bootTimer: number | null = null

const post = (msg: unknown): void => port?.postMessage(msg)

function teardown(): void {
  subscriptions.forEach((off) => off())
  subscriptions.clear()
  if (watchdog !== null) clearInterval(watchdog)
  if (bootTimer !== null) clearTimeout(bootTimer)
  watchdog = bootTimer = null
  port?.close()
  port = null
  iframe?.remove() // unloads it; an out-of-process frame's process goes with it
  iframe = null
}

function fail(kind: 'error' | 'hung', text: string, phase = ''): void {
  teardown()
  state.value = kind
  errorText.value = text
  errorPhase.value = phase
}

function start(): void {
  teardown()
  const m = manifest.value
  if (!info.value) return void (state.value = 'missing')
  if (!m) {
    state.value = 'invalid'
    errorText.value = info.value.error ?? 'Invalid plugin.'
    return
  }
  if (!enabled.value) return void (state.value = 'disabled')
  state.value = 'loading'
  const rev = info.value.revision
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('title', `${m.name} plugin`)
  frame.tabIndex = -1
  frame.src = `crt-plugin://${m.id}/_frame?rev=${rev}`
  frame.addEventListener(
    'load',
    () => {
      const channel = new MessageChannel()
      port = channel.port1
      port.onmessage = (e) => onMessage(m, rev, e.data)
      frame.contentWindow?.postMessage({ type: 'crt:connect' }, '*', [channel.port2])
    },
    { once: true }
  )
  iframe = frame
  container.value!.appendChild(frame)
  bootTimer = window.setTimeout(() => state.value === 'loading' && fail('error', 'The plugin did not start within 10 seconds.', 'mount'), 10_000)
  lastPong = performance.now()
  watchdog = window.setInterval(() => {
    // Two missed pings in a row (~6 s): the plugin's thread is stuck, so pull the plug.
    if (performance.now() - lastPong > 6000) return fail('hung', 'The plugin stopped responding and was stopped.')
    post({ type: 'ping', id: ++pingSeq })
  }, 2000)
}

async function onMessage(m: PluginManifest, rev: number, msg: { type: string; [k: string]: unknown }): Promise<void> {
  switch (msg.type) {
    case 'connected':
      post({
        type: 'init',
        apiVersion: PLUGIN_API_VERSION,
        manifest: m,
        entryUrl: `crt-plugin://${m.id}/${m.entry}?rev=${rev}`,
        theme: pluginTheme(props.settings),
        settings: resolved.value,
        policy: policy.value,
        panel: { id: props.panelId, title: props.title }
      })
      break
    case 'ready':
      if (bootTimer !== null) clearTimeout(bootTimer)
      state.value = 'running'
      break
    case 'error':
      errorStack.value = String(msg.stack ?? '')
      fail('error', String(msg.message ?? 'Unknown error'), String(msg.phase ?? ''))
      break
    case 'pong':
      lastPong = performance.now()
      break
    case 'subscribe': {
      const topic = String(msg.topic)
      // Only what the manifest declared: the runtime checks too, but the host is the gatekeeper.
      if (!m.data.includes(topic as PluginManifest['data'][number]) || subscriptions.has(topic)) return
      const forward = (payload: unknown): void => post({ type: 'data', topic, payload })
      subscriptions.set(topic, topic === 'audio' ? subscribeAudio(forward) : subscribeData(topic as DataTopic, forward))
      break
    }
    case 'unsubscribe':
      subscriptions.get(String(msg.topic))?.()
      subscriptions.delete(String(msg.topic))
      break
    case 'setSetting': {
      const spec = m.settings.find((s) => s.key === msg.key)
      if (!spec) return
      const prefs = props.settings.plugins[m.id] ?? {}
      setSettings({
        plugins: { ...props.settings.plugins, [m.id]: { ...prefs, settings: { ...prefs.settings, [spec.key]: coerceSetting(spec, msg.value) } } }
      })
      break
    }
    case 'fetch': {
      const result = await window.crt.plugins.fetch(m.id, String(msg.url), (msg.init ?? {}) as Record<string, unknown>)
      post({ type: 'fetchResult', id: msg.id, result })
      break
    }
    case 'requestPermission': {
      let granted = false
      if (msg.name === 'audio' && m.data.includes('audio')) {
        granted = props.settings.audioCapture || (await window.crt.plugins.confirmAudio(m.name))
        if (granted && !props.settings.audioCapture) setSettings({ audioCapture: true })
      }
      post({ type: 'permission', id: msg.id, granted })
      break
    }
  }
}

// ---------------------------------------------------------------- input relay
// The iframe itself never receives pointer events (pointer-events: none): input to out-of-process
// frames isn't delivered reliably under offscreen rendering. The host catches them over the panel
// and the runtime replays them inside the plugin (hover, clicks, wheel scrolling).
function relay(kind: string, e: MouseEvent, extra: Record<string, unknown> = {}): void {
  if (!iframe || state.value !== 'running') return
  const r = iframe.getBoundingClientRect()
  post({
    type: 'input',
    kind,
    x: e.clientX - r.left,
    y: e.clientY - r.top,
    button: e.button,
    buttons: e.buttons,
    mods: { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey },
    ...extra
  })
}
const onPointer = (kind: string) => (e: PointerEvent | MouseEvent) => relay(kind, e)
function onWheel(e: WheelEvent): void {
  if (!iframe || state.value !== 'running' || e.ctrlKey) return // Ctrl+wheel stays app zoom
  e.preventDefault()
  relay('wheel', e, { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode })
}

// ---------------------------------------------------------------- live updates
// Separate sources, compared one by one: a getter returning a new array would fire on every settings change.
watch([() => props.settings.phosphor, () => props.settings.colorScheme], () => post({ type: 'theme', theme: pluginTheme(props.settings) }))
watch(resolved, (s, old) => JSON.stringify(s) !== JSON.stringify(old) && post({ type: 'settings', settings: s }))
watch([() => policy.value.paused, () => policy.value.fps], () => post({ type: 'policy', policy: policy.value }))
watch(() => props.title, (title) => post({ type: 'title', title }))
// Plugin files edited, plugin enabled/disabled/removed: reload.
watch([() => info.value?.revision, () => !!manifest.value, enabled], start)

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  start()
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('blur', onBlur)
  teardown()
})

const enable = (): void => {
  const prefs = props.settings.plugins[props.pluginId] ?? {}
  setSettings({ plugins: { ...props.settings.plugins, [props.pluginId]: { ...prefs, enabled: true } } })
}
</script>

<template>
  <div class="host">
    <div
      ref="container"
      class="frame"
      :class="{ hidden: state !== 'running' && state !== 'loading' }"
      @pointermove="onPointer('move')($event)"
      @pointerdown="onPointer('down')($event)"
      @pointerup="onPointer('up')($event)"
      @pointerleave="onPointer('leave')($event)"
      @click="onPointer('click')($event)"
      @dblclick="onPointer('dblclick')($event)"
      @contextmenu.prevent
      @wheel="onWheel"
    />
    <button v-if="devMode && state === 'running'" class="reload" title="Reload plugin (developer mode)" @click="start">↻</button>
    <div v-if="state === 'loading'" class="msg dim">Starting {{ manifest?.name ?? pluginId }}…</div>
    <div v-else-if="state === 'error' || state === 'hung'" class="msg" role="alert">
      <p class="head">{{ state === 'hung' ? 'PLUGIN NOT RESPONDING' : 'PLUGIN ERROR' }}</p>
      <p class="dim">{{ manifest?.name ?? pluginId }}<template v-if="errorPhase"> · {{ errorPhase }}</template></p>
      <p class="err">{{ errorText }}</p>
      <pre v-if="devMode && errorStack" class="stack">{{ errorStack }}</pre>
      <button class="btn" @click="start">Retry</button>
    </div>
    <div v-else-if="state === 'missing'" class="msg">
      <p class="head">PLUGIN NOT INSTALLED</p>
      <p class="dim">“{{ pluginId }}” isn't in the plugins folder. Pick another source with ⏏.</p>
    </div>
    <div v-else-if="state === 'invalid'" class="msg" role="alert">
      <p class="head">PLUGIN CAN'T LOAD</p>
      <p class="err">{{ errorText }}</p>
    </div>
    <div v-else-if="state === 'disabled'" class="msg">
      <p class="head">PLUGIN DISABLED</p>
      <p class="dim">{{ manifest?.name ?? pluginId }} is turned off.</p>
      <button class="btn" @click="enable">Enable</button>
    </div>
  </div>
</template>

<style scoped>
.host {
  position: absolute;
  inset: 0;
}
.frame {
  position: absolute;
  inset: 0;
}
.frame.hidden {
  display: none;
}
.frame :deep(iframe) {
  display: block;
  pointer-events: none;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  color-scheme: normal;
}
.msg {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 4px;
  padding: 12px;
  text-align: center;
  font-size: 12px;
}
.msg p {
  margin: 0;
}
.head {
  color: var(--chrome-fg);
  letter-spacing: 0.25em;
  font-size: 13px;
}
.dim {
  color: var(--chrome-dim);
}
.err {
  max-width: 360px;
  color: var(--chrome-fg);
  font-family: 'IBM Plex Mono', monospace;
  word-break: break-word;
}
.stack {
  max-width: 100%;
  max-height: 40%;
  margin: 4px 0 0;
  overflow: auto;
  text-align: left;
  font: 11px/1.4 'IBM Plex Mono', monospace;
  color: var(--chrome-dim);
  white-space: pre-wrap;
}
.reload {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  width: 22px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--chrome-border);
  border-radius: 3px;
  background: var(--popup-bg);
  color: var(--chrome-fg);
  opacity: 0.6;
}
.reload:hover {
  opacity: 1;
}
.btn {
  justify-self: center;
  margin-top: 6px;
  padding: 3px 12px;
  border: 1px solid var(--chrome-border);
  border-radius: 3px;
  background: transparent;
}
.btn:hover {
  border-color: var(--accent);
}
</style>
