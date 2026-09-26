// Device map: the machine and what hangs off it (USB, paired Bluetooth, displays, network links).
// Redraws when a scan arrives (every 30 s on Windows, 5-10 s on macOS/Linux); a device that just appeared blinks for a moment.

/** @typedef {import('../../plugin-runtime/crt-plugin').PluginContext} PluginContext */
/** @typedef {import('../../plugin-runtime/crt-plugin').DeviceInfo} DeviceInfo */

const KIND_LABELS = {
  keyboard: 'KEYBOARD',
  mouse: 'MOUSE',
  input: 'INPUT',
  gamepad: 'GAMEPAD',
  audio: 'AUDIO',
  storage: 'STORAGE',
  camera: 'CAMERA',
  phone: 'PHONE',
  printer: 'PRINTER',
  serial: 'SERIAL',
  network: 'NETWORK',
  display: 'DISPLAY',
  other: 'DEVICE'
}

const NEW_MS = 4000

const CSS = `
.map { position: absolute; inset: 0; display: flex; flex-direction: column; box-sizing: border-box;
  font: 13px/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--phosphor); font-variant-numeric: tabular-nums; }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 10px; }
.host { display: flex; align-items: center; gap: 10px; color: var(--phosphor-bright); font-size: 16px;
  text-shadow: 0 0 8px var(--phosphor-glow); }
.host .mark { width: 9px; height: 9px; border: 1.5px solid currentColor; transform: rotate(45deg); flex-shrink: 0; }
.host .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spec { margin: 6px 0 0 21px; color: var(--phosphor-dim); }
.tree { margin: 12px 0 0 8px; border-left: 1px solid var(--phosphor-dim); padding: 2px 0; }
.row { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center;
  gap: 12px; padding: 4px 0 4px 26px; }
.row::before { content: ''; position: absolute; left: 0; top: 50%; width: 18px; border-top: 1px solid var(--phosphor-dim); }
.port { min-width: 6ch; padding: 3px 6px; border: 1px solid var(--phosphor-dim); text-align: center;
  color: var(--phosphor); font-size: 12px; }
.dev { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { display: flex; align-items: center; gap: 8px; color: var(--phosphor-dim); white-space: nowrap; }
.cells { display: flex; gap: 3px; }
.cells i { width: 7px; height: 12px; border: 1px solid var(--phosphor-dim); box-sizing: border-box; }
.cells i.on { background: var(--phosphor); border-color: var(--phosphor); box-shadow: 0 0 4px var(--phosphor-glow); }
.low .cells i.on, .low .pct { animation: blink 1s steps(2) infinite; color: var(--phosphor-bright); }
.off { opacity: 0.45; }
.new { animation: arrive 0.5s steps(2) 6; }
.row:hover .dev { color: var(--phosphor-bright); }
.note { padding: 6px 0 6px 26px; color: var(--phosphor-dim); }
.foot { flex-shrink: 0; display: flex; flex-wrap: wrap; gap: 6px 22px; padding: 12px 16px;
  border-top: 1px solid var(--chrome-border); color: var(--phosphor-dim); }
.foot b { font-weight: normal; margin-left: 8px; color: var(--phosphor-bright); text-shadow: 0 0 6px var(--phosphor-glow); }
.hidden { display: none !important; }
@keyframes blink { 50% { opacity: 0.25; } }
@keyframes arrive { 50% { color: var(--phosphor-bright); background: var(--phosphor-faint); } }
`

const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function gigabytes(bytes) {
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

/** @param {PluginContext} ctx */
export function mount(ctx) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = el('div', 'map')
  const body = el('div', 'body')
  const host = el('div', 'host')
  host.append(el('span', 'mark'), el('span', 'name', 'SCANNING…'))
  const spec = el('div', 'spec')
  const tree = el('div', 'tree')
  const foot = el('div', 'foot')
  body.append(host, spec, tree)
  root.append(body, foot)
  ctx.el.appendChild(root)

  /** @type {import('../../plugin-runtime/crt-plugin').DevicesData | null} */
  let last = null
  /** Device ids seen so far, and when the new ones arrived. */
  let seen = null
  const arrived = new Map()

  /** @param {DeviceInfo} d */
  function detail(d) {
    const box = el('span', 'detail')
    if (!d.connected) {
      box.textContent = 'STANDBY'
    } else if (d.battery != null) {
      const cells = el('span', 'cells')
      const on = Math.round(d.battery / 25)
      for (let i = 0; i < 4; i++) cells.appendChild(el('i', i < on ? 'on' : ''))
      box.append(cells, el('span', 'pct', `${d.battery}%`))
      if (d.battery <= 15) box.classList.add('low')
      box.title = `Battery ${d.battery}%`
    } else {
      box.textContent = d.detail ?? KIND_LABELS[d.kind] ?? 'DEVICE'
    }
    return box
  }

  /** @param {DeviceInfo} d */
  function row(d, now) {
    const r = el('div', 'row')
    if (!d.connected) r.classList.add('off')
    if ((arrived.get(d.id) ?? 0) > now) r.classList.add('new')
    r.append(el('span', 'port', d.port), el('span', 'dev', d.name), detail(d))
    r.title = [d.name, KIND_LABELS[d.kind], d.detail].filter(Boolean).join(' · ')
    return r
  }

  function render() {
    const s = ctx.settings
    tree.replaceChildren()
    foot.replaceChildren()
    if (!last) return
    if (!last.available) {
      host.lastChild.textContent = 'NO SCAN'
      spec.textContent = ''
      tree.appendChild(el('div', 'note', last.reason))
      return
    }
    const { host: h, devices } = last
    host.lastChild.textContent = h.name
    spec.textContent = `${h.os} · ${h.cores} CORES · ${gigabytes(h.memoryBytes)}`

    const shown = devices.filter(
      (d) =>
        (s.showOffline !== false || d.connected) &&
        (s.showDisplays !== false || d.bus !== 'display') &&
        (s.showNetwork !== false || d.bus !== 'network')
    )
    // Within a bus: connected first, then by name. The hub already orders the buses.
    const order = ['usb', 'bluetooth', 'display', 'network']
    shown.sort(
      (a, b) => order.indexOf(a.bus) - order.indexOf(b.bus) || Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)
    )
    const now = Date.now()
    for (const d of shown) tree.appendChild(row(d, now))
    if (!shown.length) tree.appendChild(el('div', 'note', 'NO EXTERNAL DEVICES'))

    const linked = shown.filter((d) => d.connected)
    const count = (label, n, always = false) => {
      if (!n && !always) return
      const c = el('span', '', label)
      c.appendChild(el('b', '', String(n)))
      foot.appendChild(c)
    }
    count('LINKED', linked.length, true)
    count('USB', linked.filter((d) => d.bus === 'usb').length)
    count('BT', linked.filter((d) => d.bus === 'bluetooth').length)
    count('VIDEO', linked.filter((d) => d.bus === 'display').length)
    count('NET', linked.filter((d) => d.bus === 'network').length)
  }

  ctx.subscribe('devices', (data) => {
    if (data.available) {
      const now = Date.now()
      const ids = new Set(data.devices.filter((d) => d.connected).map((d) => d.id))
      // Nothing blinks on the first scan; after that, anything newly connected does.
      if (seen) for (const id of ids) if (!seen.has(id)) arrived.set(id, now + NEW_MS)
      for (const [id, until] of arrived) if (until <= now) arrived.delete(id)
      seen = ids
    }
    last = data
    render()
  })
  ctx.onSettings(render)
}
