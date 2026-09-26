<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Settings, ShellProfile } from '@shared/settings'
import LayoutMenu from '../layout/LayoutMenu.vue'
import { profileShortcut } from '../keybindings'

export interface TabInfo {
  key: number
  title: string
}

defineProps<{
  tabs: TabInfo[]
  activeKey: number | null
  profiles: ShellProfile[]
  defaultId: string
  /**
   * overlay: Windows draws the caption buttons over the title bar; leave room for them.
   * custom:  draw our own (webgl renderer, so they go through the CRT like everything else).
   */
  frame: 'overlay' | 'custom' | 'mac'
  maximized: boolean
  settings: Settings | null
}>()

const emit = defineEmits<{
  activate: [key: number]
  close: [key: number]
  newTab: [profileId?: string]
  settings: []
  tweaks: []
}>()

const menuOpen = ref(false)
const menuRoot = ref<HTMLElement>()

function onDocPointer(e: PointerEvent): void {
  if (menuOpen.value && !menuRoot.value?.contains(e.target as Node)) menuOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer))

const win = window.crt.window

function pick(profileId?: string): void {
  menuOpen.value = false
  emit('newTab', profileId)
}
</script>

<template>
  <header class="tabbar" :class="frame">
    <!-- data-drag: empty areas that move the window (reported to the host in webgl mode). -->
    <div class="top-strip" data-drag />
    <div class="tabs" role="tablist">
      <div
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        role="tab"
        :aria-selected="t.key === activeKey"
        :class="{ active: t.key === activeKey }"
        :title="t.title"
        @mousedown.left="emit('activate', t.key)"
        @mousedown.middle.prevent="emit('close', t.key)"
      >
        <span class="label">{{ t.title }}</span>
        <button class="close" aria-label="Close tab" @mousedown.stop @click.stop="emit('close', t.key)">✕</button>
      </div>
    </div>
    <div ref="menuRoot" class="new">
      <button class="icon" title="New tab (Ctrl+Shift+T)" @click="emit('newTab')">＋</button>
      <button class="icon chevron" title="Open a profile" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">⌄</button>
      <div v-if="menuOpen" class="menu" role="menu">
        <button v-for="(p, i) in profiles" :key="p.id" role="menuitem" class="item" @click="pick(p.id)">
          <span>{{ p.name }}<span v-if="p.id === defaultId" class="dim"> · default</span></span>
          <kbd v-if="profileShortcut(i)">{{ profileShortcut(i) }}</kbd>
        </button>
        <div class="sep" />
        <button role="menuitem" class="item" @click="menuOpen = false; emit('tweaks')">
          <span>Tweaks</span><kbd>Ctrl+Shift+E</kbd>
        </button>
        <button role="menuitem" class="item" @click="menuOpen = false; emit('settings')">
          <span>Settings</span><kbd>Ctrl+,</kbd>
        </button>
      </div>
    </div>
    <div class="drag" data-drag />
    <LayoutMenu v-if="settings" :settings="settings" />
    <button class="icon tweaks" title="Tweaks (Ctrl+Shift+E)" aria-label="Tweaks" @click="emit('tweaks')">◐</button>
    <div v-if="frame === 'custom'" class="caption">
      <button aria-label="Minimize" title="Minimize" @click="win.minimize()">&#x2012;</button>
      <button :aria-label="maximized ? 'Restore' : 'Maximize'" :title="maximized ? 'Restore' : 'Maximize'" @click="win.toggleMaximize()">
        {{ maximized ? '❐' : '☐' }}
      </button>
      <button class="close-win" aria-label="Close window" title="Close" @click="win.close()">✕</button>
    </div>
  </header>
</template>

<style scoped>
.tabbar {
  position: relative;
  display: flex;
  align-items: stretch;
  height: var(--titlebar-h);
  background: var(--chrome-bg);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
}
.tabbar.mac {
  /* Room for the traffic lights on the left. */
  padding-left: 76px;
}
.tabbar.mac .top-strip {
  -webkit-app-region: drag;
}
.tabbar.overlay {
  /* Space for the window's min/max/close buttons. */
  padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 140px)));
}
.tabs {
  display: flex;
  min-width: 0;
  padding: 6px 0 0 6px;
  gap: 2px;
  overflow: hidden;
}
.tab {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 60px;
  max-width: 220px;
  flex: 0 1 220px;
  padding: 0 6px 0 12px;
  border-radius: 6px 6px 0 0;
  color: var(--chrome-dim);
  cursor: default;
}
.tab:hover {
  background: var(--chrome-hover);
}
.tab.active {
  background: var(--term-bg);
  color: var(--chrome-fg);
}
.label {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.close {
  border: 0;
  background: transparent;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  font-size: 10px;
  color: inherit;
  opacity: 0.6;
}
.close:hover {
  opacity: 1;
  background: #ffffff1a;
}
.new {
  position: relative;
  display: flex;
  align-items: center;
  padding: 6px 4px 0;
  -webkit-app-region: no-drag;
}
.icon {
  border: 0;
  background: transparent;
  height: 26px;
  min-width: 26px;
  border-radius: 4px;
  color: var(--chrome-fg);
}
.icon:hover {
  background: var(--chrome-hover);
}
.tweaks {
  align-self: center;
  margin: 6px 6px 0 0;
  -webkit-app-region: no-drag;
}
.chevron {
  min-width: 18px;
  font-size: 12px;
}
.menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 50;
  min-width: 260px;
  padding: 4px;
  background: var(--popup-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 6px;
  box-shadow: 0 8px 24px #0008;
}
.item {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  text-align: left;
}
.item:hover {
  background: var(--chrome-hover);
}
kbd {
  font: 11px var(--ui-font);
  color: var(--chrome-dim);
}
.dim {
  color: var(--chrome-dim);
}
.sep {
  height: 1px;
  margin: 4px 0;
  background: var(--chrome-border);
}
.drag {
  flex: 1;
}
/* Thin draggable band above the tabs, like Windows Terminal. */
.top-strip {
  position: absolute;
  top: 0;
  left: 0;
  right: 140px;
  height: 6px;
}
.overlay .top-strip {
  -webkit-app-region: drag;
}
.caption {
  display: flex;
  -webkit-app-region: no-drag;
}
.caption button {
  width: 46px;
  border: 0;
  background: transparent;
  color: var(--chrome-fg);
  font-size: 12px;
}
.caption button:hover {
  background: var(--chrome-hover);
}
.caption .close-win:hover {
  background: #c42b1c;
  color: #fff;
}
</style>
