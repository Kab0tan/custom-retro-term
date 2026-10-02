import { describe, expect, it } from 'vitest'
import { resolveAction, resolvePrefixKey, type KeyContext } from '../src/renderer/src/keybindings'

interface Mods {
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
}

/** A keydown as the browser reports it: `key` is what the layout produces, `code` the physical key. */
const press = (key: string, code: string, m: Mods = {}): KeyboardEvent =>
  ({ type: 'keydown', key, code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta }) as KeyboardEvent

const TERM: KeyContext = { inTerminal: true, hasSelection: false, altScreen: false, ctrlVPastes: false, ctrlCCopiesSelection: false }
const MAC: KeyContext = { ...TERM, mac: true }

const CTRL_SHIFT = { ctrl: true, shift: true }

describe('pane chords (Windows / Linux)', () => {
  it('split, zoom, close and the prefix use Ctrl+Shift', () => {
    expect(resolveAction(press('D', 'KeyD', CTRL_SHIFT), TERM)).toEqual({ type: 'splitPane', dir: 'right' })
    expect(resolveAction(press('S', 'KeyS', CTRL_SHIFT), TERM)).toEqual({ type: 'splitPane', dir: 'bottom' })
    expect(resolveAction(press('Z', 'KeyZ', CTRL_SHIFT), TERM)).toEqual({ type: 'zoomPane' })
    expect(resolveAction(press('W', 'KeyW', CTRL_SHIFT), TERM)).toEqual({ type: 'closePane' })
    expect(resolveAction(press(' ', 'Space', CTRL_SHIFT), TERM)).toEqual({ type: 'panePrefix' })
  })

  it('also work outside a terminal (search box, settings)', () => {
    const ui = { ...TERM, inTerminal: false }
    expect(resolveAction(press('D', 'KeyD', CTRL_SHIFT), ui)).toEqual({ type: 'splitPane', dir: 'right' })
    expect(resolveAction(press(' ', 'Space', CTRL_SHIFT), ui)).toEqual({ type: 'panePrefix' })
  })

  it('follow the letter on AZERTY, not the physical key', () => {
    // AZERTY swaps Z/W and A/Q: Z sits on KeyW, W on KeyZ.
    expect(resolveAction(press('Z', 'KeyW', CTRL_SHIFT), TERM)).toEqual({ type: 'zoomPane' })
    expect(resolveAction(press('W', 'KeyZ', CTRL_SHIFT), TERM)).toEqual({ type: 'closePane' })
    expect(resolveAction(press('A', 'KeyQ', CTRL_SHIFT), TERM)).toBeNull()
    // Digits need Shift on AZERTY: Ctrl+Shift+& is still "new tab with profile 1".
    expect(resolveAction(press('1', 'Digit1', CTRL_SHIFT), TERM)).toEqual({ type: 'newTab', profileIndex: 0 })
  })

  it('fall back to the physical key on non-Latin layouts', () => {
    expect(resolveAction(press('В', 'KeyD', CTRL_SHIFT), TERM)).toEqual({ type: 'splitPane', dir: 'right' })
  })

  it('leave Ctrl+Shift+Up/Down to line scrolling', () => {
    expect(resolveAction(press('ArrowUp', 'ArrowUp', CTRL_SHIFT), TERM)).toEqual({ type: 'scroll', by: 'line', dir: -1 })
    expect(resolveAction(press('ArrowDown', 'ArrowDown', CTRL_SHIFT), TERM)).toEqual({ type: 'scroll', by: 'line', dir: 1 })
  })
})

describe('pane chords (macOS)', () => {
  it('use Cmd like iTerm2', () => {
    expect(resolveAction(press('d', 'KeyD', { meta: true }), MAC)).toEqual({ type: 'splitPane', dir: 'right' })
    expect(resolveAction(press('d', 'KeyD', { meta: true, shift: true }), MAC)).toEqual({ type: 'splitPane', dir: 'bottom' })
    expect(resolveAction(press('Enter', 'Enter', { meta: true, shift: true }), MAC)).toEqual({ type: 'zoomPane' })
    expect(resolveAction(press('w', 'KeyW', { meta: true }), MAC)).toEqual({ type: 'closePane' })
    expect(resolveAction(press(' ', 'Space', { meta: true, shift: true }), MAC)).toEqual({ type: 'panePrefix' })
  })

  it('never take a Ctrl chord', () => {
    expect(resolveAction(press('D', 'KeyD', CTRL_SHIFT), MAC)).toBeNull()
    expect(resolveAction(press('Z', 'KeyZ', CTRL_SHIFT), MAC)).toBeNull()
    expect(resolveAction(press(' ', 'Space', CTRL_SHIFT), MAC)).toBeNull()
    expect(resolveAction(press(' ', 'Space', { ctrl: true }), MAC)).toBeNull()
  })
})

describe('keys the shell needs', () => {
  const shellKeys: Array<[string, KeyboardEvent]> = [
    ['Ctrl+D (EOF)', press('d', 'KeyD', { ctrl: true })],
    ['Ctrl+S (forward search)', press('s', 'KeyS', { ctrl: true })],
    ['Ctrl+Z (suspend)', press('z', 'KeyZ', { ctrl: true })],
    ['Ctrl+W (delete word)', press('w', 'KeyW', { ctrl: true })],
    ['Ctrl+X', press('x', 'KeyX', { ctrl: true })],
    ['Ctrl+B (tmux prefix)', press('b', 'KeyB', { ctrl: true })],
    ['Ctrl+A (screen prefix)', press('a', 'KeyA', { ctrl: true })],
    ['Ctrl+Space (set mark)', press(' ', 'Space', { ctrl: true })],
    ['Alt+Left', press('ArrowLeft', 'ArrowLeft', { alt: true })],
    ['Alt+Right', press('ArrowRight', 'ArrowRight', { alt: true })],
    ['Alt+Up', press('ArrowUp', 'ArrowUp', { alt: true })],
    ['Alt+Down', press('ArrowDown', 'ArrowDown', { alt: true })],
    ['Alt+Shift+Left', press('ArrowLeft', 'ArrowLeft', { alt: true, shift: true })],
    ['Ctrl+Left', press('ArrowLeft', 'ArrowLeft', { ctrl: true })],
    ['Ctrl+Right', press('ArrowRight', 'ArrowRight', { ctrl: true })],
    ['Ctrl+Shift+Left (select word)', press('ArrowLeft', 'ArrowLeft', CTRL_SHIFT)],
    ['Ctrl+Shift+Right', press('ArrowRight', 'ArrowRight', CTRL_SHIFT)],
    ['Shift+Left', press('ArrowLeft', 'ArrowLeft', { shift: true })],
    ['Alt+D (kill word)', press('d', 'KeyD', { alt: true })],
    ['Alt+Z', press('z', 'KeyZ', { alt: true })],
    ['AltGr+D (Ctrl+Alt on Windows)', press('d', 'KeyD', { ctrl: true, alt: true })],
    ['AltGr+{ on AZERTY', press('{', 'Digit4', { ctrl: true, alt: true })],
    ['AltGr+Space', press(' ', 'Space', { ctrl: true, alt: true })],
    ['Shift+Space', press(' ', 'Space', { shift: true })],
    ['%', press('%', 'Digit5', { shift: true })],
    ['plain z', press('z', 'KeyZ')]
  ]

  for (const [name, e] of shellKeys) {
    it(`${name} goes to the shell`, () => {
      expect(resolveAction(e, TERM)).toBeNull()
      expect(resolveAction(e, MAC)).toBeNull()
    })
  }

  it('Option+letters and Option+arrows go to the shell on macOS', () => {
    expect(resolveAction(press('∂', 'KeyD', { alt: true }), MAC)).toBeNull()
    expect(resolveAction(press('ArrowLeft', 'ArrowLeft', { alt: true }), MAC)).toBeNull()
    expect(resolveAction(press('d', 'KeyD', { meta: true, alt: true }), MAC)).toBeNull()
  })
})

describe('resolvePrefixKey', () => {
  const key = (k: string, code: string, shiftKey = false): Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'> => ({ key: k, code, shiftKey })

  it('arrows move focus, Shift+arrows resize', () => {
    expect(resolvePrefixKey(key('ArrowLeft', 'ArrowLeft'))).toEqual({ type: 'focusPane', dir: 'left' })
    expect(resolvePrefixKey(key('ArrowRight', 'ArrowRight'))).toEqual({ type: 'focusPane', dir: 'right' })
    expect(resolvePrefixKey(key('ArrowUp', 'ArrowUp'))).toEqual({ type: 'focusPane', dir: 'up' })
    expect(resolvePrefixKey(key('ArrowDown', 'ArrowDown'))).toEqual({ type: 'focusPane', dir: 'down' })
    expect(resolvePrefixKey(key('ArrowLeft', 'ArrowLeft', true))).toEqual({ type: 'resizePane', dir: 'left' })
    expect(resolvePrefixKey(key('ArrowDown', 'ArrowDown', true))).toEqual({ type: 'resizePane', dir: 'down' })
  })

  it('reads tmux keys from the character typed (US layout)', () => {
    expect(resolvePrefixKey(key('%', 'Digit5', true))).toEqual({ type: 'splitPane', dir: 'right' })
    expect(resolvePrefixKey(key('"', 'Quote', true))).toEqual({ type: 'splitPane', dir: 'bottom' })
    expect(resolvePrefixKey(key('z', 'KeyZ'))).toEqual({ type: 'zoomPane' })
    expect(resolvePrefixKey(key('x', 'KeyX'))).toEqual({ type: 'closePane' })
    expect(resolvePrefixKey(key('o', 'KeyO'))).toEqual({ type: 'nextPane', dir: 1 })
    expect(resolvePrefixKey(key('{', 'BracketLeft', true))).toEqual({ type: 'swapPane', dir: -1 })
    expect(resolvePrefixKey(key('}', 'BracketRight', true))).toEqual({ type: 'swapPane', dir: 1 })
    expect(resolvePrefixKey(key('E', 'KeyE', true))).toEqual({ type: 'equalizePanes' })
    expect(resolvePrefixKey(key('e', 'KeyE'))).toBeNull()
  })

  it('works on AZERTY', () => {
    expect(resolvePrefixKey(key('%', 'Quote', true))).toEqual({ type: 'splitPane', dir: 'right' }) // Shift+ù
    expect(resolvePrefixKey(key('"', 'Digit3'))).toEqual({ type: 'splitPane', dir: 'bottom' })
    expect(resolvePrefixKey(key('{', 'Digit4'))).toEqual({ type: 'swapPane', dir: -1 }) // AltGr+'
    expect(resolvePrefixKey(key('}', 'Equal'))).toEqual({ type: 'swapPane', dir: 1 }) // AltGr+=
    expect(resolvePrefixKey(key('z', 'KeyW'))).toEqual({ type: 'zoomPane' })
    expect(resolvePrefixKey(key('x', 'KeyX'))).toEqual({ type: 'closePane' })
  })

  it('works with text from the webgl host (no code, no Shift flag)', () => {
    expect(resolvePrefixKey(key('%', ''))).toEqual({ type: 'splitPane', dir: 'right' })
    expect(resolvePrefixKey(key('E', ''))).toEqual({ type: 'equalizePanes' })
  })

  it('anything else ends the prefix', () => {
    expect(resolvePrefixKey(key('Escape', 'Escape'))).toBeNull()
    expect(resolvePrefixKey(key('q', 'KeyQ'))).toBeNull()
    expect(resolvePrefixKey(key(' ', 'Space'))).toBeNull()
  })
})
