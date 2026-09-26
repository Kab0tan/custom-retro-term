<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { BUNDLED_FONTS, type CrtSettings, type Settings, type ShellProfile } from '@shared/settings'
import { isFontInstalled } from '../theme'
import { setCrt, setSettings } from '../settingsWriter'
import PluginSettings from '../plugins/PluginSettings.vue'

const props = defineProps<{
  settings: Settings
  profiles: ShellProfile[]
  defaultId: string
  /** Renderer this window is running with (changing it needs a restart). */
  activeRenderer: 'webgl' | 'css'
}>()
const emit = defineEmits<{ close: []; tweaks: [] }>()

const set = setSettings
const openFile = (): void => void window.crt.settings.openFile()
const num = (e: Event): number => Number((e.target as HTMLInputElement).value)

const relaunch = (): void => void window.crt.relaunch()

const update = ref<{ version: string; status: string; enabled: boolean } | null>(null)
void window.crt.updates.status().then((u) => (update.value = u))
const checking = ref(false)
async function checkUpdates(): Promise<void> {
  checking.value = true
  update.value = await window.crt.updates.check()
  checking.value = false
}

const FONT_SUGGESTIONS = [
  ...BUNDLED_FONTS,
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'Lucida Console',
  'Courier New',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'CaskaydiaCove Nerd Font',
  'JetBrainsMono Nerd Font'
]
const fontInstalled = computed(() => isFontInstalled(props.settings.fontFamily))
const rendererPending = computed(() => props.settings.crt.renderer !== props.activeRenderer)

const root = ref<HTMLElement>()
onMounted(() => root.value?.querySelector<HTMLElement>('select, input')?.focus())
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')" @keydown.esc.prevent="emit('close')">
    <section ref="root" class="panel" role="dialog" aria-label="Settings">
      <header>
        <h1>Settings</h1>
        <button class="x" aria-label="Close settings" @click="emit('close')">✕</button>
      </header>

      <div class="grid">
        <h2>Startup</h2>
        <label for="s-shell">Default shell</label>
        <select id="s-shell" :value="defaultId" @change="set({ defaultProfile: ($event.target as HTMLSelectElement).value })">
          <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>

        <h2>Appearance</h2>
        <label>Look</label>
        <div><button class="btn" @click="emit('tweaks')">Open Tweaks: phosphor, effects, presets</button> <span class="dim small">Ctrl+Shift+E</span></div>
        <label for="s-font">Font</label>
        <div>
          <input
            id="s-font"
            list="font-list"
            :value="settings.fontFamily"
            spellcheck="false"
            @change="set({ fontFamily: ($event.target as HTMLInputElement).value.trim() || BUNDLED_FONTS[0] })"
          />
          <datalist id="font-list"><option v-for="f in FONT_SUGGESTIONS" :key="f" :value="f" /></datalist>
          <p v-if="BUNDLED_FONTS.includes(settings.fontFamily)" class="dim small">Bundled with the app.<template v-if="settings.fontFamily === 'VT323'"> Best at size 20 or more.</template></p>
          <p v-else-if="!fontInstalled" class="warn">Not installed. Falling back to IBM Plex Mono.</p>
        </div>
        <label for="s-size">Font size</label>
        <input id="s-size" type="number" min="6" max="72" :value="settings.fontSize" @change="set({ fontSize: num($event) })" />
        <label for="s-lh">Line height</label>
        <input id="s-lh" type="number" min="1" max="3" step="0.05" :value="settings.lineHeight" @change="set({ lineHeight: num($event) })" />
        <label for="s-cursor">Cursor</label>
        <div class="row">
          <select id="s-cursor" :value="settings.cursorStyle" @change="set({ cursorStyle: ($event.target as HTMLSelectElement).value as Settings['cursorStyle'] })">
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
          <label class="check"><input type="checkbox" :checked="settings.cursorBlink" @change="set({ cursorBlink: !settings.cursorBlink })" /> Blink</label>
        </div>

        <h2>Rendering</h2>
        <label for="crt-fps">Frame rate</label>
        <div class="row">
          <select id="crt-fps" :value="settings.crt.fpsCap" @change="setCrt({ fpsCap: num($event) as CrtSettings['fpsCap'] })">
            <option :value="30">30 fps (lighter)</option>
            <option :value="60">60 fps</option>
            <option :value="120">120 fps</option>
          </select>
          <label class="check"><input type="checkbox" :checked="settings.crt.pauseWhenUnfocused" @change="setCrt({ pauseWhenUnfocused: !settings.crt.pauseWhenUnfocused })" /> Pause animation when unfocused</label>
        </div>
        <label for="crt-renderer">Renderer</label>
        <div>
          <select id="crt-renderer" :value="settings.crt.renderer" @change="setCrt({ renderer: ($event.target as HTMLSelectElement).value as CrtSettings['renderer'] })">
            <option value="webgl">WebGL: full effect</option>
            <option value="css">CSS overlay: best compatibility (IME, screen readers)</option>
          </select>
          <p v-if="rendererPending" class="warn">
            Applies after a restart, which closes all open tabs.
            <button class="btn inline" @click="relaunch">Restart now</button>
          </p>
        </div>

        <h2>Scrollback</h2>
        <label for="s-sb">Lines kept</label>
        <input id="s-sb" type="number" min="0" max="1000000" step="1000" :value="settings.scrollback" @change="set({ scrollback: num($event) })" />

        <h2>Clipboard</h2>
        <span />
        <div class="checks">
          <label class="check"><input type="checkbox" :checked="settings.ctrlCCopiesSelection" @change="set({ ctrlCCopiesSelection: !settings.ctrlCCopiesSelection })" /> Ctrl+C copies when text is selected</label>
          <label class="check"><input type="checkbox" :checked="settings.ctrlVPastes" @change="set({ ctrlVPastes: !settings.ctrlVPastes })" /> Ctrl+V pastes <span class="dim">(off: Ctrl+V goes to the shell, e.g. vim block select)</span></label>
          <label class="check"><input type="checkbox" :checked="settings.copyOnSelect" @change="set({ copyOnSelect: !settings.copyOnSelect })" /> Copy on select</label>
          <label class="check"><input type="checkbox" :checked="settings.rightClick === 'copyPaste'" @change="set({ rightClick: settings.rightClick === 'copyPaste' ? 'none' : 'copyPaste' })" /> Right-click copies the selection, or pastes</label>
          <label class="check"><input type="checkbox" :checked="settings.warnOnMultilinePaste" @change="set({ warnOnMultilinePaste: !settings.warnOnMultilinePaste })" /> Warn before pasting several lines</label>
        </div>

        <h2>Plugins</h2>
        <div class="span"><PluginSettings :settings="settings" /></div>

        <h2>Updates</h2>
        <label>Version</label>
        <div class="row">
          <span>{{ update?.version ?? '…' }}</span>
          <span class="dim small">{{ update?.status }}</span>
        </div>
        <span />
        <div class="checks">
          <label class="check"><input type="checkbox" :checked="settings.autoUpdate" @change="set({ autoUpdate: !settings.autoUpdate })" /> Download updates automatically</label>
          <div><button class="btn" :disabled="!update?.enabled || checking" @click="checkUpdates">{{ checking ? 'Checking…' : 'Check now' }}</button></div>
        </div>

        <h2>Advanced</h2>
        <span />
        <div class="checks">
          <label class="check"><input type="checkbox" :checked="settings.confirmCloseMultipleTabs" @change="set({ confirmCloseMultipleTabs: !settings.confirmCloseMultipleTabs })" /> Confirm before closing a window with several tabs</label>
          <label class="check"><input type="checkbox" :checked="settings.forceUtf8" @change="set({ forceUtf8: !settings.forceUtf8 })" /> Use UTF-8 in PowerShell and cmd <span class="dim">(new tabs)</span></label>
          <label class="check"><input type="checkbox" :checked="settings.useBundledConpty" @change="set({ useBundledConpty: !settings.useBundledConpty })" /> Use bundled ConPTY <span class="dim">(experimental, new tabs)</span></label>
        </div>
      </div>

      <footer>
        <span class="dim">Custom shells: add them to <code>customProfiles</code> in settings.json.</span>
        <button class="btn" @click="openFile">Open settings.json</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: var(--titlebar-h) 0 0 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: #0009;
}
.panel {
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100vh - var(--titlebar-h) - 32px);
  overflow: auto;
  background: var(--panel-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 8px;
  box-shadow: 0 16px 40px #000a;
}
header,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
}
footer {
  border-top: 1px solid var(--chrome-border);
}
h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
h2 {
  grid-column: 1 / -1;
  margin: 14px 0 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--chrome-dim);
}
.grid {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 8px 14px;
  align-items: center;
  padding: 0 18px 16px;
}
input:not([type='checkbox']),
select {
  width: 100%;
  max-width: 320px;
  padding: 5px 8px;
  background: var(--field-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 4px;
}
.row {
  display: flex;
  gap: 16px;
  align-items: center;
}
.row select {
  width: auto;
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.check {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.span {
  grid-column: 1 / -1;
}
.slider {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 320px;
}
.slider input {
  flex: 1;
  accent-color: var(--accent);
}
.val {
  width: 32px;
  text-align: right;
  color: var(--chrome-dim);
  font-variant-numeric: tabular-nums;
}
.small {
  margin: 4px 0 0;
  font-size: 12px;
}
.btn.inline {
  margin-left: 8px;
  padding: 2px 8px;
}
.warn {
  margin: 4px 0 0;
  color: #f9c74f;
  font-size: 12px;
}
.dim {
  color: var(--chrome-dim);
}
code {
  font-family: 'Cascadia Mono', Consolas, monospace;
}
.x,
.btn {
  border: 1px solid transparent;
  background: transparent;
  border-radius: 4px;
  padding: 4px 10px;
}
.btn {
  border-color: var(--chrome-border);
  white-space: nowrap;
}
.x:hover,
.btn:hover {
  background: var(--chrome-hover);
}
@media (max-width: 520px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
