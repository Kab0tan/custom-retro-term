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
Until the owner is set, the app skips update checks and says so. A `.deb` install registered with the APT repository
(below) leaves updates to apt instead.

## APT repository

Debian and Ubuntu users install and update through apt:

```bash
curl -fsSL https://raw.githubusercontent.com/Kab0tan/custom-retro-term/main/scripts/install-linux.sh | sudo sh
```

Afterwards `sudo apt install crt-terminal` works, and `sudo apt upgrade` (or the system's update notifier) brings new
versions. Downloading the `.deb` from Releases and opening it does the same: its install script registers the
repository, the way the VS Code and Chrome packages do.

**How it works.** No server needed: GitHub Releases *is* the repository. Each release carries the `.deb` plus `Packages`,
`Release`, `InRelease` (signed) and the public key, and apt reads them from
`https://github.com/<owner>/<repo>/releases/latest/download/`, which GitHub redirects to the newest release. So:
- apt always sees the latest **published** release only. Drafts and pre-releases are invisible until you publish them.
- Older versions stay downloadable from their release page, but apt can't downgrade to them.
- The repository must be **public**: apt doesn't authenticate to GitHub.

| Piece | What it does |
|---|---|
| [scripts/apt-repo.sh](../scripts/apt-repo.sh) | `package-files`: public key + `crt-terminal.sources` that ship in the `.deb` (`resources/apt`). `index`: builds and signs the repository metadata. |
| [build/linux/after-install.tpl](../build/linux/after-install.tpl) | The `.deb` install script: electron-builder's default, plus copying the key to `/usr/share/keyrings/` and the source entry to `/etc/apt/sources.list.d/` (only if missing). |
| [build/linux/after-remove.tpl](../build/linux/after-remove.tpl) | Default removal script, plus removing both files on `apt purge`. |
| [scripts/install-linux.sh](../scripts/install-linux.sh) | The one-line installer above. |
| [release.yml](../.github/workflows/release.yml) | Generates the `.deb`'s files before packaging; the `apt` job signs the metadata and uploads it to the release. |

**Setup, once.** Create a signing key with no passphrase (the GitHub secret store protects it), and store its private half
as the repository secret `APT_SIGNING_KEY`:

```bash
gpg --batch --passphrase '' --quick-gen-key "CRT Terminal APT <you@example.com>" ed25519 sign never
gpg --armor --export-secret-keys "CRT Terminal APT" > apt-signing-key.asc
```

Paste the file's contents into *Settings → Secrets and variables → Actions → New repository secret*, then delete the file
and keep a backup of the key somewhere safe. If the key has a passphrase, also add it as `APT_SIGNING_KEY_PASSPHRASE`. Without
the secret, releases still build: the `.deb` just doesn't register the repository, and the app updates itself as before.

**Rotating the key** breaks `apt update` for existing users: they still have the old key and must rerun the install
command (or reinstall the `.deb`), which fetches the new one. Give the key no expiry and rotate only if it leaks.

**Opting out.** Put `ADD_APT_REPO=false` in `/etc/default/crt-terminal` before installing the `.deb`, or set
`Enabled: no` in `/etc/apt/sources.list.d/crt-terminal.sources` (later installs keep that file as it is).

**Forks.** The source entry uses `GITHUB_REPOSITORY`, so it points at the fork automatically. For the one-line installer,
set `CRT_TERMINAL_REPO=owner/repo`.

## Code signing (optional)

| Platform | What you need | Environment / CI secrets |
|---|---|---|
| Windows | An OV/EV code-signing certificate (.pfx), or Azure Trusted Signing. Unsigned installers trigger SmartScreen until they build reputation. | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |
| macOS | Apple Developer ID Application certificate + notarization (Gatekeeper blocks unsigned apps downloaded from the web) | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Linux | Not required for the AppImage and `.deb`; the APT repository needs a GPG key ([above](#apt-repository)) | `APT_SIGNING_KEY`, `APT_SIGNING_KEY_PASSPHRASE` (optional) |

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
| Temperature | ACPI thermal zones (often N/A without admin) | N/A (not exposed to apps) | CPU sensor first: `x86_pkg_temp`, hwmon `coretemp`/`k10temp`, `TCPU`, ARM `cpu`/`soc` zones; else `acpitz` |
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
- [ ] (Ubuntu/Debian, with a published release) the one-line installer installs the app; `apt policy crt-terminal` lists
  the GitHub repository; after the next release `sudo apt update && sudo apt upgrade` updates it; Settings → Updates says
  updates come from apt; `sudo apt purge crt-terminal` removes `/etc/apt/sources.list.d/crt-terminal.sources`
