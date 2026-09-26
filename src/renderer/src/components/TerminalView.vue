<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard'
import type { Settings, ShellProfile } from '@shared/settings'
import type { PlatformInfo } from '@shared/types'
import { resolveAction, type Action } from '../keybindings'
import { subscribePty } from '../ptyBus'
import { fontStack, terminalTheme } from '../theme'

const props = defineProps<{
  profileId: string | null
  active: boolean
  settings: Settings
  platform: PlatformInfo
  /** Window-level zoom added to settings.fontSize. */
  zoom: number
}>()

const emit = defineEmits<{
  title: [title: string]
  spawned: [profile: Pick<ShellProfile, 'id' | 'name' | 'kind'>]
  /** Shell ended cleanly: the tab should close. */
  done: []
  /** An app shortcut pressed inside this terminal. */
  action: [action: Action]
  search: [result: { index: number; count: number }]
}>()

const host = ref<HTMLDivElement>()
let term: Terminal
let fit: FitAddon
let search: SearchAddon
let webgl: WebglAddon | null = null
let ptyId: number | null = null
let kind: ShellProfile['kind'] = 'custom'
let exited = false
let unsubscribe: (() => void) | null = null
const disposables: IDisposable[] = []
let ro: ResizeObserver | null = null

// ---------------------------------------------------------------- rendering
/** WebGL only on the visible tab: Chromium caps live WebGL contexts (~16) per process. */
function attachWebgl(): void {
  if (webgl) return
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      addon.dispose()
      if (webgl === addon) webgl = null // DOM renderer takes over; re-attached on next activation
    })
    term.loadAddon(addon)
    webgl = addon
  } catch (err) {
    console.warn('WebGL renderer unavailable, using DOM renderer', err)
  }
}

function detachWebgl(): void {
  webgl?.dispose()
  webgl = null
}

let fitQueued = false
function queueFit(): void {
  if (fitQueued) return
  fitQueued = true
  requestAnimationFrame(() => {
    fitQueued = false
    // Hidden tabs have no size; they refit when activated.
    if (props.active && host.value && host.value.clientWidth > 0) fit.fit()
  })
}

// ---------------------------------------------------------------- shell
async function spawn(): Promise<void> {
  exited = false
  try {
    const r = await window.crt.pty.spawn({ profileId: props.profileId, cols: term.cols, rows: term.rows })
    ptyId = r.id
    kind = r.profile.kind
    emit('spawned', r.profile)
    unsubscribe = subscribePty(
      r.id,
      (data) => term.write(data, () => ptyId === r.id && window.crt.pty.ack(r.id, data.length)),
      (code) => onExit(code)
    )
  } catch (err) {
    exited = true
    const msg = String((err as Error).message ?? err).replace(/^Error invoking remote method 'pty:spawn': /, '')
    term.write(`\x1b[31mCould not start shell: ${msg}\x1b[0m\r\n\x1b[90mPress Enter to retry, Ctrl+Shift+W to close.\x1b[0m\r\n`)
  }
}

function onExit(code: number): void {
  unsubscribe?.()
  unsubscribe = null
  ptyId = null
  exited = true
  if (code === 0) {
    emit('done')
    return
  }
  term.write(`\r\n\x1b[90m[process exited with code ${code}] Press Enter to restart, Ctrl+Shift+W to close.\x1b[0m\r\n`)
}

function sendToShell(data: string): void {
  if (ptyId !== null) window.crt.pty.write(ptyId, data)
  else if (exited && data === '\r') {
    term.reset()
    void spawn()
  }
}

// ---------------------------------------------------------------- cursor blink
// Each blink repaints the screen, which keeps the CRT pipeline drawing; so, like many editors, the cursor stops
// blinking (stays solid) after a while without input or output, and starts again on the next one.
const BLINK_REST_MS = 15_000
let blinkTimer: ReturnType<typeof setTimeout> | undefined

function nudgeBlink(): void {
  clearTimeout(blinkTimer)
  if (!props.settings.cursorBlink) return
  if (!term.options.cursorBlink) term.options.cursorBlink = true
  blinkTimer = setTimeout(() => (term.options.cursorBlink = false), BLINK_REST_MS)
}

// ---------------------------------------------------------------- clipboard
function copy(): boolean {
  const text = term.getSelection()
  if (!text) return false
  window.crt.clipboard.writeText(text)
  term.clearSelection()
  return true
}

async function paste(): Promise<void> {
  const text = await window.crt.clipboard.readText()
  if (!text) return
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/)
  // With bracketed paste the shell receives it as one block; without it each line runs.
  if (lines.length > 1 && props.settings.warnOnMultilinePaste && !term.modes.bracketedPasteMode) {
    const preview = lines.slice(0, 5).join('\n') + (lines.length > 5 ? '\n…' : '')
    const r = await window.crt.confirmPaste(lines.length, preview)
    if (r.dontAskAgain) void window.crt.settings.set({ warnOnMultilinePaste: false })
    if (!r.ok) return
  }
  term.paste(text)
  term.focus()
}

/** OSC 52 from programs (nvim, tmux over WSL/SSH): allow writing the clipboard, never reading it. */
const osc52: IClipboardProvider = {
  readText: () => '',
  writeText: (_sel, text) => window.crt.clipboard.writeText(text)
}

// ---------------------------------------------------------------- drag & drop
/** POSIX shell quoting: single quotes, with embedded ones written as '\''. */
const shQuote = (s: string): string => (/[\s'"$`\\()&;|<>*?!#~]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s)

function quotePath(p: string): string {
  if (kind === 'posix') return shQuote(p)
  if (kind === 'wsl' || kind === 'gitbash') {
    const m = /^([a-zA-Z]):\\(.*)$/.exec(p)
    return shQuote(m ? `${kind === 'wsl' ? '/mnt/' : '/'}${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/'))
  }
  if (kind === 'cmd') return /[\s&()^%!,;=]/.test(p) ? `"${p}"` : p
  // PowerShell: single quotes are literal; double embedded ones.
  return /[\s'"$`&(){}@#;,|<>]/.test(p) ? `'${p.replace(/'/g, "''")}'` : p
}

function pastePaths(paths: string[]): void {
  if (!paths.length) return
  term.paste(paths.map(quotePath).join(' ') + ' ')
  term.focus()
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  const files = [...(e.dataTransfer?.files ?? [])]
  pastePaths(files.map((f) => window.crt.pathForFile(f)).filter(Boolean))
}

// ---------------------------------------------------------------- mouse
function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (props.settings.rightClick !== 'copyPaste') return
  if (!copy()) void paste()
}

// ---------------------------------------------------------------- keys
function onKey(e: KeyboardEvent): boolean {
  const action = resolveAction(e, {
    inTerminal: true,
    mac: props.platform.os === 'darwin',
    hasSelection: term.hasSelection(),
    altScreen: term.buffer.active.type === 'alternate',
    ctrlVPastes: props.settings.ctrlVPastes,
    ctrlCCopiesSelection: props.settings.ctrlCCopiesSelection
  })
  if (!action) return true
  // Also stops the browser's own paste on Ctrl+V / Ctrl+Shift+V, which would paste twice.
  e.preventDefault()
  if (e.type !== 'keydown') return false
  switch (action.type) {
    case 'copy':
      copy()
      break
    case 'paste':
      void paste()
      break
    case 'scroll':
      if (action.by === 'line') term.scrollLines(action.dir)
      else if (action.by === 'page') term.scrollPages(action.dir)
      else if (action.dir < 0) term.scrollToTop()
      else term.scrollToBottom()
      break
    default:
      emit('action', action)
  }
  return false
}

// ---------------------------------------------------------------- options
function fontSize(): number {
  return Math.min(72, Math.max(6, props.settings.fontSize + props.zoom))
}

function applyOptions(): void {
  const s = props.settings
  term.options.fontFamily = fontStack(s.fontFamily)
  term.options.fontSize = fontSize()
  term.options.lineHeight = s.lineHeight
  term.options.scrollback = s.scrollback
  term.options.cursorStyle = s.cursorStyle
  term.options.cursorBlink = s.cursorBlink
  nudgeBlink()
  term.options.theme = terminalTheme(s)
  queueFit()
}

async function loadFont(): Promise<void> {
  // xterm measures the cell once; measuring before the font is ready gives wrong widths.
  try {
    await document.fonts.load(`${fontSize()}px ${fontStack(props.settings.fontFamily)}`)
  } catch {
    // Unknown font: the fallback stack is used.
  }
}

// ---------------------------------------------------------------- lifecycle
onMounted(async () => {
  await loadFont()
  term = new Terminal({
    fontFamily: fontStack(props.settings.fontFamily),
    fontSize: fontSize(),
    lineHeight: props.settings.lineHeight,
    scrollback: props.settings.scrollback,
    cursorStyle: props.settings.cursorStyle,
    cursorBlink: props.settings.cursorBlink,
    cursorInactiveStyle: 'outline',
    theme: terminalTheme(props.settings),
    allowProposedApi: true,
    // Tells xterm to follow ConPTY's reflow behaviour on resize.
    windowsPty: props.platform.os === 'win32' ? { backend: 'conpty', buildNumber: props.platform.windowsBuild } : undefined,
    rescaleOverlappingGlyphs: true,
    overviewRuler: { width: 10 }
  })
  fit = new FitAddon()
  search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  const unicode = new Unicode11Addon()
  term.loadAddon(unicode)
  term.unicode.activeVersion = '11' // correct widths for emoji and CJK
  term.loadAddon(new WebLinksAddon((e, uri) => (e.ctrlKey ? window.crt.openExternal(uri) : undefined)))
  term.loadAddon(new ClipboardAddon(undefined, osc52))

  term.attachCustomKeyEventHandler(onKey)
  // Ctrl+wheel is zoom (handled by the window), not scroll.
  term.attachCustomWheelEventHandler((e) => !e.ctrlKey)
  term.open(host.value!)
  nudgeBlink()
  if (props.active) attachWebgl()
  fit.fit()

  disposables.push(
    term.onData(sendToShell),
    term.onBinary(sendToShell),
    term.onData(nudgeBlink),
    term.onWriteParsed(nudgeBlink),
    term.onResize(({ cols, rows }) => ptyId !== null && window.crt.pty.resize(ptyId, cols, rows)),
    term.onTitleChange((t) => emit('title', t)),
    term.onSelectionChange(() => {
      if (props.settings.copyOnSelect && term.hasSelection()) window.crt.clipboard.writeText(term.getSelection())
    }),
    search.onDidChangeResults((r) => emit('search', { index: r.resultIndex, count: r.resultCount }))
  )
  ro = new ResizeObserver(queueFit)
  ro.observe(host.value!)

  await spawn()
  if (props.active) term.focus()
})

onBeforeUnmount(() => {
  clearTimeout(blinkTimer)
  ro?.disconnect()
  unsubscribe?.()
  if (ptyId !== null) window.crt.pty.kill(ptyId)
  disposables.forEach((d) => d.dispose())
  term?.dispose()
})

watch(
  () => props.active,
  async (active) => {
    if (!term) return
    if (active) {
      attachWebgl()
      await nextTick()
      queueFit()
      term.focus()
    } else detachWebgl()
  }
)
watch(
  () => [props.settings, props.zoom],
  async () => {
    if (!term) return
    await loadFont()
    applyOptions()
  },
  { deep: true }
)

// ---------------------------------------------------------------- api
const SEARCH_DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#5c4b00',
  activeMatchBackground: '#b58900',
  matchOverviewRuler: '#b5890088',
  activeMatchColorOverviewRuler: '#ffcc00'
}

defineExpose({
  focus: () => term?.focus(),
  copy,
  paste,
  /** `incremental` while typing keeps the current match instead of jumping to the next one. */
  find(query: string, dir: 1 | -1, opts: { caseSensitive: boolean; regex: boolean }, incremental = false) {
    const o: ISearchOptions = { ...opts, decorations: SEARCH_DECORATIONS, incremental: incremental && dir === 1 }
    return dir === 1 ? search.findNext(query, o) : search.findPrevious(query, o)
  },
  clearFind: () => {
    search?.clearDecorations()
    term?.clearSelection()
  },
  /** Profile kind of the running shell (for UI decisions). */
  kind: () => kind,
  pastePaths,
  /** Text typed in the webgl host window, delivered as if typed here. */
  input: (text: string) => term?.input(text, true)
})
</script>

<template>
  <div class="term" @contextmenu="onContextMenu" @dragover.prevent @drop="onDrop">
    <div ref="host" class="xterm-host" />
  </div>
</template>

<style scoped>
.term {
  position: absolute;
  inset: 0;
  padding: 4px 0 0 8px;
  background: var(--term-bg);
}
.xterm-host {
  width: 100%;
  height: 100%;
}
</style>
