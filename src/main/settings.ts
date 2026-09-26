import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { isPhosphorId } from '@shared/phosphor'
import { sanitizeLayout, type SavedLayout } from '@shared/layout'
import {
  DEFAULT_CRT,
  DEFAULT_SETTINGS,
  EFFECT_KEYS,
  LOOK_CRT_KEYS,
  type CrtSettings,
  type EffectKey,
  type LookPreset,
  type Settings
} from '@shared/settings'

const file = (): string => join(app.getPath('userData'), 'settings.json')

/**
 * settings.json holds only what the user changed, so new defaults reach existing users.
 * `version` is written for future format changes: migrate on `raw.version` before sanitizing.
 * Unknown keys and wrong types are dropped by sanitize(), so any old file still loads.
 */
const VERSION = 3

type Json = Record<string, unknown>

let current: Settings = structuredClone(DEFAULT_SETTINGS)
let lastWritten = ''

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Copy keys of `src` whose type matches the default's. Unknown keys and wrong types are ignored. */
function pick<T extends object>(defaults: T, src: unknown): T {
  const out = { ...defaults }
  if (!src || typeof src !== 'object') return out
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const v = (src as Json)[key as string]
    const def = defaults[key]
    if (v === undefined || v === null) continue
    if (Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def) out[key] = v as T[keyof T]
  }
  return out
}

function sanitizeCrt(raw: unknown): CrtSettings {
  const c = pick(DEFAULT_CRT, raw)
  for (const k of ['curvature', 'scanlines', 'bloom', 'glow', 'vignette', 'flicker', 'noise', 'rgbShift', 'burnIn', 'chroma'] as const) {
    c[k] = clamp(c[k], 0, 1)
  }
  c.brightness = clamp(c.brightness, 0.5, 1.5)
  c.effectsOff = [...new Set(c.effectsOff.filter((k): k is EffectKey => (EFFECT_KEYS as readonly string[]).includes(k)))]
  if (![30, 60, 120].includes(c.fpsCap)) c.fpsCap = 60
  if (c.renderer !== 'webgl' && c.renderer !== 'css') c.renderer = 'webgl'
  return c
}

function sanitizePreset(raw: unknown): LookPreset | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Json
  if (typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') return null
  const crt = sanitizeCrt(p.crt)
  const look = Object.fromEntries(LOOK_CRT_KEYS.map((k) => [k, crt[k]])) as LookPreset['crt']
  return {
    id: p.id.slice(0, 80),
    name: p.name.trim().slice(0, 40) || 'Untitled',
    phosphor: isPhosphorId(p.phosphor) ? p.phosphor : 'amber',
    colorScheme: p.colorScheme === 'campbell' ? 'campbell' : 'phosphor',
    crt: look
  }
}

/** Plugin prefs are checked against each manifest in the UI; here just keep them plain and small. */
function sanitizePluginPrefs(raw: unknown): Settings['plugins'] {
  const out: Settings['plugins'] = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Json).slice(0, 200)) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || !v || typeof v !== 'object') continue
    const p = v as Json
    const settings: Record<string, unknown> = {}
    if (p.settings && typeof p.settings === 'object') {
      for (const [k, sv] of Object.entries(p.settings as Json).slice(0, 50)) {
        if (/^\w{1,40}$/.test(k) && ['number', 'boolean', 'string'].includes(typeof sv)) settings[k] = typeof sv === 'string' ? sv.slice(0, 200) : sv
      }
    }
    out[id] = { ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}), ...(Object.keys(settings).length ? { settings } : {}) }
  }
  return out
}

function sanitize(raw: unknown): Settings {
  const out = pick(DEFAULT_SETTINGS, raw)
  out.crt = sanitizeCrt((raw as Json | undefined)?.crt)
  if (!isPhosphorId(out.phosphor)) out.phosphor = 'amber'
  if (out.colorScheme !== 'phosphor' && out.colorScheme !== 'campbell') out.colorScheme = 'phosphor'
  out.presets = out.presets.map(sanitizePreset).filter((p): p is LookPreset => !!p)
  out.layout = sanitizeLayout((raw as Json | undefined)?.layout)
  if (out.pluginFps !== 30 && out.pluginFps !== 60) out.pluginFps = 30
  out.plugins = sanitizePluginPrefs((raw as Json | undefined)?.plugins)
  out.pluginLinks = [...new Set(out.pluginLinks.filter((p): p is string => typeof p === 'string' && p.length < 500))].slice(0, 50)
  if (out.pluginCatalogUrl && !/^https:\/\//i.test(out.pluginCatalogUrl)) out.pluginCatalogUrl = ''
  out.layouts = out.layouts
    .filter((l): l is SavedLayout => !!l && typeof l === 'object' && typeof l.id === 'string' && typeof l.name === 'string')
    .map((l) => ({ id: l.id.slice(0, 80), name: l.name.trim().slice(0, 40) || 'Untitled', root: sanitizeLayout(l.root) }))
  out.fontSize = clamp(out.fontSize, 6, 72)
  out.scrollback = clamp(Math.round(out.scrollback), 0, 1_000_000)
  out.lineHeight = clamp(out.lineHeight, 1, 3)
  return out
}

/** Only the values that differ from the defaults. */
function overrides(s: Settings): Json {
  const out: Json = { version: VERSION }
  for (const [k, v] of Object.entries(s)) {
    if (k === 'crt') continue
    if (!same(v, (DEFAULT_SETTINGS as unknown as Json)[k])) out[k] = v
  }
  const crt: Json = {}
  for (const [k, v] of Object.entries(s.crt)) if (!same(v, (DEFAULT_CRT as unknown as Json)[k])) crt[k] = v
  if (Object.keys(crt).length) out.crt = crt
  return out
}

function readFile(): Settings | null {
  try {
    return sanitize(JSON.parse(readFileSync(file(), 'utf8')))
  } catch (err) {
    // Missing on first run; a broken file keeps the previous settings until it parses.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) {
      console.warn('[settings] could not read settings.json:', err)
    }
    return null
  }
}

function save(): void {
  mkdirSync(dirname(file()), { recursive: true })
  lastWritten = JSON.stringify(overrides(current), null, 2)
  writeFileSync(file(), lastWritten)
}

/** Main-process listeners (e.g. the compositor's frame-rate cap). */
export const settingsEvents = new EventEmitter()

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', current)
  settingsEvents.emit('changed', current)
}

export function getSettings(): Settings {
  return current
}

export function initSettings(): void {
  current = readFile() ?? current
  save() // creates the file, and rewrites an old one with only valid overrides

  // Hand edits to settings.json apply live.
  let timer: NodeJS.Timeout | undefined
  watch(dirname(file()), (_event, name) => {
    if (name !== 'settings.json') return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        if (readFileSync(file(), 'utf8') === lastWritten) return
      } catch {
        return
      }
      const next = readFile()
      if (next) {
        current = next
        broadcast()
      }
    }, 150)
  })

  ipcMain.handle('settings:get', () => current)
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const crt = patch.crt ? { ...current.crt, ...patch.crt } : current.crt
    current = sanitize({ ...current, ...patch, crt })
    save()
    broadcast()
    return current
  })
  ipcMain.handle('settings:openFile', () => shell.openPath(file()))
}
