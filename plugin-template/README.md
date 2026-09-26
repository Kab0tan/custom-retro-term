# My plugin

A CRT Terminal panel plugin.

- `manifest.json`: id, name, version, the data it uses, network hosts, settings.
- `index.js`: `export function mount(ctx)`. Save it and the panel reloads.
- `crt-plugin.d.ts`: the API types (editor completion through the JSDoc in `index.js`).

## Share it

- **Zip**: zip this folder. Others use Settings → Plugins → Install from zip.
- **Git**: push it to a repository. Others use Settings → Plugins → Install from Git with the repo URL.
- **Catalog**: send a pull request adding it to a community catalog JSON (see the app docs).

Bump `version` whenever you publish. Keep `apiVersion` at the API you tested against.

## Getting your plugin into the official repo

Plugins are meant first of all to be written and used locally. To propose yours for the bundled set, open an issue
on the CRT Terminal GitHub repository with a link to its source. The maintainers review it and decide whether it
fits the official repo.
