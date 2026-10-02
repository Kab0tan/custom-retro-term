import { describe, expect, it } from 'vitest'
import {
  HELIOS7_LAYOUT,
  MIN_FRACTION,
  TERMINAL_ONLY_LAYOUT,
  addPanel,
  movePanel,
  normalize,
  panel,
  panels,
  removePanel,
  resizeSplit,
  sameLayout,
  sanitizeLayout,
  setPanelPlugin,
  splitPanel,
  type SplitNode
} from '@shared/layout'
import { expectWellFormed, sum } from './trees'

describe('built-in layouts', () => {
  it('have exactly one terminal panel and are well formed', () => {
    for (const l of [HELIOS7_LAYOUT, TERMINAL_ONLY_LAYOUT]) {
      expect(panels(l.root).filter((p) => p.kind === 'terminal')).toHaveLength(1)
      expectWellFormed(l.root)
    }
  })
})

describe('normalize', () => {
  it('collapses single-child splits and merges same-direction nesting', () => {
    const a = panel('terminal', 'SHELL', 'a')
    const b = panel('empty', 'B', 'b')
    const c = panel('empty', 'C', 'c')
    const nested: SplitNode = {
      type: 'split',
      id: 's1',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [a, { type: 'split', id: 's2', dir: 'row', sizes: [0.5, 0.5], children: [b, c] }]
    }
    const n = normalize(nested) as SplitNode
    expect(n.children.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(n.sizes).toEqual([0.5, 0.25, 0.25])
    expect(normalize({ type: 'split', id: 's', dir: 'column', sizes: [1], children: [a] })).toBe(a)
  })
})

describe('edits', () => {
  const root = TERMINAL_ONLY_LAYOUT.root

  it('splitPanel adds an empty slot on the requested side', () => {
    const s = splitPanel(root, 'solo-shell', 'left') as SplitNode
    expect(s.dir).toBe('row')
    expect(s.children[0].type === 'panel' && s.children[0].kind).toBe('empty')
    expect(s.children[1].id).toBe('solo-shell')
    expectWellFormed(s)
  })

  it('addPanel splits the largest panel', () => {
    const once = addPanel(root)
    const twice = addPanel(once)
    expect(panels(twice)).toHaveLength(3)
    expectWellFormed(twice)
  })

  it('removePanel never removes the terminal', () => {
    expect(removePanel(root, 'solo-shell')).toBe(root)
    const s = splitPanel(root, 'solo-shell', 'right')
    const extra = panels(s).find((p) => p.kind === 'empty')!
    expect(removePanel(s, extra.id)).toEqual(root)
  })

  it('movePanel swaps with center and docks beside otherwise', () => {
    const l = HELIOS7_LAYOUT.root
    const swapped = movePanel(l, 'h7-shell', 'h7-log', 'center')
    expect(panels(swapped).map((p) => p.id)).toEqual(panels(l).map((p) => p.id).map((id) => (id === 'h7-shell' ? 'h7-log' : id === 'h7-log' ? 'h7-shell' : id)))
    const docked = movePanel(l, 'h7-spectrum', 'h7-log', 'bottom')
    expect(panels(docked)).toHaveLength(panels(l).length)
    expectWellFormed(docked)
    expect(movePanel(l, 'h7-shell', 'h7-shell', 'left')).toBe(l)
  })

  it('resizeSplit keeps both neighbours above MIN_FRACTION', () => {
    const l = HELIOS7_LAYOUT.root
    const r = resizeSplit(l, 'h7-root', 0, 5) as SplitNode
    expect(r.sizes[1]).toBeCloseTo(MIN_FRACTION, 6)
    expect(sum(r.sizes)).toBeCloseTo(1, 6)
  })

  it('setPanelPlugin replaces default titles but keeps custom ones', () => {
    const s = splitPanel(root, 'solo-shell', 'right')
    const slot = panels(s).find((p) => p.kind === 'empty')!
    const withPlugin = setPanelPlugin(s, slot.id, 'system', 'System', [])
    expect(panels(withPlugin).find((p) => p.id === slot.id)).toMatchObject({ plugin: 'system', title: 'SYSTEM' })
    const renamed = setPanelPlugin(withPlugin, slot.id, 'devices', 'Device map', ['System'])
    expect(panels(renamed).find((p) => p.id === slot.id)).toMatchObject({ plugin: 'devices', title: 'DEVICE MAP' })
  })

  it('sameLayout ignores ids', () => {
    const a = splitPanel(root, 'solo-shell', 'right')
    const b = splitPanel(root, 'solo-shell', 'right')
    expect(sameLayout(a, b)).toBe(true)
    expect(sameLayout(a, root)).toBe(false)
  })
})

describe('sanitizeLayout', () => {
  it('falls back for garbage', () => {
    for (const raw of [null, 42, 'x', [], { type: 'nope' }]) {
      expect(sameLayout(sanitizeLayout(raw), HELIOS7_LAYOUT.root)).toBe(true)
    }
  })

  it('adds a terminal when missing and demotes extra terminals', () => {
    const noTerminal = sanitizeLayout({ type: 'panel', id: 'x', kind: 'empty', title: 'X' })
    expect(panels(noTerminal).filter((p) => p.kind === 'terminal')).toHaveLength(1)
    const two = sanitizeLayout({
      type: 'split',
      dir: 'row',
      sizes: [1, 1],
      children: [
        { type: 'panel', id: 'a', kind: 'terminal' },
        { type: 'panel', id: 'b', kind: 'terminal' }
      ]
    })
    expect(panels(two).filter((p) => p.kind === 'terminal')).toHaveLength(1)
  })

  it('makes ids unique and drops invalid plugin ids', () => {
    const l = sanitizeLayout({
      type: 'split',
      dir: 'row',
      children: [
        { type: 'panel', id: 'same', kind: 'terminal' },
        { type: 'panel', id: 'same', kind: 'empty', plugin: '../../etc' }
      ]
    })
    const ps = panels(l)
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length)
    expect(ps.every((p) => p.plugin === undefined)).toBe(true)
    expectWellFormed(l)
  })
})
