import { describe, expect, it } from 'vitest'
import { NEUTRAL_CHROME, PHOSPHOR_IDS, PHOSPHORS, cssVariables, isPhosphorId, mix, phosphorChrome, phosphorPalette } from '@shared/phosphor'

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i

describe('mix', () => {
  it('interpolates linearly and clamps', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff')
  })
})

describe('phosphors', () => {
  it('recognises their ids', () => {
    expect(PHOSPHOR_IDS).toEqual(['amber', 'green', 'cyan'])
    expect(isPhosphorId('green')).toBe(true)
    expect(isPhosphorId('purple')).toBe(false)
    expect(isPhosphorId('toString')).toBe(false)
  })

  it('generate valid palettes, chrome and CSS variables', () => {
    for (const id of PHOSPHOR_IDS) {
      const t = PHOSPHORS[id]
      for (const v of Object.values(phosphorPalette(t))) expect(v).toMatch(HEX)
      const chrome = phosphorChrome(t)
      const vars = cssVariables(t, chrome, t.background)
      expect(Object.keys(vars).every((k) => k.startsWith('--'))).toBe(true)
      expect(t.shader.every((c) => c >= 0 && c <= 1)).toBe(true)
    }
    expect(Object.keys(phosphorChrome(PHOSPHORS.amber)).sort()).toEqual(Object.keys(NEUTRAL_CHROME).sort())
  })
})
