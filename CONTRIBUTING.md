# Contributing

Thanks for your interest in CRT Terminal! Bug reports, fixes, ideas and plugins are all welcome.

## Before you start

- **Bugs**: open an issue with your OS, the app version (Settings → Updates) and steps to reproduce.
  Screenshots help a lot for rendering problems.
- **Features**: open an issue first so we can agree on the approach before you spend time on a pull request.
- **Plugins**: see [Proposing a plugin](#proposing-a-plugin-for-the-official-repo) below.

## Development setup

Requirements: Node.js 22+ and npm. On Linux, node-pty compiles from source, so you also need `build-essential` and
`python3`.

```bash
npm ci
npm run dev        # run the app with hot reload
npm run typecheck  # vue-tsc + tsc
npm test           # unit tests (src/shared)
npm run smoke:pty  # checks that node-pty can spawn a shell inside Electron
```

See the [project layout](README.md#project-layout) in the README for where things live, and
[docs/packaging.md](docs/packaging.md) for building installers.

## Pull requests

- Keep each pull request focused on one change, and describe what it does and how you tested it.
- Match the existing style: TypeScript, no semicolons, single quotes, 2-space indent (see `.editorconfig`).
- `npm run typecheck`, `npm test` and `npm run build` must pass; CI runs them on Windows, macOS and Linux.
- The CRT effect runs on the GPU: keep an eye on its cost. An idle window should do no GPU work unless an animated
  effect (flicker, noise) is turned on, and even then only for a few seconds after the last keyboard or mouse input.
- If you change a bundled plugin in `plugins/`, bump the `version` in its `manifest.json`: the app only refreshes
  the user's installed copy when that version changes.
- If you change user-visible behaviour, add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.

## Proposing a plugin for the official repo

Plugins are meant first of all to be written and used locally: create one from Settings → Plugins → **New plugin…**
and follow [docs/plugin-api.md](docs/plugin-api.md). You don't need anyone's approval to use your own plugins.

To propose a plugin for the bundled set, **open an issue** using the *Plugin proposal* template, with a link to the
plugin's source and a screenshot. The maintainers review the code and decide whether it fits the official repo.
Not every good plugin will be bundled: we look at usefulness for most users, performance, security (no unnecessary
data or network permissions), and whether it works on all three platforms or degrades gracefully.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
