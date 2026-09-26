import { inject, type InjectionKey, type Ref } from 'vue'
import type { DropZone, LayoutNode } from '@shared/layout'
import type { Settings } from '@shared/settings'

/** A panel being dragged by its header, and where it would land. */
export interface MoveDrag {
  srcId: string
  targetId: string | null
  zone: DropZone | null
}

export interface LayoutContext {
  /** The tree on screen. Edits show immediately; `commit` also saves them to settings.json. */
  root: Ref<LayoutNode>
  edit(next: LayoutNode, opts?: { commit?: boolean }): void
  /** Commit the current tree (end of a drag). */
  commit(): void
  move: Ref<MoveDrag | null>
  /** The terminal panel's placeholder element; the real terminals are positioned over it. */
  setTerminalSlot(el: HTMLElement): void
  /** Only clears the slot if `el` is still the current one (a moved panel mounts before the old one unmounts). */
  releaseTerminalSlot(el: HTMLElement): void
  /** Give keyboard focus back to the active shell (after a click inside a plugin). */
  focusTerminal(): void
  settings: Ref<Settings | null>
}

export const LAYOUT_KEY: InjectionKey<LayoutContext> = Symbol('layout')

export function useLayout(): LayoutContext {
  const ctx = inject(LAYOUT_KEY)
  if (!ctx) throw new Error('layout context missing')
  return ctx
}

/** Which drop zone of `rect` the point is in: outer quarter of each side docks, the middle swaps. */
export function zoneAt(rect: DOMRect, x: number, y: number): DropZone {
  const fx = (x - rect.left) / rect.width
  const fy = (y - rect.top) / rect.height
  const edges: Array<[DropZone, number]> = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy]
  ]
  const [zone, dist] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
  return dist < 0.25 ? zone : 'center'
}
