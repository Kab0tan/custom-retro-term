import type { ForwardedInputEvent } from '../shared/input'
import type { Settings } from '../shared/settings'
import type { FrameTransport, UiRect } from '../shared/types'

export interface OsrStatsSnapshot {
  transport: FrameTransport
  paintsPerSec: number
  framesSentPerSec: number
  droppedPerSec: number
  inputToPaintMs: number | null
  frameSize: string
  /** % of one core, per process type. */
  cpu: { ui: number; host: number; gpu: number; main: number }
}

export interface CompositorBridge {
  /** GPU path: called with a VideoFrame the receiver must close. */
  onVideoFrame(cb: (frame: VideoFrame) => void): void
  /** CPU path: raw BGRA pixels. */
  onBitmap(cb: (width: number, height: number, bgra: Uint8Array) => void): void
  onOsrStats(cb: (s: OsrStatsSnapshot) => void): void
  /** Stats are only sampled (and sent) while the HUD is shown. */
  setHudVisible(visible: boolean): void
  /** CSS cursor name requested by the offscreen UI. */
  onCursor(cb: (type: string) => void): void
  /** Empty title-bar areas of the UI, in UI CSS pixels (pre-curvature). */
  onDragRects(cb: (rects: UiRect[]) => void): void
  getSettings(): Promise<Settings>
  onSettings(cb: (s: Settings) => void): void
  sendInput(events: ForwardedInputEvent[]): void
  sendText(text: string): void
  sendDrop(files: File[]): void
}
