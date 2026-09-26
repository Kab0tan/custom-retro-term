import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getSettings } from './settings'

/**
 * Auto-updates from GitHub Releases (electron-updater). Installed builds only, when the build has
 * a real publish target (electron-builder.yml → publish) and the user hasn't turned it off.
 * Updates download in the background; the user chooses when to restart.
 */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

function configured(): boolean {
  if (!app.isPackaged) return false
  const file = join(process.resourcesPath, 'app-update.yml')
  return existsSync(file) && !readFileSync(file, 'utf8').includes('YOUR_GITHUB_USER')
}

let status = 'Updates are checked in installed builds only.'

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    status = `Update check failed: ${(err as Error).message}`
  }
}

export function initUpdater(): void {
  ipcMain.handle('app:updateStatus', () => ({ version: app.getVersion(), status, enabled: configured() }))
  ipcMain.handle('app:checkUpdates', async () => {
    if (!configured()) return { version: app.getVersion(), status, enabled: false }
    await check()
    return { version: app.getVersion(), status, enabled: true }
  })
  if (!configured()) {
    status = app.isPackaged ? 'Auto-update is not configured for this build.' : status
    return
  }
  status = 'Up to date.'
  autoUpdater.autoDownload = true
  autoUpdater.on('update-available', (info) => (status = `Downloading ${info.version}…`))
  autoUpdater.on('update-not-available', () => (status = 'Up to date.'))
  autoUpdater.on('error', (err) => (status = `Update error: ${err.message}`))
  autoUpdater.on('update-downloaded', async (info) => {
    status = `${info.version} is ready to install.`
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'Update ready',
      message: `CRT Terminal ${info.version} is ready.`,
      detail: 'Restart now to install it? Open tabs will close. Otherwise it installs when you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (r.response === 0) autoUpdater.quitAndInstall()
  })
  if (getSettings().autoUpdate) {
    void check()
    setInterval(() => getSettings().autoUpdate && void check(), CHECK_EVERY_MS)
  }
}
