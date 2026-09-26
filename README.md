# custom-retro-term

[![ci](https://github.com/Kab0tan/custom-retro-term/actions/workflows/ci.yml/badge.svg)](https://github.com/Kab0tan/custom-retro-term/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-orange.svg)](LICENSE)

Retro CRT terminal for Windows, macOS and Linux: curvature, bloom, scanlines and amber/green/cyan phosphors.
Put live panels next to your shell (system stats, kernel log, audio spectrum, device map), or write your own as one
small JavaScript plugin.

Heavily inspired by [cool-retro-term](https://github.com/Swordfish90/cool-retro-term). custom-retro-term is a separate,
independent implementation (Electron + WebGL rather than Qt) and contains no code from it.

Windows, macOS and Linux · Electron + Vue + xterm.js + node-pty · WebGL CRT pipeline.

## Features

- **CRT renderer**: screen curvature, bloom and glow, scanlines, aperture grille, vignette, colour fringing,
  phosphor burn-in, flicker and noise. Amber, green and cyan phosphors, built-in presets, and your own presets.
- **A real terminal**: xterm.js with GPU text rendering, tabs, search, zoom, clickable links, Unicode 11, and shell
  profiles detected for your OS (PowerShell 7, Windows PowerShell, cmd, Git Bash and WSL on Windows; your login
  shell plus bash, zsh, fish… on macOS and Linux).
- **Panels next to the shell**: split, move and resize panels, and save layouts.
- **Bundled panels**: System (CPU, memory, network), Kernel log, Spectrum (system audio), Device map.
- **Plugins**: a manifest and one ES module, sandboxed, hot reload, no build step.
- **Installers** for Windows, macOS and Linux, with auto-updates from GitHub Releases.

## Install

Download the installer for your OS from the [Releases](https://github.com/Kab0tan/custom-retro-term/releases)
page:

| OS | File | Note |
|---|---|---|
| Windows 10/11 | `CRT Terminal-Setup-<version>.exe` | Unsigned builds show a SmartScreen warning: *More info → Run anyway*. |
| macOS | `CRT Terminal-<version>-<arch>.dmg` | Unsigned builds: right-click the app → *Open* the first time. |
| Linux | `.AppImage` or `.deb` | `chmod +x` the AppImage before running it. |

Or build an installer yourself: `npm ci && npm run dist` (see the [packaging guide](docs/packaging.md)).

## Use it

- **Tweaks** (Ctrl+Shift+E, ⌘⇧E on macOS): phosphor colour, every CRT effect, presets.
- **Layout** (▦ in the tab bar): add, split, move and resize panels; save layouts.
- **Settings** (Ctrl+, / ⌘,): shells and profiles, fonts, rendering, plugins, updates.

### Keyboard shortcuts

App shortcuts use Ctrl+Shift on Windows and Linux (and ⌘ on macOS), so plain Ctrl chords such as Ctrl+C and Ctrl+R
stay with your shell.

| Action | Windows / Linux | macOS |
|---|---|---|
| New tab / new tab with profile 1–9 | Ctrl+Shift+T / Ctrl+Shift+1…9 | ⌘T / ⌘⇧1…9 |
| Close tab | Ctrl+Shift+W | ⌘W |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | ⌘⇧] / ⌘⇧[ (or Ctrl+Tab) |
| New window | Ctrl+Shift+N | ⌘N |
| Copy / paste | Ctrl+Shift+C / Ctrl+Shift+V (Ctrl+C / Ctrl+V optional in Settings) | ⌘C / ⌘V |
| Find | Ctrl+Shift+F | ⌘F |
| Zoom in / out / reset | Ctrl+= / Ctrl+- / Ctrl+0 | ⌘= / ⌘- / ⌘0 |
| Settings | Ctrl+, | ⌘, |
| Tweaks | Ctrl+Shift+E | ⌘⇧E |
| Full screen | F11 | ⌘⌃F |
| Scroll by page | Shift+PageUp / Shift+PageDown | Shift+PageUp / Shift+PageDown |
| CRT stats overlay (WebGL renderer) | Ctrl+Shift+F10 | Ctrl+Shift+F10 |

### Where your files are

Settings (`settings.json`), window state and installed plugins live in the app-data folder:

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\crt-terminal` |
| macOS | `~/Library/Application Support/crt-terminal` |
| Linux | `~/.config/crt-terminal` |

Uninstalling the app leaves this folder in place.

## Plugins

Plugins are meant to be written and used locally: Settings → Plugins → **New plugin…** creates a working starter
in your plugins folder, and **[docs/plugin-api.md](docs/plugin-api.md)** explains the rest on one page (a manifest,
one JS module, hot reload, no build step). Types for editor autocompletion ship with the template (`crt-plugin.d.ts`).

Plugins run in a sandboxed frame: no Node.js, no file system, and no network except the hosts they declare. They get
live system data only for the topics listed in their manifest.

**Getting a plugin into the official repo**: open an issue with the *Plugin proposal* template and a link to the
plugin's source. The maintainers review it and decide whether it's appropriate to bundle it. See
[CONTRIBUTING.md](CONTRIBUTING.md#proposing-a-plugin-for-the-official-repo).

## Troubleshooting

- **Black or garbled screen, or a WebGL error at startup**: switch Settings → Rendering → Renderer to *CSS overlay*
  and restart. If the app doesn't get that far, set `"crt": { "renderer": "css" }` in `settings.json`, or start it
  once with the environment variable `CRT_MODE=css`.
- **Temperature shows N/A on Windows**: Windows only exposes ACPI thermal zones to administrators on most machines.
- **Kernel log is empty on Linux**: `journalctl -k` needs your user in the `systemd-journal` or `adm` group.
- **Spectrum says "not available"**: system-audio capture is only implemented on Windows so far.
- **Device map is slow to notice a new device**: devices are rescanned every 30 seconds to keep background CPU low.

## Develop

Requirements: Node.js 22+ and npm (on Linux also `build-essential` and `python3`, since node-pty compiles from source).

```bash
npm ci
npm run dev          # WebGL CRT renderer (default)
npm run dev:css      # CSS-overlay renderer
npm run typecheck
npm test
npm run dist         # installer for the current OS
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Project layout

| Folder | What's in it |
|---|---|
| `src/main/` | Electron main process: windows, shells and PTYs, settings, system data sampling, plugin loading, CRT compositor, updates |
| `src/preload/` | Bridges between the main process and the UI (terminal window and WebGL compositor window) |
| `src/renderer/` | The Vue UI: tabs, terminal, layout grid, settings and Tweaks, WebGL CRT pipeline, plugin host |
| `src/shared/` | Types and logic used on both sides: settings, layouts, phosphor colours, presets, data topics |
| `plugins/` | Bundled panels, each one a plugin: system, kernel log, spectrum, device map |
| `plugin-runtime/` | The runtime loaded into every plugin panel, plus the `crt-plugin.d.ts` types for authors |
| `plugin-template/` | Starter plugin copied by Settings → Plugins → New plugin… |
| `tests/` | Unit tests (Vitest) |
| `docs/` | Plugin API guide and packaging guide |
| `build/` | App icons and macOS entitlements used by electron-builder |
| `scripts/` | Dev scripts (node-pty smoke test) |
| `.github/` | CI (checks on every pull request, installers on every tag), issue and PR templates |

## Credits

- [cool-retro-term](https://github.com/Swordfish90/cool-retro-term) by Filippo Scognamiglio, the inspiration for the
  look and for the idea of a multi-pass CRT pipeline. No code from it is used.
- [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty), [Electron](https://www.electronjs.org/),
  [Vue](https://vuejs.org/), [electron-vite](https://electron-vite.org/), [fflate](https://github.com/101arrowz/fflate).
- Fonts, all under the SIL Open Font License 1.1 and bundled via [Fontsource](https://fontsource.org/):
  IBM Plex Mono, VT323, Share Tech Mono, Courier Prime.

## License

[MIT](LICENSE) © CRT Terminal contributors
