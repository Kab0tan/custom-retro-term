import type { PhosphorId } from './phosphor'
import { HELIOS7_LAYOUT, type LayoutNode, type SavedLayout } from './layout'
import type { PluginPrefs } from './plugins'

/** A shell the user can open in a tab. Detected at startup or defined in settings.json. */
export interface ShellProfile {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  /** posix = zsh/bash/fish/sh on macOS and Linux. */
  kind: 'pwsh' | 'powershell' | 'cmd' | 'gitbash' | 'wsl' | 'posix' | 'custom'
}

/** User-defined profile as written in settings.json. */
export interface CustomProfile {
  name: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export type RightClickAction = 'copyPaste' | 'none'
export type CursorStyle = 'block' | 'bar' | 'underline'
/**
 * phosphor: terminal and UI colours come from the phosphor tokens (src/shared/phosphor.ts).
 * campbell: Windows Terminal colours and neutral chrome (the shader tint still uses the phosphor).
 */
export type ColorScheme = 'phosphor' | 'campbell'

/**
 * How the CRT look is produced (needs a restart to change):
 * - webgl: the whole window is composited through the CRT shader (full effect)
 * - css:   a native window with a CSS overlay (scanlines/vignette only), for IME or screen-reader use
 */
export type CrtRenderer = 'webgl' | 'css'

/** Effects with their own on/off toggle in the Tweaks panel. */
export const EFFECT_KEYS = ['curvature', 'scanlines', 'bloom', 'glow', 'vignette', 'rgbShift', 'flicker', 'noise', 'burnIn'] as const
export type EffectKey = (typeof EFFECT_KEYS)[number]

/** Effect strengths, 0..1 unless noted. Tuned so 0 = off. */
export interface CrtSettings {
  /** Master switch; applies live. Off = pixel-exact passthrough. */
  enabled: boolean
  renderer: CrtRenderer
  curvature: number
  scanlines: number
  bloom: number
  /** Soft phosphor haze over the whole screen. */
  glow: number
  vignette: number
  flicker: number
  noise: number
  /** Chromatic aberration toward the edges. */
  rgbShift: number
  /** Fading trails behind changing text; 0 = off. */
  burnIn: number
  /** 0 = monochrome phosphor, 1 = full terminal colours. */
  chroma: number
  brightness: number
  /** Effects toggled off; their slider values are kept for when they're turned back on. */
  effectsOff: EffectKey[]
  /** Frame-rate cap for the compositor. */
  fpsCap: 30 | 60 | 120
  /** Stop flicker/noise animation while the window isn't focused (saves GPU). */
  pauseWhenUnfocused: boolean
}

/** The part of CrtSettings that makes up a "look" (what presets save). */
export const LOOK_CRT_KEYS = [...EFFECT_KEYS, 'chroma', 'brightness', 'enabled', 'effectsOff'] as const
export type LookCrt = Pick<CrtSettings, (typeof LOOK_CRT_KEYS)[number]>

/** A saved look: phosphor + colour scheme + effect values. */
export interface LookPreset {
  id: string
  name: string
  phosphor: PhosphorId
  colorScheme: ColorScheme
  crt: LookCrt
}

export interface Settings {
  /** Profile id opened by new tabs; empty = first detected shell. */
  defaultProfile: string
  phosphor: PhosphorId
  colorScheme: ColorScheme
  fontFamily: string
  fontSize: number
  lineHeight: number
  scrollback: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  copyOnSelect: boolean
  /** Ctrl+V pastes (like Windows Terminal). Off = Ctrl+V goes to the shell (vim block select). */
  ctrlVPastes: boolean
  /** Ctrl+C copies when text is selected, otherwise sends ^C. */
  ctrlCCopiesSelection: boolean
  rightClick: RightClickAction
  warnOnMultilinePaste: boolean
  confirmCloseMultipleTabs: boolean
  /** Force UTF-8 code page in PowerShell / cmd so native tools print accents and emoji correctly. */
  forceUtf8: boolean
  /** Use the ConPTY shipped with node-pty (newer than the OS one). Applies to new tabs. */
  useBundledConpty: boolean
  crt: CrtSettings
  /** User-saved looks (built-ins live in src/shared/presets.ts). */
  presets: LookPreset[]
  /** Id of the preset last applied; the Tweaks panel flags when the look has drifted from it. */
  activePreset: string
  /** The panel layout on screen (shared by all windows). */
  layout: LayoutNode
  /** User-saved layouts (built-ins live in src/shared/layout.ts). */
  layouts: SavedLayout[]
  /** Id of the layout last loaded; the Layout menu flags when the screen has drifted from it. */
  activeLayout: string
  /** Per-plugin enable flag and settings, by plugin id. */
  plugins: Record<string, PluginPrefs>
  /** The user allowed plugins to analyse system audio (spectrum). */
  audioCapture: boolean
  /** Animation frame-rate cap for plugin panels (lower = lighter). */
  pluginFps: 30 | 60
  /** Plugin developer mode: linked folders, stack traces, reload buttons. */
  pluginDevMode: boolean
  /** Developer mode: plugin folders used in place (hot-reloaded on save). */
  pluginLinks: string[]
  /** Optional community catalog: HTTPS URL of a JSON array of CatalogEntry. */
  pluginCatalogUrl: string
  /** Check for and download app updates automatically (installed builds only). */
  autoUpdate: boolean
  customProfiles: CustomProfile[]
}

/**
 * "Readable first": the look is there, but comfortable for a full day. Static (no flicker or
 * noise), so an idle window does no GPU work.
 */
export const DEFAULT_CRT: CrtSettings = {
  enabled: true,
  renderer: 'webgl',
  curvature: 0.35,
  scanlines: 0.3,
  bloom: 0.35,
  glow: 0.25,
  vignette: 0.4,
  flicker: 0,
  noise: 0,
  rgbShift: 0.15,
  burnIn: 0,
  chroma: 0.55,
  brightness: 1,
  effectsOff: [],
  fpsCap: 60,
  pauseWhenUnfocused: true
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProfile: '',
  phosphor: 'amber',
  colorScheme: 'phosphor',
  fontFamily: 'IBM Plex Mono',
  fontSize: 15,
  lineHeight: 1.15,
  scrollback: 10000,
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
  ctrlVPastes: true,
  ctrlCCopiesSelection: true,
  rightClick: 'copyPaste',
  warnOnMultilinePaste: true,
  confirmCloseMultipleTabs: true,
  forceUtf8: true,
  useBundledConpty: false,
  crt: DEFAULT_CRT,
  presets: [],
  activePreset: 'helios-amber',
  layout: HELIOS7_LAYOUT.root,
  layouts: [],
  activeLayout: HELIOS7_LAYOUT.id,
  plugins: {},
  audioCapture: false,
  pluginFps: 30,
  pluginDevMode: false,
  pluginLinks: [],
  pluginCatalogUrl: '',
  autoUpdate: true,
  customProfiles: []
}

/** CRT values as the renderer should use them: toggled-off effects become 0. */
export function effectiveCrt(crt: CrtSettings): CrtSettings {
  if (!crt.effectsOff.length) return crt
  const out = { ...crt }
  for (const k of crt.effectsOff) out[k] = 0
  return out
}

export function lookOf(crt: CrtSettings): LookCrt {
  const out = {} as Record<string, unknown>
  for (const k of LOOK_CRT_KEYS) out[k] = k === 'effectsOff' ? [...crt.effectsOff].sort() : crt[k]
  return out as unknown as LookCrt
}

/** Fonts shipped with the app (OFL). The first is the HELIOS-7 default. */
export const BUNDLED_FONTS = ['IBM Plex Mono', 'VT323', 'Share Tech Mono', 'Courier Prime']
