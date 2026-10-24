import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  sharedTexture,
  type NativeImage,
  type OffscreenSharedTexture,
  type Rectangle,
  type WebContents
} from 'electron'
import { UNFOCUSED_FPS, type Settings } from '@shared/settings'
import type { FrameTransport, UiRect } from '@shared/types'
import type { ForwardedInputEvent } from '@shared/input'
import type { OsrStatsSnapshot } from '../../preload/compositor-bridge'
import { getSettings, settingsEvents } from '../settings'

/**
 * webgl renderer: the real UI renders in a hidden offscreen (OSR) window; every frame it
 * paints is handed to a visible "host" window that draws it through the CRT shaders.
 * Input goes the other way: the host captures DOM events and main replays them into the OSR.
 * CRT_TRANSPORT=bitmap forces the CPU copy path instead of GPU shared textures.
 */

export interface CompositedOptions {
  bounds: Rectangle
  maximized: boolean
  preloadPath: (name: 'index' | 'compositor') => string
  loadPage: (wc: WebContents, page: 'index' | 'compositor', query: Record<string, string>) => Promise<void>
}

export interface CompositedWindow {
  /** The visible host window. */
  win: BrowserWindow
  /** The offscreen WebContents running the real UI. */
  ui: WebContents
}

function cpuByProcess(host: WebContents, ui: WebContents): OsrStatsSnapshot['cpu'] {
  const metrics = app.getAppMetrics()
  const of = (pid: number): number => +(metrics.find((m) => m.pid === pid)?.cpu.percentCPUUsage ?? 0).toFixed(1)
  const gpu = metrics.find((m) => m.type === 'GPU')
  return {
    ui: ui.isDestroyed() ? 0 : of(ui.getOSProcessId()),
    host: host.isDestroyed() ? 0 : of(host.getOSProcessId()),
    gpu: +(gpu?.cpu.percentCPUUsage ?? 0).toFixed(1),
    main: of(process.pid)
  }
}

export async function openComposited(opts: CompositedOptions): Promise<CompositedWindow> {
  // GPU shared textures are proven on Windows (D3D) and macOS (IOSurface); Linux uses the CPU copy.
  const envT = process.env.CRT_TRANSPORT
  const t: FrameTransport = envT === 'bitmap' || envT === 'shared' ? envT : process.platform === 'linux' ? 'bitmap' : 'shared'
  const scale = screen.getDisplayMatching(opts.bounds).scaleFactor
  const host = new BrowserWindow({
    ...opts.bounds,
    minWidth: 420,
    minHeight: 240,
    title: 'CRT Terminal',
    backgroundColor: '#000000',
    show: false,
    // Native frame (resize edges, snapping) without a title bar. macOS keeps its traffic lights
    // (drawn natively over the CRT); elsewhere the UI draws caption buttons inside the CRT.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      preload: opts.preloadPath('compositor'),
      // Needed so the preload can hand VideoFrames straight to the page. Safe here:
      // the host only ever loads our own compositor page, never remote content.
      contextIsolation: false,
      sandbox: false,
      // The host's only job is presenting frames; never let Chromium throttle its rAF.
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  const [cw, ch] = host.getContentSize()
  const osr = new BrowserWindow({
    width: cw,
    height: ch,
    show: false,
    frame: false,
    webPreferences: {
      preload: opts.preloadPath('index'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false,
      offscreen: t === 'shared' ? { useSharedTexture: true, deviceScaleFactor: scale } : { deviceScaleFactor: scale }
    }
  })
  const hostWc = host.webContents
  const uiWc = osr.webContents
  const alive = (): boolean => !host.isDestroyed() && !osr.isDestroyed()

  // --- frame rate: cap, and slow down when nobody is looking --------------------
  const applyFrameRate = (s: Settings = getSettings()): void => {
    if (!alive()) return
    const focused = host.isFocused()
    uiWc.setFrameRate(focused || !s.crt.pauseWhenUnfocused ? s.crt.fpsCap : Math.min(UNFOCUSED_FPS, s.crt.fpsCap))
  }
  applyFrameRate()
  settingsEvents.on('changed', applyFrameRate)
  host.on('minimize', () => alive() && uiWc.stopPainting())
  host.on('restore', () => {
    if (!alive()) return
    uiWc.startPainting()
    uiWc.invalidate()
  })

  // --- stats (sampled only while the host's HUD is shown) -----------------------------
  let paints = 0
  let sent = 0
  let dropped = 0
  let lastInputAt = 0
  let inputToPaint: number | null = null
  let frameSize = '-'
  let statsTimer: NodeJS.Timeout | null = null
  const setStats = (on: boolean): void => {
    if (statsTimer) clearInterval(statsTimer)
    statsTimer = null
    if (!on) return
    paints = sent = dropped = 0
    statsTimer = setInterval(() => {
      if (!alive()) return
      const snapshot: OsrStatsSnapshot = {
        transport: t,
        paintsPerSec: paints,
        framesSentPerSec: sent,
        droppedPerSec: dropped,
        inputToPaintMs: inputToPaint,
        frameSize,
        cpu: cpuByProcess(hostWc, uiWc)
      }
      paints = sent = dropped = 0
      hostWc.send('osr:stats', snapshot)
    }, 1000)
  }

  // --- frames: GPU shared texture ---------------------------------------------------
  // Keep one frame in flight and only the newest pending one; older ones are dropped.
  let inflight = false
  let pendingTex: OffscreenSharedTexture | null = null
  const sendTexture = async (tex: OffscreenSharedTexture): Promise<void> => {
    inflight = true
    let imported: ReturnType<typeof sharedTexture.importSharedTexture> | null = null
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: tex.textureInfo,
        allReferencesReleased: () => tex.release()
      })
      await sharedTexture.sendSharedTexture({ frame: hostWc.mainFrame, importedSharedTexture: imported })
      sent++
    } catch (err) {
      if (!host.isDestroyed()) console.warn('[osr] shared texture send failed:', (err as Error).message)
    } finally {
      if (imported) imported.release()
      else tex.release()
      inflight = false
    }
    if (pendingTex && !host.isDestroyed()) {
      const next = pendingTex
      pendingTex = null
      void sendTexture(next)
    }
  }

  // --- frames: CPU bitmap (fallback) ------------------------------------------------
  let bitmapInflight = false
  let pendingImage: NativeImage | null = null
  const sendBitmap = (image: NativeImage): void => {
    const { width, height } = image.getSize()
    bitmapInflight = true
    hostWc.send('osr:bitmap', width, height, image.toBitmap())
    sent++
  }

  uiWc.on('paint', (e, _dirty, image) => {
    paints++
    if (lastInputAt) {
      inputToPaint = performance.now() - lastInputAt
      lastInputAt = 0
    }
    const tex = e.texture
    if (host.isDestroyed()) {
      tex?.release()
      return
    }
    if (tex) {
      const s = tex.textureInfo.codedSize
      frameSize = `${s.width}x${s.height} ${tex.textureInfo.pixelFormat}`
      if (inflight) {
        if (pendingTex) {
          pendingTex.release()
          dropped++
        }
        pendingTex = tex
      } else void sendTexture(tex)
      return
    }
    const s = image.getSize()
    frameSize = `${s.width}x${s.height} bgra`
    if (bitmapInflight) {
      if (pendingImage) dropped++
      pendingImage = image
    } else sendBitmap(image)
  })

  uiWc.on('cursor-changed', (_e, type) => !host.isDestroyed() && hostWc.send('osr:cursor', type))

  // --- messages between the two windows ------------------------------------------------
  // Registered per window pair and filtered by sender, so several windows can coexist.
  // IPC arguments are untyped at runtime; each handler states what it expects.
  type Handler = (...args: any[]) => void
  const fromHost: Record<string, Handler> = {
    'osr:ack': () => {
      bitmapInflight = false
      if (pendingImage) {
        const next = pendingImage
        pendingImage = null
        sendBitmap(next)
      }
    },
    'osr:input': (events: ForwardedInputEvent[]) => {
      forwardInput(uiWc, events)
      lastInputAt = performance.now()
    },
    /** Committed text (typing, dead keys, IME, emoji picker): inserted directly, not as key events. */
    'osr:text': (text: string) => {
      uiWc.send('ui:text', text)
      lastInputAt = performance.now()
    },
    'osr:drop': (paths: string[]) => uiWc.send('ui:drop', paths),
    'osr:hud': (visible: boolean) => setStats(visible === true)
  }
  const fromUi: Record<string, Handler> = {
    /** Empty title-bar areas: the host overlays native drag regions there. */
    'ui:dragRects': (rects: UiRect[]) => hostWc.send('host:dragRects', rects)
  }
  const handlers: Array<[string, (e: Electron.IpcMainEvent, ...args: unknown[]) => void]> = []
  for (const [channel, fn] of Object.entries(fromHost)) {
    handlers.push([channel, (e, ...args) => e.sender === hostWc && alive() && fn(...args)])
  }
  for (const [channel, fn] of Object.entries(fromUi)) {
    handlers.push([channel, (e, ...args) => e.sender === uiWc && alive() && fn(...args)])
  }
  for (const [channel, h] of handlers) ipcMain.on(channel, h)

  // --- size and focus ------------------------------------------------------------------
  const syncSize = (): void => {
    if (!alive()) return
    const [w, h] = host.getContentSize()
    osr.setSize(w, h)
  }
  host.on('resize', syncSize)
  // The OSR window never gets OS focus on its own; mirror the host's so the UI
  // sees focus/blur (xterm's cursor, :focus styles, key handling).
  // Linux: activating/deactivating the never-shown OSR window maps and unmaps it on X11, which
  // hides the page and blanks xterm's WebGL canvas (the terminal text vanished whenever focus moved
  // to another monitor). There, only the WebContents is focused and the native window is left alone.
  const nativeOsrFocus = process.platform !== 'linux'
  const focusOsr = (): void => {
    if (!alive()) return
    if (nativeOsrFocus) osr.focus()
    uiWc.focus()
  }
  host.on('focus', () => {
    focusOsr()
    applyFrameRate()
  })
  host.on('blur', () => {
    if (!alive()) return
    if (nativeOsrFocus) osr.blur()
    applyFrameRate()
    uiWc.invalidate() // repaint the full frame at the new rate
  })
  host.once('ready-to-show', () => {
    if (opts.maximized) host.maximize()
    host.show()
  })

  const dispose = (): void => {
    setStats(false)
    settingsEvents.off('changed', applyFrameRate)
    for (const [channel, h] of handlers) ipcMain.off(channel, h)
    pendingTex?.release()
    pendingTex = null
    if (!osr.isDestroyed()) osr.destroy()
    if (!host.isDestroyed()) host.destroy()
  }
  host.on('closed', dispose)

  await opts.loadPage(hostWc, 'compositor', { transport: t })
  await opts.loadPage(uiWc, 'index', {})
  syncSize()
  focusOsr()

  return { win: host, ui: uiWc }
}

export function forwardInput(wc: WebContents, events: ForwardedInputEvent[]): void {
  for (const ev of events) {
    try {
      wc.sendInputEvent(ev as Electron.KeyboardInputEvent | Electron.MouseInputEvent | Electron.MouseWheelInputEvent)
    } catch (err) {
      // An unmappable key code must not take down input handling.
      console.warn('[osr] dropped input event', ev, (err as Error).message)
    }
  }
}
