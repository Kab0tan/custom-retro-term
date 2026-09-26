<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{ result: { index: number; count: number } | null }>()
const emit = defineEmits<{
  find: [query: string, dir: 1 | -1, opts: { caseSensitive: boolean; regex: boolean }, incremental: boolean]
  close: []
}>()

const query = ref('')
const caseSensitive = ref(false)
const regex = ref(false)
const input = ref<HTMLInputElement>()

const opts = (): { caseSensitive: boolean; regex: boolean } => ({ caseSensitive: caseSensitive.value, regex: regex.value })
const run = (dir: 1 | -1, incremental = false): void => emit('find', query.value, dir, opts(), incremental)

watch([query, caseSensitive, regex], () => run(1, true))

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    run(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function focus(): void {
  input.value?.focus()
  input.value?.select()
}
onMounted(() => nextTick(focus))
defineExpose({ focus })

const status = (): string => {
  const r = props.result
  if (!query.value || !r) return ''
  if (r.count === 0) return 'No results'
  return r.index >= 0 ? `${r.index + 1} of ${r.count}` : `${r.count}+`
}
</script>

<template>
  <div class="search" @keydown="onKey">
    <input ref="input" v-model="query" placeholder="Find" spellcheck="false" aria-label="Find in terminal" />
    <span class="status">{{ status() }}</span>
    <button :class="{ on: caseSensitive }" title="Match case" @click="caseSensitive = !caseSensitive">Aa</button>
    <button :class="{ on: regex }" title="Regular expression" @click="regex = !regex">.*</button>
    <button title="Previous (Shift+Enter)" @click="run(-1)">↑</button>
    <button title="Next (Enter)" @click="run(1)">↓</button>
    <button title="Close (Esc)" @click="emit('close')">✕</button>
  </div>
</template>

<style scoped>
.search {
  position: absolute;
  top: 8px;
  right: 22px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: var(--popup-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 6px;
  box-shadow: 0 6px 18px #0008;
}
input {
  width: 220px;
  padding: 4px 8px;
  background: var(--field-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
  outline: none;
}
input:focus {
  border-color: var(--accent);
}
.status {
  min-width: 70px;
  padding: 0 6px;
  color: var(--chrome-dim);
  font-size: 12px;
  text-align: right;
}
button {
  min-width: 26px;
  height: 26px;
  border: 0;
  border-radius: 4px;
  background: transparent;
}
button:hover {
  background: var(--chrome-hover);
}
button.on {
  background: #4d9fff33;
  color: #fff;
}
</style>
