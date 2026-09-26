<script setup lang="ts">
import { computed, ref } from 'vue'
import { coerceSetting, PLUGIN_ID, resolveSettings, type CatalogEntry, type InstallResult, type PluginInfo, type PluginSettingSpec } from '@shared/plugins'
import type { Settings } from '@shared/settings'
import { setSettings } from '../settingsWriter'
import { isEnabled, pluginFolder, pluginList, rescanPlugins } from './store'

// Settings → Plugins: install/create, developer mode, catalog, and one card per plugin.
const props = defineProps<{ settings: Settings }>()
const api = window.crt.plugins

// ---------------------------------------------------------------- per-plugin prefs
function patchPlugin(id: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }): void {
  const prefs = props.settings.plugins[id] ?? {}
  setSettings({ plugins: { ...props.settings.plugins, [id]: { ...prefs, ...patch } } })
}
const values = (p: PluginInfo): Record<string, unknown> => resolveSettings(p.manifest!, props.settings.plugins[p.id]?.settings)
function setValue(p: PluginInfo, spec: PluginSettingSpec, raw: unknown): void {
  patchPlugin(p.id, { settings: { ...props.settings.plugins[p.id]?.settings, [spec.key]: coerceSetting(spec, raw) } })
}
const resetValues = (p: PluginInfo): void => patchPlugin(p.id, { settings: {} })
const inputValue = (e: Event): string => (e.target as HTMLInputElement | HTMLSelectElement).value

// ---------------------------------------------------------------- install / create
const busy = ref(false)
const result = ref<InstallResult | null>(null)
async function run(p: Promise<InstallResult>): Promise<void> {
  busy.value = true
  result.value = null
  try {
    const r = await p
    if (r.message !== 'Cancelled.') result.value = r
  } finally {
    busy.value = false
  }
}

async function installFrom(kind: 'folder' | 'zip'): Promise<void> {
  const path = await api.pickSource(kind)
  if (path) await run(api.install({ kind, path }))
}

const gitOpen = ref(false)
const gitUrl = ref('')
async function installGit(): Promise<void> {
  if (!gitUrl.value.trim()) return
  await run(api.install({ kind: 'git', url: gitUrl.value.trim() }))
  if (result.value?.ok) {
    gitOpen.value = false
    gitUrl.value = ''
  }
}

const createOpen = ref(false)
const newName = ref('')
const newId = computed(() =>
  newName.value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
)
async function create(): Promise<void> {
  if (!PLUGIN_ID.test(newId.value)) return
  await run(api.create(newId.value, newName.value))
  if (result.value?.ok) {
    createOpen.value = false
    void api.openFolder(newId.value)
    newName.value = ''
  }
}

const uninstall = (p: PluginInfo): Promise<void> => run(api.uninstall(p.id))

// ---------------------------------------------------------------- developer mode
async function addLink(): Promise<void> {
  const path = await api.pickSource('folder')
  if (path && !props.settings.pluginLinks.includes(path)) setSettings({ pluginLinks: [...props.settings.pluginLinks, path] })
}
const removeLink = (path: string): void => setSettings({ pluginLinks: props.settings.pluginLinks.filter((p) => p !== path) })

// ---------------------------------------------------------------- catalog
const catalog = ref<CatalogEntry[] | null>(null)
const catalogError = ref('')
async function loadCatalog(): Promise<void> {
  catalogError.value = ''
  const r = await api.catalog()
  catalog.value = r.entries
  catalogError.value = r.error ?? (r.entries.length ? '' : 'The catalog is empty.')
}
const installed = (id: string): boolean => pluginList.value.some((p) => p.id === id)
</script>

<template>
  <div class="plugins">
    <div class="bar wrap">
      <button class="btn" :disabled="busy" @click="installFrom('folder')">Install from folder…</button>
      <button class="btn" :disabled="busy" @click="installFrom('zip')">Install from zip…</button>
      <button class="btn" :disabled="busy" @click="gitOpen = !gitOpen">Install from Git…</button>
      <button class="btn" :disabled="busy" @click="createOpen = !createOpen">New plugin…</button>
    </div>
    <form v-if="gitOpen" class="bar" @submit.prevent="installGit">
      <input v-model="gitUrl" class="grow" placeholder="https://github.com/someone/crt-plugin-weather.git" spellcheck="false" aria-label="Git repository URL" />
      <button class="btn" type="submit" :disabled="busy">{{ busy ? 'Cloning…' : 'Install' }}</button>
    </form>
    <form v-if="createOpen" class="bar" @submit.prevent="create">
      <input v-model="newName" class="grow" placeholder="Plugin name, e.g. Weather" maxlength="40" aria-label="New plugin name" />
      <span class="dim small">id: {{ newId || '…' }}</span>
      <button class="btn" type="submit" :disabled="busy || !newId">Create</button>
    </form>
    <p v-if="result" :class="result.ok ? 'okmsg' : 'warn'" role="status">{{ result.message }}</p>

    <div class="bar">
      <button class="btn" @click="api.openFolder()">Open plugins folder</button>
      <button class="btn" @click="rescanPlugins">Rescan</button>
      <span class="dim path" :title="pluginFolder">{{ pluginFolder }}</span>
    </div>
    <label class="check">
      <input type="checkbox" :checked="settings.audioCapture" @change="setSettings({ audioCapture: !settings.audioCapture })" />
      Allow plugins to analyse system audio <span class="dim">(analysed live, never recorded)</span>
    </label>
    <label class="check">
      Plugin animation
      <select :value="settings.pluginFps" @change="setSettings({ pluginFps: Number(inputValue($event)) as Settings['pluginFps'] })">
        <option :value="30">30 fps (lighter)</option>
        <option :value="60">60 fps</option>
      </select>
    </label>

    <details class="section" :open="settings.pluginDevMode">
      <summary>Developer mode</summary>
      <label class="check">
        <input type="checkbox" :checked="settings.pluginDevMode" @change="setSettings({ pluginDevMode: !settings.pluginDevMode })" />
        Developer mode <span class="dim">(linked folders, stack traces, ↻ reload on panels)</span>
      </label>
      <template v-if="settings.pluginDevMode">
        <p class="dim small">
          Linked folders are used in place and reload on every save. A linked plugin replaces an installed one with the same id.
          Plugin consoles are in DevTools (Ctrl+Shift+F12).
        </p>
        <ul class="links">
          <li v-for="path in settings.pluginLinks" :key="path">
            <span class="path" :title="path">{{ path }}</span>
            <button class="btn small" @click="removeLink(path)">Unlink</button>
          </li>
        </ul>
        <button class="btn small" @click="addLink">Link a folder…</button>
      </template>
    </details>

    <details class="section">
      <summary>Community catalog</summary>
      <p class="dim small">An HTTPS URL of a JSON list of plugins, e.g. a <code>catalog.json</code> in a GitHub repository (raw URL).</p>
      <div class="bar">
        <input
          class="grow"
          :value="settings.pluginCatalogUrl"
          placeholder="https://raw.githubusercontent.com/…/catalog.json"
          spellcheck="false"
          aria-label="Catalog URL"
          @change="setSettings({ pluginCatalogUrl: inputValue($event).trim() })"
        />
        <button class="btn" :disabled="!settings.pluginCatalogUrl" @click="loadCatalog">Browse</button>
      </div>
      <p v-if="catalogError" class="warn">{{ catalogError }}</p>
      <ul v-if="catalog?.length" class="catalog">
        <li v-for="e in catalog" :key="e.id">
          <div>
            <strong>{{ e.name }}</strong>
            <span class="dim"> {{ e.version ? `v${e.version}` : '' }}{{ e.author ? ` · ${e.author}` : '' }}</span>
            <p v-if="e.description" class="dim small">{{ e.description }}</p>
          </div>
          <button class="btn small" :disabled="busy" @click="run(api.install({ kind: 'git', url: e.repo }))">{{ installed(e.id) ? 'Update' : 'Install' }}</button>
        </li>
      </ul>
    </details>

    <p v-if="!pluginList.length" class="dim">No plugins installed.</p>
    <article v-for="p in pluginList" :key="p.id" class="card" :class="{ off: p.manifest && !isEnabled(settings, p.id) }">
      <header>
        <div>
          <strong>{{ p.manifest?.name ?? p.id }}</strong>
          <span class="dim">
            {{ p.manifest ? ` v${p.manifest.version} · API v${p.manifest.apiVersion}` : '' }} · {{ p.id }}
            <template v-if="p.bundled"> · bundled</template><template v-if="p.linked"> · linked</template>
          </span>
        </div>
        <label v-if="p.manifest" class="check">
          <input type="checkbox" :checked="isEnabled(settings, p.id)" @change="patchPlugin(p.id, { enabled: !isEnabled(settings, p.id) })" /> Enabled
        </label>
      </header>
      <p v-if="p.error" class="warn">This plugin {{ p.error.startsWith('needs') || p.error.startsWith('was') ? p.error : `can't load: ${p.error}` }}</p>
      <template v-if="p.manifest">
        <p v-if="p.manifest.description" class="dim small">{{ p.manifest.description }}</p>
        <p class="dim small">
          Data: {{ p.manifest.data.join(', ') || 'none' }}<template v-if="p.manifest.network.length"> · Network: {{ p.manifest.network.join(', ') }}</template>
        </p>
        <div v-if="p.manifest.settings.length && isEnabled(settings, p.id)" class="fields">
          <template v-for="spec in p.manifest.settings" :key="spec.key">
            <label :for="`pl-${p.id}-${spec.key}`">{{ spec.label }}</label>
            <div class="field">
              <template v-if="spec.type === 'number'">
                <input
                  :id="`pl-${p.id}-${spec.key}`"
                  type="range"
                  :min="spec.min"
                  :max="spec.max"
                  :step="spec.step ?? (spec.max - spec.min) / 100"
                  :value="values(p)[spec.key] as number"
                  @change="setValue(p, spec, Number(inputValue($event)))"
                />
                <span class="val">{{ values(p)[spec.key] }}</span>
              </template>
              <input
                v-else-if="spec.type === 'boolean'"
                :id="`pl-${p.id}-${spec.key}`"
                type="checkbox"
                :checked="values(p)[spec.key] as boolean"
                @change="setValue(p, spec, !values(p)[spec.key])"
              />
              <select v-else :id="`pl-${p.id}-${spec.key}`" :value="values(p)[spec.key] as string" @change="setValue(p, spec, inputValue($event))">
                <option v-for="o in spec.options" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
          </template>
        </div>
      </template>
      <div class="bar actions">
        <button class="btn small" @click="api.openFolder(p.id)">Open folder</button>
        <button v-if="p.manifest?.settings.length" class="btn small" @click="resetValues(p)">Reset settings</button>
        <button v-if="!p.linked" class="btn small danger" :disabled="busy" @click="uninstall(p)">Remove</button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.plugins {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.bar.wrap {
  flex-wrap: wrap;
}
.grow {
  flex: 1;
  min-width: 0;
}
input:not([type='checkbox']):not([type='range']),
select {
  padding: 4px 8px;
  background: var(--field-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
}
.path {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
}
.section {
  padding: 6px 10px;
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
}
.section summary {
  cursor: pointer;
  color: var(--chrome-fg);
}
.section > * + * {
  margin-top: 6px;
}
.links,
.catalog {
  margin: 0;
  padding: 0;
  list-style: none;
}
.links li,
.catalog li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
}
.card {
  padding: 8px 10px;
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
}
.card.off {
  opacity: 0.7;
}
.card header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}
.fields {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 6px 12px;
  align-items: center;
  margin-top: 8px;
}
.field {
  display: flex;
  gap: 8px;
  align-items: center;
  max-width: 300px;
}
.field input[type='range'] {
  flex: 1;
  accent-color: var(--accent);
}
.val {
  width: 40px;
  text-align: right;
  color: var(--chrome-dim);
  font-variant-numeric: tabular-nums;
}
.actions {
  margin-top: 8px;
}
.btn {
  padding: 3px 10px;
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
  background: transparent;
  white-space: nowrap;
}
.btn.small {
  padding: 2px 8px;
  font-size: 12px;
}
.btn:hover:not(:disabled) {
  background: var(--chrome-hover);
}
.btn.danger:hover:not(:disabled) {
  border-color: var(--danger);
}
.btn:disabled {
  opacity: 0.5;
}
.dim {
  color: var(--chrome-dim);
}
.small {
  margin: 2px 0 0;
  font-size: 12px;
}
.warn {
  margin: 2px 0 0;
  color: #f9c74f;
  font-size: 12px;
}
.okmsg {
  margin: 2px 0 0;
  color: var(--accent);
  font-size: 12px;
}
code {
  font-family: 'IBM Plex Mono', monospace;
}
</style>
