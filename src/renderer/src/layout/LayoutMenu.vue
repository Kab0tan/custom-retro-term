<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { addPanel, BUILTIN_LAYOUTS, newId, sameLayout, type SavedLayout } from '@shared/layout'
import type { Settings } from '@shared/settings'
import { setSettings } from '../settingsWriter'
import { useLayout } from './context'

const props = defineProps<{ settings: Settings }>()
const layout = useLayout()

const open = ref(false)
const root = ref<HTMLElement>()
function onDocPointer(e: PointerEvent): void {
  if (open.value && !root.value?.contains(e.target as Node)) close()
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer))
function close(): void {
  open.value = false
  naming.value = null
}

const all = computed<SavedLayout[]>(() => [...BUILTIN_LAYOUTS, ...props.settings.layouts])
const active = computed(() => all.value.find((l) => l.id === props.settings.activeLayout) ?? null)
const isUser = computed(() => !!active.value && props.settings.layouts.some((l) => l.id === active.value!.id))
const modified = computed(() => !active.value || !sameLayout(layout.root.value, active.value.root))

function load(l: SavedLayout): void {
  const root = structuredClone(l.root)
  layout.edit(root)
  setSettings({ layout: root, activeLayout: l.id })
  close()
}

const add = (): void => layout.edit(addPanel(layout.root.value), { commit: true })
const revert = (): void => {
  if (active.value) load(active.value)
}

function update(): void {
  const a = active.value
  if (!a || !isUser.value) return
  setSettings({ layouts: props.settings.layouts.map((l) => (l.id === a.id ? { ...l, root: layout.root.value } : l)) })
}

function remove(): void {
  const a = active.value
  if (!a || !isUser.value) return
  // The screen keeps its current panels; only the saved entry goes.
  setSettings({ layouts: props.settings.layouts.filter((l) => l.id !== a.id), activeLayout: BUILTIN_LAYOUTS[0].id })
}

// ---------------------------------------------------------------- naming (save as / rename)
const naming = ref<'new' | 'rename' | null>(null)
const draft = ref('')
const input = ref<HTMLInputElement>()
function startNaming(mode: 'new' | 'rename'): void {
  naming.value = mode
  draft.value = mode === 'rename' ? (active.value?.name ?? '') : `${active.value?.name ?? 'Layout'} (custom)`
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}
function commitName(): void {
  const name = draft.value.trim().slice(0, 40)
  if (!name) return
  if (naming.value === 'new') {
    const id = newId('layout')
    setSettings({ layouts: [...props.settings.layouts, { id, name, root: layout.root.value }], activeLayout: id })
  } else if (naming.value === 'rename' && isUser.value) {
    setSettings({ layouts: props.settings.layouts.map((l) => (l.id === active.value!.id ? { ...l, name } : l)) })
  }
  naming.value = null
}
</script>

<template>
  <div ref="root" class="layout-menu">
    <button class="icon" title="Layout" aria-label="Layout" :aria-expanded="open" @click="open ? close() : (open = true)">▦</button>
    <div v-if="open" class="menu" role="menu">
      <div class="label">Layouts</div>
      <button v-for="l in all" :key="l.id" role="menuitemradio" :aria-checked="l.id === settings.activeLayout" class="item" @click="load(l)">
        <span><span class="mark">{{ l.id === settings.activeLayout ? '●' : '' }}</span>{{ l.name }}</span>
        <span v-if="l.id === settings.activeLayout && modified" class="badge">modified</span>
      </button>
      <div class="sep" />
      <form v-if="naming" class="row" @submit.prevent="commitName">
        <input ref="input" v-model="draft" maxlength="40" aria-label="Layout name" @keydown.esc.stop.prevent="naming = null" />
        <button class="btn" type="submit">{{ naming === 'new' ? 'Save' : 'Rename' }}</button>
      </form>
      <template v-else>
        <button role="menuitem" class="item" @click="add">Add panel</button>
        <button role="menuitem" class="item" @click="startNaming('new')">Save layout as…</button>
        <button v-if="isUser && modified" role="menuitem" class="item" @click="update">Update “{{ active!.name }}”</button>
        <button v-if="isUser" role="menuitem" class="item" @click="startNaming('rename')">Rename “{{ active!.name }}”</button>
        <button v-if="isUser" role="menuitem" class="item danger" @click="remove">Delete “{{ active!.name }}”</button>
        <button v-if="active && modified" role="menuitem" class="item" @click="revert">Revert to “{{ active.name }}”</button>
      </template>
      <p class="hint">Drag a panel's header to move it; drag the gaps to resize.</p>
    </div>
  </div>
</template>

<style scoped>
.layout-menu {
  position: relative;
  display: flex;
  align-items: center;
  padding-top: 6px;
  -webkit-app-region: no-drag;
}
.icon {
  height: 26px;
  min-width: 26px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--chrome-fg);
}
.icon:hover {
  background: var(--chrome-hover);
}
.menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 50;
  min-width: 260px;
  padding: 4px;
  background: var(--popup-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 6px;
  box-shadow: 0 8px 24px #0008;
}
.label {
  padding: 4px 10px;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--chrome-dim);
}
.item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
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
.item.danger:hover {
  color: var(--danger);
}
.mark {
  display: inline-block;
  width: 14px;
  color: var(--accent);
}
.badge {
  font-size: 11px;
  color: var(--accent);
}
.sep {
  height: 1px;
  margin: 4px 0;
  background: var(--chrome-border);
}
.row {
  display: flex;
  gap: 6px;
  padding: 4px 6px;
}
.row input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  background: var(--field-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
}
.btn {
  padding: 4px 9px;
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
  background: transparent;
}
.hint {
  margin: 6px 10px 4px;
  font-size: 12px;
  color: var(--chrome-dim);
}
</style>
