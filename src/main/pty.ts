import { existsSync } from 'node:fs'
import os from 'node:os'
import { app, ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type { ShellProfile } from '@shared/settings'
import type { PtySpawnRequest, PtySpawnResult } from '@shared/types'
import { getSettings } from './settings'
import { resolveProfile } from './profiles'

/**
 * Flow control: stop reading from the shell while the renderer has this many
 * characters it hasn't parsed yet, so a runaway build can't freeze the UI.
 */
const HIGH_WATERMARK = 200_000
const LOW_WATERMARK = 20_000
/** Output is coalesced for this long before one IPC message is sent. */
const BATCH_MS = 5

interface Session {
  id: number
  owner: WebContents
  proc: pty.IPty
  buffer: string
  timer: NodeJS.Timeout | null
  unacked: number
  paused: boolean
}

const sessions = new Map<number, Session>()
let nextId = 1

// Variables Electron / electron-vite inject into our own process; they must not leak into shells.
const INJECTED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ELECTRON_NO_ATTACH_CONSOLE']

function buildEnv(profile: ShellProfile): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of INJECTED_ENV) delete env[k]
  if (!app.isPackaged) delete env.NODE_ENV
  env.TERM_PROGRAM = 'CRTTerminal'
  env.TERM_PROGRAM_VERSION = app.getVersion()
  env.COLORTERM = 'truecolor'
  // Apps started from the macOS Dock/Finder get no locale; shells would fall back to ASCII.
  if (process.platform !== 'win32' && !env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8'
  return { ...env, ...profile.env }
}

const UTF8_PS =
  '$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding'

function buildArgs(profile: ShellProfile, forceUtf8: boolean): string[] {
  if (!forceUtf8) return profile.args
  if (profile.kind === 'pwsh' || profile.kind === 'powershell') {
    return [...profile.args, '-NoExit', '-Command', UTF8_PS]
  }
  if (profile.kind === 'cmd') return [...profile.args, '/K', 'chcp 65001 >nul']
  return profile.args
}

/** ~, %VAR% (Windows) and $VAR / ${VAR} (POSIX) in a profile's cwd. */
function expandPath(p: string): string {
  return p
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
    .replace(/\$(\w+)|\$\{(\w+)\}/g, (m, a, b) => process.env[a ?? b] ?? m)
}

function resolveCwd(requested: string | undefined, profile: ShellProfile): string {
  const home = os.homedir()
  const cwd = requested ?? (profile.cwd ? expandPath(profile.cwd) : home)
  return existsSync(cwd) ? cwd : home
}

function flush(s: Session): void {
  s.timer = null
  if (!s.buffer || s.owner.isDestroyed()) return
  const data = s.buffer
  s.buffer = ''
  s.unacked += data.length
  s.owner.send('pty:data', s.id, data)
  if (!s.paused && s.unacked > HIGH_WATERMARK) {
    s.paused = true
    s.proc.pause()
  }
}

function kill(s: Session): void {
  sessions.delete(s.id)
  if (s.timer) clearTimeout(s.timer)
  try {
    s.proc.kill()
  } catch {
    // Already gone.
  }
}

async function spawn(owner: WebContents, req: PtySpawnRequest): Promise<PtySpawnResult> {
  const profile = await resolveProfile(req.profileId)
  const settings = getSettings()
  const proc = pty.spawn(profile.command, buildArgs(profile, settings.forceUtf8), {
    name: 'xterm-256color',
    cols: Math.max(2, req.cols),
    rows: Math.max(1, req.rows),
    cwd: resolveCwd(req.cwd, profile),
    env: buildEnv(profile),
    useConpty: true,
    useConptyDll: settings.useBundledConpty
  })
  const s: Session = { id: nextId++, owner, proc, buffer: '', timer: null, unacked: 0, paused: false }
  sessions.set(s.id, s)

  proc.onData((data) => {
    s.buffer += data
    if (!s.timer) s.timer = setTimeout(() => flush(s), BATCH_MS)
  })
  proc.onExit(({ exitCode }) => {
    if (!sessions.has(s.id)) return // killed by us
    if (s.timer) clearTimeout(s.timer)
    flush(s)
    sessions.delete(s.id)
    if (!owner.isDestroyed()) owner.send('pty:exit', s.id, exitCode)
  })
  return { id: s.id, pid: proc.pid, profile: { id: profile.id, name: profile.name, kind: profile.kind } }
}

function own(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, id: number): Session | undefined {
  const s = sessions.get(id)
  return s && s.owner === e.sender ? s : undefined
}

export function registerPtyIpc(): void {
  const tracked = new WeakSet<WebContents>()
  ipcMain.handle('pty:spawn', (e, req: PtySpawnRequest) => {
    if (!tracked.has(e.sender)) {
      // First shell in this renderer (or a reload): its shells die with it.
      tracked.add(e.sender)
      const cleanup = (): void => {
        for (const s of [...sessions.values()]) if (s.owner === e.sender) kill(s)
      }
      e.sender.once('destroyed', cleanup)
      e.sender.on('did-start-navigation', (_ev, _url, _inPlace, isMainFrame) => isMainFrame && cleanup())
    }
    return spawn(e.sender, req)
  })
  ipcMain.on('pty:write', (e, id: number, data: string) => own(e, id)?.proc.write(data))
  ipcMain.on('pty:resize', (e, id: number, cols: number, rows: number) => {
    const s = own(e, id)
    if (s && cols > 0 && rows > 0) {
      try {
        s.proc.resize(cols, rows)
      } catch {
        // Resizing a pty that is exiting throws; harmless.
      }
    }
  })
  ipcMain.on('pty:ack', (e, id: number, chars: number) => {
    const s = own(e, id)
    if (!s) return
    s.unacked = Math.max(0, s.unacked - chars)
    if (s.paused && s.unacked < LOW_WATERMARK) {
      s.paused = false
      s.proc.resume()
    }
  })
  ipcMain.on('pty:kill', (e, id: number) => {
    const s = own(e, id)
    if (s) kill(s)
  })
}

export function killAllPtys(): void {
  for (const s of [...sessions.values()]) kill(s)
}
