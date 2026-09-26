import { execFile } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, net } from 'electron'
import { unzipSync } from 'fflate'
import {
  hostAllowed,
  PLUGIN_ID,
  validateManifest,
  type CatalogEntry,
  type InstallResult,
  type InstallSource,
  type PluginManifest
} from '@shared/plugins'
import { getSettings } from './settings'
import { installedPlugins, markRemoved, pluginsDir, rescan, resourcesDir } from './plugins'

/**
 * Installing, removing and creating plugins, plus the two network features plugins can use
 * through the host: the community catalog and `ctx.fetch` (allowlisted hosts only).
 */

const MAX_ZIP_BYTES = 50 * 1024 * 1024
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024

const winOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow | undefined => BrowserWindow.fromWebContents(e.sender) ?? undefined

// ------------------------------------------------------------------ staging
/** A plugin folder is one with a manifest.json, at the top or one level down (GitHub zips wrap everything in a folder). */
function findPluginRoot(dir: string): string | null {
  if (existsSync(join(dir, 'manifest.json'))) return dir
  const subdirs = readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isDirectory())
  if (subdirs.length === 1 && existsSync(join(dir, subdirs[0], 'manifest.json'))) return join(dir, subdirs[0])
  return null
}

function extractZip(file: string, into: string): void {
  if (statSync(file).size > MAX_ZIP_BYTES) throw new Error('The zip is larger than 50 MB.')
  // fflate inflates each entry into a buffer of its declared size, so capping the sum caps memory.
  let total = 0
  const entries = unzipSync(readFileSync(file), {
    filter: (f) => {
      total += Math.max(f.size, f.originalSize)
      if (total > MAX_UNZIPPED_BYTES) throw new Error('The zip unpacks to more than 200 MB.')
      return true
    }
  })
  for (const [name, data] of Object.entries(entries)) {
    const target = resolve(into, name)
    if (!target.startsWith(resolve(into) + sep)) throw new Error(`Unsafe path in zip: ${name}`)
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
}

function gitClone(url: string, into: string): Promise<void> {
  return new Promise((ok, fail) => {
    execFile('git', ['clone', '--depth', '1', '--quiet', '--', url, into], { timeout: 120_000, windowsHide: true }, (err, _out, stderr) => {
      if (!err) return ok()
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') fail(new Error('Git is not installed (or not on PATH). Install Git, or download the plugin as a zip.'))
      else fail(new Error(String(stderr || err.message).trim().split('\n').pop() || 'git clone failed'))
    })
  })
}

/** A symlink would let an installed plugin serve any file on disk: refuse them. .git and node_modules aren't copied. */
function findLink(dir: string): string | null {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return p
    const hit = st.isDirectory() ? findLink(p) : null
    if (hit) return hit
  }
  return null
}

const GIT_URL = /^(https:\/\/|ssh:\/\/|git@)[\w.@:/~+-]+$/

async function stage(source: InstallSource, tmp: string): Promise<string> {
  if (source.kind !== 'git') {
    if (source.kind === 'folder') return source.path
    extractZip(source.path, tmp)
    return tmp
  }
  if (!GIT_URL.test(source.url)) throw new Error('Use an https://, ssh:// or git@ repository URL.')
  await gitClone(source.url, join(tmp, 'repo'))
  return join(tmp, 'repo')
}

// ------------------------------------------------------------------ install / remove
async function install(source: InstallSource, win?: BrowserWindow): Promise<InstallResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'crt-plugin-'))
  try {
    const staged = await stage(source, tmp)
    const root = findPluginRoot(staged)
    if (!root) return { ok: false, message: 'No manifest.json found (looked at the top level and one folder down).' }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    } catch (err) {
      return { ok: false, message: `manifest.json is not valid JSON: ${(err as Error).message}` }
    }
    // Validated before anything is copied: a plugin that can't run never replaces one that can.
    const manifest = validateManifest(raw, null, app.getVersion())
    if (typeof manifest === 'string') return { ok: false, message: `This plugin ${manifest.startsWith('needs') || manifest.startsWith('was') ? manifest : `can't be installed: ${manifest}`}` }
    if (!existsSync(join(root, manifest.entry))) return { ok: false, message: `The entry file ${manifest.entry} is missing.` }
    const link = lstatSync(root).isSymbolicLink() ? root : findLink(root)
    if (link) return { ok: false, message: `Plugins can't contain symbolic links: ${relative(root, link) || link}` }

    const target = join(pluginsDir(), manifest.id)
    if (existsSync(target)) {
      const old = installedPlugins().find((p) => p.id === manifest.id)?.manifest
      const opts: Electron.MessageBoxOptions = {
        type: 'question',
        title: 'Replace plugin?',
        message: `“${manifest.name}” is already installed${old ? ` (v${old.version})` : ''}.`,
        detail: `Replace it with v${manifest.version}? Its settings are kept.`,
        buttons: ['Replace', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (r.response !== 0) return { ok: false, message: 'Cancelled.' }
      rmSync(target, { recursive: true, force: true })
    }
    cpSync(root, target, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src.slice(root.length)) })
    rescan()
    return { ok: true, id: manifest.id, message: `Installed ${manifest.name} v${manifest.version}.` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function uninstall(id: string, win?: BrowserWindow): Promise<InstallResult> {
  const p = installedPlugins().find((x) => x.id === id)
  if (!p || p.linked || !PLUGIN_ID.test(id)) return { ok: false, message: 'Not an installed plugin.' }
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Remove plugin?',
    message: `Remove “${p.manifest?.name ?? id}”?`,
    detail: `Its folder is deleted:\n${p.folder}`,
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  }
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (r.response !== 0) return { ok: false, message: 'Cancelled.' }
  rmSync(p.folder, { recursive: true, force: true })
  markRemoved(id)
  rescan()
  return { ok: true, id, message: `Removed ${p.manifest?.name ?? id}.` }
}

/** New plugin from the starter template (plugin-template/), with the id and name filled in. */
function createFromTemplate(id: string, name: string): InstallResult {
  if (!PLUGIN_ID.test(id)) return { ok: false, message: 'Use lowercase letters, digits and dashes for the id.' }
  const target = join(pluginsDir(), id)
  if (existsSync(target)) return { ok: false, message: `A plugin called "${id}" already exists.` }
  const template = join(resourcesDir(), 'plugin-template')
  cpSync(template, target, { recursive: true })
  // Types for editor completion (JSDoc in index.js points at it).
  cpSync(join(resourcesDir(), 'plugin-runtime', 'crt-plugin.d.ts'), join(target, 'crt-plugin.d.ts'))
  const manifestFile = join(target, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
  manifest.id = id
  manifest.name = name.trim().slice(0, 40) || id
  manifest.defaultTitle = (name.trim() || id).toUpperCase().slice(0, 32)
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  rescan()
  return { ok: true, id, message: `Created ${id} in ${target}` }
}

// ------------------------------------------------------------------ network (via the host only)
async function fetchCatalog(): Promise<{ entries: CatalogEntry[]; error?: string }> {
  const url = getSettings().pluginCatalogUrl
  if (!url) return { entries: [] }
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { entries: [], error: `The catalog answered ${res.status}.` }
    const data = (await res.json()) as unknown
    const list = Array.isArray(data) ? data : Array.isArray((data as { plugins?: unknown })?.plugins) ? (data as { plugins: unknown[] }).plugins : []
    const entries = list
      .filter((e): e is CatalogEntry => !!e && typeof e === 'object' && typeof (e as CatalogEntry).id === 'string' && typeof (e as CatalogEntry).repo === 'string')
      .map((e) => ({
        id: String(e.id).slice(0, 40),
        name: String(e.name ?? e.id).slice(0, 60),
        description: e.description ? String(e.description).slice(0, 200) : undefined,
        author: e.author ? String(e.author).slice(0, 60) : undefined,
        version: e.version ? String(e.version).slice(0, 20) : undefined,
        repo: String(e.repo)
      }))
    return { entries }
  } catch (err) {
    return { entries: [], error: `Couldn't load the catalog: ${(err as Error).message}` }
  }
}

const MAX_FETCH_BYTES = 2 * 1024 * 1024

/**
 * ctx.fetch: HTTPS requests to the hosts listed in the plugin's manifest (permissions.network),
 * nothing else. Text responses only, 2 MB max, 15 s timeout.
 */
async function pluginFetch(pluginId: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
  const manifest: PluginManifest | null | undefined = installedPlugins().find((p) => p.id === pluginId)?.manifest
  if (!manifest) return { error: 'Unknown plugin.' }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { error: 'Invalid URL.' }
  }
  if (u.protocol !== 'https:') return { error: 'Only https:// URLs are allowed.' }
  if (!hostAllowed(u.hostname, manifest.network)) {
    return { error: `${u.hostname} is not in this plugin's permissions.network (${manifest.network.join(', ') || 'none'}).` }
  }
  const method = (init.method ?? 'GET').toUpperCase()
  if (!['GET', 'POST', 'HEAD'].includes(method)) return { error: 'Only GET, POST and HEAD are allowed.' }
  try {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) if (!/^(cookie|proxy-authorization|host)$/i.test(k)) headers[k] = String(v)
    // Redirects aren't followed: one could leave the allowlist. net.fetch rejects them in manual mode.
    const res = await net.fetch(u.toString(), {
      method,
      headers,
      body: method === 'POST' ? String(init.body ?? '') : undefined,
      credentials: 'omit',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000)
    })
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_FETCH_BYTES) return { error: 'The response is larger than 2 MB.' }
    return { status: res.status, statusText: res.statusText, contentType: res.headers.get('content-type') ?? '', body: buf.toString('utf8') }
  } catch (err) {
    const message = (err as Error).message
    return { error: message === 'Redirect was cancelled' ? `${u.hostname} answered with a redirect, which ctx.fetch doesn't follow.` : message }
  }
}

// ------------------------------------------------------------------ IPC
export function registerPluginInstallIpc(): void {
  ipcMain.handle('plugins:pickSource', async (e, kind: 'folder' | 'zip') => {
    const win = winOf(e)
    const opts: Electron.OpenDialogOptions =
      kind === 'folder'
        ? { title: 'Choose a plugin folder', properties: ['openDirectory'] }
        : { title: 'Choose a plugin zip', properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('plugins:install', (e, source: InstallSource) => install(source, winOf(e)))
  ipcMain.handle('plugins:uninstall', (e, id: string) => uninstall(String(id), winOf(e)))
  ipcMain.handle('plugins:create', (_e, id: string, name: string) => createFromTemplate(String(id), String(name)))
  ipcMain.handle('plugins:catalog', () => fetchCatalog())
  ipcMain.handle('plugins:fetch', (_e, pluginId: string, url: string, init: Record<string, unknown>) =>
    pluginFetch(String(pluginId), String(url), (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string })
  )
}
