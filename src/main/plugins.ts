import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron'
import { PLUGIN_ID, validateManifest, type PluginInfo, type PluginList } from '@shared/plugins'
import { getSettings, settingsEvents } from './settings'

/**
 * Plugin registry.
 * - Installed plugins live in <userData>/plugins/<id>/ (manifest.json + an ES module). The bundled
 *   ones are copied there once; a folder you delete stays deleted.
 * - In developer mode, folders anywhere on disk can be *linked* (used in place, hot-reloaded).
 * - Plugin pages are served over crt-plugin://<id>/ and run in sandboxed iframes (PluginHost.vue).
 */
export const PLUGIN_SCHEME = 'crt-plugin'

/** App resources: next to the app in development, in resources/ once packaged (outside the asar). */
export const resourcesDir = (): string => (app.isPackaged ? process.resourcesPath : app.getAppPath())
export const pluginsDir = (): string => join(app.getPath('userData'), 'plugins')
const bundledDir = (): string => join(resourcesDir(), 'plugins')
const runtimeDir = (): string => join(resourcesDir(), 'plugin-runtime')
const seedFile = (): string => join(pluginsDir(), '.bundled.json')

/** Must run before app ready: lets plugin iframes load ES modules and fetch their own files. */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

// ------------------------------------------------------------------ seeding
function readVersion(dir: string): string | null {
  try {
    return String((JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }).version ?? '')
  } catch {
    return null
  }
}

function readSeeded(): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(seedFile(), 'utf8')) as { seeded?: Record<string, string> }).seeded ?? {}
  } catch {
    return {}
  }
}

/**
 * Copy bundled plugins in on first sight, update them when the app ships a new version,
 * and never bring back one the user deleted.
 */
function seedBundled(): void {
  mkdirSync(pluginsDir(), { recursive: true })
  const seeded = readSeeded()
  if (existsSync(bundledDir())) {
    for (const id of readdirSync(bundledDir())) {
      const src = join(bundledDir(), id)
      const dst = join(pluginsDir(), id)
      const version = readVersion(src)
      if (!version || !statSync(src).isDirectory()) continue
      const known = id in seeded
      if (known && !existsSync(dst)) continue // the user removed it
      if (!known || seeded[id] !== version) {
        cpSync(src, dst, { recursive: true, force: true })
        seeded[id] = version
      }
    }
  }
  writeFileSync(seedFile(), JSON.stringify({ seeded }, null, 2))
}

/** After an uninstall, a bundled plugin must not be re-seeded. */
export function markRemoved(id: string): void {
  const seeded = readSeeded()
  if (id in seeded) return // already known: the missing folder means "removed"
  if (existsSync(join(bundledDir(), id))) {
    seeded[id] = readVersion(join(bundledDir(), id)) ?? ''
    writeFileSync(seedFile(), JSON.stringify({ seeded }, null, 2))
  }
}

// ------------------------------------------------------------------ scanning
function newestMtime(dir: string, depth = 0): number {
  let t = 0
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const p = join(dir, name)
    const st = statSync(p)
    t = Math.max(t, st.mtimeMs)
    if (st.isDirectory() && depth < 3) t = Math.max(t, newestMtime(p, depth + 1))
  }
  return Math.round(t)
}

/** Read one plugin folder. `expectedId` is the folder name for installed plugins, null for links. */
function readPlugin(dir: string, expectedId: string | null, flags: { bundled: boolean; linked: boolean }): PluginInfo {
  const fallbackId = expectedId ?? dir.split(/[\\/]/).pop() ?? 'plugin'
  const base = { id: fallbackId, revision: 0, folder: dir, ...flags }
  if (expectedId !== null && !PLUGIN_ID.test(expectedId)) {
    return { ...base, manifest: null, error: 'Folder name must be lowercase letters, digits and dashes.' }
  }
  try {
    base.revision = newestMtime(dir)
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { id?: unknown }
    if (expectedId === null && typeof raw.id === 'string' && PLUGIN_ID.test(raw.id)) base.id = raw.id
    const result = validateManifest(raw, expectedId, app.getVersion())
    if (typeof result === 'string') return { ...base, manifest: null, error: result }
    if (!existsSync(join(dir, result.entry))) return { ...base, manifest: null, error: `entry file ${result.entry} is missing` }
    return { ...base, manifest: result }
  } catch (err) {
    return { ...base, manifest: null, error: `manifest.json: ${(err as Error).message}` }
  }
}

let current: PluginInfo[] = []

function scan(): PluginInfo[] {
  const bundled = existsSync(bundledDir()) ? new Set(readdirSync(bundledDir())) : new Set<string>()
  const byId = new Map<string, PluginInfo>()
  for (const id of readdirSync(pluginsDir())) {
    const dir = join(pluginsDir(), id)
    if (id.startsWith('.') || !statSync(dir).isDirectory()) continue
    byId.set(id, readPlugin(dir, id, { bundled: bundled.has(id), linked: false }))
  }
  // Developer mode: linked folders are used in place and win over an installed copy of the same id.
  const s = getSettings()
  if (s.pluginDevMode) {
    for (const dir of s.pluginLinks) {
      if (!existsSync(dir)) continue
      const info = readPlugin(dir, null, { bundled: false, linked: true })
      byId.set(info.id, info)
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function rescan(): PluginInfo[] {
  const next = scan()
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    current = next
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('plugins:changed')
  }
  return current
}

export const installedPlugins = (): PluginInfo[] => current
export const pluginList = (): PluginList => ({ plugins: current, folder: pluginsDir() })

// ------------------------------------------------------------------ watching (hot reload)
let rescanTimer: NodeJS.Timeout | undefined
const scheduleRescan = (): void => {
  clearTimeout(rescanTimer)
  rescanTimer = setTimeout(rescan, 300)
}
const watchers = new Map<string, FSWatcher>()

/** Watch the plugins folder plus every linked folder; any change re-scans (and reloads panels). */
function syncWatchers(): void {
  const s = getSettings()
  const wanted = new Set([pluginsDir(), ...(s.pluginDevMode ? s.pluginLinks.filter((d) => existsSync(d)) : [])])
  for (const [dir, w] of watchers) {
    if (!wanted.has(dir)) {
      w.close()
      watchers.delete(dir)
    }
  }
  for (const dir of wanted) {
    if (watchers.has(dir)) continue
    try {
      watchers.set(dir, watch(dir, { recursive: true }, scheduleRescan))
    } catch (err) {
      console.warn('[plugins] cannot watch', dir, err)
    }
  }
}

// ------------------------------------------------------------------ serving
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/** Fonts the runtime exposes to plugins, so they can match the app. */
const FONTS: Record<string, string> = {
  'ibm-plex-mono-400.woff2': '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  'ibm-plex-mono-700.woff2': '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2',
  'share-tech-mono-400.woff2': '@fontsource/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2'
}

/** Plugin pages may load only their own files and the runtime: no network (ctx.fetch goes through the host), no eval. */
const FRAME_CSP = [
  "default-src 'none'",
  `script-src ${PLUGIN_SCHEME}:`,
  `style-src 'unsafe-inline' ${PLUGIN_SCHEME}:`,
  `img-src ${PLUGIN_SCHEME}: data: blob:`,
  `font-src ${PLUGIN_SCHEME}:`,
  `connect-src ${PLUGIN_SCHEME}:`,
  `worker-src blob: ${PLUGIN_SCHEME}:`
].join('; ')

/** The frame loads the runtime for the plugin's own API version, so old plugins keep their API. */
const frameHtml = (apiVersion: number): string => `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#root{position:absolute;inset:0;overflow:hidden}</style>
<script type="module" src="${PLUGIN_SCHEME}://_runtime/v${apiVersion}/runtime.js"></script>
</head><body><div id="root"></div></body></html>`

function respond(body: Buffer | string, file: string, extra: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    headers: {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // Sandboxed plugin frames have an opaque origin; their module loads are cross-origin.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      ...extra
    }
  })
}

const notFound = (): Response => new Response('Not found', { status: 404 })

/** Resolve `rel` inside `root`, refusing anything that escapes it (symlinks included: both sides are real paths). */
function inside(root: string, rel: string): string | null {
  const realRoot = realpathSync(root)
  const full = resolve(realRoot, `.${rel}`)
  if (!existsSync(full)) return null
  const real = realpathSync(full)
  return real === realRoot || real.startsWith(realRoot + sep) ? real : null
}

function servePlugin(request: Request): Response {
  const url = new URL(request.url)
  const host = url.hostname
  const path = decodeURIComponent(url.pathname)
  try {
    if (host === '_runtime') {
      if (path.startsWith('/fonts/')) {
        const rel = FONTS[path.slice('/fonts/'.length)]
        return rel ? respond(readFileSync(join(app.getAppPath(), 'node_modules', rel)), rel) : notFound()
      }
      const file = inside(runtimeDir(), path)
      return file && existsSync(file) ? respond(readFileSync(file), file) : notFound()
    }
    const plugin = PLUGIN_ID.test(host) ? current.find((p) => p.id === host && p.manifest) : undefined
    if (!plugin) return notFound()
    if (path === '/_frame') return respond(frameHtml(plugin.manifest!.apiVersion), 'frame.html', { 'Content-Security-Policy': FRAME_CSP })
    const file = inside(plugin.folder, path)
    return file && existsSync(file) && statSync(file).isFile() ? respond(readFileSync(file), file) : notFound()
  } catch {
    return notFound()
  }
}

// ------------------------------------------------------------------ init
export function initPlugins(): void {
  try {
    seedBundled()
  } catch (err) {
    console.warn('[plugins] seeding failed:', err)
  }
  current = scan()
  protocol.handle(PLUGIN_SCHEME, servePlugin)
  syncWatchers()
  // Developer mode and linked folders change what's scanned and watched.
  let lastDev = JSON.stringify([getSettings().pluginDevMode, getSettings().pluginLinks])
  settingsEvents.on('changed', (s) => {
    const dev = JSON.stringify([s.pluginDevMode, s.pluginLinks])
    if (dev === lastDev) return
    lastDev = dev
    syncWatchers()
    rescan()
  })

  ipcMain.handle('plugins:list', (): PluginList => pluginList())
  ipcMain.handle('plugins:rescan', (): PluginList => {
    rescan()
    return pluginList()
  })
  ipcMain.handle('plugins:openFolder', (_e, id?: string) => {
    const p = id ? current.find((x) => x.id === id) : undefined
    return shell.openPath(p ? p.folder : pluginsDir())
  })
}
