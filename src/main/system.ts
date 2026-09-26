import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'

/** Clipboard, links and dialogs, which sandboxed renderers can't do themselves. */
export function registerSystemIpc(): void {
  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.on('clipboard:writeText', (_e, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  ipcMain.on('shell:openExternal', (_e, url: string) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') void shell.openExternal(u.toString())
    } catch {
      // Not a URL; ignore.
    }
  })

  ipcMain.handle('dialog:confirmPaste', async (e, lines: number, preview: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Paste multiple lines?',
      message: `You are about to paste ${lines} lines.`,
      detail: `Each line may run as a separate command.\n\n${preview}`,
      buttons: ['Paste', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "Don't warn me again"
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return { ok: r.response === 0, dontAskAgain: r.checkboxChecked }
  })
}
