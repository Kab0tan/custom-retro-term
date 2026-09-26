import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'

interface WindowState {
  bounds: Rectangle
  maximized: boolean
}

const file = (): string => join(app.getPath('userData'), 'window-state.json')
const DEFAULT: WindowState = { bounds: { x: 0, y: 0, width: 1100, height: 700 }, maximized: false }

function onSomeScreen(b: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: w }) => {
    const overlapX = Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x)
    const overlapY = Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y)
    return overlapX > 100 && overlapY > 50
  })
}

function centered(width: number, height: number): Rectangle {
  const { workArea: w } = screen.getPrimaryDisplay()
  return { width, height, x: Math.round(w.x + (w.width - width) / 2), y: Math.round(w.y + (w.height - height) / 2) }
}

export function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as WindowState
    if (s?.bounds && onSomeScreen(s.bounds)) return s
  } catch {
    // First run or unreadable: fall through to default.
  }
  return { ...DEFAULT, bounds: centered(DEFAULT.bounds.width, DEFAULT.bounds.height) }
}

/** New windows after the first are cascaded so they don't stack exactly. */
export function cascade(b: Rectangle, n: number): Rectangle {
  const shifted = { ...b, x: b.x + 28 * n, y: b.y + 28 * n }
  return onSomeScreen(shifted) ? shifted : b
}

export function saveWindowState(win: BrowserWindow): void {
  try {
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
    writeFileSync(file(), JSON.stringify(state))
  } catch (err) {
    console.warn('[window-state] save failed:', err)
  }
}
