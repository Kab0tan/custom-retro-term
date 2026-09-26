// Spectrum: system audio in log-spaced frequency bands (30 Hz – 16 kHz), dB scale, with peak hold.
// Draws when an audio frame arrives; goes quiet (no redraws) once silence has settled.

/** @typedef {import('../../plugin-runtime/crt-plugin').PluginContext} PluginContext */

const F_MIN = 30
const F_MAX = 16000
const PEAK_FALL = 0.6 // of full scale per second

const CSS = `
canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.note { position: absolute; left: 0; right: 0; top: 40%; display: flex; gap: 10px; justify-content: center; align-items: center;
  font-size: 12px; color: var(--chrome-dim); pointer-events: none; }
.note[hidden] { display: none; }
.note button { pointer-events: auto; padding: 2px 10px; border: 1px solid var(--chrome-border); border-radius: 3px;
  background: var(--popup-bg); color: var(--chrome-fg); font: inherit; cursor: pointer; }
.note button[hidden] { display: none; }
`

/** @param {PluginContext} ctx */
export function mount(ctx) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const canvas = document.createElement('canvas')
  const note = document.createElement('div')
  note.className = 'note'
  note.innerHTML = '<span></span><button>Listen to system audio</button>'
  ctx.el.append(canvas, note)
  const listen = note.querySelector('button')
  listen.addEventListener('click', () => void ctx.requestPermission('audio'))

  const g = canvas.getContext('2d')
  let w = 0
  let h = 0
  let levels = new Float32Array(0)
  let peaks = new Float32Array(0)
  let lastTime = 0
  let settled = false

  function fit() {
    const dpr = devicePixelRatio || 1
    w = ctx.el.clientWidth
    h = ctx.el.clientHeight
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw()
  }

  const LABEL_H = () => (ctx.settings.labels ? 16 : 0)

  function draw() {
    const t = ctx.theme
    g.fillStyle = t.phosphor.background
    g.fillRect(0, 0, w, h)
    const n = levels.length || Number(ctx.settings.bars) || 48
    const plotH = h - LABEL_H() - 6
    const gap = 2
    const slot = (w - 12) / n
    const barW = Math.min(24, Math.max(1, slot - gap))
    const x0 = 6 + (slot - barW) / 2
    // Baseline hairline.
    g.fillStyle = t.chrome.border
    g.fillRect(6, plotH + 0.5, w - 12, 1)
    g.fillStyle = t.phosphor.base
    for (let i = 0; i < levels.length; i++) {
      const bh = Math.max(1, levels[i] * (plotH - 4))
      const x = x0 + i * slot
      g.beginPath()
      g.roundRect(x, plotH - bh, barW, bh, [Math.min(4, barW / 2), Math.min(4, barW / 2), 0, 0])
      g.fill()
    }
    if (ctx.settings.peakHold) {
      g.fillStyle = t.phosphor.bright
      for (let i = 0; i < peaks.length; i++) {
        if (peaks[i] <= 0.01) continue
        g.fillRect(x0 + i * slot, plotH - peaks[i] * (plotH - 4) - 2, barW, 2)
      }
    }
    if (ctx.settings.labels) {
      g.fillStyle = t.chrome.dim
      g.font = `11px '${t.fonts.ui}', monospace`
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      for (const [f, label] of [
        [100, '100'],
        [1000, '1k'],
        [10000, '10k']
      ]) {
        const x = 6 + (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * (w - 12)
        g.fillText(label, x, h - 2)
      }
      g.textAlign = 'right'
      g.fillText('Hz', w - 6, h - 2)
    }
  }

  ctx.subscribe('audio', (a) => {
    if (!a.available) {
      note.hidden = false
      note.firstChild.textContent = a.reason === 'not-allowed' ? 'System audio analysis is off.' : a.message
      listen.hidden = a.reason !== 'not-allowed'
      levels = new Float32Array(0)
      peaks = new Float32Array(0)
      draw()
      return
    }
    note.hidden = true
    const now = performance.now() / 1000
    const dt = lastTime ? Math.min(0.2, now - lastTime) : 0
    lastTime = now

    const n = Number(ctx.settings.bars) || 48
    if (levels.length !== n) {
      levels = new Float32Array(n)
      peaks = new Float32Array(n)
    }
    const binHz = a.sampleRate / 2 / a.spectrum.length
    const top = Math.min(F_MAX, a.sampleRate / 2)
    const smoothing = Number(ctx.settings.smoothing) || 0
    let any = false
    for (let i = 0; i < n; i++) {
      const f0 = F_MIN * Math.pow(top / F_MIN, i / n)
      const f1 = F_MIN * Math.pow(top / F_MIN, (i + 1) / n)
      const b0 = Math.floor(f0 / binHz)
      const b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz))
      let db = -Infinity
      for (let b = b0; b < b1 && b < a.spectrum.length; b++) db = Math.max(db, a.spectrum[b])
      const v = Math.min(1, Math.max(0, (db - a.minDb) / (a.maxDb - a.minDb)))
      // Rise instantly, fall smoothly.
      levels[i] = v > levels[i] ? v : levels[i] * smoothing + v * (1 - smoothing)
      peaks[i] = Math.max(levels[i], peaks[i] - PEAK_FALL * dt)
      if (levels[i] > 0.01 || peaks[i] > 0.01) any = true
    }
    // Silence: draw the empty state once, then stop repainting.
    if (!any) {
      if (settled) return
      settled = true
    } else settled = false
    if (!ctx.paused) draw()
  })

  ctx.onResize(fit)
  ctx.onTheme(draw)
  ctx.onSettings(draw)
  fit()
}
