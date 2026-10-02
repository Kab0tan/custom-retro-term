import { describe, expect, it } from 'vitest'
import {
  MAX_PANES,
  closePane,
  equalize,
  gutters,
  neighbor,
  pane,
  paneIds,
  paneRects,
  resizeBoundary,
  resizePane,
  splitPane,
  swapPanes,
  type PaneNode,
  type PaneSplit
} from '@shared/panes'
import { MIN_FRACTION } from '@shared/tree'
import { expectWellFormed, sum } from './trees'

const row = (children: PaneNode[], sizes: number[], id: string): PaneSplit => ({ type: 'split', id, dir: 'row', children, sizes })
const column = (children: PaneNode[], sizes: number[], id: string): PaneSplit => ({ type: 'split', id, dir: 'column', children, sizes })

/**
 * Uneven and nested:
 *   +-----+-----------+
 *   |     |     B     |   A: 0..0.5 wide, full height
 *   |  A  +------+----+   B: right half, top 30%
 *   |     |  C   | D  |   C: 0.5..0.8, D: 0.8..1, bottom 70%
 *   +-----+------+----+
 */
const NESTED: PaneNode = row([pane('A'), column([pane('B'), row([pane('C'), pane('D')], [0.6, 0.4], 'cd')], [0.3, 0.7], 'bcd')], [0.5, 0.5], 'root')

const rectOf = (root: PaneNode, id: string): { x: number; y: number; w: number; h: number } => paneRects(root).find((r) => r.id === id)!

/** Structure with sizes rounded, so float noise from renormalising doesn't fail equality. */
const shape = (n: PaneNode): unknown =>
  n.type === 'pane' ? n.id : [n.id, n.dir, n.sizes.map((s) => Math.round(s * 1e9)), n.children.map(shape)]

/** Small deterministic PRNG, so the random trees are the same on every run. */
function rng(seed: number): () => number {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

function randomTree(seed: number, count: number): PaneNode {
  const r = rng(seed)
  let root: PaneNode = pane('p0')
  for (let i = 1; i < count; i++) {
    const ids = paneIds(root)
    root = splitPane(root, ids[Math.floor(r() * ids.length)], r() < 0.5 ? 'right' : 'bottom', `p${i}`)
    // Uneven sizes too.
    const g = gutters(root)
    const pick = g[Math.floor(r() * g.length)]
    root = resizeBoundary(root, pick.splitId, pick.index, (r() - 0.5) * 0.4)
  }
  return root
}

describe('splitPane / closePane', () => {
  it('split then close gives back the original tree', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const root = randomTree(seed, 1 + (seed % MAX_PANES))
      for (const id of paneIds(root)) {
        for (const side of ['right', 'bottom'] as const) {
          const split = splitPane(root, id, side, 'new')
          if (split === root) continue // at MAX_PANES
          expectWellFormed(split)
          expect(paneIds(split)).toHaveLength(paneIds(root).length + 1)
          expect(shape(closePane(split, 'new')!)).toEqual(shape(root))
        }
      }
    }
  })

  it('puts the new pane to the right of or below the old one', () => {
    const right = splitPane(pane('a'), 'a', 'right', 'b')
    expect(rectOf(right, 'b').x).toBeCloseTo(0.5, 6)
    const below = splitPane(pane('a'), 'a', 'bottom', 'b')
    expect(rectOf(below, 'b').y).toBeCloseTo(0.5, 6)
  })

  it('stops at MAX_PANES, at the minimum size, and on unknown or duplicate ids', () => {
    let root: PaneNode = pane('p0')
    for (let i = 1; i < MAX_PANES; i++) root = splitPane(root, `p${i - 1}`, i % 2 ? 'right' : 'bottom', `p${i}`)
    expect(paneIds(root)).toHaveLength(MAX_PANES)
    expect(splitPane(root, 'p0', 'right', 'extra')).toBe(root)
    const min = { w: 0.3, h: 0.3 }
    const half = splitPane(pane('a'), 'a', 'right', 'b', min)
    expect(splitPane(half, 'b', 'right', 'c', min)).toBe(half) // 0.25 < 0.3
    expect(splitPane(half, 'b', 'bottom', 'c', min)).not.toBe(half)
    expect(splitPane(half, 'nope', 'right', 'c')).toBe(half)
    expect(splitPane(half, 'a', 'right', 'b')).toBe(half)
  })

  it('closing the last pane leaves nothing', () => {
    expect(closePane(pane('a'), 'a')).toBeNull()
  })

  it('gives the closed pane space to the one before it', () => {
    const three = row([pane('a'), pane('b'), pane('c')], [0.2, 0.3, 0.5], 'r')
    expect((closePane(three, 'b') as PaneSplit).sizes).toEqual([0.5, 0.5])
    expect((closePane(three, 'a') as PaneSplit).sizes).toEqual([0.5, 0.5])
  })
})

describe('paneRects', () => {
  it('covers the stage without overlaps', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rects = paneRects(randomTree(seed, 1 + (seed % MAX_PANES)))
      expect(sum(rects.map((r) => r.w * r.h))).toBeCloseTo(1, 9)
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(-1e-9)
        expect(r.y).toBeGreaterThanOrEqual(-1e-9)
        expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
        expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]
          const b = rects[j]
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
          expect(ox <= 1e-9 || oy <= 1e-9).toBe(true)
        }
      }
    }
  })

  it('gives one gutter per boundary, on a pane edge', () => {
    const g = gutters(NESTED)
    expect(g).toHaveLength(3)
    const cd = g.find((x) => x.splitId === 'cd')!
    expect(cd).toMatchObject({ dir: 'row', index: 0 })
    expect(cd.x).toBeCloseTo(0.8, 6)
    expect(cd.y).toBeCloseTo(0.3, 6)
    expect(cd.h).toBeCloseTo(0.7, 6)
    expect(cd.span).toBeCloseTo(0.5, 6)
  })
})

describe('neighbor', () => {
  it('follows the geometry of uneven nested splits in all 4 directions', () => {
    expect(neighbor(NESTED, 'A', 'right')).toBe('C') // C overlaps A more than B does
    expect(neighbor(NESTED, 'A', 'left')).toBeNull()
    expect(neighbor(NESTED, 'A', 'up')).toBeNull()
    expect(neighbor(NESTED, 'A', 'down')).toBeNull()
    expect(neighbor(NESTED, 'B', 'left')).toBe('A')
    expect(neighbor(NESTED, 'B', 'down')).toBe('C') // 0.3 of overlap against D's 0.2
    expect(neighbor(NESTED, 'B', 'right')).toBeNull()
    expect(neighbor(NESTED, 'C', 'left')).toBe('A')
    expect(neighbor(NESTED, 'C', 'up')).toBe('B')
    expect(neighbor(NESTED, 'C', 'right')).toBe('D')
    expect(neighbor(NESTED, 'D', 'left')).toBe('C')
    expect(neighbor(NESTED, 'D', 'up')).toBe('B')
    expect(neighbor(NESTED, 'D', 'down')).toBeNull()
  })

  it('breaks ties toward the top or left', () => {
    const grid = row([pane('L'), column([pane('T'), pane('B')], [0.5, 0.5], 'c')], [0.5, 0.5], 'r')
    expect(neighbor(grid, 'L', 'right')).toBe('T')
  })

  it('returns null for an unknown pane', () => {
    expect(neighbor(NESTED, 'nope', 'left')).toBeNull()
  })
})

describe('resizePane', () => {
  const three = row([pane('a'), pane('b'), pane('c')], [1 / 3, 1 / 3, 1 / 3], 'r')

  it('moves the border on that side, or the opposite one at the edge', () => {
    const grow = resizePane(three, 'b', 'right', 0.1)
    expect(rectOf(grow, 'b').w).toBeCloseTo(1 / 3 + 0.1, 6)
    expect(rectOf(grow, 'c').w).toBeCloseTo(1 / 3 - 0.1, 6)
    const shrink = resizePane(three, 'c', 'right', 0.1)
    expect(rectOf(shrink, 'c').w).toBeCloseTo(1 / 3 - 0.1, 6)
    expect(rectOf(shrink, 'b').w).toBeCloseTo(1 / 3 + 0.1, 6)
    const left = resizePane(three, 'b', 'left', 0.1)
    expect(rectOf(left, 'a').w).toBeCloseTo(1 / 3 - 0.1, 6)
    expectWellFormed(left)
  })

  it('uses the nearest ancestor that has a border on that side', () => {
    // Y is last in its own row, so growing it right moves the outer border against W.
    const tree = row([column([row([pane('X'), pane('Y')], [0.5, 0.5], 'xy'), pane('Z')], [0.5, 0.5], 'xyz'), pane('W')], [0.6, 0.4], 'r')
    const r = resizePane(tree, 'Y', 'right', 0.1)
    expect(rectOf(r, 'W').w).toBeCloseTo(0.3, 6)
    expect(rectOf(r, 'Y').w).toBeCloseTo(0.35, 6)
    // No column ancestor: nothing to resize vertically.
    const flat = row([pane('a'), pane('b')], [0.5, 0.5], 'r')
    expect(resizePane(flat, 'a', 'down', 0.1)).toBe(flat)
  })

  it('stops at the minimum size, in stage fractions and MIN_FRACTION', () => {
    const two = row([pane('a'), pane('b')], [0.5, 0.5], 'r')
    expect(rectOf(resizePane(two, 'a', 'right', 5), 'b').w).toBeCloseTo(MIN_FRACTION, 6)
    const min = { w: 0.2, h: 0.1 }
    expect(rectOf(resizePane(two, 'a', 'right', 5, min), 'b').w).toBeCloseTo(0.2, 3)
    expect(rectOf(resizePane(two, 'a', 'right', 5, min), 'b').w).toBeGreaterThanOrEqual(0.2 - 1e-6)
  })

  it('still lets a pane that is already too small grow', () => {
    const tiny = row([pane('a'), pane('b')], [0.1, 0.9], 'r')
    const r = resizePane(tiny, 'a', 'right', 0.05, { w: 0.3, h: 0.1 })
    expect(rectOf(r, 'a').w).toBeCloseTo(0.15, 6)
  })
})

describe('equalize / swapPanes', () => {
  it('equalize gives panes side by side the same width', () => {
    const tree = row([pane('A'), column([pane('B'), row([pane('C'), pane('D')], [0.9, 0.1], 'cd')], [0.5, 0.5], 'bcd')], [0.8, 0.2], 'r')
    const even = equalize(tree)
    expectWellFormed(even)
    for (const id of ['A', 'C', 'D']) expect(rectOf(even, id).w).toBeCloseTo(1 / 3, 6)
    expect(rectOf(even, 'B').h).toBeCloseTo(0.5, 6)
  })

  it('swapPanes exchanges places and keeps the shape', () => {
    const s = swapPanes(NESTED, 'A', 'D')
    expectWellFormed(s)
    expect({ ...rectOf(s, 'D'), id: 'A' }).toEqual(rectOf(NESTED, 'A'))
    expect({ ...rectOf(s, 'A'), id: 'D' }).toEqual(rectOf(NESTED, 'D'))
    expect(swapPanes(NESTED, 'A', 'A')).toBe(NESTED)
  })
})
