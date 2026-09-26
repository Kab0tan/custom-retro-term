<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, shallowRef, watch } from 'vue'
import { HELIOS7_LAYOUT, panels, type LayoutNode as LayoutTree } from '@shared/layout'
import type { Settings, ShellProfile } from '@shared/settings'
import type { PlatformInfo, UiRect } from '@shared/types'
import TabBar from './components/TabBar.vue'
import TerminalView from './components/TerminalView.vue'
import SearchBar from './components/SearchBar.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import CrtOverlay from './components/CrtOverlay.vue'
import TweaksPanel from './components/TweaksPanel.vue'
import { uiVariables } from './theme'
import { resolveAction, type Action } from './keybindings'
import LayoutNode from './layout/LayoutNode.vue'
import { LAYOUT_KEY, type MoveDrag } from './layout/context'
import { setSettings } from './settingsWriter'
import { setAudioAllowed } from './plugins/audio'

interface Tab {
  key: number
  profileId: string | null
  profileName: string
  /** Title set by the shell (OSC 0/2); empty until it sends one. */
  shellTitle: string
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
const views = new Map<number, TerminalHandle>()
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

const activeView = (): TerminalHandle | undefined => (activeKey.value === null ? undefined : views.get(activeKey.value))

/** Shells often set the title to their own .exe path; the profile name reads better. */
function tabTitle(t: Tab): string {
  const s = t.shellTitle.trim()
  if (!s || /\.exe$/i.test(s)) return t.profileName
  return s
}
const tabInfos = computed(() => tabs.map((t) => ({ key: t.key, title: tabTitle(t) })))

// ---------------------------------------------------------------- tabs
function newTab(profileId: string | null = null): void {
  const p = profiles.value.find((x) => x.id === (profileId ?? defaultId.value))
  const tab: Tab = { key: nextKey++, profileId: p?.id ?? profileId, profileName: p?.name ?? 'Shell', shellTitle: '' }
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
  tabs.splice(i, 1)
  views.delete(key!)
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

function setView(key: number, el: unknown): void {
  if (el) views.set(key, el as TerminalHandle)
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
    case 'closeTab':
      closeTab()
      break
    case 'nextTab':
      cycle(1)
      break
    case 'prevTab':
      cycle(-1)
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
  window.removeEventListener('keydown', onWindowKey)
  window.removeEventListener('wheel', onWheel, { capture: true })
  offs.forEach((off) => off())
  dragObserver.disconnect()
  slotObserver.disconnect()
})

watch(
  () => tabs.length,
  (n) => window.crt.window.setTabCount(n)
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
        <TerminalView
          v-for="t in tabs"
          v-show="t.key === activeKey"
          :key="t.key"
          :ref="(el) => setView(t.key, el)"
          :profile-id="t.profileId"
          :active="t.key === activeKey"
          :settings="settings"
          :platform="platform"
          :zoom="zoom"
          @title="(title) => (t.shellTitle = title)"
          @spawned="(p) => ((t.profileId = p.id), (t.profileName = p.name))"
          @done="closeTab(t.key)"
          @action="run"
          @search="(r) => t.key === activeKey && (searchResult = r)"
        />
      </template>
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
</style>
