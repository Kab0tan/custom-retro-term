<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * A <select> drawn by the page itself. Chromium draws a native <select>'s list in its own popup widget, which an
 * offscreen (webgl renderer) page can't show properly: it covered the whole window and flickered on mouse moves.
 * Parents style the root with the `.select` class, the same way they styled <select>.
 */
export interface SelectOption {
  value: string | number
  label: string
  /** Options sharing a group are listed under its heading, in order of first appearance. */
  group?: string
  disabled?: boolean
}

const props = defineProps<{ value: string | number; options: SelectOption[]; id?: string; ariaLabel?: string }>()
const emit = defineEmits<{ change: [value: string | number] }>()

const root = ref<HTMLElement>()
const list = ref<HTMLElement>()
const open = ref(false)
const highlighted = ref(-1)

const current = computed(() => props.options.find((o) => o.value === props.value))
const enabled = computed(() => props.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0))
const rows = computed(() => {
  const out: Array<{ heading: string } | { option: SelectOption; index: number }> = []
  let group: string | undefined
  props.options.forEach((option, index) => {
    if (option.group && option.group !== group) out.push({ heading: option.group })
    group = option.group
    out.push({ option, index })
  })
  return out
})

function show(): void {
  open.value = true
  highlighted.value = props.options.findIndex((o) => o.value === props.value)
  void nextTick(() => list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
}

function close(): void {
  open.value = false
  root.value?.querySelector('button')?.focus()
}

function pick(i: number): void {
  const o = props.options[i]
  if (!o || o.disabled) return
  close()
  if (o.value !== props.value) emit('change', o.value)
}

function step(dir: 1 | -1): void {
  const e = enabled.value
  if (!e.length) return
  const at = e.indexOf(highlighted.value)
  const next = e[at < 0 ? (dir > 0 ? 0 : e.length - 1) : Math.min(e.length - 1, Math.max(0, at + dir))]
  if (!open.value) return pick(next)
  highlighted.value = next
  void nextTick(() => list.value?.querySelector('.hl')?.scrollIntoView({ block: 'nearest' }))
}

function onKey(e: KeyboardEvent): void {
  const keys: Record<string, () => void> = {
    ArrowDown: () => (e.altKey && !open.value ? show() : step(1)),
    ArrowUp: () => step(-1),
    Enter: () => (open.value ? pick(highlighted.value) : show()),
    ' ': () => (open.value ? pick(highlighted.value) : show()),
    Escape: () => close(),
    Tab: () => void (open.value = false)
  }
  const fn = keys[e.key]
  if (!fn || (e.key === 'Escape' && !open.value)) return
  if (e.key !== 'Tab') {
    e.preventDefault()
    e.stopPropagation() // Escape closes the list, not the panel around it
  }
  fn()
}

const onOutside = (e: MouseEvent): void => {
  if (!root.value?.contains(e.target as Node)) open.value = false
}
watch(open, (o) => (o ? window.addEventListener('mousedown', onOutside, true) : window.removeEventListener('mousedown', onOutside, true)))
onBeforeUnmount(() => window.removeEventListener('mousedown', onOutside, true))
</script>

<template>
  <div ref="root" class="select" :class="{ open }" @keydown="onKey">
    <button
      :id="id"
      type="button"
      class="trigger"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      @click="open ? close() : show()"
    >
      <span class="label">{{ current?.label ?? '' }}</span>
      <span class="arrow" aria-hidden="true">▾</span>
    </button>
    <div v-if="open" ref="list" class="list" role="listbox" :aria-label="ariaLabel">
      <template v-for="(r, n) in rows" :key="n">
        <div v-if="'heading' in r" class="heading" role="presentation">{{ r.heading }}</div>
        <div
          v-else
          class="option"
          role="option"
          :class="{ hl: r.index === highlighted, grouped: !!r.option.group }"
          :aria-selected="r.option.value === value"
          :aria-disabled="r.option.disabled || undefined"
          @mousemove="!r.option.disabled && (highlighted = r.index)"
          @click="pick(r.index)"
        >
          {{ r.option.label }}
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.select {
  position: relative;
  display: inline-block;
}
.trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  background: none;
  border: 0;
  text-align: left;
  cursor: default;
}
.trigger:focus-visible {
  outline: none;
}
.select:focus-within {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.arrow {
  opacity: 0.7;
}
.list {
  position: absolute;
  z-index: 50;
  top: calc(100% + 2px);
  left: -1px;
  min-width: calc(100% + 2px);
  max-height: 280px;
  overflow-y: auto;
  padding: 3px 0;
  background: var(--popup-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.5);
}
.heading {
  padding: 4px 8px 2px;
  opacity: 0.6;
  font-size: 0.85em;
}
.option {
  padding: 3px 8px;
  white-space: nowrap;
}
.option.grouped {
  padding-left: 16px;
}
.option.hl {
  background: var(--chrome-hover);
}
.option[aria-selected='true'] {
  color: var(--accent);
}
.option[aria-disabled] {
  opacity: 0.5;
}
</style>
