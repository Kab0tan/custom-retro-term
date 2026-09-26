// Preload for the webgl host window. Runs without context isolation so VideoFrames
// from `sharedTexture` can be handed to the page directly (they can't cross contextBridge).
import { ipcRenderer, sharedTexture, webUtils } from 'electron'
import type { ForwardedInputEvent } from '@shared/input'
import type { CompositorBridge } from './compositor-bridge'

let onVideoFrame: ((frame: VideoFrame) => void) | null = null

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  try {
    const frame = importedSharedTexture.getVideoFrame()
    if (onVideoFrame) onVideoFrame(frame)
    else frame.close()
  } finally {
    importedSharedTexture.release()
  }
})

const on = <T extends unknown[]>(channel: string, cb: (...args: T) => void): void => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...(args as T)))
}

const bridge: CompositorBridge = {
  onVideoFrame: (cb) => {
    onVideoFrame = cb
  },
  onBitmap: (cb) => {
    ipcRenderer.on('osr:bitmap', (_e, w: number, h: number, data: Uint8Array) => {
      cb(w, h, data)
      ipcRenderer.send('osr:ack')
    })
  },
  onOsrStats: (cb) => on('osr:stats', cb),
  setHudVisible: (visible: boolean) => ipcRenderer.send('osr:hud', visible),
  onCursor: (cb) => on('osr:cursor', cb),
  onDragRects: (cb) => on('host:dragRects', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  onSettings: (cb) => on('settings:changed', cb),
  sendInput: (events: ForwardedInputEvent[]) => ipcRenderer.send('osr:input', events),
  sendText: (text: string) => ipcRenderer.send('osr:text', text),
  sendDrop: (files: File[]) => {
    const paths = files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)
    if (paths.length) ipcRenderer.send('osr:drop', paths)
  }
}

;(window as unknown as { compositor: CompositorBridge }).compositor = bridge
