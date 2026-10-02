/**
 * Tiling layout: a tree of splits whose leaves are panels.
 * Pure functions only (no DOM), shared by the UI (editing) and main (validating settings.json).
 * Every operation returns a new tree; inputs are never mutated.
 */
import { PLUGIN_ID } from './plugins'
import { insertBeside, leaves, mapTree, MIN_FRACTION, newId, normalize, prune, split, type Side, type Split, type Tree } from './tree'

export { MIN_FRACTION, newId, normalize, resizeSplit } from './tree'

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

export type SplitNode = Split<PanelNode>

export type LayoutNode = Tree<PanelNode>

export interface SavedLayout {
  id: string
  name: string
  root: LayoutNode
}

/** Where a dragged panel lands relative to the target: an edge docks beside it, center swaps. */
export type DropZone = Side | 'center'

export const panel = (kind: PanelKind, title: string, id = newId('p'), plugin?: string): PanelNode =>
  plugin ? { type: 'panel', id, kind, title, plugin } : { type: 'panel', id, kind, title }

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
export const panels = (root: LayoutNode): PanelNode[] => leaves(root)

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

// ------------------------------------------------------------------ edits
/** Split a panel, adding a new empty slot beside it. */
export function splitPanel(root: LayoutNode, targetId: string, zone: Side, title = 'EMPTY'): LayoutNode {
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
  return normalize(prune(root, id) ?? root)
}

export function renamePanel(root: LayoutNode, id: string, title: string): LayoutNode {
  const t = title.trim().slice(0, 32)
  if (!t) return root
  return mapTree(root, (n) => (n.type === 'panel' && n.id === id ? { ...n, title: t } : n))
}

/** Put a plugin in a slot (or clear it). `title` replaces the old title if that was a default. */
export function setPanelPlugin(root: LayoutNode, id: string, plugin: string | null, title: string | null, defaultTitles: string[]): LayoutNode {
  const defaults = new Set(['EMPTY', ...defaultTitles.map((t) => t.toUpperCase())])
  return mapTree(root, (n) => {
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
    return mapTree(root, (n) => (n.type !== 'panel' ? n : n.id === srcId ? dst : n.id === targetId ? src : n))
  }
  // Detach the source (even the terminal: it's re-inserted right away), then dock it.
  const without = prune(root, srcId)
  return without ? insertBeside(normalize(without), targetId, src, zone) : root
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
