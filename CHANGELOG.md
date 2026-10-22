# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Disk usage panel: a Baobab-style sunburst of the home folder, the 10 largest folders and what's inside them, with a
  ranked legend, free space and a ↻ button to rescan. Plugins get it from the new `disk` topic.
- Plugin API: `ctx.refresh(topic)` asks the app to collect a topic again now (supported by `disk`).

## [0.2.0] - 2026-10-08

### Added

- Split panes inside a tab (tmux / Windows Terminal style): split right (Ctrl+Shift+D, ⌘D) or down (Ctrl+Shift+S,
  ⌘⇧D), zoom (Ctrl+Shift+Z, ⌘⇧Enter), and a tmux-style prefix (Ctrl+Shift+Space, ⌘⇧Space) to move between panes
  with the arrows, resize with Shift+arrows, swap, close and spread them evenly. Gutters between panes can be dragged
  or nudged with the arrow keys. Up to 8 panes per tab.
- A new pane starts in the same folder as the pane it was split from, when the shell reports it (OSC 7, OSC 9;9) or,
  on Linux, from the process.
- APT repository for Debian and Ubuntu, served from GitHub Releases: install with one command
  (`curl -fsSL …/scripts/install-linux.sh | sudo sh`) and update with `sudo apt upgrade`. The `.deb` registers the
  repository when installed, and the app then leaves updates to apt.
- System panel: a SWAP bar under MEM when the system has swap (the page file on Windows). The `memory` topic carries it
  as `swap: { totalBytes, usedBytes }`.

### Changed

- Ctrl+Shift+W (⌘W) closes the focused pane; closing the last pane closes the tab.
- A shell that exits cleanly closes its pane instead of the whole tab.
- "Close all N tabs?" when closing a window now counts shells (panes across all tabs).
- A new shell whose requested folder doesn't exist starts in its profile's folder instead of the home folder.

### Fixed

- System panel on Linux: the temperature now comes from the CPU (`x86_pkg_temp`, hwmon `coretemp` / `k10temp`, `TCPU`,
  ARM `cpu`/`soc` zones) instead of whichever thermal zone was listed first, often the `acpitz` board sensor that can
  read 30 °C lower. It says CORE TEMP only when the sensor really is the CPU, and its tooltip names the sensor. The
  `temperature` topic lists the best sensor first and flags it with `cpu`.
- Resizing two neighbouring panels that were together smaller than the minimum size could give one of them a
  negative size.

## [0.1.0] - 2026-09-26

First public release.

- WebGL CRT renderer: curvature, bloom, glow, scanlines, aperture mask, vignette, colour fringing, burn-in,
  flicker and noise, with amber, green and cyan phosphors and built-in presets. CSS-overlay renderer as a fallback.
- Tabs, shell profiles (PowerShell, cmd, Git Bash, WSL, zsh, bash, fish…), search, zoom, full screen.
- Panel layouts: split, move and resize panels next to the terminal, and save layouts.
- Plugin system: sandboxed panels written as one ES module plus a manifest, with hot reload and no build step.
- Bundled plugins: System, Kernel log, Spectrum (system audio, Windows), Device map.
- Installers for Windows, macOS and Linux, with auto-updates from GitHub Releases.
