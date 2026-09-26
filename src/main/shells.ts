import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { CustomProfile, ShellProfile } from '@shared/settings'

const env = process.env
const SYSTEM_ROOT = env.SystemRoot ?? 'C:\\Windows'
const PROGRAM_FILES = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean) as string[]

function findOnPath(exe: string): string | undefined {
  for (const dir of (env.Path ?? env.PATH ?? '').split(';')) {
    if (!dir) continue
    const p = join(dir, exe)
    if (existsSync(p)) return p
  }
  return undefined
}

const firstExisting = (paths: Array<string | undefined>): string | undefined =>
  paths.find((p): p is string => !!p && existsSync(p))

function findPwsh(): string | undefined {
  return firstExisting([
    ...PROGRAM_FILES.map((pf) => join(pf, 'PowerShell', '7', 'pwsh.exe')),
    findOnPath('pwsh.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ])
}

function findGitBash(): string | undefined {
  const git = findOnPath('git.exe') // usually <Git>\cmd\git.exe
  return firstExisting([
    ...PROGRAM_FILES.map((pf) => join(pf, 'Git', 'bin', 'bash.exe')),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    git && join(dirname(dirname(git)), 'bin', 'bash.exe')
  ])
}

/** `wsl -l -q` prints UTF-16LE unless WSL_UTF8 is honoured; handle both. */
function decodeWslOutput(buf: Buffer): string {
  const looksUtf16 = buf.length > 1 && buf.includes(0)
  return (looksUtf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '')
}

function listWslDistros(): Promise<string[]> {
  const wsl = join(SYSTEM_ROOT, 'System32', 'wsl.exe')
  if (!existsSync(wsl)) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      wsl,
      ['--list', '--quiet'],
      { encoding: 'buffer', timeout: 5000, windowsHide: true, env: { ...env, WSL_UTF8: '1' } },
      (err, stdout) => {
        // The inbox stub exits non-zero with a "not installed" message when WSL is absent.
        if (err) return resolve([])
        const names = decodeWslOutput(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !/^docker-desktop(-data)?$/i.test(s))
        resolve(names)
      }
    )
  })
}

/**
 * macOS / Linux: the user's login shell ($SHELL) first, then other common shells that exist.
 * macOS terminals start login shells (so ~/.zprofile runs); Linux ones usually don't.
 */
function detectPosixProfiles(): ShellProfile[] {
  const listed = existsSync('/etc/shells')
    ? readFileSync('/etc/shells', 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('/'))
    : []
  const candidates = [env.SHELL, ...['zsh', 'bash', 'fish', 'sh'].flatMap((n) => [`/bin/${n}`, `/usr/bin/${n}`, `/usr/local/bin/${n}`, `/opt/homebrew/bin/${n}`]), ...listed]
  const args = process.platform === 'darwin' ? ['-l'] : []
  const seen = new Set<string>()
  const profiles: ShellProfile[] = []
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue
    const name = basename(path)
    if (seen.has(name) || !['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu'].includes(name)) continue
    seen.add(name)
    profiles.push({ id: name, name: name === basename(env.SHELL ?? '') ? `${name} (login shell)` : name, command: path, args, kind: 'posix' })
  }
  if (!profiles.length) profiles.push({ id: 'sh', name: 'sh', command: '/bin/sh', args: [], kind: 'posix' })
  return profiles
}

/** Shells found by file checks only (fast). On Windows, in a Windows-Terminal-like order. */
export function detectLocalProfiles(): ShellProfile[] {
  if (process.platform !== 'win32') return detectPosixProfiles()
  const profiles: ShellProfile[] = []
  const pwsh = findPwsh()
  if (pwsh) profiles.push({ id: 'pwsh', name: 'PowerShell', command: pwsh, args: ['-NoLogo'], kind: 'pwsh' })
  const winPs = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(winPs)) {
    profiles.push({ id: 'powershell', name: 'Windows PowerShell', command: winPs, args: ['-NoLogo'], kind: 'powershell' })
  }
  profiles.push({
    id: 'cmd',
    name: 'Command Prompt',
    command: env.ComSpec ?? join(SYSTEM_ROOT, 'System32', 'cmd.exe'),
    args: [],
    kind: 'cmd'
  })
  const bash = findGitBash()
  if (bash) {
    profiles.push({
      id: 'gitbash',
      name: 'Git Bash',
      command: bash,
      args: ['--login', '-i'],
      // Keep the starting directory instead of cd-ing to $HOME in /etc/profile.
      env: { CHERE_INVOKING: '1', MSYSTEM: 'MINGW64' },
      kind: 'gitbash'
    })
  }
  return profiles
}

export async function detectWslProfiles(): Promise<ShellProfile[]> {
  if (process.platform !== 'win32') return []
  return (await listWslDistros()).map((distro) => ({
    id: `wsl:${distro}`,
    name: distro,
    command: join(SYSTEM_ROOT, 'System32', 'wsl.exe'),
    args: ['-d', distro, '--cd', '~'],
    kind: 'wsl' as const
  }))
}

export function customToProfiles(custom: CustomProfile[]): ShellProfile[] {
  return custom
    .filter((c) => c && typeof c.name === 'string' && typeof c.command === 'string')
    .map((c, i) => ({
      id: `custom:${i}:${c.name}`,
      name: c.name,
      command: c.command,
      args: Array.isArray(c.args) ? c.args.map(String) : [],
      cwd: c.cwd,
      env: c.env,
      kind: 'custom' as const
    }))
}
