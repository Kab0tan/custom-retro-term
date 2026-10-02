/**
 * Split trees: the shape shared by the panel layout (layout.ts) and the panes inside a tab (panes.ts).
 * A split's children sit side by side (row) or stacked (column); leaves are panels or panes.
 * Pure functions only; every operation returns a new tree and inputs are never mutated.
 */

export interface Leaf {
  type: string
  id: string
}

export interface Split<L extends Leaf> {
  type: 'split'
  id: string
  /** row = children side by side, column = stacked. */
  dir: 'row' | 'column'
  children: Array<Tree<L>>
  /** Fractions of the split's size, one per child, summing to 1. */
  sizes: number[]
}

export type Tree<L extends Leaf> = L | Split<L>

/** Where something lands beside a target leaf. */
export type Side = 'left' | 'right' | 'top' | 'bottom'

/** No child may shrink below this fraction of its split. */
export const MIN_FRACTION = 0.08

let counter = 0
export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`

export const isSplit = <L extends Leaf>(n: Tree<L>): n is Split<L> => n.type === 'split'

export const split = <L extends Leaf>(dir: Split<L>['dir'], children: Array<Tree<L>>, sizes?: number[], id = newId('s')): Split<L> => ({
  type: 'split',
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length)
})

export function leaves<L extends Leaf>(root: Tree<L>): L[] {
  return isSplit(root) ? root.children.flatMap((c) => leaves(c)) : [root]
}

/** Collapse single-child splits, merge same-direction nesting, renormalise sizes. */
export function normalize<L extends Leaf>(node: Tree<L>): Tree<L> {
  if (!isSplit(node)) return node
  const children: Array<Tree<L>> = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const n = normalize(c)
    const size = node.sizes[i] ?? 1 / node.children.length
    if (isSplit(n) && n.dir === node.dir) {
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

export function mapTree<L extends Leaf>(node: Tree<L>, fn: (n: Tree<L>) => Tree<L>): Tree<L> {
  const mapped = fn(node)
  if (!isSplit(mapped)) return mapped
  return { ...mapped, children: mapped.children.map((c) => mapTree(c, fn)) }
}

/**
 * Replace one leaf. Unlike mapTree this doesn't descend into the replacement: the new split
 * contains the old leaf, and walking into it would replace it again, forever.
 */
export function replaceLeaf<L extends Leaf>(node: Tree<L>, id: string, fn: (leaf: L) => Tree<L>): Tree<L> {
  if (!isSplit(node)) return node.id === id ? fn(node) : node
  return { ...node, children: node.children.map((c) => replaceLeaf(c, id, fn)) }
}

/**
 * Remove a leaf, without normalising (null if nothing is left). By default the siblings share its
 * space in proportion; with `giveToSibling` it all goes to the sibling before it (after it, if first).
 */
export function prune<L extends Leaf>(node: Tree<L>, id: string, giveToSibling = false): Tree<L> | null {
  if (!isSplit(node)) return node.id === id ? null : node
  const kept: Array<{ node: Tree<L>; size: number }> = []
  let freed = -1
  node.children.forEach((c, i) => {
    const p = prune(c, id, giveToSibling)
    if (p) kept.push({ node: p, size: node.sizes[i] })
    else freed = i
  })
  if (!kept.length) return null
  if (giveToSibling && freed >= 0) kept[Math.max(0, freed - 1)].size += node.sizes[freed]
  return { ...node, children: kept.map((k) => k.node), sizes: kept.map((k) => k.size) }
}

/** Put `insert` beside the leaf `targetId`, on the given side. */
export function insertBeside<L extends Leaf>(root: Tree<L>, targetId: string, insert: L, side: Side): Tree<L> {
  const dir: Split<L>['dir'] = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'top'
  return normalize(replaceLeaf(root, targetId, (n) => split<L>(dir, before ? [insert, n] : [n, insert])))
}

/**
 * Resize the boundary between children `index` and `index + 1` of a split.
 * `delta` is a fraction of the split's size; both neighbours keep at least `min`.
 */
export function resizeSplit<L extends Leaf>(root: Tree<L>, splitId: string, index: number, delta: number, min = MIN_FRACTION): Tree<L> {
  return mapTree(root, (n) => {
    if (!isSplit(n) || n.id !== splitId || index < 0 || index >= n.children.length - 1) return n
    const sizes = [...n.sizes]
    const pair = sizes[index] + sizes[index + 1]
    // Two neighbours already smaller than 2 × min together (after splitting a small child) share what they have.
    const floor = Math.min(min, pair / 2)
    const a = Math.min(pair - floor, Math.max(floor, sizes[index] + delta))
    sizes[index] = a
    sizes[index + 1] = pair - a
    return { ...n, sizes }
  })
}
