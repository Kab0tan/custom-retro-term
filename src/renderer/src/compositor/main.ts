// webgl renderer host: draws offscreen UI frames through the CRT pipeline and forwards
// input back to the offscreen window, undoing the curvature so clicks land correctly.
import { curveUv, uncurveUv, type FrameTransport, type UiRect } from '@shared/types'
import { keyDownEvents, keyUpEvents, modifiersOf, producesText, type ForwardedInputEvent } from '@shared/input'
import { DEFAULT_CRT, effectiveCrt, type CrtSettings, type Settings } from '@shared/settings'
import { PHOSPHORS } from '@shared/phosphor'
import type { OsrStatsSnapshot } from '../../../preload/compositor-bridge'
import { CrtRenderer } from '../crt/renderer'

const bridge = window.compositor
const transport = (new URLSearchParams(location.search).get('transport') ?? 'shared') as FrameTransport
const canvas = document.getElementById('screen') as HTMLCanvasElement
const kbd = document.getElementById('kbd') as HTMLTextAreaElement
const hudEl = document.getElementById('hud') as HTMLDivElement
const dragLayer = document.getElementById('drag') as HTMLDivElement

let crt: CrtSettings = DEFAULT_CRT
const renderer = createRenderer()

/** A shader or WebGL failure would otherwise be a silent black window: say so on screen. */
function createRenderer(): CrtRenderer {
  try {
    return new CrtRenderer(canvas, crt)
  } catch (err) {
    hudEl.hidden = false
    hudEl.style.cssText = 'top:40px;left:40px;right:40px;bottom:auto;font-size:13px;white-space:pre-wrap'
    hudEl.textContent =
      `CRT renderer failed to start:

${(err as Error).message}

` +
      'Switch Settings → Rendering → Renderer to "CSS overlay" (settings.json: "crt": { "renderer": "css" }) and restart.'
    throw err
  }
}

// ---------------------------------------------------------------- render loop
// Draw on new content, or continuously only while an effect animates. Idle = no GPU work.
// Flicker/noise rest after REST_MS without keyboard or mouse input, frozen at their last state. New frames still
// draw while resting, but don't wake the effects: panels update every second and would keep them running forever.
const REST_MS = 10_000
let focused = document.hasFocus()
let visible = document.visibilityState === 'visible'
let rafPending = false
let poked = false // something asked for a draw since the last tick
let animTime = 0 // effect clock; stops while paused so the picture freezes, not jumps
let lastTick = 0
let lastActivityAt = performance.now()

function schedule(): void {
  poked = true
  if (rafPending || !visible) return
  rafPending = true
  requestAnimationFrame(tick)
}

/** Input, focus or a settings change: effects resume. */
function wake(): void {
  lastActivityAt = performance.now()
  schedule()
}

function tick(now: number): void {
  rafPending = false
  const poke = poked
  poked = false
  if (renderer.needsAnimation(focused) && now - lastActivityAt > REST_MS) {
    // Resting: only explicit requests (resize, settings, focus…) draw, at the frozen time.
    lastTick = 0
    if (!poke) return
    if (renderer.wantsDraw(now, focused)) renderer.draw(now, animTime)
    else schedule() // throttled; try again next frame
    return
  }
  const animating = renderer.needsAnimation(focused)
  if (lastTick && animating) animTime += Math.min(0.1, (now - lastTick) / 1000)
  lastTick = now
  if (renderer.wantsDraw(now, focused)) renderer.draw(now, animTime)
  // Keep ticking while animating, or until a throttled draw has gone out.
  if (animating || renderer.wantsDraw(now + 1000, focused)) schedule()
  else lastTick = 0
}

bridge.onVideoFrame((frame) => {
  renderer.uploadVideoFrame(frame)
  frame.close()
  frameArrived()
})
bridge.onBitmap((w, h, bgra) => {
  renderer.uploadBitmap(w, h, bgra)
  frameArrived()
})

window.addEventListener('focus', () => {
  focused = true
  kbd.focus({ preventScroll: true })
  wake()
})
window.addEventListener('blur', () => {
  focused = false
  schedule() // one more draw at the frozen time
})
document.addEventListener('visibilitychange', () => {
  visible = document.visibilityState === 'visible'
  renderer.invalidate()
  schedule()
})
new ResizeObserver(() => {
  renderer.invalidate()
  layoutDragRects()
  schedule()
}).observe(canvas)

void bridge.getSettings().then(applySettings)
bridge.onSettings(applySettings)

/** Live: every settings change (phosphor, sliders, toggles) redraws with the new values. */
function applySettings(s: Settings): void {
  crt = effectiveCrt(s.crt)
  renderer.setSettings(crt, PHOSPHORS[s.phosphor].shader)
  layoutDragRects()
  wake()
}

/** Curvature actually in effect (0 when effects are off, so input maps 1:1). */
const curvature = (): number => (crt.enabled ? crt.curvature : 0)

// ---------------------------------------------------------------- HUD (Ctrl+Shift+F10)
let framesIn = 0
let lastKeyAt = 0
let keyToFrameMs: number | null = null
let osrStats: OsrStatsSnapshot | null = null

function frameArrived(): void {
  framesIn++
  if (lastKeyAt) {
    keyToFrameMs = performance.now() - lastKeyAt
    lastKeyAt = 0
  }
  schedule()
}
bridge.onOsrStats((s) => (osrStats = s))

setInterval(() => {
  const draws = renderer.draws
  renderer.draws = 0
  const fin = framesIn
  framesIn = 0
  if (hudEl.hidden) return
  const c = osrStats?.cpu
  hudEl.textContent = [
    `transport   ${transport}`,
    `draws/s     ${draws}  (cap ${crt.fpsCap}${focused ? '' : ', unfocused'})`,
    `frames in/s ${fin}  (osr paints ${osrStats?.paintsPerSec ?? '-'}, dropped ${osrStats?.droppedPerSec ?? '-'})`,
    `key→frame   ${keyToFrameMs === null ? '-' : keyToFrameMs.toFixed(1)} ms`,
    `frame       ${osrStats?.frameSize ?? '-'}`,
    `cpu %       ui ${c?.ui ?? '-'} · host ${c?.host ?? '-'} · gpu ${c?.gpu ?? '-'} · main ${c?.main ?? '-'}`
  ].join('\n')
}, 1000)

// ---------------------------------------------------------------- keyboard
// Text goes through the hidden textarea (dead keys, AltGr, IME, emoji picker compose natively);
// everything else is forwarded as key events.
const send = (events: ForwardedInputEvent[]): void => {
  if (!events.length) return
  bridge.sendInput(events)
  wake()
}
const forwardedKeys = new Set<string>()

kbd.focus({ preventScroll: true })
kbd.addEventListener('keydown', (e) => {
  if (e.key === 'F10' && e.ctrlKey && e.shiftKey) {
    hudEl.hidden = !hudEl.hidden
    bridge.setHudVisible(!hudEl.hidden) // main samples process stats only while shown
    e.preventDefault()
    return
  }
  if (e.isComposing || e.keyCode === 229 || producesText(e)) return
  e.preventDefault() // keep Tab, Enter, Alt… from acting on the host page
  lastKeyAt = performance.now()
  forwardedKeys.add(e.code)
  send(keyDownEvents(e))
})
kbd.addEventListener('keyup', (e) => {
  if (!forwardedKeys.delete(e.code)) return
  e.preventDefault()
  send(keyUpEvents(e))
})
kbd.addEventListener('input', (e) => {
  if ((e as InputEvent).isComposing) return
  flushText()
})
kbd.addEventListener('compositionend', flushText)

function flushText(): void {
  const text = kbd.value
  kbd.value = ''
  if (!text) return
  lastKeyAt = performance.now()
  bridge.sendText(text)
  wake()
}

// ---------------------------------------------------------------- mouse
/**
 * Screen point → offscreen-UI point, through the same curvature as the shader.
 * Points on the bezel return null, unless `clamp` (a drag in progress) pins them to the edge.
 */
function mapPoint(e: MouseEvent, clamp = false): { x: number; y: number } | null {
  let [su, sv] = curveUv(e.clientX / canvas.clientWidth, e.clientY / canvas.clientHeight, curvature())
  if (su < 0 || su > 1 || sv < 0 || sv > 1) {
    if (!clamp) return null
    su = Math.min(1, Math.max(0, su))
    sv = Math.min(1, Math.max(0, sv))
  }
  return { x: Math.round(su * canvas.clientWidth), y: Math.round(sv * canvas.clientHeight) }
}
const buttons = ['left', 'middle', 'right'] as const

// Pointer events report detail = 0, so count double/triple clicks ourselves (word/line selection).
let clickCount = 0
let lastDown = { t: 0, x: 0, y: 0, button: -1 }
function countClick(e: PointerEvent): number {
  const near = Math.abs(e.clientX - lastDown.x) < 5 && Math.abs(e.clientY - lastDown.y) < 5
  clickCount = near && e.button === lastDown.button && e.timeStamp - lastDown.t < 500 ? clickCount + 1 : 1
  lastDown = { t: e.timeStamp, x: e.clientX, y: e.clientY, button: e.button }
  return clickCount
}
let dragging = false

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault() // keep focus in the textarea
  kbd.focus({ preventScroll: true })
  const p = mapPoint(e)
  if (!p) return
  dragging = true
  canvas.setPointerCapture(e.pointerId) // drags keep selecting outside the window
  send([{ type: 'mouseDown', ...p, button: buttons[e.button] ?? 'left', clickCount: countClick(e), modifiers: modifiersOf(e) }])
})
canvas.addEventListener('pointerup', (e) => {
  const p = mapPoint(e, dragging)
  dragging = false
  if (p) send([{ type: 'mouseUp', ...p, button: buttons[e.button] ?? 'left', clickCount, modifiers: modifiersOf(e) }])
})
canvas.addEventListener('pointermove', (e) => {
  const p = mapPoint(e, dragging)
  if (p) send([{ type: 'mouseMove', ...p, modifiers: modifiersOf(e) }])
})
// Wheel → scrollback (or the app, when it has mouse mode on: vim, htop, less).
// Chromium's native wheel events use the opposite sign to DOM ones and want pixels plus
// "ticks" (one notch = 100 px on Windows); without ticks, some targets ignore the event.
const WHEEL_PX_PER_LINE = 40
const WHEEL_PX_PER_TICK = 100
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    // Scrolling over the bezel or curved edge still scrolls the screen, pinned to its edge.
    const p = mapPoint(e, true)!
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_PX_PER_LINE : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1
    const dx = -e.deltaX * unit
    const dy = -e.deltaY * unit
    send([
      {
        type: 'mouseWheel',
        ...p,
        deltaX: dx,
        deltaY: dy,
        wheelTicksX: dx / WHEEL_PX_PER_TICK,
        wheelTicksY: dy / WHEEL_PX_PER_TICK,
        // Touchpads send fractional pixel deltas; mouse wheels send whole notches.
        hasPreciseScrollingDeltas: e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && e.deltaY % WHEEL_PX_PER_TICK !== 0,
        canScroll: true,
        modifiers: modifiersOf(e)
      }
    ])
  },
  { passive: false }
)
canvas.addEventListener('contextmenu', (e) => e.preventDefault())

// Cursor shape requested by the UI (text beam over the terminal, pointer over tabs…).
const CSS_CURSORS = new Set([
  'default', 'crosshair', 'pointer', 'text', 'wait', 'help', 'move', 'progress', 'not-allowed', 'grab', 'grabbing',
  'col-resize', 'row-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'copy', 'alias', 'cell', 'none'
])
bridge.onCursor((type) => (canvas.style.cursor = CSS_CURSORS.has(type) ? type : type === 'hand' ? 'pointer' : 'default'))

// ---------------------------------------------------------------- files
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  bridge.sendDrop([...(e.dataTransfer?.files ?? [])])
})

// ---------------------------------------------------------------- window dragging
// The tab bar lives inside the offscreen UI, which can't declare drag regions for this window.
// It reports its empty title-bar areas instead, and we lay native drag regions over where
// they appear on the curved screen.
let dragRects: UiRect[] = []
bridge.onDragRects((rects) => {
  dragRects = rects
  layoutDragRects()
})

function layoutDragRects(): void {
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  if (!W || !H) return
  const amount = curvature()
  const els = dragRects.map((r) => {
    // Map the corners and keep the box inside all of them, so a drag region never covers a tab.
    const [x0, y0] = uncurveUv(r.x / W, r.y / H, amount)
    const [x1, y1] = uncurveUv((r.x + r.width) / W, (r.y + r.height) / H, amount)
    const [x2, y2] = uncurveUv(r.x / W, (r.y + r.height) / H, amount)
    const [x3, y3] = uncurveUv((r.x + r.width) / W, r.y / H, amount)
    const left = Math.max(x0, x2) * W
    const right = Math.min(x1, x3) * W
    const top = Math.max(y0, y3) * H
    const bottom = Math.min(y1, y2) * H
    const el = document.createElement('div')
    el.style.cssText = `left:${left}px;top:${top}px;width:${Math.max(0, right - left)}px;height:${Math.max(0, bottom - top)}px`
    return el
  })
  dragLayer.replaceChildren(...els)
}
