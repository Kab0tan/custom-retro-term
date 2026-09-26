// Kernel log: the Windows System event log as a scrolling dmesg-style tail.
// Follows new lines while you're at the bottom; scrolling up pins the view.

/** @typedef {import('../../plugin-runtime/crt-plugin').PluginContext} PluginContext */

const RANK = { info: 0, warning: 1, error: 2, critical: 3 }
// Severity is carried by an icon and a label, never by colour alone.
const LEVEL = {
  critical: ['✖', 'CRIT'],
  error: ['✖', 'ERR'],
  warning: ['▲', 'WARN'],
  info: ['·', 'INFO']
}

const CSS = `
.log { position: absolute; inset: 0; display: flex; flex-direction: column; font: 12px/1.45 var(--font-mono); }
.lines { flex: 1; margin: 0; padding: 4px 10px; overflow-y: auto; list-style: none; }
.lines li { display: flex; gap: 8px; white-space: nowrap; }
.t, .src, .lvl { color: var(--chrome-dim); flex-shrink: 0; }
.lvl { width: 52px; }
.src { width: 110px; overflow: hidden; text-overflow: ellipsis; }
.msg { color: var(--chrome-fg); overflow: hidden; text-overflow: ellipsis; }
.warning .lvl, .warning .msg { color: var(--phosphor-bright); }
.error .lvl, .error .msg, .critical .lvl, .critical .msg { color: var(--phosphor-bright); font-weight: 700; }
.no-src .src { display: none; }
.empty { color: var(--chrome-dim); }
.jump { position: absolute; right: 12px; bottom: 8px; padding: 2px 8px; border: 1px solid var(--chrome-border); border-radius: 3px;
  background: var(--popup-bg); color: var(--chrome-fg); font: inherit; cursor: pointer; }
.jump[hidden] { display: none; }
`

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false })

/** @param {PluginContext} ctx */
export function mount(ctx) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'log'
  root.innerHTML = '<ol class="lines" aria-label="System event log"></ol><button class="jump" hidden>↓ Latest</button>'
  ctx.el.appendChild(root)
  const list = root.querySelector('.lines')
  const jump = root.querySelector('.jump')

  let entries = []
  let following = true

  function row(e) {
    const li = document.createElement('li')
    li.className = e.level
    const [icon, label] = LEVEL[e.level] ?? LEVEL.info
    for (const [cls, text] of [
      ['t', time(e.time)],
      ['lvl', `${icon} ${label}`],
      ['src', e.source],
      ['msg', e.message]
    ]) {
      const span = document.createElement('span')
      span.className = cls
      span.textContent = text
      if (cls === 'msg' || cls === 'src') span.title = text
      li.appendChild(span)
    }
    return li
  }

  function render() {
    const s = ctx.settings
    const min = RANK[s.minLevel] ?? 0
    const shown = entries.filter((e) => (RANK[e.level] ?? 0) >= min)
    list.classList.toggle('no-src', !s.showSource)
    if (!shown.length) {
      const li = document.createElement('li')
      li.className = 'empty'
      li.textContent = entries.length ? 'No entries at this level yet.' : 'Waiting for events…'
      list.replaceChildren(li)
      return
    }
    list.replaceChildren(...shown.map(row))
    if (following) list.scrollTop = list.scrollHeight
  }

  list.addEventListener('scroll', () => {
    following = list.scrollHeight - list.scrollTop - list.clientHeight < 8
    jump.hidden = following
  })
  jump.addEventListener('click', () => {
    following = true
    jump.hidden = true
    list.scrollTop = list.scrollHeight
  })

  ctx.subscribe('log', (p) => {
    const max = Number(ctx.settings.maxLines) || 300
    const next = p.reset ? p.entries : entries.concat(p.entries)
    entries = next.length > max ? next.slice(next.length - max) : next
    render()
  })
  ctx.onSettings(render)
  render()
}
