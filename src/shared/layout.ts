/**
 * Tiling layout: a tree of splits whose leaves are panels.
 * Pure functions only (no DOM), shared by the UI (editing) and main (validating settings.json).
 * Every operation returns a new tree; inputs are never mutated.
 */
import { PLUGIN_ID } from './plugins'

/**
 * terminal: the shell pane (hosts the tabs). Exactly one per layout.
 * empty:    a slot; runs the plugin named by `plugin`, else shows a "no signal" picker.
 */
export type PanelKind = 'terminal' | 'empty'

export interface PanelNode {
  type: 'panel'
  id: string
  kind: PanelKind
  title: string
  /** Plugin id shown in an empty slot (see src/shared/plugins.ts). */
  plugin?: string
}

export interface SplitNode {
  type: 'split'
  id: string
  /** row = children side by side, column = stacked. */
  dir: 'row' | 'column'
  children: LayoutNode[]
  /** Fractions of the split's size, one per child, summing to 1. */
  sizes: number[]
}

export type LayoutNode = PanelNode | SplitNode

export interface SavedLayout {
  id: string
  name: string
  root: LayoutNode
}

/** Where a dragged panel lands relative to the target: an edge docks beside it, center swaps. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** No pane may shrink below this fraction of its split. */
export const MIN_FRACTION = 0.08

let counter = 0
export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`

export const panel = (kind: PanelKind, title: string, id = newId('p'), plugin?: string): PanelNode =>
  plugin ? { type: 'panel', id, kind, title, plugin } : { type: 'panel', id, kind, title }

const split = (dir: SplitNode['dir'], children: LayoutNode[], sizes?: number[], id = newId('s')): SplitNode => ({
  type: 'split',
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length)
})

// ------------------------------------------------------------------ built-in layouts
/**
 * HELIOS-7: the full console. Shell with the spectrum under it; on the right the
 * system stats and the device map over the kernel log. The default layout.
 */
export const HELIOS7_LAYOUT: SavedLayout = {
  id: 'helios-7',
  name: 'HELIOS-7',
  root: split(
    'row',
    [
      split(
        'column',
        [
          panel('terminal', 'SHELL', 'h7-shell'),
          panel('empty', 'SPECTRUM', 'h7-spectrum', 'spectrum')
        ],
        [0.68, 0.32],
        'h7-main'
      ),
      split(
        'column',
        [
          split('row', [panel('empty', 'SYSTEM', 'h7-system', 'system'), panel('empty', 'DEVICE MAP', 'h7-devices', 'devices')], [0.55, 0.45], 'h7-top'),
          panel('empty', 'KERNEL LOG', 'h7-log', 'kernel-log')
        ],
        [0.5, 0.5],
        'h7-side'
      )
    ],
    [0.6, 0.4],
    'h7-root'
  )
}

export const TERMINAL_ONLY_LAYOUT: SavedLayout = {
  id: 'terminal-only',
  name: 'Terminal only',
  root: panel('terminal', 'SHELL', 'solo-shell')
}

export const BUILTIN_LAYOUTS: SavedLayout[] = [HELIOS7_LAYOUT, TERMINAL_ONLY_LAYOUT]

// ------------------------------------------------------------------ queries
export function panels(root: LayoutNode): PanelNode[] {
  return root.type === 'panel' ? [root] : root.children.flatMap(panels)
}

function findPanel(root: LayoutNode, id: string): PanelNode | undefined {
  return panels(root).find((p) => p.id === id)
}

/** Same shape, sizes and titles (ids ignored), e.g. to tell whether a layout was modified. */
export function sameLayout(a: LayoutNode, b: LayoutNode): boolean {
  const shape = (n: LayoutNode): unknown =>
    n.type === 'panel'
      ? [n.kind, n.title, n.plugin ?? null]
      : [n.dir, n.sizes.map((s) => Math.round(s * 1000)), n.children.map(shape)]
  return JSON.stringify(shape(a)) === JSON.stringify(shape(b))
}

// ------------------------------------------------------------------ cleanup
/** Collapse single-child splits, merge same-direction nesting, renormalise sizes. */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.type === 'panel') return node
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const n = normalize(c)
    const size = node.sizes[i] ?? 1 / node.children.length
    if (n.type === 'split' && n.dir === node.dir) {
      n.children.forEach((gc, j) => {
        children.push(gc)
        sizes.push(size * n.sizes[j])
      })
    } else {
      children.push(n)
      sizes.push(size)
    }
  })
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0) || 1
  return { ...node, children, sizes: sizes.map((s) => s / total) }
}

// ------------------------------------------------------------------ edits
function mapNode(node: LayoutNode, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  const mapped = fn(node)
  if (mapped.type === 'panel') return mapped
  return { ...mapped, children: mapped.children.map((c) => mapNode(c, fn)) }
}

/**
 * Replace one panel. Unlike mapNode this doesn't descend into the replacement: the new split
 * contains the old panel, and walking into it would replace it again, forever.
 */
function replacePanel(node: LayoutNode, id: string, fn: (p: PanelNode) => LayoutNode): LayoutNode {
  if (node.type === 'panel') return node.id === id ? fn(node) : node
  return { ...node, children: node.children.map((c) => replacePanel(c, id, fn)) }
}

/** Put `insert` beside the panel `targetId`, on the given side. */
function insertBeside(root: LayoutNode, targetId: string, insert: PanelNode, zone: Exclude<DropZone, 'center'>): LayoutNode {
  const dir: SplitNode['dir'] = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const before = zone === 'left' || zone === 'top'
  return normalize(replacePanel(root, targetId, (n) => split(dir, before ? [insert, n] : [n, insert])))
}

/** Split a panel, adding a new empty slot beside it. */
export function splitPanel(root: LayoutNode, targetId: string, zone: Exclude<DropZone, 'center'>, title = 'EMPTY'): LayoutNode {
  return insertBeside(root, targetId, panel('empty', title), zone)
}

/** Add an empty slot next to the largest panel, splitting along its long side. */
export function addPanel(root: LayoutNode, title = 'EMPTY'): LayoutNode {
  // Area of each panel as a fraction of the screen, and whether it's wider than tall (screen ~16:10).
  let best: { id: string; area: number; wide: boolean } | null = null
  const walk = (n: LayoutNode, w: number, h: number): void => {
    if (n.type === 'panel') {
      if (!best || w * h > best.area) best = { id: n.id, area: w * h, wide: w * 1.6 >= h }
      return
    }
    n.children.forEach((c, i) => walk(c, n.dir === 'row' ? w * n.sizes[i] : w, n.dir === 'column' ? h * n.sizes[i] : h))
  }
  walk(root, 1, 1)
  const target = best as { id: string; wide: boolean } | null
  return target ? splitPanel(root, target.id, target.wide ? 'right' : 'bottom', title) : root
}

/** Remove a panel. The terminal panel can't be removed. */
export function removePanel(root: LayoutNode, id: string): LayoutNode {
  if (findPanel(root, id)?.kind === 'terminal') return root
  const prune = (n: LayoutNode): LayoutNode | null => {
    if (n.type === 'panel') return n.id === id ? null : n
    const kept: Array<{ node: LayoutNode; size: number }> = []
    n.children.forEach((c, i) => {
      const p = prune(c)
      if (p) kept.push({ node: p, size: n.sizes[i] })
    })
    if (!kept.length) return null
    return { ...n, children: kept.map((k) => k.node), sizes: kept.map((k) => k.size) }
  }
  return normalize(prune(root) ?? root)
}

export function renamePanel(root: LayoutNode, id: string, title: string): LayoutNode {
  const t = title.trim().slice(0, 32)
  if (!t) return root
  return mapNode(root, (n) => (n.type === 'panel' && n.id === id ? { ...n, title: t } : n))
}

/** Put a plugin in a slot (or clear it). `title` replaces the old title if that was a default. */
export function setPanelPlugin(root: LayoutNode, id: string, plugin: string | null, title: string | null, defaultTitles: string[]): LayoutNode {
  const defaults = new Set(['EMPTY', ...defaultTitles.map((t) => t.toUpperCase())])
  return mapNode(root, (n) => {
    if (n.type !== 'panel' || n.id !== id || n.kind !== 'empty') return n
    const nextTitle = defaults.has(n.title.toUpperCase()) ? (title ?? 'EMPTY').toUpperCase().slice(0, 32) : n.title
    const { plugin: _old, ...rest } = n
    return plugin ? { ...rest, title: nextTitle, plugin } : { ...rest, title: nextTitle }
  })
}

/** Move a panel next to (or, with 'center', swap it with) another panel. */
export function movePanel(root: LayoutNode, srcId: string, targetId: string, zone: DropZone): LayoutNode {
  if (srcId === targetId) return root
  const src = findPanel(root, srcId)
  const dst = findPanel(root, targetId)
  if (!src || !dst) return root
  if (zone === 'center') {
    return mapNode(root, (n) => (n.type !== 'panel' ? n : n.id === srcId ? dst : n.id === targetId ? src : n))
  }
  // Detach the source (even the terminal: it's re-inserted right away), then dock it.
  const prune = (n: LayoutNode): LayoutNode | null => {
    if (n.type === 'panel') return n.id === srcId ? null : n
    const kept = n.children.map((c, i) => ({ node: prune(c), size: n.sizes[i] })).filter((k) => k.node)
    return kept.length ? { ...n, children: kept.map((k) => k.node!), sizes: kept.map((k) => k.size) } : null
  }
  const without = prune(root)
  return without ? insertBeside(normalize(without), targetId, src, zone) : root
}

/**
 * Resize the boundary between children `index` and `index + 1` of a split.
 * `delta` is a fraction of the split's size; both neighbours keep at least MIN_FRACTION.
 */
export function resizeSplit(root: LayoutNode, splitId: string, index: number, delta: number): LayoutNode {
  return mapNode(root, (n) => {
    if (n.type !== 'split' || n.id !== splitId || index < 0 || index >= n.children.length - 1) return n
    const sizes = [...n.sizes]
    const pair = sizes[index] + sizes[index + 1]
    const a = Math.min(pair - MIN_FRACTION, Math.max(MIN_FRACTION, sizes[index] + delta))
    sizes[index] = a
    sizes[index + 1] = pair - a
    return { ...n, sizes }
  })
}

// ------------------------------------------------------------------ validation
/**
 * Make any parsed JSON a usable layout: valid nodes only, unique ids, and exactly one
 * terminal panel (added if missing, extras demoted to empty slots).
 */
export function sanitizeLayout(raw: unknown, fallback: LayoutNode = HELIOS7_LAYOUT.root): LayoutNode {
  const seen = new Set<string>()
  const uniqueId = (id: unknown, prefix: string): string => {
    const s = typeof id === 'string' && id && !seen.has(id) ? id.slice(0, 80) : newId(prefix)
    seen.add(s)
    return s
  }
  let terminals = 0
  const walk = (n: unknown, depth: number): LayoutNode | null => {
    if (!n || typeof n !== 'object' || depth > 12) return null
    const o = n as Record<string, unknown>
    if (o.type === 'panel') {
      let kind: PanelKind = o.kind === 'terminal' ? 'terminal' : 'empty'
      if (kind === 'terminal' && terminals++ > 0) kind = 'empty'
      const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 32) : kind === 'terminal' ? 'SHELL' : 'EMPTY'
      const node: PanelNode = { type: 'panel', id: uniqueId(o.id, 'p'), kind, title }
      if (kind === 'empty' && typeof o.plugin === 'string' && PLUGIN_ID.test(o.plugin)) node.plugin = o.plugin
      return node
    }
    if (o.type === 'split' && Array.isArray(o.children)) {
      const kids: LayoutNode[] = []
      const sizes: number[] = []
      o.children.forEach((c, i) => {
        const k = walk(c, depth + 1)
        if (!k) return
        kids.push(k)
        const s = Array.isArray(o.sizes) ? Number(o.sizes[i]) : NaN
        sizes.push(Number.isFinite(s) && s > 0 ? Math.max(MIN_FRACTION, s) : 1)
      })
      if (!kids.length) return null
      return { type: 'split', id: uniqueId(o.id, 's'), dir: o.dir === 'column' ? 'column' : 'row', children: kids, sizes }
    }
    return null
  }
  let root = walk(raw, 0) ?? structuredClone(fallback)
  if (!panels(root).some((p) => p.kind === 'terminal')) root = split('row', [panel('terminal', 'SHELL'), root], [0.7, 0.3])
  return normalize(root)
}
