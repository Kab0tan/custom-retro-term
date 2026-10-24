<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { PHOSPHOR_IDS, PHOSPHORS, type PhosphorId } from '@shared/phosphor'
import { EFFECT_KEYS, type ColorScheme, type CrtSettings, type EffectKey, type Settings } from '@shared/settings'
import SelectMenu, { type SelectOption } from './SelectMenu.vue'
import { allPresets, applyPreset, BUILTIN_PRESETS, captureLook, isBuiltIn, matchesPreset } from '@shared/presets'
import { setCrt, setSettings } from '../settingsWriter'

// Live look editor, docked beside the terminal so every change is visible as it happens.
// Everything here is saved to settings.json immediately and survives a restart.
const props = defineProps<{ settings: Settings; activeRenderer: 'webgl' | 'css' }>()
const emit = defineEmits<{ close: [] }>()

const EFFECT_LABELS: Record<EffectKey, string> = {
  curvature: 'Curvature',
  scanlines: 'Scanlines',
  bloom: 'Bloom',
  glow: 'Glow',
  vignette: 'Vignette',
  rgbShift: 'Colour fringing',
  flicker: 'Flicker',
  noise: 'Noise',
  burnIn: 'Burn-in'
}
/** What the CSS overlay renderer can show; the rest needs the WebGL renderer. */
const CSS_EFFECTS: EffectKey[] = ['scanlines', 'vignette', 'bloom', 'flicker']
const supported = (k: EffectKey): boolean => props.activeRenderer === 'webgl' || CSS_EFFECTS.includes(k)

const crt = computed(() => props.settings.crt)
const num = (e: Event): number => Number((e.target as HTMLInputElement).value)
const patchCrt = (patch: Partial<CrtSettings>): void => setCrt(patch)

function toggleEffect(k: EffectKey): void {
  const off = new Set(crt.value.effectsOff)
  if (off.has(k)) off.delete(k)
  else off.add(k)
  patchCrt({ effectsOff: [...off] })
}

// ---------------------------------------------------------------- phosphor
const setPhosphor = (id: PhosphorId): void => setSettings({ phosphor: id })
const setScheme = (scheme: ColorScheme): void => setSettings({ colorScheme: scheme })

// ---------------------------------------------------------------- presets
const presets = computed(() => allPresets(props.settings))
const presetOptions = computed((): SelectOption[] => [
  ...(active.value ? [] : [{ value: '', label: 'Custom', disabled: true }]),
  ...BUILTIN_PRESETS.map((p) => ({ value: p.id, label: p.name, group: 'Built-in' })),
  ...props.settings.presets.map((p) => ({ value: p.id, label: p.name, group: 'My presets' }))
])
const active = computed(() => presets.value.find((p) => p.id === props.settings.activePreset) ?? null)
const modified = computed(() => !active.value || !matchesPreset(props.settings, active.value))
const activeIsUser = computed(() => !!active.value && !isBuiltIn(active.value.id))

function pickPreset(id: string): void {
  const p = presets.value.find((x) => x.id === id)
  if (p) setSettings(applyPreset(props.settings, p))
}

/** Inline name editor, used for "Save as new" and "Rename". */
const naming = ref<'new' | 'rename' | null>(null)
const nameDraft = ref('')
const nameInput = ref<HTMLInputElement>()

function startNaming(mode: 'new' | 'rename'): void {
  naming.value = mode
  nameDraft.value = mode === 'rename' ? (active.value?.name ?? '') : `${active.value?.name ?? 'My look'} (custom)`
  nextTick(() => {
    nameInput.value?.focus()
    nameInput.value?.select()
  })
}

function commitName(): void {
  const name = nameDraft.value.trim()
  if (!name) return
  if (naming.value === 'new') {
    const id = `user-${Date.now().toString(36)}`
    setSettings({ presets: [...props.settings.presets, captureLook(props.settings, id, name)], activePreset: id })
  } else if (naming.value === 'rename' && activeIsUser.value) {
    setSettings({ presets: props.settings.presets.map((p) => (p.id === active.value!.id ? { ...p, name } : p)) })
  }
  naming.value = null
}

function updateActive(): void {
  const a = active.value
  if (!a || isBuiltIn(a.id)) return
  setSettings({ presets: props.settings.presets.map((p) => (p.id === a.id ? captureLook(props.settings, a.id, a.name) : p)) })
}

function deleteActive(): void {
  const a = active.value
  if (!a || isBuiltIn(a.id)) return
  // Keep the current look; just forget the preset.
  setSettings({ presets: props.settings.presets.filter((p) => p.id !== a.id), activePreset: BUILTIN_PRESETS[0].id })
}

const revert = (): void => {
  if (active.value) setSettings(applyPreset(props.settings, active.value))
}
</script>

<template>
  <aside class="tweaks" aria-label="Tweaks" @keydown.esc.prevent="emit('close')">
    <header>
      <h1>Tweaks</h1>
      <button class="x" aria-label="Close tweaks" title="Close (Ctrl+Shift+E)" @click="emit('close')">✕</button>
    </header>

    <section>
      <h2>Preset</h2>
      <div class="row">
        <SelectMenu :value="active ? settings.activePreset : ''" :options="presetOptions" aria-label="Preset" @change="pickPreset(String($event))" />
        <span v-if="modified" class="badge" title="The current look differs from this preset">modified</span>
      </div>

      <form v-if="naming" class="row" @submit.prevent="commitName">
        <input ref="nameInput" v-model="nameDraft" maxlength="40" aria-label="Preset name" @keydown.esc.stop.prevent="naming = null" />
        <button class="btn" type="submit">{{ naming === 'new' ? 'Save' : 'Rename' }}</button>
        <button class="btn" type="button" @click="naming = null">Cancel</button>
      </form>
      <div v-else class="row wrap">
        <button class="btn" @click="startNaming('new')">Save as new…</button>
        <button v-if="activeIsUser && modified" class="btn" @click="updateActive">Update “{{ active!.name }}”</button>
        <button v-if="activeIsUser" class="btn" @click="startNaming('rename')">Rename</button>
        <button v-if="activeIsUser" class="btn danger" @click="deleteActive">Delete</button>
        <button v-if="active && modified" class="btn" @click="revert">Revert</button>
      </div>
    </section>

    <section>
      <h2>Phosphor</h2>
      <div class="swatches" role="radiogroup" aria-label="Phosphor colour">
        <button
          v-for="id in PHOSPHOR_IDS"
          :key="id"
          role="radio"
          :aria-checked="settings.phosphor === id"
          class="swatch"
          :class="{ on: settings.phosphor === id }"
          :style="{ '--sw': PHOSPHORS[id].base, '--sw-bg': PHOSPHORS[id].background }"
          @click="setPhosphor(id)"
        >
          <span class="dot" />{{ PHOSPHORS[id].name }}
        </button>
      </div>
      <div class="segmented" role="radiogroup" aria-label="Terminal colours">
        <button role="radio" :aria-checked="settings.colorScheme === 'phosphor'" :class="{ on: settings.colorScheme === 'phosphor' }" @click="setScheme('phosphor')">Phosphor palette</button>
        <button role="radio" :aria-checked="settings.colorScheme === 'campbell'" :class="{ on: settings.colorScheme === 'campbell' }" @click="setScheme('campbell')">Campbell</button>
      </div>
      <div class="slider-row">
        <label for="tw-chroma">Colour</label>
        <input id="tw-chroma" type="range" min="0" max="1" step="0.01" :value="crt.chroma" :disabled="!crt.enabled || activeRenderer === 'css'" @input="patchCrt({ chroma: num($event) })" />
        <span class="val">{{ Math.round(crt.chroma * 100) }}</span>
      </div>
      <p class="hint">Colour 0 = pure monochrome phosphor, 100 = full terminal colours.</p>
    </section>

    <section>
      <div class="row between">
        <h2>Effects</h2>
        <label class="switch"><input type="checkbox" :checked="crt.enabled" @change="patchCrt({ enabled: !crt.enabled })" /> CRT on</label>
      </div>
      <div v-for="k in EFFECT_KEYS" :key="k" class="slider-row" :class="{ muted: !crt.enabled || crt.effectsOff.includes(k) || !supported(k) }">
        <input
          type="checkbox"
          :checked="!crt.effectsOff.includes(k)"
          :disabled="!crt.enabled || !supported(k)"
          :aria-label="`${EFFECT_LABELS[k]} on`"
          @change="toggleEffect(k)"
        />
        <label :for="`tw-${k}`">{{ EFFECT_LABELS[k] }}</label>
        <input
          :id="`tw-${k}`"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="crt[k]"
          :disabled="!crt.enabled || crt.effectsOff.includes(k) || !supported(k)"
          @input="patchCrt({ [k]: num($event) })"
        />
        <span class="val">{{ Math.round(crt[k] * 100) }}</span>
      </div>
      <div class="slider-row" :class="{ muted: !crt.enabled }">
        <span />
        <label for="tw-bright">Brightness</label>
        <input id="tw-bright" type="range" min="0.5" max="1.5" step="0.01" :value="crt.brightness" :disabled="!crt.enabled || activeRenderer === 'css'" @input="patchCrt({ brightness: num($event) })" />
        <span class="val">{{ Math.round(crt.brightness * 100) }}</span>
      </div>
      <p v-if="activeRenderer === 'css'" class="hint">Greyed-out effects need the WebGL renderer (Settings → Rendering).</p>
    </section>

    <footer class="hint">Changes apply live and are saved automatically.</footer>
  </aside>
</template>

<style scoped>
.tweaks {
  width: 320px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--panel-bg);
  border-left: 1px solid var(--chrome-border);
  padding: 0 14px 14px;
}
header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0 8px;
  background: var(--panel-bg);
}
h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h2 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--chrome-dim);
}
section {
  padding: 12px 0;
  border-top: 1px solid var(--chrome-border);
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}
.row.wrap {
  flex-wrap: wrap;
}
.row.between {
  justify-content: space-between;
}
.row.between h2 {
  margin: 0;
}
.select,
input:not([type='checkbox']):not([type='range']) {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  background: var(--field-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
}
.badge {
  padding: 1px 6px;
  border: 1px solid var(--chrome-border);
  border-radius: 3px;
  color: var(--accent);
  font-size: 11px;
}
.btn,
.x {
  padding: 4px 9px;
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
  background: transparent;
  white-space: nowrap;
}
.x {
  border-color: transparent;
}
.btn:hover,
.x:hover {
  background: var(--chrome-hover);
}
.btn.danger:hover {
  border-color: var(--danger);
}
.swatches {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-bottom: 8px;
}
.swatch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
  background: var(--sw-bg);
  color: var(--sw);
}
.swatch.on {
  border-color: var(--sw);
  box-shadow: 0 0 8px color-mix(in srgb, var(--sw) 45%, transparent);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--sw);
  box-shadow: 0 0 6px var(--sw);
}
.segmented {
  display: flex;
  margin-bottom: 10px;
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
  overflow: hidden;
}
.segmented button {
  flex: 1;
  padding: 5px;
  border: 0;
  background: transparent;
}
.segmented button.on {
  background: var(--chrome-hover);
  color: var(--accent);
}
.slider-row {
  display: grid;
  grid-template-columns: 18px 96px 1fr 30px;
  gap: 6px;
  align-items: center;
  margin: 5px 0;
}
section:nth-of-type(2) .slider-row {
  grid-template-columns: 96px 1fr 30px;
}
.slider-row.muted label,
.slider-row.muted .val {
  opacity: 0.45;
}
input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}
input[type='checkbox'] {
  accent-color: var(--accent);
}
.val {
  text-align: right;
  color: var(--chrome-dim);
  font-variant-numeric: tabular-nums;
}
.switch {
  display: flex;
  gap: 6px;
  align-items: center;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--chrome-dim);
}
footer {
  padding-top: 10px;
  border-top: 1px solid var(--chrome-border);
}
</style>
