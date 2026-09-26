/**
 * Plugin contract (API v1), the part shared by main (validation) and the UI (hosting).
 * The author-facing side is plugin-runtime/crt-plugin.d.ts; the guide is docs/plugin-api.md.
 */
import { isDataTopic, type DataTopic } from './data'

/** The API this app implements natively; new plugins should target it. */
export const PLUGIN_API_VERSION = 1

/**
 * Every API version this app can still run. Each has its own runtime (plugin-runtime/v<N>/), so a
 * plugin written for an older supported version keeps working after the API moves on.
 */
export const SUPPORTED_API_VERSIONS = [1]

/** Data a plugin may ask for: the hub's topics plus `audio` (system audio, needs the user's consent). */
export type PluginDataId = DataTopic | 'audio'

export const isPluginDataId = (v: unknown): v is PluginDataId => v === 'audio' || isDataTopic(v)

export type PluginSettingSpec =
  | { key: string; label: string; type: 'number'; default: number; min: number; max: number; step?: number }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | { key: string; label: string; type: 'select'; default: string; options: Array<{ value: string; label: string }> }

export interface PluginManifest {
  /** Lowercase id; must equal the plugin's folder name. */
  id: string
  name: string
  version: string
  apiVersion: number
  description?: string
  /** ES module to load, relative to the plugin folder. */
  entry: string
  /** Panel title when the plugin is placed in a slot. */
  defaultTitle?: string
  /** Data it subscribes to; anything else is refused at runtime. */
  data: PluginDataId[]
  settings: PluginSettingSpec[]
  /** Oldest app version the plugin works with, e.g. "0.2.0". */
  minAppVersion?: string
  /** Hosts `ctx.fetch` may reach (HTTPS only), e.g. ["api.open-meteo.com", "*.github.com"]. */
  network: string[]
}

/** A scanned plugin folder, valid or not. */
export interface PluginInfo {
  id: string
  manifest: PluginManifest | null
  /** Why the folder can't be loaded (bad manifest, wrong API version…). */
  error?: string
  /** Changes when any file in the folder changes; used to bust the module cache. */
  revision: number
  bundled: boolean
  /** Developer mode: a folder used in place (not copied into the plugins folder). */
  linked: boolean
  /** Where the plugin's files are. */
  folder: string
}

/** Where a plugin comes from when installing. */
export type InstallSource = { kind: 'folder' | 'zip'; path: string } | { kind: 'git'; url: string }

export interface InstallResult {
  ok: boolean
  id?: string
  message: string
}

/** One entry of a community catalog (a JSON array served over HTTPS, e.g. from a GitHub repo). */
export interface CatalogEntry {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  /** Git URL to install from. */
  repo: string
}

export interface PluginList {
  plugins: PluginInfo[]
  folder: string
}

/** Per-plugin entry in settings.json. */
export interface PluginPrefs {
  enabled?: boolean
  settings?: Record<string, unknown>
}

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

/** Compare dotted versions numerically: -1, 0 or 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

const HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/

/** Whether a hostname matches a manifest network entry ("example.com" or "*.example.com"). */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase()
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) || h === p.slice(2) : h === p))
}

/**
 * Validate a parsed manifest.json. Returns the manifest or an error message written for the
 * person who installed the plugin. `folder` is null for plugins not yet installed.
 */
export function validateManifest(raw: unknown, folder: string | null, appVersion = '999.0.0'): PluginManifest | string {
  if (!raw || typeof raw !== 'object') return 'manifest.json is not an object'
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !PLUGIN_ID.test(m.id)) return 'id must be lowercase letters, digits and dashes'
  if (folder !== null && m.id !== folder) return `id "${m.id}" must match the folder name "${folder}"`
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name is required'
  if (typeof m.version !== 'string') return 'version is required'
  if (typeof m.apiVersion !== 'number' || !Number.isInteger(m.apiVersion)) return 'apiVersion is required (use 1)'
  if (!SUPPORTED_API_VERSIONS.includes(m.apiVersion)) {
    const newest = Math.max(...SUPPORTED_API_VERSIONS)
    return m.apiVersion > newest
      ? `needs a newer CRT Terminal: it uses plugin API v${m.apiVersion}, this version supports up to v${newest}. Update the app.`
      : `was written for plugin API v${m.apiVersion}, which is no longer supported (supported: v${SUPPORTED_API_VERSIONS.join(', v')}). Ask its author for an update.`
  }
  if (typeof m.minAppVersion === 'string' && compareVersions(appVersion, m.minAppVersion) < 0) {
    return `needs CRT Terminal ${m.minAppVersion} or newer (this is ${appVersion}). Update the app.`
  }
  const network: string[] = []
  const perms = m.permissions && typeof m.permissions === 'object' ? (m.permissions as Record<string, unknown>) : {}
  for (const h of Array.isArray(perms.network) ? perms.network : []) {
    if (typeof h !== 'string' || !HOST_PATTERN.test(h.toLowerCase())) return `permissions.network: "${String(h)}" is not a hostname`
    network.push(h.toLowerCase())
  }
  if (typeof m.entry !== 'string' || !/^\w[\w./-]*\.m?js$/.test(m.entry) || m.entry.includes('..')) return 'entry must be a .js file inside the plugin folder'
  const data = Array.isArray(m.data) ? m.data : []
  const badData = data.find((d) => !isPluginDataId(d))
  if (badData !== undefined) return `unknown data "${String(badData)}"`
  const settings: PluginSettingSpec[] = []
  for (const s of Array.isArray(m.settings) ? m.settings : []) {
    const spec = validateSetting(s)
    if (typeof spec === 'string') return spec
    settings.push(spec)
  }
  return {
    id: m.id,
    name: m.name.trim().slice(0, 40),
    version: m.version.slice(0, 20),
    apiVersion: m.apiVersion,
    description: typeof m.description === 'string' ? m.description.slice(0, 200) : undefined,
    entry: m.entry,
    defaultTitle: typeof m.defaultTitle === 'string' ? m.defaultTitle.slice(0, 32) : undefined,
    data: data as PluginDataId[],
    settings,
    minAppVersion: typeof m.minAppVersion === 'string' ? m.minAppVersion : undefined,
    network
  }
}

function validateSetting(raw: unknown): PluginSettingSpec | string {
  if (!raw || typeof raw !== 'object') return 'each setting must be an object'
  const s = raw as Record<string, unknown>
  if (typeof s.key !== 'string' || !/^\w{1,40}$/.test(s.key)) return 'setting key must be a word'
  const label = typeof s.label === 'string' ? s.label.slice(0, 60) : s.key
  if (s.type === 'number') {
    if (typeof s.default !== 'number' || typeof s.min !== 'number' || typeof s.max !== 'number') return `setting "${s.key}": number needs default, min, max`
    return { key: s.key, label, type: 'number', default: s.default, min: s.min, max: s.max, step: typeof s.step === 'number' ? s.step : undefined }
  }
  if (s.type === 'boolean') {
    if (typeof s.default !== 'boolean') return `setting "${s.key}": boolean needs a default`
    return { key: s.key, label, type: 'boolean', default: s.default }
  }
  if (s.type === 'select') {
    const options = Array.isArray(s.options)
      ? s.options.filter((o): o is { value: string; label: string } => !!o && typeof o.value === 'string').map((o) => ({ value: o.value, label: String(o.label ?? o.value) }))
      : []
    if (!options.length || typeof s.default !== 'string') return `setting "${s.key}": select needs options and a default`
    return { key: s.key, label, type: 'select', default: s.default, options }
  }
  return `setting "${String(s.key)}": unknown type "${String(s.type)}"`
}

/** Coerce one value to its spec, or return the default. */
export function coerceSetting(spec: PluginSettingSpec, v: unknown): number | boolean | string {
  if (spec.type === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : spec.default
  }
  if (spec.type === 'boolean') return typeof v === 'boolean' ? v : spec.default
  return spec.options.some((o) => o.value === v) ? (v as string) : spec.default
}

/** The plugin's settings: stored values checked against the schema, defaults for the rest. */
export function resolveSettings(manifest: PluginManifest, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of manifest.settings) out[spec.key] = coerceSetting(spec, stored?.[spec.key])
  return out
}
