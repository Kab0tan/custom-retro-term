/**
 * App shortcuts. Rules that keep them out of the shell's way:
 * - Everything app-level uses Ctrl+Shift (terminals can't distinguish Ctrl+Shift+letter from Ctrl+letter
 *   anyway, so shells don't bind them), plus Ctrl+Tab, Ctrl+=/-/0, Ctrl+, and F11, like Windows Terminal.
 * - Nothing uses Ctrl+Alt: on Windows AltGr arrives as Ctrl+Alt, and AZERTY/QWERTZ users type @ # { [ | \ with it.
 * - Ctrl+C / Ctrl+V only act as copy/paste when the settings say so (and Ctrl+C only with a selection).
 * - Letters match the layout's letter (`key`, so AZERTY's W is W); digits match the physical key (`code`,
 *   since AZERTY digits need Shift). Non-Latin layouts fall back to the physical key for letters.
 * - Alt+arrows and Ctrl+arrows stay with the shell (word moves, fish's prevd/nextd), and Ctrl+Shift+Up/Down
 *   already scroll, so pane navigation lives behind a tmux-style prefix (see resolvePrefixKey) and only the
 *   common pane actions get direct chords.
 */
import type { PaneDirection } from '@shared/panes'

export type Action =
  | { type: 'newTab'; profileIndex?: number }
  | { type: 'nextTab' }
  | { type: 'prevTab' }
  | { type: 'newWindow' }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'find' }
  | { type: 'zoom'; delta: number | 'reset' }
  | { type: 'settings' }
  | { type: 'tweaks' }
  | { type: 'fullscreen' }
  | { type: 'devtools' }
  | { type: 'scroll'; by: 'page' | 'line' | 'edge'; dir: -1 | 1 }
  | { type: 'splitPane'; dir: 'right' | 'bottom' }
  /** Closes the focused pane; the last pane takes its tab with it. */
  | { type: 'closePane' }
  | { type: 'focusPane'; dir: PaneDirection }
  | { type: 'resizePane'; dir: PaneDirection }
  | { type: 'zoomPane' }
  | { type: 'nextPane'; dir: 1 | -1 }
  | { type: 'swapPane'; dir: 1 | -1 }
  | { type: 'equalizePanes' }
  /** Arms the pane prefix: the next key is read by resolvePrefixKey. */
  | { type: 'panePrefix' }

export interface KeyContext {
  /** macOS: app shortcuts use Cmd, and every Ctrl chord goes to the shell. */
  mac?: boolean
  /** The key came from a terminal (not from a text field in the UI). */
  inTerminal: boolean
  hasSelection: boolean
  /** Alternate screen (vim, htop…) has no scrollback, so scroll keys go to the app. */
  altScreen: boolean
  ctrlVPastes: boolean
  ctrlCCopiesSelection: boolean
}

const digitOf = (e: KeyboardEvent): number | null => {
  const m = /^Digit([1-9])$/.exec(e.code)
  return m ? Number(m[1]) : null
}

/** The letter a-z this key produces on the current layout, e.g. 'w'. */
function letterOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  const m = /^Key([A-Z])$/.exec(e.code)
  return m && e.key.length === 1 && !/^[ -~]$/.test(e.key) ? m[1].toLowerCase() : null
}

/** macOS conventions (Terminal/iTerm): Cmd+T/W/N/C/V/F/D/,/=/-/0, Cmd+Shift+[ ] D Enter, Cmd+Ctrl+F. */
function resolveMac(e: KeyboardEvent, ctx: KeyContext): Action | null {
  if (!e.metaKey || e.altKey) return null
  const letter = letterOf(e)
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (e.ctrlKey) return letter === 'f' ? { type: 'fullscreen' } : null
  if (e.shiftKey) {
    const n = digitOf(e)
    if (n) return { type: 'newTab', profileIndex: n - 1 }
    if (e.code === 'BracketLeft') return { type: 'prevTab' }
    if (e.code === 'BracketRight') return { type: 'nextTab' }
    if (letter === 'e') return { type: 'tweaks' }
    if (letter === 'd') return { type: 'splitPane', dir: 'bottom' }
    if (e.key === 'Enter') return { type: 'zoomPane' }
    // Ctrl+Space is the input-source switch on macOS (and Ctrl chords belong to the shell there).
    if (e.code === 'Space' || e.key === ' ') return { type: 'panePrefix' }
    if (k === '+') return { type: 'zoom', delta: 1 }
    return null
  }
  switch (letter) {
    case 't':
      return { type: 'newTab' }
    case 'w':
      return { type: 'closePane' }
    case 'd':
      return { type: 'splitPane', dir: 'right' }
    case 'n':
      return { type: 'newWindow' }
    case 'f':
      return { type: 'find' }
    case 'c':
      return ctx.inTerminal ? { type: 'copy' } : null
    case 'v':
      return ctx.inTerminal ? { type: 'paste' } : null
  }
  if (k === '=' || k === '+') return { type: 'zoom', delta: 1 }
  if (k === '-') return { type: 'zoom', delta: -1 }
  if (k === '0') return { type: 'zoom', delta: 'reset' }
  if (k === ',') return { type: 'settings' }
  if (e.key === 'ArrowUp' && ctx.inTerminal && !ctx.altScreen) return { type: 'scroll', by: 'edge', dir: -1 }
  if (e.key === 'ArrowDown' && ctx.inTerminal && !ctx.altScreen) return { type: 'scroll', by: 'edge', dir: 1 }
  return null
}

export function resolveAction(e: KeyboardEvent, ctx: KeyContext): Action | null {
  if (ctx.mac) {
    if (e.code === 'KeyI' && e.metaKey && e.altKey) return { type: 'devtools' }
    if (e.key === 'Tab' && e.ctrlKey && !e.metaKey) return { type: e.shiftKey ? 'prevTab' : 'nextTab' }
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && ctx.inTerminal && !ctx.altScreen) {
      if (e.key === 'PageUp') return { type: 'scroll', by: 'page', dir: -1 }
      if (e.key === 'PageDown') return { type: 'scroll', by: 'page', dir: 1 }
    }
    return resolveMac(e, ctx)
  }
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey
  const shift = e.shiftKey
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const letter = letterOf(e)

  if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !shift) return { type: 'fullscreen' }

  if (ctrl && shift) {
    const n = digitOf(e)
    if (n) return { type: 'newTab', profileIndex: n - 1 }
    switch (letter) {
      case 't':
        return { type: 'newTab' }
      case 'w':
        return { type: 'closePane' }
      case 'n':
        return { type: 'newWindow' }
      case 'f':
        return { type: 'find' }
      case 'e':
        return { type: 'tweaks' }
      case 'd':
        return { type: 'splitPane', dir: 'right' }
      case 's':
        return { type: 'splitPane', dir: 'bottom' }
      case 'z':
        return { type: 'zoomPane' }
    }
    if (e.code === 'Space' || e.key === ' ') return { type: 'panePrefix' }
    if (e.key === 'F12') return { type: 'devtools' }
    if (e.key === 'Tab') return { type: 'prevTab' }
    // Layouts where + and 0 need Shift (AZERTY: Shift+= and Shift+0).
    if (k === '+') return { type: 'zoom', delta: 1 }
    if (e.code === 'Digit0') return { type: 'zoom', delta: 'reset' }
    if (ctx.inTerminal) {
      if (letter === 'c') return { type: 'copy' }
      if (letter === 'v') return { type: 'paste' }
      if (!ctx.altScreen) {
        if (e.key === 'ArrowUp') return { type: 'scroll', by: 'line', dir: -1 }
        if (e.key === 'ArrowDown') return { type: 'scroll', by: 'line', dir: 1 }
        if (e.key === 'Home') return { type: 'scroll', by: 'edge', dir: -1 }
        if (e.key === 'End') return { type: 'scroll', by: 'edge', dir: 1 }
      }
    }
    return null
  }

  if (ctrl) {
    if (e.key === 'Tab') return { type: 'nextTab' }
    if (k === '=' || k === '+' || e.code === 'NumpadAdd') return { type: 'zoom', delta: 1 }
    if ((k === '-' && !shift) || e.code === 'NumpadSubtract') return { type: 'zoom', delta: -1 }
    if (k === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return { type: 'zoom', delta: 'reset' }
    if (k === ',') return { type: 'settings' }
    if (ctx.inTerminal) {
      if (letter === 'c' && ctx.ctrlCCopiesSelection && ctx.hasSelection) return { type: 'copy' }
      if (letter === 'v' && ctx.ctrlVPastes) return { type: 'paste' }
      if (e.key === 'Insert') return { type: 'copy' }
    }
    return null
  }

  if (shift && !e.ctrlKey && !e.altKey && !e.metaKey && ctx.inTerminal) {
    if (e.key === 'Insert') return { type: 'paste' }
    if (!ctx.altScreen) {
      if (e.key === 'PageUp') return { type: 'scroll', by: 'page', dir: -1 }
      if (e.key === 'PageDown') return { type: 'scroll', by: 'page', dir: 1 }
    }
  }
  return null
}

const ARROWS: Record<string, PaneDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/**
 * The key pressed after the pane prefix (tmux keys): arrows focus, Shift+arrows resize, % and " split,
 * z zoom, x close, o next pane, { } swap, E spread evenly. Characters come from `key`, so they work on
 * any layout (AZERTY's % and ", AltGr's { }). Null for anything else, which just ends the prefix.
 */
export function resolvePrefixKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>): Action | null {
  const arrow = ARROWS[e.key]
  if (arrow) return e.shiftKey ? { type: 'resizePane', dir: arrow } : { type: 'focusPane', dir: arrow }
  switch (e.key) {
    case '%':
      return { type: 'splitPane', dir: 'right' }
    case '"':
      return { type: 'splitPane', dir: 'bottom' }
    case '{':
      return { type: 'swapPane', dir: -1 }
    case '}':
      return { type: 'swapPane', dir: 1 }
  }
  const letter = letterOf(e)
  if (letter === 'e' && (e.key === 'E' || e.shiftKey)) return { type: 'equalizePanes' }
  switch (letter) {
    case 'z':
      return { type: 'zoomPane' }
    case 'x':
      return { type: 'closePane' }
    case 'o':
      return { type: 'nextPane', dir: 1 }
  }
  return null
}

/** Shortcut hint shown next to profile N in the new-tab menu. */
export const profileShortcut = (index: number): string | null => (index < 9 ? `Ctrl+Shift+${index + 1}` : null)
