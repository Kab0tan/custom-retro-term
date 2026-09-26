import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { registerProfileIpc } from './profiles'
import { killAllPtys, registerPtyIpc } from './pty'
import { initSettings } from './settings'
import { registerSystemIpc } from './system'
import { createWindow, initRenderer, isUiVisible, registerWindowIpc } from './windows'
import { initDataHub, stopDataHub } from './data/hub'
import { initPlugins, registerPluginScheme } from './plugins'
import { registerPluginInstallIpc } from './pluginInstall'
import { allowAudioWithoutGesture, initAudio } from './audio'
import { initUpdater } from './updater'

// No application menu on Windows/Linux: its accelerators (Ctrl+W, Ctrl+R…) would steal keys from the
// shell. macOS needs one for Cmd+Q/H/M; it has no Edit menu, so Cmd+C/V reach the terminal's own handling.
Menu.setApplicationMenu(
  process.platform === 'darwin'
    ? Menu.buildFromTemplate([
        { role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
        { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
      ])
    : null
)
nativeTheme.themeSource = 'dark'
registerPluginScheme()
allowAudioWithoutGesture()

app.whenReady().then(async () => {
  initSettings()
  initRenderer()
  registerPtyIpc()
  registerProfileIpc()
  registerSystemIpc()
  registerWindowIpc()
  initDataHub({ isVisible: isUiVisible })
  initPlugins()
  registerPluginInstallIpc()
  initAudio()
  await createWindow()
  initUpdater()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  killAllPtys()
  stopDataHub()
})
