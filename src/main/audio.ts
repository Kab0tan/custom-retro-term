import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } from 'electron'
import { getSettings } from './settings'

/**
 * System audio for plugins (spectrum): Windows loopback capture, analysed locally in
 * the UI (never recorded or sent anywhere). Only granted once the user has allowed it
 * (Settings → Plugins, or the prompt a plugin can trigger).
 */
/**
 * Must run before app ready. The analyser's AudioContext is created without a user gesture
 * (e.g. when consent was given in an earlier session); Chromium would keep it suspended, which
 * reads as silence.
 */
export function allowAudioWithoutGesture(): void {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
}

export function initAudio(): void {
  // Screen source id for the loopback capture path in the UI (desktop capture needs one).
  // Loopback (system audio) capture is a Windows feature of Chromium's desktop capture.
  ipcMain.handle('audio:screenSource', async () => {
    if (process.platform !== 'win32') return { id: null, supported: false }
    if (!getSettings().audioCapture) return { id: null, supported: true }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    return { id: sources[0]?.id ?? null, supported: true }
  })

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (process.platform !== 'win32' || !getSettings().audioCapture || !request.audioRequested) {
        callback({})
        return
      }
      // getDisplayMedia always needs a video source; the UI stops that track immediately.
      void desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )

  ipcMain.handle('dialog:confirmAudio', async (e, pluginName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Analyse system audio?',
      message: `${String(pluginName).slice(0, 40)} wants to visualise what your PC is playing.`,
      detail:
        'The sound is analysed live inside CRT Terminal to draw waveforms and spectra. It is never recorded, saved or sent anywhere. You can turn this off in Settings → Plugins.',
      buttons: ['Allow', 'Not now'],
      defaultId: 0,
      cancelId: 1
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return r.response === 0
  })
}
