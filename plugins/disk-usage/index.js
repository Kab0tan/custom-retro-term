// Disk usage: a two-ring sunburst of the home folder (Baobab style), kept to the 10 largest entries so it reads on a
// small screen. Inner ring: the largest folders in home; outer ring: the largest things inside each. Angles are a share
// of the whole home folder, so what the top 10 leave out stays as an empty arc. Hover a slice or a legend row.

/** @typedef {import('../../plugin-runtime/crt-plugin').PluginContext} PluginContext */
/** @typedef {import('../../plugin-runtime/crt-plugin').DiskData} DiskData */
/** @typedef {import('../../plugin-runtime/crt-plugin').DiskEntry} DiskEntry */

const CSS = `
.du { position: absolute; inset: 0; display: flex; flex-direction: column; box-sizing: border-box;
  font: 13px/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--phosphor); font-variant-numeric: tabular-nums; }
.main { flex: 1; min-height: 0; display: flex; gap: 14px; padding: 12px 16px 8px; }
.du.tall .main { flex-direction: column; }
.chart { position: relative; flex: 1 1 55%; min-width: 0; min-height: 0; }
.chart canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.legend { flex: 1 1 45%; min-width: 0; min-height: 0; overflow-y: auto; align-self: center; max-height: 100%; }
.du.tall .legend { align-self: stretch; flex: 0 1 auto; }
.row { display: grid; grid-template-columns: 2.5ch minmax(0, 1fr) auto; gap: 10px; align-items: baseline;
  padding: 3px 4px; cursor: default; }
.row .n { color: var(--phosphor-dim); }
.row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .size { color: var(--phosphor-dim); }
.row .bar { grid-column: 2 / 4; height: 2px; background: var(--phosphor-faint); }
.row .bar i { display: block; height: 100%; background: var(--phosphor-dim); }
.row.hot { background: var(--phosphor-faint); }
.row.hot .name, .row.hot .size { color: var(--phosphor-bright); text-shadow: 0 0 6px var(--phosphor-glow); }
.row.hot .bar i { background: var(--phosphor-bright); }
.note { padding: 6px 4px; color: var(--phosphor-dim); text-transform: none; }
.foot { flex-shrink: 0; display: flex; flex-wrap: wrap; gap: 6px 22px; padding: 10px 16px;
  border-top: 1px solid var(--chrome-border); color: var(--phosphor-dim); }
.foot b { font-weight: normal; margin-left: 8px; color: var(--phosphor-bright); }
.again { margin-left: auto; padding: 0 6px; border: 1px solid var(--phosphor-dim); background: none;
  font: inherit; line-height: 1.3; color: var(--phosphor); cursor: pointer; }
.again:hover { color: var(--phosphor-bright); border-color: var(--phosphor); background: var(--phosphor-faint);
  text-shadow: 0 0 6px var(--phosphor-glow); }
.again:disabled { opacity: 0.35; cursor: default; background: none; }
.busy b { animation: blink 1s steps(2) infinite; }
.hidden { display: none !important; }
@keyframes blink { 50% { opacity: 0.3; } }
`

const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function size(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${bytes >= 100 || i === 0 ? Math.round(bytes) : bytes.toFixed(1)} ${units[i]}`
}

const START = -Math.PI / 2
const TAU = Math.PI * 2

/** @param {PluginContext} ctx */
export function mount(ctx) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = el('div', 'du')
  const main = el('div', 'main')
  const chart = el('div', 'chart')
  const canvas = document.createElement('canvas')
  const legend = el('div', 'legend')
  const foot = el('div', 'foot')
  chart.appendChild(canvas)
  main.append(chart, legend)
  root.append(main, foot)
  ctx.el.appendChild(root)
  const g = canvas.getContext('2d')
  const again = el('button', 'again', '↻')
  again.title = 'Rescan now'
  again.addEventListener('click', () => {
    if (last?.available && last.scanning) return
    again.disabled = true
    ctx.refresh('disk')
  })

  /** @type {DiskData | null} */
  let last = null
  /** Slices from the last draw, for hit testing: { r0, r1, a0, a1, entry, rank, parent } */
  let slices = []
  /** Hovered: { rank, child } (child -1 for the folder itself), or null. */
  let hot = null

  const rgba = (a) => {
    const [r, gg, b] = ctx.theme.phosphor.rgb
    return `rgba(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)},${a})`
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1
    const w = chart.clientWidth
    const h = chart.clientHeight
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    slices = []
    if (!last?.available || !last.bytes) return

    const showInner = ctx.settings.showInner !== false
    const R = Math.max(0, Math.min(w, h) / 2 - 4)
    const cx = w / 2
    const cy = h / 2
    const hole = R * 0.32
    const mid = showInner ? R * 0.68 : R
    const outer0 = mid + 3
    const total = last.bytes
    const bg = ctx.theme.phosphor.background
    const theme = ctx.theme

    // Guide rings: what the top 10 leave out reads as an empty, outlined arc.
    g.lineWidth = 1
    g.strokeStyle = rgba(0.25)
    for (const r of showInner ? [hole, mid, R] : [hole, R]) {
      g.beginPath()
      g.arc(cx, cy, r, 0, TAU)
      g.stroke()
    }

    const slice = (r0, r1, a0, a1, fill, hi) => {
      g.beginPath()
      g.arc(cx, cy, r1, a0, a1)
      g.arc(cx, cy, r0, a1, a0, true)
      g.closePath()
      g.fillStyle = fill
      if (hi) {
        g.shadowColor = theme.phosphor.bright
        g.shadowBlur = 10
      }
      g.fill()
      g.shadowBlur = 0
      g.lineWidth = 1.5
      g.strokeStyle = bg
      g.stroke()
    }

    let a = START
    last.entries.forEach((e, rank) => {
      const span = (e.bytes / total) * TAU
      const a0 = a
      const a1 = a + span
      a = a1
      if (span <= 0) return
      const on = hot?.rank === rank
      const dim = hot && !on
      const alpha = 0.92 - rank * 0.06
      slice(hole, mid, a0, a1, on ? theme.phosphor.bright : rgba(dim ? alpha * 0.45 : alpha), on && hot.child < 0)
      slices.push({ r0: hole, r1: mid, a0, a1, entry: e, rank, child: -1 })

      // Rank number on the slice when it fits.
      const rm = (hole + mid) / 2
      if (span * rm > 18) {
        const am = (a0 + a1) / 2
        g.fillStyle = bg
        g.font = `12px ${theme.fonts.mono}`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(String(rank + 1), cx + Math.cos(am) * rm, cy + Math.sin(am) * rm)
      }

      if (!showInner || !e.children) return
      let b = a0
      e.children.forEach((c, i) => {
        const cs = (c.bytes / total) * TAU
        const b0 = b
        b += cs
        if (cs * R < 1) return
        const con = on && hot.child === i
        const ca = alpha * (0.62 - i * 0.04)
        slice(outer0, R, b0, b, con ? theme.phosphor.bright : rgba(dim ? ca * 0.45 : on ? ca + 0.2 : ca), con)
        slices.push({ r0: outer0, r1: R, a0: b0, a1: b, entry: c, rank, child: i })
      })
    })

    // Centre: the hovered entry, or the whole folder.
    const sel = hot && slices.find((s) => s.rank === hot.rank && s.child === hot.child)
    const label = sel ? sel.entry.name : 'HOME'
    const value = sel ? size(sel.entry.bytes) : size(total)
    const sub = sel ? `${((sel.entry.bytes / total) * 100).toFixed(1)}%` : last.scanning ? 'SCANNING' : `${last.files.toLocaleString()} FILES`
    const fit = (text, px) => {
      g.font = `${px}px ${theme.fonts.mono}`
      let t = text.toUpperCase()
      while (t.length > 1 && g.measureText(t).width > hole * 1.7) t = t.slice(0, -2) + '…'
      return t
    }
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const big = Math.max(11, Math.min(20, hole * 0.34))
    g.fillStyle = theme.phosphor.bright
    g.fillText(fit(value, big), cx, cy)
    g.fillStyle = theme.phosphor.dim
    g.fillText(fit(label, 11), cx, cy - big * 0.95)
    g.fillText(fit(sub, 11), cx, cy + big * 0.95)
  }

  function renderLegend() {
    legend.classList.toggle('hidden', ctx.settings.showLegend === false)
    legend.replaceChildren()
    if (!last) {
      legend.appendChild(el('div', 'note', 'Waiting for the first scan…'))
      return
    }
    if (!last.available) {
      legend.appendChild(el('div', 'note', last.reason))
      return
    }
    const max = last.entries[0]?.bytes || 1
    last.entries.forEach((e, rank) => {
      const r = el('div', 'row')
      r.dataset.rank = String(rank)
      if (hot?.rank === rank) r.classList.add('hot')
      const bar = el('span', 'bar')
      const fill = el('i')
      fill.style.width = `${(e.bytes / max) * 100}%`
      bar.appendChild(fill)
      r.append(el('span', 'n', String(rank + 1).padStart(2, '0')), el('span', 'name', e.dir ? `${e.name}/` : e.name), el('span', 'size', size(e.bytes)), bar)
      r.title = `${e.name} · ${size(e.bytes)}`
      r.addEventListener('pointerenter', () => setHot({ rank, child: -1 }))
      r.addEventListener('pointerleave', () => setHot(null))
      legend.appendChild(r)
    })
    if (!last.entries.length) legend.appendChild(el('div', 'note', last.scanning ? 'Scanning…' : 'Empty.'))
  }

  function renderFoot() {
    foot.replaceChildren()
    again.disabled = !last || (last.available && last.scanning)
    if (!last?.available) {
      if (last) foot.appendChild(again)
      return
    }
    const item = (label, value, cls = '') => {
      const c = el('span', cls, label)
      c.appendChild(el('b', '', value))
      foot.appendChild(c)
    }
    item('HOME', size(last.bytes))
    if (last.volume) item('FREE', `${size(last.volume.freeBytes)} / ${size(last.volume.totalBytes)}`)
    if (last.scanning) item('SCAN', `${last.files.toLocaleString()} FILES`, 'busy')
    else item('AT', new Date(last.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    foot.appendChild(again)
  }

  function setHot(h) {
    if (h?.rank === hot?.rank && h?.child === hot?.child) return
    hot = h
    for (const r of legend.children) r.classList.toggle('hot', hot != null && r.dataset.rank === String(hot.rank))
    draw()
  }

  function layout() {
    root.classList.toggle('tall', ctx.size.width < ctx.size.height * 1.2)
    draw()
  }

  canvas.addEventListener('pointermove', (ev) => {
    const box = canvas.getBoundingClientRect()
    const x = ev.clientX - box.left - box.width / 2
    const y = ev.clientY - box.top - box.height / 2
    const r = Math.hypot(x, y)
    let ang = Math.atan2(y, x)
    if (ang < START) ang += TAU
    const s = slices.find((s) => r >= s.r0 && r <= s.r1 && ang >= s.a0 && ang < s.a1)
    setHot(s ? { rank: s.rank, child: s.child } : null)
  })
  canvas.addEventListener('pointerleave', () => setHot(null))

  function render() {
    renderLegend()
    renderFoot()
    draw()
  }

  ctx.subscribe('disk', (data) => {
    last = data
    render()
  })
  ctx.onSettings(render)
  ctx.onTheme(draw)
  ctx.onResize(layout)
  layout()
  render()
}
