/**
 * Phosphor colours: the single source of truth for colour.
 * The same tokens drive the xterm palette, the UI chrome (CSS variables), the CRT shader tint
 * and the native window chrome, and they're what plugins should read (see `cssVariables`).
 */
export type PhosphorId = 'amber' | 'green' | 'cyan'

export interface PhosphorTokens {
  id: PhosphorId
  name: string
  /** Main text colour. */
  base: string
  /** Highlights, cursor, accents. */
  bright: string
  /** Secondary text. */
  dim: string
  /** Borders, separators. */
  faint: string
  /** Hover backgrounds. */
  hover: string
  /** The dark glass. */
  background: string
  panel: string
  popup: string
  field: string
  /** Linear-ish RGB 0..1 used by the shader's monochrome tint, bloom and bezel glow. */
  shader: [number, number, number]
}

export const PHOSPHORS: Record<PhosphorId, PhosphorTokens> = {
  amber: {
    id: 'amber',
    name: 'Amber',
    base: '#ffb22e',
    bright: '#ffd27a',
    dim: '#a8741f',
    faint: '#5a3c12',
    hover: '#2a1a08',
    background: '#0b0703',
    panel: '#120b04',
    popup: '#160d05',
    field: '#070401',
    shader: [1.0, 0.69, 0.18]
  },
  green: {
    id: 'green',
    name: 'Green',
    base: '#39ff6a',
    bright: '#a2ffbb',
    dim: '#219a45',
    faint: '#124f22',
    hover: '#0b2412',
    background: '#030b05',
    panel: '#06120a',
    popup: '#07150b',
    field: '#020603',
    shader: [0.26, 1.0, 0.42]
  },
  cyan: {
    id: 'cyan',
    name: 'Cyan',
    base: '#3fe3ff',
    bright: '#aef4ff',
    dim: '#2590a6',
    faint: '#134a56',
    hover: '#0a2127',
    background: '#02090b',
    panel: '#051317',
    popup: '#06171b',
    field: '#010507',
    shader: [0.28, 0.88, 1.0]
  }
}

export const PHOSPHOR_IDS = Object.keys(PHOSPHORS) as PhosphorId[]

export const isPhosphorId = (v: unknown): v is PhosphorId => typeof v === 'string' && Object.hasOwn(PHOSPHORS, v)

// ------------------------------------------------------------------ colour helpers
type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')
}

/** Linear mix of two hex colours; t = 0 → a, 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

function withAlpha(hex: string, alpha: number): string {
  return hex.slice(0, 7) + Math.round(alpha * 255).toString(16).padStart(2, '0')
}

// ------------------------------------------------------------------ terminal palette
/** The 16 ANSI colours plus terminal colours, in xterm's ITheme shape (kept dependency-free). */
export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
  scrollbarSliderBackground: string
  scrollbarSliderHoverBackground: string
  scrollbarSliderActiveBackground: string
}

const ANSI_HUES = {
  red: '#ff4b3a',
  green: '#4bff5a',
  yellow: '#ffe14b',
  blue: '#4b8cff',
  magenta: '#ff4bd2',
  cyan: '#4bf0ff'
} as const

/**
 * ANSI colours pulled toward the phosphor, so a screen reads as one colour but errors still
 * look different from success. The shader's `chroma` then decides how much hue survives.
 */
export function phosphorPalette(t: PhosphorTokens): TerminalPalette {
  const normal = (hue: string): string => mix(mix(hue, t.base, 0.55), t.background, 0.1)
  const bright = (hue: string): string => mix(mix(hue, t.bright, 0.5), '#ffffff', 0.08)
  return {
    background: t.background,
    foreground: t.base,
    cursor: t.bright,
    cursorAccent: t.background,
    selectionBackground: withAlpha(t.base, 0.3),
    selectionForeground: mix(t.bright, '#ffffff', 0.5),
    black: mix(t.background, t.base, 0.1),
    red: normal(ANSI_HUES.red),
    green: normal(ANSI_HUES.green),
    yellow: normal(ANSI_HUES.yellow),
    blue: normal(ANSI_HUES.blue),
    magenta: normal(ANSI_HUES.magenta),
    cyan: normal(ANSI_HUES.cyan),
    white: mix(t.base, '#ffffff', 0.2),
    brightBlack: mix(t.background, t.base, 0.45),
    brightRed: bright(ANSI_HUES.red),
    brightGreen: bright(ANSI_HUES.green),
    brightYellow: bright(ANSI_HUES.yellow),
    brightBlue: bright(ANSI_HUES.blue),
    brightMagenta: bright(ANSI_HUES.magenta),
    brightCyan: bright(ANSI_HUES.cyan),
    brightWhite: mix(t.bright, '#ffffff', 0.5),
    scrollbarSliderBackground: withAlpha(t.base, 0.13),
    scrollbarSliderHoverBackground: withAlpha(t.base, 0.27),
    scrollbarSliderActiveBackground: withAlpha(t.base, 0.4)
  }
}

// ------------------------------------------------------------------ UI chrome
/** Colours of the app chrome (tabs, panels), whichever colour scheme is active. */
export interface ChromeTokens {
  bg: string
  fg: string
  dim: string
  hover: string
  border: string
  accent: string
  panel: string
  popup: string
  field: string
}

export function phosphorChrome(t: PhosphorTokens): ChromeTokens {
  return {
    bg: t.background,
    fg: t.base,
    dim: t.dim,
    hover: t.hover,
    border: t.faint,
    accent: t.bright,
    panel: t.panel,
    popup: t.popup,
    field: t.field
  }
}

/** Neutral chrome used with the Campbell scheme. */
export const NEUTRAL_CHROME: ChromeTokens = {
  bg: '#1b1b1f',
  fg: '#c8c8cc',
  dim: '#8a8a92',
  hover: '#2a2a30',
  border: '#2e2e35',
  accent: '#4d9fff',
  panel: '#1f1f24',
  popup: '#242429',
  field: '#151518'
}

/**
 * CSS variables for the UI. `--phosphor-*` are the stable names for plugins; the `--chrome-*`
 * ones are what the app's own components use.
 */
export function cssVariables(t: PhosphorTokens, chrome: ChromeTokens, termBg: string): Record<string, string> {
  return {
    '--phosphor': t.base,
    '--phosphor-bright': t.bright,
    '--phosphor-dim': t.dim,
    '--phosphor-faint': t.faint,
    '--phosphor-bg': t.background,
    '--phosphor-glow': withAlpha(t.base, 0.35),
    '--chrome-bg': chrome.bg,
    '--chrome-fg': chrome.fg,
    '--chrome-dim': chrome.dim,
    '--chrome-hover': chrome.hover,
    '--chrome-border': chrome.border,
    '--accent': chrome.accent,
    '--panel-bg': chrome.panel,
    '--popup-bg': chrome.popup,
    '--field-bg': chrome.field,
    '--term-bg': termBg
  }
}
