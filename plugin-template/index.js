// Starter plugin: a big phosphor clock with the CPU load under it.
// Save this file and the panel reloads by itself. Guide: docs/plugin-api.md (in the app repo).

/** @param {import('./crt-plugin').PluginContext} ctx */
export function mount(ctx) {
  // 1. Build your UI inside ctx.el. Colours come from the theme as CSS variables.
  const style = document.createElement('style')
  style.textContent = `
    .clock { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
    .time  { color: var(--phosphor); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .sub   { color: var(--chrome-dim); font-size: 12px; margin-top: 4px; }
  `
  document.head.appendChild(style)
  ctx.el.innerHTML = '<div class="clock"><div class="time"></div><div class="sub"></div></div>'
  const time = ctx.el.querySelector('.time')
  const sub = ctx.el.querySelector('.sub')

  // 2. Read your settings (declared in manifest.json, edited in Settings → Plugins).
  function render() {
    const s = ctx.settings
    time.style.fontSize = `${s.size}px`
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: s.seconds ? '2-digit' : undefined })
  }
  render()
  ctx.onSettings(render)
  const timer = setInterval(render, 1000)

  // 3. Subscribe to data listed in manifest.json "data".
  ctx.subscribe('cpu', (cpu) => {
    sub.textContent = `CPU ${Math.round(cpu.total * 100)}% · ${cpu.cores.length} cores`
  })

  // 4. Clean up what ctx doesn't know about.
  return {
    unmount() {
      clearInterval(timer)
    }
  }
}
