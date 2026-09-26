import { shallowRef } from 'vue'
import type { PluginInfo, PluginManifest } from '@shared/plugins'
import type { Settings } from '@shared/settings'

/** Installed plugins, kept in sync with the plugins folder (main watches it). */
export const pluginList = shallowRef<PluginInfo[]>([])
export const pluginFolder = shallowRef('')

async function load(): Promise<void> {
  const r = await window.crt.plugins.list()
  pluginList.value = r.plugins
  pluginFolder.value = r.folder
}
void load()
window.crt.plugins.onChanged(() => void load())

export async function rescanPlugins(): Promise<void> {
  const r = await window.crt.plugins.rescan()
  pluginList.value = r.plugins
}

export const findPlugin = (id: string): PluginInfo | undefined => pluginList.value.find((p) => p.id === id)

export const isEnabled = (s: Settings, id: string): boolean => s.plugins[id]?.enabled !== false

/** Valid, enabled plugins, for the "connect a slot" picker. */
export function usablePlugins(s: Settings): PluginManifest[] {
  return pluginList.value.filter((p) => p.manifest && isEnabled(s, p.id)).map((p) => p.manifest!)
}
