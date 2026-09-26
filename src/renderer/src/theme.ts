import type { ITheme } from '@xterm/xterm'
import type { Settings } from '@shared/settings'
import { cssVariables, NEUTRAL_CHROME, phosphorChrome, phosphorPalette, PHOSPHORS } from '@shared/phosphor'

/** Windows Terminal "Campbell", so output looks the way Windows tools expect. */
export const campbell: ITheme = {
  background: '#0c0c0c',
  foreground: '#cccccc',
  cursor: '#ffffff',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#ffffff40',
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#0037da',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2',
  scrollbarSliderBackground: '#ffffff22',
  scrollbarSliderHoverBackground: '#ffffff44',
  scrollbarSliderActiveBackground: '#ffffff66'
}

/** Terminal colours for the current settings: generated from the phosphor tokens, or Campbell. */
export function terminalTheme(s: Pick<Settings, 'phosphor' | 'colorScheme'>): ITheme {
  return s.colorScheme === 'campbell' ? campbell : phosphorPalette(PHOSPHORS[s.phosphor])
}

/** CSS variables for the app chrome and for plugins (`--phosphor-*`). */
export function uiVariables(s: Pick<Settings, 'phosphor' | 'colorScheme'>): Record<string, string> {
  const t = PHOSPHORS[s.phosphor]
  const chrome = s.colorScheme === 'campbell' ? NEUTRAL_CHROME : phosphorChrome(t)
  return cssVariables(t, chrome, terminalTheme(s).background!)
}

/** Fallbacks after the user's font: a safe monospace, then colour emoji and symbols. */
export function fontStack(family: string): string {
  const user = family.includes(',') || family.includes('"') ? family : `"${family}"`
  // Per-OS monospace fallbacks, then colour emoji for each OS.
  return `${user}, "IBM Plex Mono", "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", "Segoe UI Emoji", "Segoe UI Symbol", "Apple Color Emoji", "Noto Color Emoji", monospace`
}

/**
 * Whether a font is installed. `document.fonts.check()` can't tell (it reports true for any
 * system font name), so compare text widths against generic fallbacks instead.
 */
export function isFontInstalled(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return true
  const sample = 'mmmmmmmmmmlli10WW@'
  return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
    ctx.font = `72px ${fallback}`
    const base = ctx.measureText(sample).width
    ctx.font = `72px "${family}", ${fallback}`
    return ctx.measureText(sample).width !== base
  })
}
