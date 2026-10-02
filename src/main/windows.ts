import os from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { NEUTRAL_CHROME, phosphorChrome, PHOSPHORS, type ChromeTokens } from '@shared/phosphor'
import type { CrtRenderer, Settings } from '@shared/settings'
import type { PlatformInfo } from '@shared/types'
import { openComposited } from './crt/compositor'
import { getSettings, settingsEvents } from './settings'
import { cascade, loadWindowState, saveWindowState } from './windowState'

const TITLEBAR_HEIGHT = 36
const IS_MAC = process.platform === 'darwin'

/** Native chrome (title-bar overlay, window background) from the same tokens as the UI. */
function chrome(s: Settings = getSettings()): ChromeTokens {
  return s.colorScheme === 'campbell' ? NEUTRAL_CHROME : phosphorChrome(PHOSPHORS[s.phosphor])
}

/**
 * The renderer is fixed for the app's lifetime (switching it means new windows and new shells),
 * so a change in settings applies on next launch. CRT_MODE=webgl|css overrides it for development.
 */
let renderer: CrtRenderer = 'webgl'
export function initRenderer(): void {
  const env = process.env.CRT_MODE
  renderer = env === 'webgl' || env === 'css' ? env : getSettings().crt.renderer
}

interface TerminalWindow {
  win: BrowserWindow
  /** WebContents running the UI; differs from win.webContents in webgl mode. */
  ui: WebContents
  /** Shells open in it: panes across all tabs. */
  shellCount: number
  closeConfirmed: boolean
}

const windows = new Map<number, TerminalWindow>() // keyed by ui.id

const preloadPath = (name: 'index' | 'compositor'): string => join(__dirname, `../preload/${name}.js`)

function loadPage(wc: WebContents, page: 'index' | 'compositor', query: Record<string, string>): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(`${devUrl}/${page}.html`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    return wc.loadURL(url.toString())
  }
  return wc.loadFile(join(__dirname, `../renderer/${page}.html`), { query })
}

/** A terminal must never navigate away or open popups; links go through shell:openExternal. */
function harden(wc: WebContents): void {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault()
  })
  wc.setVisualZoomLevelLimits(1, 1)
}

function track(tw: TerminalWindow): void {
  const { win, ui } = tw
  windows.set(ui.id, tw)
  win.on('close', (e) => {
    saveWindowState(win)
    if (tw.closeConfirmed || tw.shellCount <= 1 || !getSettings().confirmCloseMultipleTabs) return
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'Close window?',
      message: `Close all ${tw.shellCount} shells?`,
      detail: 'Every shell in this window (tabs and split panes) will be stopped.',
      buttons: ['Close all', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice === 0) {
      tw.closeConfirmed = true
      win.close()
    }
  })
  win.on('closed', () => windows.delete(ui.id))
  const sendMaximized = (): void => {
    if (!ui.isDestroyed()) ui.send('window:maximized', win.isMaximized())
  }
  win.on('maximize', sendMaximized)
  win.on('unmaximize', sendMaximized)
  ui.on('did-finish-load', sendMaximized)
  const title = (): void => {
    if (!win.isDestroyed()) win.setTitle(ui.getTitle() || 'CRT Terminal')
  }
  ui.on('page-title-updated', title)
}

export async function createWindow(): Promise<BrowserWindow> {
  const state = loadWindowState()
  const bounds = windows.size ? cascade(state.bounds, windows.size) : state.bounds

  if (renderer === 'webgl') {
    const c = await openComposited({ bounds, preloadPath, loadPage, maximized: state.maximized && windows.size === 0 })
    harden(c.win.webContents)
    harden(c.ui)
    track({ win: c.win, ui: c.ui, shellCount: 1, closeConfirmed: false })
    return c.win
  }

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 240,
    show: false,
    title: 'CRT Terminal',
    backgroundColor: chrome().bg,
    // Windows/Linux: tabs in the title bar with native caption buttons drawn over it.
    // macOS: native traffic lights, inset into the tab bar.
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: chrome().bg, symbolColor: chrome().fg, height: TITLEBAR_HEIGHT } }),
    webPreferences: { preload: preloadPath('index'), sandbox: true, contextIsolation: true, spellcheck: false }
  })
  harden(win.webContents)
  track({ win, ui: win.webContents, shellCount: 1, closeConfirmed: false })
  // Phosphor changes recolour Windows' caption buttons live too.
  const recolour = (s: Settings): void => {
    if (win.isDestroyed()) return
    const c = chrome(s)
    if (!IS_MAC) win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT })
    win.setBackgroundColor(c.bg)
  }
  settingsEvents.on('changed', recolour)
  win.on('closed', () => settingsEvents.off('changed', recolour))
  win.once('ready-to-show', () => {
    if (state.maximized && windows.size === 1) win.maximize()
    win.show()
  })
  await loadPage(win.webContents, 'index', {})
  return win
}

const fromUi = (wc: WebContents): TerminalWindow | undefined => windows.get(wc.id)

/** Whether a UI's window is on screen (not minimised or hidden); the data hub skips hidden ones. */
export function isUiVisible(wc: WebContents): boolean {
  const w = fromUi(wc)?.win
  return !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized()
}

export function registerWindowIpc(): void {
  ipcMain.handle(
    'app:platform',
    (): PlatformInfo => ({
      windowsBuild: Number(os.release().split('.')[2]) || 0,
      hostname: os.hostname(),
      frame: IS_MAC ? 'mac' : renderer === 'webgl' ? 'custom' : 'overlay',
      renderer,
      os: process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32'
    })
  )
  ipcMain.on('window:new', () => void createWindow())
  ipcMain.on('window:close', (e) => {
    const tw = fromUi(e.sender)
    if (!tw) return
    tw.closeConfirmed = true // the renderer only asks once its shells are gone
    tw.win.close()
  })
  ipcMain.on('window:shellCount', (e, n: number) => {
    const tw = fromUi(e.sender)
    if (tw) tw.shellCount = n
  })
  ipcMain.on('window:toggleFullscreen', (e) => {
    const tw = fromUi(e.sender)
    if (tw) tw.win.setFullScreen(!tw.win.isFullScreen())
  })
  ipcMain.on('window:toggleDevTools', (e) => e.sender.toggleDevTools())
  // Caption buttons drawn by the UI (webgl renderer).
  ipcMain.on('window:minimize', (e) => fromUi(e.sender)?.win.minimize())
  ipcMain.on('window:toggleMaximize', (e) => {
    const w = fromUi(e.sender)?.win
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })
}
