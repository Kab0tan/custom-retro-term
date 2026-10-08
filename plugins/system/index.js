// System stats, SYSMON style: a scanlined bar per core, memory bar, then a readout list.
// Redraws only when data arrives (every 1-2 s), so it costs nothing between samples.

/** @typedef {import('../../plugin-runtime/crt-plugin').PluginContext} PluginContext */

const pct = (v) => `${Math.round(v * 100)}%`
function rate(n) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`
}
function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

const CSS = `
.sys { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px 16px;
  box-sizing: border-box; overflow-y: auto; font: 13px/1 var(--font-mono); text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--phosphor-dim); font-variant-numeric: tabular-nums; }
.group { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 7px 24px; }
.bar-row { display: grid; grid-template-columns: 5ch minmax(60px, 1fr) 5ch; align-items: center; gap: 12px; }
.bar-row .v, .stat .v { color: var(--phosphor-bright); text-align: right; text-shadow: 0 0 6px var(--phosphor-glow); }
.bar { position: relative; height: 14px;
  background: radial-gradient(circle, var(--phosphor-faint) 0.8px, transparent 1px) 0 0 / 3px 3px; }
.bar > span { position: absolute; inset: 0 auto 0 0; width: 0;
  background: repeating-linear-gradient(to bottom, var(--phosphor-bright) 0 2px, var(--phosphor) 2px 3px);
  box-shadow: 0 0 6px var(--phosphor-glow); transition: width 0.4s steps(6); }
.bar-row:hover .bar > span { background: var(--phosphor-bright); }
.rule { flex-shrink: 0; border-top: 1px dashed var(--chrome-border); opacity: 0.8; }
.stats { display: flex; flex-direction: column; gap: 12px; }
.stat { display: grid; grid-template-columns: 1fr auto; gap: 12px; }
.stat .v { text-align: left; min-width: 12ch; }
.hidden { display: none !important; }
`

/** @param {PluginContext} ctx */
export function mount(ctx) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'sys'
  const add = (parent, cls, html = '') => {
    const d = document.createElement('div')
    d.className = cls
    d.innerHTML = html
    parent.appendChild(d)
    return d
  }
  const barRow = (parent, label) => {
    const row = add(parent, 'bar-row', `<span></span><div class="bar"><span></span></div><span class="v">--</span>`)
    row.firstChild.textContent = label
    return {
      row,
      set(f, title) {
        row.querySelector('.bar > span').style.width = `${Math.min(100, Math.max(0, f * 100))}%`
        row.lastChild.textContent = pct(f)
        row.title = title ?? ''
      }
    }
  }
  const stat = (parent, label) => {
    const row = add(parent, 'stat', '<span></span><span class="v">--</span>')
    row.firstChild.textContent = label
    return row
  }

  const coresEl = add(root, 'group')
  coresEl.setAttribute('aria-label', 'CPU per core')
  const coresRule = add(root, 'rule')
  const memEl = add(root, 'group')
  const mem = barRow(memEl, 'MEM')
  const swap = barRow(memEl, 'SWAP')
  swap.row.classList.add('hidden')
  add(root, 'rule')
  const stats = add(root, 'stats')
  const load = stat(stats, 'CPU LOAD')
  const temp = stat(stats, 'TEMP')
  const up = stat(stats, 'NET ▲')
  const down = stat(stats, 'NET ▼')
  ctx.el.appendChild(root)

  function applySettings(s) {
    coresEl.classList.toggle('hidden', !s.showCores)
    coresRule.classList.toggle('hidden', !s.showCores)
    up.classList.toggle('hidden', !s.showNetwork)
    down.classList.toggle('hidden', !s.showNetwork)
    temp.classList.toggle('hidden', !s.showTemperature)
  }
  applySettings(ctx.settings)
  ctx.onSettings(applySettings)

  // ------------------------------------------------------------ CPU
  let cores = []
  ctx.subscribe('cpu', (c) => {
    if (cores.length !== c.cores.length) {
      coresEl.replaceChildren()
      cores = c.cores.map((_, i) => barRow(coresEl, `CPU${i}`))
    }
    c.cores.forEach((v, i) => cores[i].set(v, `Core ${i}: ${pct(v)}`))
    load.lastChild.textContent = pct(c.total)
    load.title = c.model
  })

  // ------------------------------------------------------------ memory
  ctx.subscribe('memory', (m) => {
    mem.set(m.usedBytes / m.totalBytes, `${bytes(m.usedBytes)} / ${bytes(m.totalBytes)}`)
    // Only when the system has swap (the page file on Windows).
    swap.row.classList.toggle('hidden', !m.swap)
    if (m.swap) swap.set(m.swap.usedBytes / m.swap.totalBytes, `Swap: ${bytes(m.swap.usedBytes)} / ${bytes(m.swap.totalBytes)}`)
  })

  // ------------------------------------------------------------ network
  ctx.subscribe('network', (n) => {
    const [upV, downV] = [up.lastChild, down.lastChild]
    if (!n.available) {
      upV.textContent = downV.textContent = 'N/A'
      up.title = down.title = n.reason
      return
    }
    upV.textContent = rate(n.txBytesPerSec)
    downV.textContent = rate(n.rxBytesPerSec)
    up.title = down.title = ''
  })

  // ------------------------------------------------------------ temperature
  ctx.subscribe('temperature', (t) => {
    // zones[0] is the best sensor; say "CORE" only when it really is the CPU's.
    const [label, v] = [temp.firstChild, temp.lastChild]
    if (t.available) {
      const z = t.zones[0]
      label.textContent = z.cpu ? 'CORE TEMP' : 'TEMP'
      v.textContent = `${z.celsius.toFixed(0)} °C`
      temp.title = z.cpu ? `CPU sensor: ${z.name}` : `Sensor: ${z.name} (not the CPU die)`
    } else {
      label.textContent = 'TEMP'
      v.textContent = 'N/A'
      temp.title = t.reason
    }
  })
}
