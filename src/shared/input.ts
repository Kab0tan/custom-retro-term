/**
 * Converts DOM keyboard events into Electron `sendInputEvent` payloads, used to
 * forward input from the visible compositor window into the offscreen UI.
 * Plain objects only, so this module works in main and renderer alike.
 */

export interface KeyLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat?: boolean
}

export type ForwardedInputEvent =
  | { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers: string[] }
  | {
      type: 'mouseDown' | 'mouseUp' | 'mouseMove'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right'
      clickCount?: number
      modifiers: string[]
    }
  | {
      type: 'mouseWheel'
      x: number
      y: number
      deltaX: number
      deltaY: number
      wheelTicksX?: number
      wheelTicksY?: number
      hasPreciseScrollingDeltas?: boolean
      canScroll: boolean
      modifiers: string[]
    }

// DOM `key` → Electron accelerator key code, for keys whose names differ.
const KEY_NAMES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert'
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

export function modifiersOf(
  e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; buttons?: number },
  repeat = false
): string[] {
  const m: string[] = []
  // Held mouse buttons, so drags (text selection) work on the forwarded side.
  if (e.buttons) {
    if (e.buttons & 1) m.push('leftButtonDown')
    if (e.buttons & 2) m.push('rightButtonDown')
    if (e.buttons & 4) m.push('middleButtonDown')
  }
  if (e.ctrlKey) m.push('control')
  if (e.shiftKey) m.push('shift')
  if (e.altKey) m.push('alt')
  if (e.metaKey) m.push('meta')
  if (repeat) m.push('isAutoRepeat')
  return m
}

function keyCodeOf(key: string): string | null {
  if (KEY_NAMES[key]) return KEY_NAMES[key]
  if (/^F\d{1,2}$/.test(key)) return key
  if (key.length === 1) return key.toUpperCase()
  return null
}

/**
 * Keys that produce text are left to a textarea in the host, so dead keys (^ then e),
 * AltGr, IME and the emoji picker compose natively; the result is sent as text.
 * AltGr arrives as Ctrl+Alt on Windows.
 */
export function producesText(e: KeyLike): boolean {
  if (e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return true
  const altGr = e.ctrlKey && e.altKey
  return [...e.key].length === 1 && (altGr || (!e.ctrlKey && !e.altKey && !e.metaKey))
}

/** A non-text key (Enter, arrows, Ctrl/Alt chords…) as an Electron key event. */
export function keyDownEvents(e: KeyLike): ForwardedInputEvent[] {
  if (MODIFIER_KEYS.has(e.key)) return []
  const keyCode = keyCodeOf(e.key)
  return keyCode ? [{ type: 'keyDown', keyCode, modifiers: modifiersOf(e, e.repeat) }] : []
}

export function keyUpEvents(e: KeyLike): ForwardedInputEvent[] {
  const keyCode = keyCodeOf(e.key)
  return keyCode && !MODIFIER_KEYS.has(e.key) ? [{ type: 'keyUp', keyCode, modifiers: modifiersOf(e) }] : []
}
