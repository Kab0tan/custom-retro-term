import { expect } from 'vitest'
import type { Leaf, Tree } from '@shared/tree'

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

/** Every split's sizes add up to 1 and no split has a single child. */
export function expectWellFormed<L extends Leaf>(n: Tree<L>): void {
  if (n.type !== 'split') return
  expect(n.children.length).toBeGreaterThan(1)
  expect(n.sizes).toHaveLength(n.children.length)
  expect(sum(n.sizes)).toBeCloseTo(1, 6)
  n.children.forEach(expectWellFormed)
}
