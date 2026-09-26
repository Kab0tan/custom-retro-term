// Smoke test: spawn a shell via node-pty inside Electron's runtime and check that a command
// round-trips. PowerShell (ConPTY) on Windows, /bin/sh elsewhere. Run with `npm run smoke:pty`.
const { app } = require('electron')
const os = require('node:os')
const pty = require('node-pty')

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, '')
const win = process.platform === 'win32'

app.whenReady().then(() => {
  const marker = 'CRT_SMOKE_' + Date.now()
  // The echoed command contains `$(`; the real reply has a number after the colon.
  const reply = new RegExp(marker + ':[\\d.]+')
  const shell = win
    ? pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: os.homedir(), env: process.env, useConpty: true })
    : pty.spawn('/bin/sh', [], { name: 'xterm-256color', cols: 120, rows: 30, cwd: os.homedir(), env: process.env })
  let out = ''
  const timer = setTimeout(() => finish(false, 'timeout'), 15000)
  shell.onData((d) => {
    out += d
    if (reply.test(stripAnsi(out))) finish(true)
  })
  shell.write(win ? `Write-Output "${marker}:$($PSVersionTable.PSVersion)"\r` : `echo "${marker}:$((6 * 7))"\r`)

  function finish(ok, why) {
    clearTimeout(timer)
    const line = stripAnsi(out).match(reply)?.[0] ?? ''
    console.log(`electron=${process.versions.electron} node=${process.versions.node} platform=${process.platform}`)
    console.log(ok ? `PASS pid=${shell.pid} -> ${line}` : `FAIL (${why})\n${out}`)
    shell.kill()
    app.exit(ok ? 0 : 1)
  }
})
