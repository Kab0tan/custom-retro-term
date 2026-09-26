import { BrowserWindow, ipcMain } from 'electron'
import type { ShellProfile } from '@shared/settings'
import { getSettings } from './settings'
import { customToProfiles, detectLocalProfiles, detectWslProfiles } from './shells'

// Local shells are found instantly; WSL needs `wsl.exe`, which can take seconds while its
// service starts, so it arrives later and must not hold up the first tab.
let local: ShellProfile[] = []
let wsl: ShellProfile[] = []
let wslReady: Promise<void> = Promise.resolve()

function detect(): void {
  local = detectLocalProfiles()
  wslReady = detectWslProfiles().then((found) => {
    const changed = JSON.stringify(found) !== JSON.stringify(wsl)
    wsl = found
    if (changed) for (const w of BrowserWindow.getAllWindows()) w.webContents.send('profiles:changed')
  })
}

function listProfiles(): ShellProfile[] {
  return [...local, ...wsl, ...customToProfiles(getSettings().customProfiles)]
}

/** Requested profile → the user's default → the first detected shell. */
export async function resolveProfile(id?: string | null): Promise<ShellProfile> {
  const wanted = id || getSettings().defaultProfile
  if (wanted.startsWith('wsl:')) await wslReady
  const all = listProfiles()
  return all.find((p) => p.id === wanted) ?? all[0]
}

export function registerProfileIpc(): void {
  detect()
  ipcMain.handle('profiles:list', async () => {
    const def = await resolveProfile(null)
    return { profiles: listProfiles(), defaultId: def.id }
  })
}
