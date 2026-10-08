# Writing a CRT Terminal plugin

A plugin is a panel: a folder with a `manifest.json` and one JavaScript module. No build step, no npm.
This page is all you need. The types are in [`crt-plugin.d.ts`](../plugin-runtime/crt-plugin.d.ts), and a copy lands
in every plugin you create.

## Quick start (5 minutes)

1. **Settings → Plugins → New plugin…**, type a name (e.g. *Clock*), **Create**. The app copies the starter
   template to `plugins/clock/` and opens the folder.
2. In any empty panel slot (▦ Layout → *Add panel*), pick **Clock**.
3. Edit `index.js` in your editor and save. The panel reloads by itself.
4. Something wrong? The panel shows the error. Turn on **Developer mode** (Settings → Plugins) for the stack
   trace and a ↻ reload button. `ctx.log()` and `console.log` go to DevTools (**Ctrl+Shift+F12**).

Working on a plugin that lives elsewhere, e.g. in a Git checkout? In developer mode use **Link a folder…**: it's
used in place and hot-reloads, with no copying.

Plugin folders:
- Windows: `%APPDATA%\crt-terminal\plugins\`
- macOS: `~/Library/Application Support/crt-terminal/plugins/`
- Linux: `~/.config/crt-terminal/plugins/`

## manifest.json

```json
{
  "id": "weather",
  "name": "Weather",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Current weather from Open-Meteo.",
  "entry": "index.js",
  "defaultTitle": "WEATHER",
  "data": [],
  "permissions": { "network": ["api.open-meteo.com"] },
  "minAppVersion": "0.1.0",
  "settings": [
    { "key": "lat", "label": "Latitude", "type": "number", "default": 48.85, "min": -90, "max": 90, "step": 0.01 },
    { "key": "lon", "label": "Longitude", "type": "number", "default": 2.35, "min": -180, "max": 180, "step": 0.01 },
    { "key": "units", "label": "Units", "type": "select", "default": "celsius",
      "options": [{ "value": "celsius", "label": "°C" }, { "value": "fahrenheit", "label": "°F" }] }
  ]
}
```

| Field | |
|---|---|
| `id` | Lowercase letters, digits, dashes. Must equal the folder name once installed. |
| `name`, `version`, `description` | Shown in Settings → Plugins. Bump `version` when you publish. |
| `apiVersion` | The plugin API you wrote against. Currently **1**. See *Versioning*. |
| `entry` | Your module, relative to the folder. |
| `defaultTitle` | Panel title when someone picks your plugin. |
| `data` | Data topics you'll subscribe to (below). Anything not listed is refused. |
| `permissions.network` | Hosts `ctx.fetch` may call over HTTPS: `"api.example.com"` or `"*.example.com"`. Shown to the user. |
| `minAppVersion` | Oldest CRT Terminal your plugin works with (optional). |
| `settings` | `number` (`min`, `max`, `step`), `boolean`, `select` (`options`). Settings → Plugins renders the form. Values reach you validated and defaulted. |

## The module

```js
/** @param {import('./crt-plugin').PluginContext} ctx */
export function mount(ctx) {
  // build UI in ctx.el, subscribe to data, read ctx.settings…
  return {
    update({ settings, theme }) {},  // optional: after a settings or theme change
    unmount() {}                     // optional: panel going away (clear your own timers)
  }
}
```

`mount` may be `async`. Subscriptions, frame callbacks and resize observers registered through `ctx` are cleaned up
for you.

## ctx

| | |
|---|---|
| `ctx.el` | Your root element; it fills the panel. |
| `ctx.settings`, `ctx.onSettings(cb)`, `ctx.setSetting(key, value)` | Your settings. |
| `ctx.theme`, `ctx.onTheme(cb)` | Phosphor colours (`theme.phosphor.base / bright / dim / faint / background`, `rgb` for WebGL), chrome text colours (`theme.chrome.fg / dim / border`), fonts. The same values are CSS variables: `var(--phosphor)`, `var(--phosphor-bright)`, `var(--chrome-fg)`, `var(--chrome-dim)`, `var(--font-mono)`, `var(--font-ui)`. |
| `ctx.subscribe(topic, cb)` | Live data; returns an unsubscribe function. |
| `ctx.animate(cb)` | Frame loop `cb(t, dt)` (seconds). Capped at the user's plugin frame rate and paused while the window is hidden or unfocused. Use it only for things that move. |
| `ctx.paused` | Skip drawing from data callbacks while `true`. |
| `ctx.onResize(cb)`, `ctx.size` | Panel size in CSS pixels. |
| `ctx.fetch(url, init?)` | HTTPS request to a host in `permissions.network`. Returns `{ ok, status, text(), json() }`. 2 MB max, 15 s timeout, redirects not followed. |
| `ctx.requestPermission('audio')` | Asks the user to allow system-audio analysis. Resolves `true`/`false`. |
| `ctx.panel`, `ctx.onTitle(cb)`, `ctx.manifest`, `ctx.log(...)` | Panel id/title, your manifest, logging. |

Mouse input works as usual: `pointermove`, `pointerenter/leave`, `click`, `dblclick` and `wheel` listeners fire,
buttons and checkboxes work, and scrollable elements (`overflow: auto`) scroll with the wheel. Keyboard input stays
with the shell, so plugins are display panels.

## Data topics

| Topic | Rate | Payload |
|---|---|---|
| `cpu` | 1 s | `{ cores: number[], total, model }` (busy 0..1) |
| `memory` | 2 s | `{ totalBytes, usedBytes, swap? }` (`swap: { totalBytes, usedBytes }`, the page file on Windows; absent without swap) |
| `network` | 1 s | `{ available: true, rxBytesPerSec, txBytesPerSec, interfaces[] }` or `{ available: false, reason }` |
| `temperature` | 5 s (30 s on Windows) | `{ available: true, zones: [{ name, celsius, cpu }] }` (best sensor first; `cpu`: it's the CPU's own sensor, Linux only) or `{ available: false, reason }` |
| `log` | as it comes | `{ entries: [{ time, level, source, message }], reset? }` (system/kernel log) |
| `connections` | 2 s | `{ available: true, connections: [{ remoteAddress, remotePort, localPort }] }` |
| `devices` | 5-10 s (30 s on Windows) | `{ available: true, host: { name, os, cores, memoryBytes }, devices: [{ id, name, bus, port, kind, connected, battery?, detail? }] }` (USB, paired Bluetooth, displays, network links) |
| `audio` | ~30/s | `{ available: true, sampleRate, wave, spectrum, minDb, maxDb }` or `{ available: false, reason, message }`; needs consent |

You get the latest value as soon as you subscribe. A topic is only collected while a visible panel wants it.

## Example: weather

With the manifest above (`permissions.network: ["api.open-meteo.com"]`):

```js
/** @param {import('./crt-plugin').PluginContext} ctx */
export function mount(ctx) {
  ctx.el.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-content:center;text-align:center">
    <div id="t" style="font:40px var(--font-mono);color:var(--phosphor)">--</div>
    <div id="d" style="color:var(--chrome-dim);font-size:12px"></div></div>`
  const t = ctx.el.querySelector('#t')
  const d = ctx.el.querySelector('#d')

  async function refresh() {
    const s = ctx.settings
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}` +
      `&current=temperature_2m,wind_speed_10m&temperature_unit=${s.units}`
    try {
      const res = await ctx.fetch(url)
      const { current, current_units } = await res.json()
      t.textContent = `${Math.round(current.temperature_2m)}${current_units.temperature_2m}`
      d.textContent = `wind ${current.wind_speed_10m} ${current_units.wind_speed_10m}`
    } catch (err) {
      d.textContent = `offline: ${err.message}`
    }
  }
  refresh()
  const timer = setInterval(refresh, 10 * 60 * 1000)
  ctx.onSettings(refresh)
  return { unmount: () => clearInterval(timer) }
}
```

The starter template is the clock example: date/time, settings and a data subscription.

> **Not possible by design:** running commands, reading files, or opening arbitrary network connections. A *Git
> status* panel, for example, would need the app to publish a `git` data topic first.

## Sharing and installing

Settings → Plugins:
- **Install from folder…**: copies a plugin folder in.
- **Install from zip…**: a zip of the folder (a GitHub *Download ZIP* works; one wrapping folder is fine).
- **Install from Git…**: `git clone` of an `https://`, `ssh://` or `git@` URL. Needs Git on the PATH.
- **Remove**: deletes the plugin's folder.

Every install is validated first (manifest, API version, entry file), so a plugin that can't run never replaces one
that can. Reinstalling the same id asks before replacing and keeps its settings.

### Community catalog (optional)

A catalog is a JSON file served over HTTPS. Put its URL in Settings → Plugins → *Community catalog*, and **Browse**
lists the plugins with Install/Update buttons. A GitHub repository with a `catalog.json` works well (use the *raw* URL):

```json
[
  { "id": "weather", "name": "Weather", "version": "1.0.0", "author": "you",
    "description": "Current weather from Open-Meteo.", "repo": "https://github.com/you/crt-plugin-weather.git" }
]
```

### Getting your plugin into the official repo

Plugins are meant first of all to be written and used locally. To propose one for the bundled set, open an issue on
the GitHub repository with a link to the plugin's source. The maintainers review it and decide whether it fits the
official repo.

## Versioning

- The manifest's `apiVersion` selects the runtime the plugin runs on. The app keeps a runtime per supported version
  (`plugin-runtime/v1/`, later `v2/`…), so **a plugin keeps working unchanged when a newer API ships**, as long as its
  version is still supported.
- A plugin that asks for an API this app doesn't have fails to load and says so. Newer: *"needs a newer CRT Terminal:
  it uses plugin API v2…"*. Withdrawn: *"was written for plugin API v0, which is no longer supported…"*. Same for
  `minAppVersion`.
- Within a version, changes are additive only (new `ctx` members, new topics, new payload fields). Anything that would
  break a plugin gets a new version number.

## The sandbox

Each plugin runs in its own sandboxed frame: no Node, no access to the app, the shells or files, and no network
except `ctx.fetch` to the hosts you declared. Plugins aren't hidden from each other, though: a plugin can read the
files of any installed plugin (over `crt-plugin://<id>/`), so don't put secrets in a plugin folder. Bundle any library into your folder (e.g. a copy of
Three.js in `vendor/`) and import it with a relative path.

If your code throws, the panel shows **PLUGIN ERROR** with a Retry button, and a frame callback that throws is
removed. If it hangs (for example an infinite loop), it's stopped after about 6 s: **PLUGIN NOT RESPONDING**.

Tips: draw when data arrives rather than every frame, since every repaint also re-renders the CRT effect. Size canvases
with `devicePixelRatio`. Use theme colours everywhere so amber/green/cyan switch instantly: text in `chrome.fg`/`chrome.dim`,
marks in `phosphor.*`.
