<script setup lang="ts">
import { ref } from 'vue'
import { resizeSplit, type LayoutNode } from '@shared/layout'
import { useLayout } from './context'
import PanelFrame from './PanelFrame.vue'

defineOptions({ name: 'LayoutNode' })
const props = defineProps<{ node: LayoutNode }>()
const layout = useLayout()
const el = ref<HTMLElement>()

// ---------------------------------------------------------------- resizing
// Each move recomputes from the tree as it was at pointerdown, so rounding never accumulates.
function startResize(e: PointerEvent, index: number): void {
  const node = props.node
  if (node.type !== 'split' || !el.value) return
  e.preventDefault()
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  const rect = el.value.getBoundingClientRect()
  const span = node.dir === 'row' ? rect.width : rect.height
  const start = node.dir === 'row' ? e.clientX : e.clientY
  const snapshot = layout.root.value
  const onMove = (m: PointerEvent): void => {
    const pos = node.dir === 'row' ? m.clientX : m.clientY
    layout.edit(resizeSplit(snapshot, node.id, index, (pos - start) / span))
  }
  const onUp = (): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    layout.commit()
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/** Arrow keys on a focused divider nudge it by 2%. */
function keyResize(e: KeyboardEvent, index: number): void {
  const node = props.node
  if (node.type !== 'split') return
  const back = node.dir === 'row' ? 'ArrowLeft' : 'ArrowUp'
  const fwd = node.dir === 'row' ? 'ArrowRight' : 'ArrowDown'
  if (e.key !== back && e.key !== fwd) return
  e.preventDefault()
  layout.edit(resizeSplit(layout.root.value, node.id, index, e.key === fwd ? 0.02 : -0.02), { commit: true })
}
</script>

<template>
  <PanelFrame v-if="node.type === 'panel'" :panel="node" />
  <div v-else ref="el" class="split" :class="node.dir">
    <template v-for="(child, i) in node.children" :key="child.id">
      <div class="cell" :style="{ flexGrow: node.sizes[i] }">
        <LayoutNode :node="child" />
      </div>
      <div
        v-if="i < node.children.length - 1"
        class="gutter"
        role="separator"
        tabindex="0"
        :aria-orientation="node.dir === 'row' ? 'vertical' : 'horizontal'"
        :aria-label="`Resize ${node.dir === 'row' ? 'columns' : 'rows'}`"
        @pointerdown="startResize($event, i)"
        @keydown="keyResize($event, i)"
      />
    </template>
  </div>
</template>

<style scoped>
.split {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.split.column {
  flex-direction: column;
}
.cell {
  flex-basis: 0;
  flex-shrink: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.gutter {
  flex: 0 0 6px;
  position: relative;
  background: transparent;
  outline: none;
}
.row > .gutter {
  cursor: col-resize;
}
.column > .gutter {
  cursor: row-resize;
}
/* A thin line in the middle of the grab area, brighter while hovered or focused. */
.gutter::after {
  content: '';
  position: absolute;
  background: var(--chrome-border);
}
.row > .gutter::after {
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
}
.column > .gutter::after {
  left: 0;
  right: 0;
  top: 2px;
  height: 2px;
}
.gutter:hover::after,
.gutter:focus-visible::after {
  background: var(--accent);
}
</style>
