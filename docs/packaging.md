# Packaging and other platforms

## Building installers

| Command | Output (in `dist/`) | Where it must run |
|---|---|---|
| `npm run dist:win` | `CRT Terminal-Setup-<version>.exe` (NSIS, per-user, choose folder) | Windows |
| `npm run dist:mac` | `.dmg` + `.zip` (the zip feeds auto-update), x64 or arm64 | macOS |
| `npm run dist:linux` | `.AppImage` + `.deb` | Linux |

Config: [electron-builder.yml](../electron-builder.yml). Bundled plugins, the plugin runtime and the template ship as
`resources/` next to the app (outside the asar), and node-pty is unpacked because native modules must be real files.

**CI**: [.github/workflows/release.yml](../.github/workflows/release.yml) builds all three on GitHub's Windows, macOS and
Linux runners. Run it manually for downloadable artifacts, or push a tag (`git tag v0.1.0 && git push --tags`) to publish a
GitHub Release.

## Auto-updates

electron-updater reads GitHub Releases. To turn it on:
1. Set `publish.owner` / `publish.repo` in electron-builder.yml (and `homepage` in package.json) to your repository.
2. Publish releases through the workflow above (it uploads the `latest*.yml` files the updater needs).

Installed builds then check at startup and every 6 hours, download in the background, and ask before restarting
(otherwise the update installs when you quit). Settings → Updates: version, status, *Check now*, and an on/off switch.
Until the owner is set, the app skips update checks and says so.

## Code signing (optional)

| Platform | What you need | Environment / CI secrets |
|---|---|---|
| Windows | An OV/EV code-signing certificate (.pfx), or Azure Trusted Signing. Unsigned installers trigger SmartScreen until they build reputation. | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |
| macOS | Apple Developer ID Application certificate + notarization (Gatekeeper blocks unsigned apps downloaded from the web) | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Linux | Not required | — |

With the macOS secrets set, electron-builder signs with the hardened runtime ([build/entitlements.mac.plist](../build/entitlements.mac.plist))
and notarizes. With none set, builds are unsigned but work: on macOS use right-click → Open the first time.

## Platform differences

| | Windows | macOS | Linux |
|---|---|---|---|
| Default shells | PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL distros | `$SHELL` (zsh) as a login shell, plus bash, fish… | `$SHELL` (bash), plus zsh, fish… |
| Terminal | ConPTY (+ reflow hints) | pty | pty |
| Window chrome | Tabs in the title bar; caption buttons native (CSS renderer) or drawn in the CRT (WebGL) | Native traffic lights, tabs beside them | Like Windows |
| Shortcuts | Ctrl+Shift+… (Ctrl stays with the shell) | ⌘T/W/N/C/V/F/,/=/-/0, ⌘⇧[ ], ⌘⌃F full screen (Ctrl stays with the shell) | Like Windows |
| CRT frames | GPU shared texture (D3D) | GPU shared texture (IOSurface) | CPU copy (set `CRT_TRANSPORT=shared` to try the GPU path) |
| Network / connections | .NET via one PowerShell process | `netstat` | `/proc/net` |
| Devices | PnP devices, Bluetooth properties, monitor connectors (same PowerShell process) | `system_profiler`, `networksetup` | `/sys/bus/usb`, `bluetoothctl`, `/sys/class/net` |
| Temperature | ACPI thermal zones (often N/A without admin) | N/A (not exposed to apps) | `/sys/class/thermal` |
| Kernel log | Windows System event log | `log stream` (kernel) | `journalctl -k` (needs the `systemd-journal`/`adm` group, else a note in the log) |
| System audio (spectrum) | Loopback capture | Not yet (panels say so) | Not yet (panels say so) |
| Settings / plugins | `%APPDATA%\crt-terminal` | `~/Library/Application Support/crt-terminal` | `~/.config/crt-terminal` |

## Manual test checklist, per OS

Run on each of Windows 10/11, macOS (Apple silicon and Intel if possible) and one Linux desktop (e.g. Ubuntu, both X11 and Wayland):

- [ ] Installer runs; the app starts from the Start menu / Applications / AppImage
- [ ] Default shell opens and works (vim, htop/top, a long build)
- [ ] **CRT rendering**: curvature, bloom, scanlines visible; Ctrl+Shift+F10 HUD shows ~60 draws/s when animating and ~0 when idle
- [ ] CSS renderer fallback (Settings → Rendering → CSS overlay → Restart) works
- [ ] Window: move by the tab bar, resize, maximise, full screen; macOS traffic lights sit in the tab bar
- [ ] Shortcuts: new tab/close/copy/paste/find with the platform's keys; Ctrl+C still interrupts
- [ ] HELIOS-7 console: System, Kernel log, Device map show live data (plug a USB device in: it appears within 30 s on Windows, 10 s elsewhere); spectrum works on Windows, says "not available" elsewhere
- [ ] Plugins folder is created in the OS's app-data location; bundled plugins appear
- [ ] Uninstall removes the app (settings and plugins stay in app data)
- [ ] (With a published release) an older install offers the update and restarts into the new version
