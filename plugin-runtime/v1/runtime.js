// CRT Terminal plugin runtime, API v1.
// Runs inside each plugin's sandboxed iframe (crt-plugin://<id>/_frame). It connects to the host
// panel over a MessagePort, loads the plugin's entry module and gives it the `ctx` API described
// in crt-plugin.d.ts. The plugin has no other way to reach the app.

const API_VERSION = 1
const root = document.getElementById('root')

/** @type {MessagePort | null} */
let port = null
let manifest = null
let theme = null
let settings = {}
let policy = { paused: false, fps: 30 }
let panel = { id: '', title: '' }
let instance = null
let booted = false

const themeListeners = new Set()
const settingsListeners = new Set()
const titleListeners = new Set()
const dataListeners = new Map() // topic -> Set<cb>
const frameCallbacks = new Set()
const pendingPermissions = new Map()
const pendingFetches = new Map()
let requestSeq = 0

const send = (msg) => port && port.postMessage(msg)

function reportError(err, phase) {
  const e = err instanceof Error ? err : new Error(String(err))
  send({ type: 'error', phase, message: e.message || String(err), stack: String(e.stack || '') })
}

window.addEventListener('error', (e) => reportError(e.error || e.message, 'runtime'))
window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'async'))

/** Call plugin code, turning a throw into an error report instead of a dead panel. */
function guard(fn, phase) {
  try {
    return fn()
  } catch (err) {
    reportError(err, phase)
    return undefined
  }
}

// ------------------------------------------------------------------ theme
function applyTheme() {
  const style = document.documentElement.style
  for (const [k, v] of Object.entries(theme.cssVariables)) style.setProperty(k, v)
  style.setProperty('--font-mono', `'${theme.fonts.mono}', monospace`)
  style.setProperty('--font-ui', `'${theme.fonts.ui}', monospace`)
  document.body.style.color = theme.chrome.fg
  document.body.style.fontFamily = `'${theme.fonts.ui}', monospace`
}

// Fonts shipped with the app, so plugins can match it.
const fontCss = document.createElement('style')
fontCss.textContent = [
  ['IBM Plex Mono', 400, 'ibm-plex-mono-400'],
  ['IBM Plex Mono', 700, 'ibm-plex-mono-700'],
  ['Share Tech Mono', 400, 'share-tech-mono-400']
]
  .map(([family, weight, file]) => `@font-face{font-family:'${family}';font-weight:${weight};font-display:swap;src:url(crt-plugin://_runtime/fonts/${file}.woff2) format('woff2')}`)
  .join('\n')
document.head.appendChild(fontCss)

// ------------------------------------------------------------------ animation
// One rAF loop for all of the plugin's frame callbacks, capped at the host's fps and stopped
// entirely while the host says the panel is paused (hidden, or unfocused when so configured).
let raf = 0
let lastFrame = 0
function loop(now) {
  raf = 0
  if (policy.paused || !frameCallbacks.size) return
  const minGap = 1000 / policy.fps - 2
  if (now - lastFrame >= minGap) {
    const dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0
    lastFrame = now
    for (const cb of [...frameCallbacks]) {
      try {
        cb(now / 1000, dt)
      } catch (err) {
        frameCallbacks.delete(cb) // a callback that throws stops being called
        reportError(err, 'animate')
      }
    }
  }
  raf = requestAnimationFrame(loop)
}
function kick() {
  if (!raf && !policy.paused && frameCallbacks.size) {
    lastFrame = 0
    raf = requestAnimationFrame(loop)
  }
}

// ------------------------------------------------------------------ ctx
function listen(set, cb) {
  set.add(cb)
  return () => set.delete(cb)
}

const ctx = {
  apiVersion: API_VERSION,
  el: root,
  get panel() {
    return { ...panel }
  },
  get manifest() {
    return manifest
  },
  get theme() {
    return theme
  },
  onTheme: (cb) => listen(themeListeners, cb),
  get settings() {
    return { ...settings }
  },
  onSettings: (cb) => listen(settingsListeners, cb),
  onTitle: (cb) => listen(titleListeners, cb),
  setSetting(key, value) {
    send({ type: 'setSetting', key: String(key), value })
  },
  subscribe(topic, cb) {
    if (!manifest.data.includes(topic)) throw new Error(`"${topic}" is not listed in this plugin's manifest "data"`)
    let set = dataListeners.get(topic)
    if (!set) {
      dataListeners.set(topic, (set = new Set()))
      send({ type: 'subscribe', topic })
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (!set.size) {
        dataListeners.delete(topic)
        send({ type: 'unsubscribe', topic })
      }
    }
  },
  animate(cb) {
    frameCallbacks.add(cb)
    kick()
    return () => frameCallbacks.delete(cb)
  },
  get paused() {
    return policy.paused
  },
  onResize(cb) {
    const ro = new ResizeObserver(() => guard(() => cb(root.clientWidth, root.clientHeight), 'resize'))
    ro.observe(root)
    return () => ro.disconnect()
  },
  get size() {
    return { width: root.clientWidth, height: root.clientHeight }
  },
  /**
   * HTTPS request to a host listed in the manifest's permissions.network (the page itself has
   * no network access). Resolves to a small Response-like object; rejects on network errors.
   */
  fetch(url, init = {}) {
    const id = ++requestSeq
    send({ type: 'fetch', id, url: String(url), init: { method: init.method, headers: init.headers, body: init.body } })
    return new Promise((resolve, reject) => pendingFetches.set(id, { resolve, reject }))
  },
  requestPermission(name) {
    const id = ++requestSeq
    send({ type: 'requestPermission', id, name })
    return new Promise((resolve) => pendingPermissions.set(id, resolve))
  },
  log(...args) {
    console.log(`[${manifest?.id}]`, ...args)
  }
}

// ------------------------------------------------------------------ host messages
function onHostMessage(e) {
  const m = e.data
  switch (m && m.type) {
    case 'init':
      if (booted) return
      booted = true
      manifest = m.manifest
      theme = m.theme
      settings = m.settings
      policy = m.policy
      panel = m.panel
      applyTheme()
      void boot(m.entryUrl)
      break
    case 'theme':
      theme = m.theme
      applyTheme()
      for (const cb of [...themeListeners]) guard(() => cb(theme), 'theme')
      if (instance && instance.update) guard(() => instance.update({ theme }), 'update')
      break
    case 'settings':
      settings = m.settings
      for (const cb of [...settingsListeners]) guard(() => cb({ ...settings }), 'settings')
      if (instance && instance.update) guard(() => instance.update({ settings: { ...settings } }), 'update')
      break
    case 'title':
      panel = { ...panel, title: m.title }
      for (const cb of [...titleListeners]) guard(() => cb(m.title), 'title')
      break
    case 'policy':
      policy = m.policy
      if (policy.paused && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      kick()
      break
    case 'data':
      for (const cb of [...(dataListeners.get(m.topic) || [])]) guard(() => cb(m.payload), `data:${m.topic}`)
      break
    case 'permission': {
      const resolve = pendingPermissions.get(m.id)
      pendingPermissions.delete(m.id)
      if (resolve) resolve(!!m.granted)
      break
    }
    case 'ping':
      send({ type: 'pong', id: m.id })
      break
    case 'fetchResult': {
      const p = pendingFetches.get(m.id)
      pendingFetches.delete(m.id)
      if (!p) break
      const r = m.result || {}
      if (r.error) p.reject(new Error(r.error))
      else
        p.resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          statusText: r.statusText,
          headers: { 'content-type': r.contentType },
          text: async () => r.body,
          json: async () => JSON.parse(r.body)
        })
      break
    }
    case 'input':
      guard(() => replayInput(m), 'input')
      break
  }
}

// ------------------------------------------------------------------ input replay
// The host forwards pointer and wheel input (the iframe itself doesn't receive any). Replay it as
// ordinary DOM events so plugin code can use normal listeners: pointer*/mouse* (with enter/leave),
// click, dblclick, wheel. A wheel nobody cancels scrolls the nearest scrollable element.
let hoverChain = []

function chainOf(el) {
  const out = []
  for (let n = el; n; n = n.parentElement) out.push(n)
  return out
}

function initOf(m, bubbles = true) {
  return {
    bubbles,
    cancelable: true,
    composed: true,
    clientX: m.x,
    clientY: m.y,
    button: m.button || 0,
    buttons: m.buttons || 0,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    ...(m.mods || {})
  }
}

function setHover(target, m) {
  const next = target ? chainOf(target) : []
  for (const el of hoverChain) {
    if (next.includes(el)) continue
    el.dispatchEvent(new PointerEvent('pointerleave', initOf(m, false)))
    el.dispatchEvent(new MouseEvent('mouseleave', initOf(m, false)))
  }
  for (const el of [...next].reverse()) {
    if (hoverChain.includes(el)) continue
    el.dispatchEvent(new PointerEvent('pointerenter', initOf(m, false)))
    el.dispatchEvent(new MouseEvent('mouseenter', initOf(m, false)))
  }
  hoverChain = next
}

function scrollable(el, vertical) {
  const style = getComputedStyle(el)
  const overflow = vertical ? style.overflowY : style.overflowX
  const room = vertical ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth
  return room && (overflow === 'auto' || overflow === 'scroll')
}

function replayInput(m) {
  if (m.kind === 'leave') return setHover(null, m)
  const target = document.elementFromPoint(m.x, m.y) || root
  const init = initOf(m)
  switch (m.kind) {
    case 'move':
      setHover(target, m)
      target.dispatchEvent(new PointerEvent('pointermove', init))
      target.dispatchEvent(new MouseEvent('mousemove', init))
      break
    case 'down':
      target.dispatchEvent(new PointerEvent('pointerdown', init))
      target.dispatchEvent(new MouseEvent('mousedown', init))
      break
    case 'up':
      target.dispatchEvent(new PointerEvent('pointerup', init))
      target.dispatchEvent(new MouseEvent('mouseup', init))
      break
    case 'click': {
      // Form controls need click() to toggle/activate; everything else gets a positioned event.
      const control = target.closest('button, input, label, a, summary')
      if (control) control.click()
      else target.dispatchEvent(new MouseEvent('click', init))
      break
    }
    case 'dblclick':
      target.dispatchEvent(new MouseEvent('dblclick', init))
      break
    case 'wheel': {
      const unit = m.deltaMode === 1 ? 16 : m.deltaMode === 2 ? root.clientHeight : 1
      const dx = (m.deltaX || 0) * unit
      const dy = (m.deltaY || 0) * unit
      const ev = new WheelEvent('wheel', { ...init, deltaX: dx, deltaY: dy, deltaMode: 0 })
      if (!target.dispatchEvent(ev)) break
      for (let n = target; n; n = n.parentElement) {
        if ((dy && scrollable(n, true)) || (dx && scrollable(n, false))) {
          n.scrollBy({ left: dx, top: dy })
          break
        }
      }
      break
    }
  }
}

async function boot(entryUrl) {
  try {
    const mod = await import(entryUrl)
    const mount = mod.mount || (mod.default && mod.default.mount)
    if (typeof mount !== 'function') throw new Error('the entry module must export a mount(ctx) function')
    instance = (await mount(ctx)) || null
    send({ type: 'ready' })
  } catch (err) {
    reportError(err, 'mount')
  }
}

window.addEventListener('pagehide', () => {
  if (instance && instance.unmount) guard(() => instance.unmount(), 'unmount')
})

// The host hands us our end of the channel in a one-off window message.
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || port || !e.data || e.data.type !== 'crt:connect' || !e.ports[0]) return
  port = e.ports[0]
  port.onmessage = onHostMessage
  send({ type: 'connected', apiVersion: API_VERSION })
})
