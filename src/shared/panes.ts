/**
 * Panes inside a tab: a split tree whose leaves are shells (tmux / Windows Terminal style).
 * Runtime state of one window only: never saved to settings.json, unlike the panel layout.
 * Pure functions, like layout.ts; every operation returns a new tree.
 */
import { insertBeside, isSplit, leaves, mapTree, newId, normalize, prune, resizeSplit, type Split, type Tree } from './tree'

export interface PaneLeaf {
  type: 'pane'
  id: string
}

export type PaneSplit = Split<PaneLeaf>
export type PaneNode = Tree<PaneLeaf>

export type PaneDirection = 'left' | 'right' | 'up' | 'down'

/** A rectangle as fractions of the stage (0..1, top-left origin). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Smallest pane allowed, as fractions of the stage (the UI derives it from the cell size). */
export interface MinSize {
  w: number
  h: number
}

/** Panes per tab. Also keeps every visible pane within the WebGL context budget. */
export const MAX_PANES = 8

const EPS = 1e-6

export const pane = (id = newId('pane')): PaneLeaf => ({ type: 'pane', id })

export const paneIds = (root: PaneNode): string[] => leaves(root).map((l) => l.id)

// ------------------------------------------------------------------ geometry
/** Rectangle of every node, splits included. */
function nodeRects(root: PaneNode): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const walk = (n: PaneNode, r: Rect): void => {
    out.set(n.id, r)
    if (!isSplit(n)) return
    let at = 0
    n.children.forEach((c, i) => {
      const s = n.sizes[i]
      walk(c, n.dir === 'row' ? { x: r.x + r.w * at, y: r.y, w: r.w * s, h: r.h } : { x: r.x, y: r.y + r.h * at, w: r.w, h: r.h * s })
      at += s
    })
  }
  walk(root, { x: 0, y: 0, w: 1, h: 1 })
  return out
}

/**
 * Each pane's rectangle as fractions of the stage. The rectangles tile the stage exactly: each one
 * includes its half of the gutters around it, which the UI takes back as a fixed inset in pixels.
 */
export function paneRects(root: PaneNode): Array<Rect & { id: string }> {
  const rects = nodeRects(root)
  return leaves(root).map((l) => ({ id: l.id, ...rects.get(l.id)! }))
}

/** The boundary between children `index` and `index + 1` of a split, as a line on the stage. */
export interface Gutter {
  splitId: string
  index: number
  /** row: a vertical line at x (w = 0); column: a horizontal line at y (h = 0). */
  dir: PaneSplit['dir']
  x: number
  y: number
  w: number
  h: number
  /** The split's width (row) or height (column) as a fraction of the stage, to turn drags into sizes. */
  span: number
}

export function gutters(root: PaneNode): Gutter[] {
  const rects = nodeRects(root)
  const out: Gutter[] = []
  const walk = (n: PaneNode): void => {
    if (!isSplit(n)) return
    const r = rects.get(n.id)!
    let at = 0
    n.sizes.slice(0, -1).forEach((s, index) => {
      at += s
      out.push(
        n.dir === 'row'
          ? { splitId: n.id, index, dir: n.dir, x: r.x + r.w * at, y: r.y, w: 0, h: r.h, span: r.w }
          : { splitId: n.id, index, dir: n.dir, x: r.x, y: r.y + r.h * at, w: r.w, h: 0, span: r.h }
      )
    })
    n.children.forEach(walk)
  }
  walk(root)
  return out
}

/**
 * The pane next to `id` on that side: of the panes touching that edge, the one that overlaps it
 * most (ties: the top/left-most). Works from geometry, so uneven nested splits behave as they look.
 */
export function neighbor(root: PaneNode, id: string, dir: PaneDirection): string | null {
  const rects = paneRects(root)
  const cur = rects.find((r) => r.id === id)
  if (!cur) return null
  const horizontal = dir === 'left' || dir === 'right'
  let best: { id: string; overlap: number; start: number } | null = null
  for (const r of rects) {
    if (r.id === id) continue
    const touches =
      dir === 'right' ? Math.abs(r.x - (cur.x + cur.w)) < EPS
      : dir === 'left' ? Math.abs(r.x + r.w - cur.x) < EPS
      : dir === 'down' ? Math.abs(r.y - (cur.y + cur.h)) < EPS
      : Math.abs(r.y + r.h - cur.y) < EPS
    if (!touches) continue
    const start = horizontal ? Math.max(r.y, cur.y) : Math.max(r.x, cur.x)
    const end = horizontal ? Math.min(r.y + r.h, cur.y + cur.h) : Math.min(r.x + r.w, cur.x + cur.w)
    const overlap = end - start
    if (overlap <= EPS) continue
    const pos = horizontal ? r.y : r.x
    if (!best || overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && pos < best.start)) {
      best = { id: r.id, overlap, start: pos }
    }
  }
  return best?.id ?? null
}

// ------------------------------------------------------------------ edits
/** Whether `next` is acceptable: no pane below `min`, unless it was already that small and didn't shrink. */
function respectsMin(prev: PaneNode, next: PaneNode, min: MinSize): boolean {
  const before = new Map(paneRects(prev).map((r) => [r.id, r]))
  return paneRects(next).every((r) => {
    const b = before.get(r.id)
    const okW = r.w >= min.w - EPS || (!!b && r.w >= b.w - EPS)
    const okH = r.h >= min.h - EPS || (!!b && r.h >= b.h - EPS)
    return okW && okH
  })
}

/**
 * Split pane `id`, putting a new pane (`newPaneId`) to its right or below it. Returns `root`
 * unchanged at MAX_PANES, or if either half would end up smaller than `min`.
 */
export function splitPane(root: PaneNode, id: string, side: 'right' | 'bottom', newPaneId = newId('pane'), min?: MinSize): PaneNode {
  const ids = paneIds(root)
  if (ids.length >= MAX_PANES || !ids.includes(id) || ids.includes(newPaneId)) return root
  const next = insertBeside(root, id, pane(newPaneId), side)
  if (!min) return next
  const halves = paneRects(next).filter((r) => r.id === id || r.id === newPaneId)
  return halves.every((r) => r.w >= min.w - EPS && r.h >= min.h - EPS) ? next : root
}

/**
 * Close a pane; its space goes back to the sibling before it (the pane it was split from), so a
 * split followed by a close gives back the original tree. Null when it was the last pane.
 */
export function closePane(root: PaneNode, id: string): PaneNode | null {
  const p = prune(root, id, true)
  return p ? normalize(p) : null
}

/**
 * Move the boundary between children `index` and `index + 1` of a split by `delta` (a fraction of the
 * split). With `min`, the move is cut short where a pane would get smaller than that.
 */
export function resizeBoundary(root: PaneNode, splitId: string, index: number, delta: number, min?: MinSize): PaneNode {
  const at = (d: number): PaneNode => resizeSplit(root, splitId, index, d)
  const full = at(delta)
  if (!min || respectsMin(root, full, min)) return full
  // Largest part of the move that still fits.
  let lo = 0
  let hi = delta
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    if (respectsMin(root, at(mid), min)) lo = mid
    else hi = mid
  }
  return lo === 0 ? root : at(lo)
}

/**
 * Move one of the pane's borders by `delta` (a fraction of the stage) in direction `dir`: the border
 * on that side if the pane has one (it grows), else the opposite one (it shrinks). The border belongs
 * to the nearest ancestor split of that orientation that has one.
 */
export function resizePane(root: PaneNode, id: string, dir: PaneDirection, delta: number, min?: MinSize): PaneNode {
  const axis: PaneSplit['dir'] = dir === 'left' || dir === 'right' ? 'row' : 'column'
  const forward = dir === 'right' || dir === 'down'
  // Ancestor splits of that orientation, nearest first, with the index of the child holding the pane.
  const path: Array<{ split: PaneSplit; index: number }> = []
  const find = (n: PaneNode): boolean => {
    if (!isSplit(n)) return n.id === id
    const i = n.children.findIndex(find)
    if (i < 0) return false
    if (n.dir === axis) path.push({ split: n, index: i })
    return true
  }
  if (!find(root) || !path.length) return root
  const last = (p: { split: PaneSplit; index: number }): boolean => p.index === p.split.children.length - 1
  const near = path.find((p) => (forward ? !last(p) : p.index > 0))
  const pick = near ?? path[0]
  const boundary = near ? (forward ? pick.index : pick.index - 1) : forward ? pick.index - 1 : pick.index
  const span = nodeRects(root).get(pick.split.id)!
  const size = axis === 'row' ? span.w : span.h
  return resizeBoundary(root, pick.split.id, boundary, ((forward ? 1 : -1) * delta) / size, min)
}

/** Even out sizes so that panes side by side share the space equally (tmux "spread evenly"). */
export function equalize(root: PaneNode): PaneNode {
  // How many panes a node lines up along `dir`.
  const across = (n: PaneNode, dir: PaneSplit['dir']): number => {
    if (!isSplit(n)) return 1
    const counts = n.children.map((c) => across(c, dir))
    return n.dir === dir ? counts.reduce((a, b) => a + b, 0) : Math.max(...counts)
  }
  return mapTree(root, (n) => {
    if (!isSplit(n)) return n
    const weights = n.children.map((c) => across(c, n.dir))
    const total = weights.reduce((a, b) => a + b, 0)
    return { ...n, sizes: weights.map((w) => w / total) }
  })
}

/** Exchange the places of two panes. */
export function swapPanes(root: PaneNode, a: string, b: string): PaneNode {
  if (a === b) return root
  return mapTree(root, (n) => (isSplit(n) ? n : n.id === a ? pane(b) : n.id === b ? pane(a) : n))
}
