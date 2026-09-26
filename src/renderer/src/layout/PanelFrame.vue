<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { movePanel, removePanel, renamePanel, setPanelPlugin, splitPanel, type PanelNode } from '@shared/layout'
import PluginHost from '../plugins/PluginHost.vue'
import { pluginList, usablePlugins } from '../plugins/store'
import { useLayout, zoneAt } from './context'

const props = defineProps<{ panel: PanelNode }>()
const layout = useLayout()
const slot = ref<HTMLElement>()

// The terminal panel is just a placeholder here; App positions the live terminals over it,
// so moving or resizing panels never remounts (and restarts) the shells.
watch(
  slot,
  (el, old) => {
    if (old) layout.releaseTerminalSlot(old)
    if (el) layout.setTerminalSlot(el)
  },
  { flush: 'post' }
)
onBeforeUnmount(() => {
  if (slot.value) layout.releaseTerminalSlot(slot.value)
})

const isTerminal = computed(() => props.panel.kind === 'terminal')
const split = (zone: 'right' | 'bottom'): void => layout.edit(splitPanel(layout.root.value, props.panel.id, zone), { commit: true })
const choices = computed(() => (layout.settings.value ? usablePlugins(layout.settings.value) : []))
/** Put a plugin in this slot (or clear it); a default title follows the plugin's own. */
function connect(pluginId: string | null): void {
  const m = pluginId ? pluginList.value.find((p) => p.id === pluginId)?.manifest : null
  const defaults = pluginList.value.flatMap((p) => (p.manifest ? [p.manifest.defaultTitle ?? p.manifest.name] : []))
  layout.edit(setPanelPlugin(layout.root.value, props.panel.id, pluginId, m ? (m.defaultTitle ?? m.name) : null, defaults), { commit: true })
}
const close = (): void => layout.edit(removePanel(layout.root.value, props.panel.id), { commit: true })

// ---------------------------------------------------------------- rename (double-click the title)
const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement>()
function startRename(): void {
  renaming.value = true
  draft.value = props.panel.title
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}
function commitRename(): void {
  if (!renaming.value) return
  renaming.value = false
  layout.edit(renamePanel(layout.root.value, props.panel.id, draft.value), { commit: true })
}

// ---------------------------------------------------------------- move (drag the header)
const DRAG_THRESHOLD = 4

function startMove(e: PointerEvent): void {
  if (e.button !== 0 || renaming.value) return
  const handle = e.currentTarget as HTMLElement
  const x0 = e.clientX
  const y0 = e.clientY
  let started = false
  handle.setPointerCapture(e.pointerId)

  const onMove = (m: PointerEvent): void => {
    if (!started) {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < DRAG_THRESHOLD) return
      started = true
      layout.move.value = { srcId: props.panel.id, targetId: null, zone: null }
    }
    // The pointer is captured by this header, so find the panel under it by position.
    const target = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>('[data-panel-id]')
    const id = target?.dataset.panelId ?? null
    layout.move.value = {
      srcId: props.panel.id,
      targetId: id && id !== props.panel.id ? id : null,
      zone: id && id !== props.panel.id ? zoneAt(target!.getBoundingClientRect(), m.clientX, m.clientY) : null
    }
  }
  const onUp = (): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    const m = layout.move.value
    layout.move.value = null
    if (started && m?.targetId && m.zone) layout.edit(movePanel(layout.root.value, m.srcId, m.targetId, m.zone), { commit: true })
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/** Clicking panel chrome or an empty slot must not take keyboard focus away from the terminal. */
function keepFocus(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest('input, textarea, select')) e.preventDefault()
}

const dropZone = computed(() => (layout.move.value?.targetId === props.panel.id ? layout.move.value.zone : null))
const dragging = computed(() => layout.move.value?.srcId === props.panel.id)
</script>

<template>
  <section class="panel" :class="{ dragging }" :data-panel-id="panel.id" :aria-label="panel.title" @mousedown="keepFocus">
    <header class="head" @pointerdown="startMove" @dblclick="startRename">
      <input
        v-if="renaming"
        ref="input"
        v-model="draft"
        class="rename"
        maxlength="32"
        aria-label="Panel name"
        @pointerdown.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="renaming = false"
        @blur="commitRename"
      />
      <span v-else class="title" title="Drag to move · double-click to rename">{{ panel.title }}</span>
      <span class="spacer" />
      <button v-if="panel.plugin" title="Disconnect source" aria-label="Disconnect source" @pointerdown.stop @click="connect(null)">⏏</button>
      <button title="Split right" aria-label="Split right" @pointerdown.stop @click="split('right')">⫴</button>
      <button title="Split down" aria-label="Split down" @pointerdown.stop @click="split('bottom')">⊟</button>
      <button
        class="close"
        :disabled="isTerminal"
        :title="isTerminal ? 'The shell panel stays' : 'Close panel'"
        aria-label="Close panel"
        @pointerdown.stop
        @click="close"
      >
        ✕
      </button>
    </header>
    <div class="content">
      <div v-if="isTerminal" ref="slot" class="terminal-slot" />
      <PluginHost
        v-else-if="panel.plugin && layout.settings.value"
        :key="panel.plugin"
        :panel-id="panel.id"
        :plugin-id="panel.plugin"
        :title="panel.title"
        :settings="layout.settings.value"
      />
      <div v-else class="empty">
        <div class="static" aria-hidden="true" />
        <p class="signal">NO SIGNAL</p>
        <template v-if="choices.length">
          <p class="hint">Connect a plugin:</p>
          <div class="sources">
            <button v-for="m in choices" :key="m.id" class="src" :title="m.description" @click="connect(m.id)">{{ m.name }}</button>
          </div>
        </template>
        <p v-else class="hint">No plugins installed or enabled (Settings → Plugins).</p>
      </div>
      <div v-if="dropZone" class="drop" :class="dropZone" aria-hidden="true" />
    </div>
  </section>
</template>

<style scoped>
.panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--chrome-border);
  background: var(--term-bg);
}
.panel.dragging {
  opacity: 0.55;
}
.head {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 22px;
  padding: 0 2px 0 8px;
  border-bottom: 1px solid var(--chrome-border);
  background: var(--chrome-bg);
  color: var(--chrome-dim);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  user-select: none;
  cursor: grab;
  flex-shrink: 0;
}
.panel.dragging .head {
  cursor: grabbing;
}
.title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.rename {
  width: 140px;
  padding: 0 4px;
  background: var(--field-bg);
  border: 1px solid var(--accent);
  color: var(--chrome-fg);
  font: inherit;
  letter-spacing: inherit;
  text-transform: uppercase;
  outline: none;
}
.spacer {
  flex: 1;
}
.head button {
  width: 20px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
.head button:hover:not(:disabled) {
  background: var(--chrome-hover);
  color: var(--chrome-fg);
}
.head button:disabled {
  opacity: 0.3;
  cursor: default;
}
.content {
  position: relative;
  flex: 1;
  min-height: 0;
}
.terminal-slot {
  position: absolute;
  inset: 0;
}
.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  overflow: hidden;
}
/* A faint pattern so an empty slot reads as a dead channel, not a bug. */
.static {
  position: absolute;
  inset: 0;
  opacity: 0.06;
  background:
    repeating-linear-gradient(0deg, var(--chrome-fg) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, transparent 0 7px, var(--chrome-fg) 7px 8px);
}
.signal {
  position: relative;
  margin: 0;
  color: var(--chrome-fg);
  font-size: 18px;
  letter-spacing: 0.35em;
}
.hint {
  position: relative;
  margin: 6px 0 0;
  color: var(--chrome-dim);
  font-size: 12px;
}
.data {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.sources {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 10px;
  padding: 0 10px;
}
.src {
  padding: 3px 10px;
  border: 1px solid var(--chrome-border);
  border-radius: 3px;
  background: var(--term-bg);
  color: var(--chrome-fg);
  font-size: 12px;
  letter-spacing: 0.05em;
}
.src:hover {
  border-color: var(--accent);
}
.drop {
  position: absolute;
  z-index: 30; /* above the positioned terminals */
  pointer-events: none;
  background: var(--phosphor-glow, #4d9fff55);
  border: 1px solid var(--accent);
}
.drop.center {
  inset: 12%;
}
.drop.left {
  inset: 0 50% 0 0;
}
.drop.right {
  inset: 0 0 0 50%;
}
.drop.top {
  inset: 0 0 50% 0;
}
.drop.bottom {
  inset: 50% 0 0 0;
}
</style>
