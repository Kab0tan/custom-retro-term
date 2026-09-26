# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-26

First public release.

- WebGL CRT renderer: curvature, bloom, glow, scanlines, aperture mask, vignette, colour fringing, burn-in,
  flicker and noise, with amber, green and cyan phosphors and built-in presets. CSS-overlay renderer as a fallback.
- Tabs, shell profiles (PowerShell, cmd, Git Bash, WSL, zsh, bash, fish…), search, zoom, full screen.
- Panel layouts: split, move and resize panels next to the terminal, and save layouts.
- Plugin system: sandboxed panels written as one ES module plus a manifest, with hot reload and no build step.
- Bundled plugins: System, Kernel log, Spectrum (system audio, Windows), Device map.
- Installers for Windows, macOS and Linux, with auto-updates from GitHub Releases.
