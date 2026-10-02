<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, shallowRef, watch } from 'vue'
import { HELIOS7_LAYOUT, panels, type LayoutNode as LayoutTree } from '@shared/layout'
import {
  MAX_PANES,
  closePane as closePaneIn,
  equalize,
  gutters,
  neighbor,
  pane as paneLeaf,
  paneIds,
  paneRects,
  resizeBoundary,
  resizePane as resizePaneIn,
  splitPane as splitPaneIn,
  swapPanes,
  type Gutter,
  type MinSize,
  type PaneDirection,
  type PaneNode,
  type Rect
} from '@shared/panes'
import { newId } from '@shared/tree'
import type { Settings, ShellProfile } from '@shared/settings'
import type { PlatformInfo, UiRect } from '@shared/types'
import TabBar from './components/TabBar.vue'
import TerminalView from './components/TerminalView.vue'
import SearchBar from './components/SearchBar.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import CrtOverlay from './components/CrtOverlay.vue'
import TweaksPanel from './components/TweaksPanel.vue'
import { uiVariables } from './theme'
import { resolveAction, resolvePrefixKey, type Action } from './keybindings'
import LayoutNode from './layout/LayoutNode.vue'
import { LAYOUT_KEY, type MoveDrag } from './layout/context'
import { setSettings } from './settingsWriter'
import { setAudioAllowed } from './plugins/audio'

/** One shell. */
interface Pane {
  id: string
  profileId: string | null
  profileName: string
  /** Title set by the shell (OSC 0/2); empty until it sends one. */
  shellTitle: string
  /** Folder it started in: where the pane it was split from was. */
  cwd: string | null
}

interface Tab {
  key: number
  /** How its panes are arranged. Replaced on every edit, never mutated (hence markRaw). */
  root: PaneNode
  /** By id, in creation order, which is also the render order: panes never move in the DOM. */
  panes: Record<string, Pane>
  /** The pane with keyboard focus when this tab is shown. */
  activePane: string
  /** The pane filling the whole stage (tmux zoom), if any. */
  zoomed: string | null
}

type TerminalHandle = InstanceType<typeof TerminalView>

const platform = shallowRef<PlatformInfo | null>(null)
const settings = ref<Settings | null>(null)
const profiles = ref<ShellProfile[]>([])
const defaultId = ref('')
const tabs = reactive<Tab[]>([])
const activeKey = ref<number | null>(null)
const zoom = ref(0)
const showSettings = ref(false)
const showTweaks = ref(false)
const showSearch = ref(false)
const searchResult = ref<{ index: number; count: number } | null>(null)
const maximized = ref(false)
/** By pane id. */
const views = new Map<string, TerminalHandle>()
let nextKey = 1

// ---------------------------------------------------------------- layout
// The tree is edited locally for instant feedback and saved on commit; changes from other
// windows or hand edits to settings.json arrive through settings and replace it.
const layoutRoot = shallowRef<LayoutTree>(HELIOS7_LAYOUT.root)
const move = shallowRef<MoveDrag | null>(null)
const terminalSlot = shallowRef<HTMLElement | null>(null)
const workspace = ref<HTMLElement>()
const stageRect = shallowRef<{ left: number; top: number; width: number; height: number } | null>(null)
const terminalPanelId = computed(() => panels(layoutRoot.value).find((p) => p.kind === 'terminal')?.id)

function commitLayout(): void {
  setSettings({ layout: layoutRoot.value })
}

provide(LAYOUT_KEY, {
  root: layoutRoot,
  edit(next, opts) {
    layoutRoot.value = next
    if (opts?.commit) commitLayout()
  },
  commit: commitLayout,
  move,
  setTerminalSlot(el) {
    terminalSlot.value = el
  },
  releaseTerminalSlot(el) {
    if (terminalSlot.value === el) terminalSlot.value = null
  },
  focusTerminal: () => activeView()?.focus(),
  settings
})
// System audio for plugins only runs with the user's consent.
watch(() => settings.value?.audioCapture ?? false, setAudioAllowed, { immediate: true })

/**
 * The terminals live outside the layout tree and are laid over the shell panel's slot, so
 * moving, splitting or resizing panels never remounts them (which would restart the shells).
 */
function measureStage(): void {
  const slot = terminalSlot.value
  const ws = workspace.value
  if (!slot || !ws) return
  const a = slot.getBoundingClientRect()
  const b = ws.getBoundingClientRect()
  const next = { left: a.left - b.left, top: a.top - b.top, width: a.width, height: a.height }
  const cur = stageRect.value
  if (!cur || cur.left !== next.left || cur.top !== next.top || cur.width !== next.width || cur.height !== next.height) {
    stageRect.value = next
  }
}
const slotObserver = new ResizeObserver(measureStage)
watch(terminalSlot, (el, old) => {
  if (old) slotObserver.unobserve(old)
  if (el) {
    slotObserver.observe(el)
    measureStage()
  }
})
// A move can change the slot's position without changing its size.
watch(layoutRoot, () => nextTick(measureStage))
const stageStyle = computed(() => {
  const r = stageRect.value
  return r ? { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` } : { visibility: 'hidden' as const }
})

const activeTab = computed(() => tabs.find((t) => t.key === activeKey.value))
/** The focused pane of the shown tab: target of search, paste, drops and text from the host. */
const activeView = (): TerminalHandle | undefined => {
  const t = activeTab.value
  return t ? views.get(t.activePane) : undefined
}

/** Shells often set the title to their own .exe path; the profile name reads better. */
function paneTitle(p: Pane | undefined): string {
  if (!p) return 'Shell'
  const s = p.shellTitle.trim()
  if (!s || /\.exe$/i.test(s)) return p.profileName
  return s
}
const tabInfos = computed(() => tabs.map((t) => ({ key: t.key, title: paneTitle(t.panes[t.activePane]) })))

// ---------------------------------------------------------------- panes on the stage
// Every pane of every tab is rendered by one flat v-for keyed by pane id and placed with percentages.
// A recursive component would remount a pane's TerminalView (and kill its shell) each time a split
// moves it one level deeper in the tree.
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
/** Gutters between panes are 6px; each neighbour gives up half. */
const HALF_GUTTER = 3
const EDGE = 1e-6
/**
 * Visible panes that may use a WebGL context; Chromium allows ~16 per renderer process. Plugin frames
 * don't count against it: they're on their own crt-plugin:// site, so they run in their own process.
 */
const WEBGL_BUDGET = 8
/** Smallest pane, in cells, so xterm always has room for some text. */
const MIN_COLS = 10
const MIN_ROWS = 3

const paneViews = computed(() =>
  tabs.flatMap((t) => {
    const shown = t.key === activeKey.value
    const rects = new Map(paneRects(t.root).map((r) => [r.id, r]))
    const framed = Object.keys(t.panes).length > 1 && !t.zoomed
    return Object.values(t.panes).map((p) => {
      const visible = shown && (!t.zoomed || t.zoomed === p.id)
      return { tab: t, pane: p, visible, focused: visible && t.activePane === p.id, framed, rect: t.zoomed ? FULL : (rects.get(p.id) ?? FULL) }
    })
  })
)

// Hidden tabs never hold a context. MAX_PANES keeps a tab within the budget anyway; if that ever
// changes, the focused pane keeps WebGL and the rest fall back to the DOM renderer.
const webglPanes = computed(
  () =>
    new Set(
      paneViews.value
        .filter((v) => v.visible)
        .sort((a, b) => Number(b.focused) - Number(a.focused))
        .slice(0, WEBGL_BUDGET)
        .map((v) => v.pane.id)
    )
)

function paneStyle(r: Rect): Record<string, string> {
  const l = r.x > EDGE ? HALF_GUTTER : 0
  const right = r.x + r.w < 1 - EDGE ? HALF_GUTTER : 0
  const t = r.y > EDGE ? HALF_GUTTER : 0
  const b = r.y + r.h < 1 - EDGE ? HALF_GUTTER : 0
  return {
    left: `calc(${r.x * 100}% + ${l}px)`,
    top: `calc(${r.y * 100}% + ${t}px)`,
    width: `calc(${r.w * 100}% - ${l + right}px)`,
    height: `calc(${r.h * 100}% - ${t + b}px)`
  }
}

const paneGutters = computed(() => {
  const t = activeTab.value
  return t && !t.zoomed ? gutters(t.root) : []
})

function gutterStyle(g: Gutter): Record<string, string> {
  return g.dir === 'row'
    ? { left: `calc(${g.x * 100}% - ${HALF_GUTTER}px)`, top: `${g.y * 100}%`, width: `${HALF_GUTTER * 2}px`, height: `${g.h * 100}%` }
    : { left: `${g.x * 100}%`, top: `calc(${g.y * 100}% - ${HALF_GUTTER}px)`, width: `${g.w * 100}%`, height: `${HALF_GUTTER * 2}px` }
}

/** MIN_COLS × MIN_ROWS plus the terminal's padding, overview ruler and gutters, as fractions of the stage. */
function minPaneSize(): MinSize {
  const stage = stageRect.value
  const cell = activeView()?.cellSize()
  if (!stage || !cell || !stage.width || !stage.height) return { w: 0, h: 0 }
  return {
    w: (MIN_COLS * cell.width + 8 + 10 + HALF_GUTTER * 2) / stage.width,
    h: (MIN_ROWS * cell.height + 4 + HALF_GUTTER * 2) / stage.height
  }
}

// Each move recomputes from the tree as it was at pointerdown, so rounding never accumulates.
function startPaneResize(e: PointerEvent, g: Gutter): void {
  const tab = activeTab.value
  const stage = stageRect.value
  if (!tab || !stage) return
  e.preventDefault()
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  const span = (g.dir === 'row' ? stage.width : stage.height) * g.span
  const start = g.dir === 'row' ? e.clientX : e.clientY
  const snapshot = tab.root
  const min = minPaneSize()
  const onMove = (m: PointerEvent): void => {
    const pos = g.dir === 'row' ? m.clientX : m.clientY
    tab.root = markRaw(resizeBoundary(snapshot, g.splitId, g.index, (pos - start) / span, min))
  }
  const onUp = (): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    activeView()?.focus()
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/** Arrow keys on a focused gutter nudge it by 2% of its split. */
function keyPaneResize(e: KeyboardEvent, g: Gutter): void {
  const tab = activeTab.value
  const back = g.dir === 'row' ? 'ArrowLeft' : 'ArrowUp'
  const fwd = g.dir === 'row' ? 'ArrowRight' : 'ArrowDown'
  if (!tab || (e.key !== back && e.key !== fwd)) return
  e.preventDefault()
  tab.root = markRaw(resizeBoundary(tab.root, g.splitId, g.index, e.key === fwd ? 0.02 : -0.02, minPaneSize()))
}

// ---------------------------------------------------------------- tabs
function newTab(profileId: string | null = null): void {
  const p = profiles.value.find((x) => x.id === (profileId ?? defaultId.value))
  const id = newId('pane')
  const pane: Pane = { id, profileId: p?.id ?? profileId, profileName: p?.name ?? 'Shell', shellTitle: '', cwd: null }
  const tab: Tab = { key: nextKey++, root: markRaw(paneLeaf(id)), panes: { [id]: pane }, activePane: id, zoomed: null }
  tabs.push(tab)
  activate(tab.key)
}

function activate(key: number): void {
  if (activeKey.value !== key) closeSearch()
  activeKey.value = key
}

function closeTab(key: number | null = activeKey.value): void {
  const i = tabs.findIndex((t) => t.key === key)
  if (i < 0) return
  const [tab] = tabs.splice(i, 1)
  for (const id of Object.keys(tab.panes)) views.delete(id)
  if (!tabs.length) {
    window.crt.window.close()
    return
  }
  if (activeKey.value === key) activate(tabs[Math.min(i, tabs.length - 1)].key)
}

function cycle(dir: 1 | -1): void {
  if (tabs.length < 2) return
  const i = tabs.findIndex((t) => t.key === activeKey.value)
  activate(tabs[(i + dir + tabs.length) % tabs.length].key)
}

function setView(id: string, el: unknown): void {
  if (el) views.set(id, el as TerminalHandle)
  else views.delete(id)
}

// ---------------------------------------------------------------- panes
function setActivePane(tab: Tab, id: string): void {
  if (!tab.panes[id] || tab.activePane === id) return
  if (tab.key === activeKey.value) closeSearch()
  tab.activePane = id
}

/** Split the focused pane; the new one starts with its profile, in its folder. */
async function splitPane(dir: 'right' | 'bottom'): Promise<void> {
  const tab = activeTab.value
  if (!tab || paneIds(tab.root).length >= MAX_PANES) return
  const from = tab.panes[tab.activePane]
  const cwd = (await views.get(from.id)?.cwd()) ?? null
  if (!tabs.includes(tab) || !tab.panes[from.id]) return // closed while asking
  const id = newId('pane')
  const next = splitPaneIn(tab.root, from.id, dir, id, minPaneSize())
  if (next === tab.root) return // at MAX_PANES, or too small to split
  tab.panes[id] = { id, profileId: from.profileId, profileName: from.profileName, shellTitle: '', cwd }
  tab.root = markRaw(next)
  tab.zoomed = null
  setActivePane(tab, id)
}

/** Close a pane (its shell is killed when its view unmounts); the last one closes the tab. */
function closePane(tab: Tab | undefined = activeTab.value, id: string | undefined = tab?.activePane): void {
  if (!tab || !id || !tab.panes[id]) return
  const next = closePaneIn(tab.root, id)
  if (!next) return closeTab(tab.key)
  if (tab.activePane === id) {
    // Focus goes to the pane that gets the space: the one before it, like the space itself.
    const ids = paneIds(tab.root)
    const i = ids.indexOf(id)
    setActivePane(tab, ids[i - 1] ?? ids[i + 1])
  }
  if (tab.zoomed === id) tab.zoomed = null
  delete tab.panes[id]
  views.delete(id)
  tab.root = markRaw(next)
}

function focusPane(dir: PaneDirection): void {
  const tab = activeTab.value
  const id = tab && neighbor(tab.root, tab.activePane, dir)
  if (!tab || !id) return
  tab.zoomed = null
  setActivePane(tab, id)
}

function nextPane(dir: 1 | -1): void {
  const tab = activeTab.value
  const ids = tab ? paneIds(tab.root) : []
  if (!tab || ids.length < 2) return
  tab.zoomed = null
  setActivePane(tab, ids[(ids.indexOf(tab.activePane) + dir + ids.length) % ids.length])
}

/** Swap the focused pane with the next/previous one; focus moves with it. */
function swapPane(dir: 1 | -1): void {
  const tab = activeTab.value
  const ids = tab ? paneIds(tab.root) : []
  if (!tab || ids.length < 2) return
  const other = ids[(ids.indexOf(tab.activePane) + dir + ids.length) % ids.length]
  tab.zoomed = null
  tab.root = markRaw(swapPanes(tab.root, tab.activePane, other))
}

/** Arrow-key resizing moves a border by a few cells. */
function resizePane(dir: PaneDirection): void {
  const tab = activeTab.value
  const stage = stageRect.value
  const cell = activeView()?.cellSize()
  if (!tab || tab.zoomed || !stage || !cell) return
  const delta = dir === 'left' || dir === 'right' ? (4 * cell.width) / stage.width : (2 * cell.height) / stage.height
  tab.root = markRaw(resizePaneIn(tab.root, tab.activePane, dir, delta, minPaneSize()))
}

function zoomPane(): void {
  const tab = activeTab.value
  if (!tab) return
  tab.zoomed = tab.zoomed || paneIds(tab.root).length < 2 ? null : tab.activePane
}

// ---------------------------------------------------------------- pane prefix (tmux style)
// Ctrl+Shift+Space (⌘⇧Space), then one key (see resolvePrefixKey). The key is taken in the capture
// phase, before xterm, so it never reaches the shell. In webgl mode text keys arrive as host text.
const PREFIX_MS = 1500
const prefixArmed = ref(false)
let prefixTimer: ReturnType<typeof setTimeout> | undefined
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

function armPrefix(): void {
  prefixArmed.value = true
  clearTimeout(prefixTimer)
  prefixTimer = setTimeout(disarmPrefix, PREFIX_MS)
}

function disarmPrefix(): void {
  clearTimeout(prefixTimer)
  prefixArmed.value = false
}

function runPrefixed(action: Action | null): void {
  disarmPrefix()
  if (!action) return // Esc or an unbound key: just cancel
  run(action)
  // Like tmux's repeatable keys: keep resizing without pressing the prefix again.
  if (action.type === 'resizePane') armPrefix()
}

function onPrefixKey(e: KeyboardEvent): void {
  if (!prefixArmed.value || MODIFIER_KEYS.has(e.key) || e.isComposing) return
  e.preventDefault()
  e.stopPropagation()
  runPrefixed(resolvePrefixKey(e))
}

// ---------------------------------------------------------------- search
function openSearch(): void {
  showSearch.value = true
  nextTick(() => searchBar.value?.focus())
}
function closeSearch(): void {
  if (!showSearch.value) return
  showSearch.value = false
  searchResult.value = null
  activeView()?.clearFind()
  activeView()?.focus()
}
const searchBar = ref<InstanceType<typeof SearchBar>>()

// ---------------------------------------------------------------- actions
function run(action: Action): void {
  switch (action.type) {
    case 'newTab':
      if (action.profileIndex === undefined) newTab()
      else if (profiles.value[action.profileIndex]) newTab(profiles.value[action.profileIndex].id)
      break
    case 'nextTab':
      cycle(1)
      break
    case 'prevTab':
      cycle(-1)
      break
    case 'splitPane':
      void splitPane(action.dir)
      break
    case 'closePane':
      closePane()
      break
    case 'focusPane':
      focusPane(action.dir)
      break
    case 'resizePane':
      resizePane(action.dir)
      break
    case 'zoomPane':
      zoomPane()
      break
    case 'nextPane':
      nextPane(action.dir)
      break
    case 'swapPane':
      swapPane(action.dir)
      break
    case 'equalizePanes':
      if (activeTab.value) activeTab.value.root = markRaw(equalize(activeTab.value.root))
      break
    case 'panePrefix':
      armPrefix()
      break
    case 'newWindow':
      window.crt.window.newWindow()
      break
    case 'find':
      openSearch()
      break
    case 'zoom':
      zoom.value = action.delta === 'reset' ? 0 : Math.max(-10, Math.min(40, zoom.value + action.delta))
      break
    case 'settings':
      showSettings.value = !showSettings.value
      if (!showSettings.value) activeView()?.focus()
      break
    case 'tweaks':
      showTweaks.value = !showTweaks.value
      if (!showTweaks.value) activeView()?.focus()
      break
    case 'fullscreen':
      window.crt.window.toggleFullscreen()
      break
    case 'devtools':
      window.crt.window.toggleDevTools()
      break
  }
}

/** Shortcuts pressed outside a terminal (settings, search box). Terminals handle their own. */
function onWindowKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || !settings.value) return
  const action = resolveAction(e, {
    inTerminal: false,
    mac: platform.value?.os === 'darwin',
    hasSelection: false,
    altScreen: false,
    ctrlVPastes: false,
    ctrlCCopiesSelection: false
  })
  if (!action) return
  e.preventDefault()
  run(action)
}

/** Ctrl+wheel zooms, and Chromium's own page zoom never kicks in. */
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey) return
  e.preventDefault()
  if (e.deltaY) run({ type: 'zoom', delta: e.deltaY < 0 ? 1 : -1 })
}

// ---------------------------------------------------------------- data
async function loadProfiles(): Promise<void> {
  const r = await window.crt.profiles.list()
  profiles.value = r.profiles
  defaultId.value = r.defaultId
}

// ---------------------------------------------------------------- webgl renderer bridge
/** Text typed in the host window goes to whatever has focus here: a terminal or a text field. */
function onHostText(text: string): void {
  if (prefixArmed.value) return runPrefixed(resolvePrefixKey({ key: [...text][0] ?? '', code: '', shiftKey: false }))
  const el = document.activeElement as HTMLElement | null
  const field = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.classList.contains('xterm-helper-textarea')
  if (field) document.execCommand('insertText', false, text)
  else activeView()?.input(text)
}

/** Empty title-bar areas, reported so the host can make them drag the window. */
function reportDragRects(): void {
  if (platform.value?.frame !== 'custom') return
  const rects: UiRect[] = [...document.querySelectorAll<HTMLElement>('[data-drag]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  window.crt.window.reportDragRects(rects.filter((r) => r.width > 0 && r.height > 0))
}
const dragObserver = new ResizeObserver(reportDragRects)

const offs: Array<() => void> = []
onMounted(async () => {
  offs.push(
    window.crt.profiles.onChanged(() => void loadProfiles()),
    window.crt.onText(onHostText),
    window.crt.onDrop((paths) => activeView()?.pastePaths(paths)),
    window.crt.window.onMaximized((m) => (maximized.value = m))
  )
  window.addEventListener('keydown', onPrefixKey, { capture: true })
  window.addEventListener('keydown', onWindowKey)
  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  const [p, s] = await Promise.all([window.crt.platform(), window.crt.settings.get(), loadProfiles()])
  platform.value = p
  settings.value = s
  layoutRoot.value = s.layout
  if (workspace.value) slotObserver.observe(workspace.value)
  const offSettings = window.crt.settings.onChanged((next) => {
    // Adopt layout changes from elsewhere, but never mid-drag.
    if (!move.value && JSON.stringify(next.layout) !== JSON.stringify(layoutRoot.value)) layoutRoot.value = next.layout
    const reloadProfiles =
      next.defaultProfile !== settings.value?.defaultProfile ||
      JSON.stringify(next.customProfiles) !== JSON.stringify(settings.value?.customProfiles)
    settings.value = next
    if (reloadProfiles) void loadProfiles()
  })
  offs.push(offSettings)
  newTab()
  await nextTick()
  document.querySelectorAll('[data-drag]').forEach((el) => dragObserver.observe(el))
  reportDragRects()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onPrefixKey, { capture: true })
  window.removeEventListener('keydown', onWindowKey)
  window.removeEventListener('wheel', onWheel, { capture: true })
  offs.forEach((off) => off())
  dragObserver.disconnect()
  slotObserver.disconnect()
  clearTimeout(prefixTimer)
})

// "Close all N shells?" counts every pane, not just tabs.
watch(
  () => tabs.reduce((n, t) => n + Object.keys(t.panes).length, 0),
  (n) => window.crt.window.setShellCount(n)
)
watch(
  () => tabInfos.value.find((t) => t.key === activeKey.value)?.title,
  (title) => (document.title = title ? `${title} — CRT Terminal` : 'CRT Terminal')
)
watch(showSettings, (open) => !open && nextTick(() => activeView()?.focus()))
// Tabs change the size of the empty title-bar area.
watch(
  () => tabs.length,
  () => nextTick(reportDragRects)
)
</script>

<template>
  <!-- Phosphor tokens as CSS variables: one change here restyles the whole UI. -->
  <div class="app" :class="`scheme-${settings?.colorScheme ?? 'phosphor'}`" :style="settings ? uiVariables(settings) : undefined">
    <TabBar
      :tabs="tabInfos"
      :active-key="activeKey"
      :profiles="profiles"
      :default-id="defaultId"
      :frame="platform?.frame ?? 'overlay'"
      :maximized="maximized"
      :settings="settings"
      @activate="activate"
      @close="closeTab"
      @new-tab="(id) => newTab(id ?? null)"
      @settings="run({ type: 'settings' })"
      @tweaks="run({ type: 'tweaks' })"
    />
    <div class="body">
    <div ref="workspace" class="workspace" :class="{ moving: !!move }">
    <LayoutNode :node="layoutRoot" />
    <main class="stage" :style="stageStyle" :data-panel-id="terminalPanelId">
      <template v-if="settings && platform && stageRect">
        <div
          v-for="v in paneViews"
          v-show="v.visible"
          :key="v.pane.id"
          class="pane"
          :class="{ framed: v.framed, active: v.focused }"
          :style="paneStyle(v.rect)"
          :data-pane-id="v.pane.id"
          @pointerdown="setActivePane(v.tab, v.pane.id)"
          @focusin="setActivePane(v.tab, v.pane.id)"
        >
          <TerminalView
            :ref="(el) => setView(v.pane.id, el)"
            :profile-id="v.pane.profileId"
            :cwd="v.pane.cwd"
            :visible="v.visible"
            :focused="v.focused"
            :webgl="webglPanes.has(v.pane.id)"
            :settings="settings"
            :platform="platform"
            :zoom="zoom"
            @title="(title) => (v.pane.shellTitle = title)"
            @spawned="(p) => ((v.pane.profileId = p.id), (v.pane.profileName = p.name))"
            @done="closePane(v.tab, v.pane.id)"
            @action="run"
            @search="(r) => v.focused && (searchResult = r)"
          />
        </div>
        <div
          v-for="g in paneGutters"
          :key="`${g.splitId}:${g.index}`"
          class="pane-gutter"
          :class="g.dir"
          :style="gutterStyle(g)"
          role="separator"
          tabindex="0"
          :aria-orientation="g.dir === 'row' ? 'vertical' : 'horizontal'"
          :aria-label="`Resize ${g.dir === 'row' ? 'panes side by side' : 'stacked panes'}`"
          @pointerdown="startPaneResize($event, g)"
          @keydown="keyPaneResize($event, g)"
        />
      </template>
      <div v-if="prefixArmed" class="prefix-hint" role="status">PANE ▸</div>
      <SearchBar
        v-if="showSearch"
        ref="searchBar"
        :result="searchResult"
        @find="(q, dir, o, inc) => (q ? activeView()?.find(q, dir, o, inc) : activeView()?.clearFind())"
        @close="closeSearch"
      />
    </main>
    </div>
    <TweaksPanel v-if="showTweaks && settings" :settings="settings" :active-renderer="platform?.renderer ?? 'webgl'" @close="run({ type: 'tweaks' })" />
    </div>
    <SettingsPanel
      v-if="showSettings && settings"
      :settings="settings"
      :profiles="profiles"
      :default-id="defaultId"
      :active-renderer="platform?.renderer ?? 'webgl'"
      @close="showSettings = false"
      @tweaks="(showSettings = false), (showTweaks = true)"
    />
    <CrtOverlay v-if="platform?.renderer === 'css' && settings?.crt.enabled" :crt="settings.crt" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.workspace {
  position: relative;
  flex: 1;
  display: flex;
  min-width: 0;
  padding: 4px;
}
/* Positioned over the shell panel's slot by measureStage(). */
.stage {
  position: absolute;
  z-index: 10;
}
/* While a panel is dragged, let the pointer "see" the panels under the terminals. */
.workspace.moving .stage {
  pointer-events: none;
}
/* Placed by paneStyle(). Its own stacking context, so the frame below sits above xterm's layers. */
.pane {
  position: absolute;
  z-index: 0;
}
/* With several panes: the focused one gets an accent frame, the others are dimmed a little. */
.pane.framed::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--term-bg) 18%, transparent);
}
.pane.framed.active::after {
  border-color: var(--accent);
  background: none;
}
.pane-gutter {
  position: absolute;
  z-index: 1;
  outline: none;
}
.pane-gutter.row {
  cursor: col-resize;
}
.pane-gutter.column {
  cursor: row-resize;
}
/* A thin line in the middle of the grab area, brighter while hovered or focused (as between panels). */
.pane-gutter::after {
  content: '';
  position: absolute;
  background: var(--chrome-border);
}
.pane-gutter.row::after {
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
}
.pane-gutter.column::after {
  left: 0;
  right: 0;
  top: 2px;
  height: 2px;
}
.pane-gutter:hover::after,
.pane-gutter:focus-visible::after {
  background: var(--accent);
}
/* Shown while the pane prefix waits for its key. */
.prefix-hint {
  position: absolute;
  right: 10px;
  bottom: 8px;
  z-index: 40;
  padding: 1px 8px;
  background: var(--accent);
  color: var(--term-bg);
  font-size: 11px;
  letter-spacing: 0.14em;
  pointer-events: none;
}
</style>
