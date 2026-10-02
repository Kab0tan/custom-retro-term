import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { DataTopic } from '@shared/data'
import type { CatalogEntry, InstallResult, InstallSource, PluginList } from '@shared/plugins'
import type { Settings } from '@shared/settings'
import type { PlatformInfo, ProfileList, PtySpawnRequest, PtySpawnResult, UiRect } from '@shared/types'

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  platform: (): Promise<PlatformInfo> => ipcRenderer.invoke('app:platform'),
  pty: {
    spawn: (req: PtySpawnRequest): Promise<PtySpawnResult> => ipcRenderer.invoke('pty:spawn', req),
    write: (id: number, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: number, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
    /** Tell main how many characters xterm has finished parsing (flow control). */
    ack: (id: number, chars: number): void => ipcRenderer.send('pty:ack', id, chars),
    kill: (id: number): void => ipcRenderer.send('pty:kill', id),
    /** The shell's working directory as the OS sees it (Linux only; null elsewhere). */
    cwd: (id: number): Promise<string | null> => ipcRenderer.invoke('pty:cwd', id),
    onData: (cb: (id: number, data: string) => void) => listen<[number, string]>('pty:data', cb),
    onExit: (cb: (id: number, code: number) => void) => listen<[number, number]>('pty:exit', cb)
  },
  profiles: {
    list: (): Promise<ProfileList> => ipcRenderer.invoke('profiles:list'),
    /** Fired when late-detected shells (WSL distros) show up. */
    onChanged: (cb: () => void) => listen<[]>('profiles:changed', cb)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
    openFile: (): Promise<string> => ipcRenderer.invoke('settings:openFile'),
    onChanged: (cb: (s: Settings) => void) => listen<[Settings]>('settings:changed', cb)
  },
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text: string): void => ipcRenderer.send('clipboard:writeText', text)
  },
  confirmPaste: (lines: number, preview: string): Promise<{ ok: boolean; dontAskAgain: boolean }> =>
    ipcRenderer.invoke('dialog:confirmPaste', lines, preview),
  openExternal: (url: string): void => ipcRenderer.send('shell:openExternal', url),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  window: {
    newWindow: (): void => ipcRenderer.send('window:new'),
    close: (): void => ipcRenderer.send('window:close'),
    /** Shells open in the window (panes across all tabs), for the close confirmation. */
    setShellCount: (n: number): void => ipcRenderer.send('window:shellCount', n),
    toggleFullscreen: (): void => ipcRenderer.send('window:toggleFullscreen'),
    toggleDevTools: (): void => ipcRenderer.send('window:toggleDevTools'),
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    onMaximized: (cb: (maximized: boolean) => void) => listen<[boolean]>('window:maximized', cb),
    /** webgl renderer: empty title-bar areas, so the host window can make them draggable. */
    reportDragRects: (rects: UiRect[]): void => ipcRenderer.send('ui:dragRects', rects)
  },
  /** webgl renderer: text typed in the host window (already composed: dead keys, IME…). */
  onText: (cb: (text: string) => void) => listen<[string]>('ui:text', cb),
  /** webgl renderer: files dropped on the host window. */
  onDrop: (cb: (paths: string[]) => void) => listen<[string[]]>('ui:drop', cb),
  relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  updates: {
    status: (): Promise<{ version: string; status: string; enabled: boolean }> => ipcRenderer.invoke('app:updateStatus'),
    check: (): Promise<{ version: string; status: string; enabled: boolean }> => ipcRenderer.invoke('app:checkUpdates')
  },
  plugins: {
    list: (): Promise<PluginList> => ipcRenderer.invoke('plugins:list'),
    rescan: (): Promise<PluginList> => ipcRenderer.invoke('plugins:rescan'),
    onChanged: (cb: () => void) => listen<[]>('plugins:changed', cb),
    /** Native consent prompt for system audio analysis. */
    confirmAudio: (pluginName: string): Promise<boolean> => ipcRenderer.invoke('dialog:confirmAudio', pluginName),
    /** Screen source id for loopback audio capture (null unless the user allowed audio). */
    audioSource: (): Promise<{ id: string | null; supported: boolean }> => ipcRenderer.invoke('audio:screenSource'),
    openFolder: (id?: string): Promise<string> => ipcRenderer.invoke('plugins:openFolder', id),
    pickSource: (kind: 'folder' | 'zip'): Promise<string | null> => ipcRenderer.invoke('plugins:pickSource', kind),
    install: (source: InstallSource): Promise<InstallResult> => ipcRenderer.invoke('plugins:install', source),
    uninstall: (id: string): Promise<InstallResult> => ipcRenderer.invoke('plugins:uninstall', id),
    create: (id: string, name: string): Promise<InstallResult> => ipcRenderer.invoke('plugins:create', id, name),
    catalog: (): Promise<{ entries: CatalogEntry[]; error?: string }> => ipcRenderer.invoke('plugins:catalog'),
    /** ctx.fetch for a plugin: main checks the URL against that plugin's permissions.network. */
    fetch: (pluginId: string, url: string, init: Record<string, unknown>): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('plugins:fetch', pluginId, url, init)
  },
  /** Data hub (src/main/data/hub.ts). Use src/renderer/src/data/bus.ts rather than this directly. */
  data: {
    subscribe: (topic: DataTopic): void => ipcRenderer.send('data:subscribe', topic),
    unsubscribe: (topic: DataTopic): void => ipcRenderer.send('data:unsubscribe', topic),
    onUpdate: (cb: (topic: DataTopic, payload: unknown) => void) => listen<[DataTopic, unknown]>('data:update', cb)
  }
}

export type CrtApi = typeof api

contextBridge.exposeInMainWorld('crt', api)
