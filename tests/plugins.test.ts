import { describe, expect, it } from 'vitest'
import { coerceSetting, hostAllowed, resolveSettings, validateManifest, type PluginManifest } from '@shared/plugins'

const base = { id: 'my-panel', name: 'My panel', version: '1.0.0', apiVersion: 1, entry: 'index.js' }

describe('validateManifest', () => {
  it('accepts a minimal manifest', () => {
    const m = validateManifest(base, 'my-panel') as PluginManifest
    expect(typeof m).toBe('object')
    expect(m).toMatchObject({ id: 'my-panel', data: [], settings: [], network: [] })
  })

  it('rejects bad ids, folder mismatches and missing fields', () => {
    expect(validateManifest({ ...base, id: 'My Panel' }, null)).toMatch(/id must be/)
    expect(validateManifest(base, 'other')).toMatch(/must match the folder/)
    expect(validateManifest({ ...base, name: ' ' }, null)).toMatch(/name/)
    expect(validateManifest(null, null)).toMatch(/not an object/)
  })

  it('keeps the entry inside the plugin folder', () => {
    for (const entry of ['../evil.js', 'a/../../b.js', 'index.ts', '/abs.js']) {
      expect(validateManifest({ ...base, entry }, null)).toMatch(/entry must be/)
    }
    expect(typeof validateManifest({ ...base, entry: 'src/main.mjs' }, null)).toBe('object')
  })

  it('checks API and app versions', () => {
    expect(validateManifest({ ...base, apiVersion: 99 }, null)).toMatch(/newer CRT Terminal/)
    expect(validateManifest({ ...base, apiVersion: 0 }, null)).toMatch(/no longer supported/)
    expect(validateManifest({ ...base, minAppVersion: '2.0.0' }, null, '1.9.9')).toMatch(/2\.0\.0 or newer/)
    expect(typeof validateManifest({ ...base, minAppVersion: '1.10.0' }, null, '1.10.0')).toBe('object')
  })

  it('validates data topics and network hosts', () => {
    expect(validateManifest({ ...base, data: ['cpu', 'nope'] }, null)).toMatch(/unknown data "nope"/)
    expect(validateManifest({ ...base, permissions: { network: ['http://x.com'] } }, null)).toMatch(/not a hostname/)
    const m = validateManifest({ ...base, data: ['cpu', 'audio'], permissions: { network: ['API.Example.com', '*.example.org'] } }, null) as PluginManifest
    expect(m.network).toEqual(['api.example.com', '*.example.org'])
  })

  it('validates settings', () => {
    expect(validateManifest({ ...base, settings: [{ key: 'n', type: 'number', default: 1 }] }, null)).toMatch(/number needs/)
    expect(validateManifest({ ...base, settings: [{ key: 'x', type: 'color' }] }, null)).toMatch(/unknown type/)
  })
})

describe('hostAllowed', () => {
  it('matches exact hosts and wildcard subdomains only', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true)
    expect(hostAllowed('API.EXAMPLE.COM', ['api.example.com'])).toBe(true)
    expect(hostAllowed('a.b.example.org', ['*.example.org'])).toBe(true)
    expect(hostAllowed('example.org', ['*.example.org'])).toBe(true)
    expect(hostAllowed('evilexample.org', ['*.example.org'])).toBe(false)
    expect(hostAllowed('example.com.evil.net', ['example.com'])).toBe(false)
    expect(hostAllowed('example.com', [])).toBe(false)
  })
})

describe('settings', () => {
  const manifest = validateManifest(
    {
      ...base,
      settings: [
        { key: 'rate', type: 'number', default: 5, min: 1, max: 10 },
        { key: 'on', type: 'boolean', default: true },
        { key: 'mode', type: 'select', default: 'a', options: [{ value: 'a' }, { value: 'b', label: 'B' }] }
      ]
    },
    null
  ) as PluginManifest

  it('clamps, type-checks and falls back to defaults', () => {
    const [rate, on, mode] = manifest.settings
    expect(coerceSetting(rate, 50)).toBe(10)
    expect(coerceSetting(rate, 'x')).toBe(5)
    expect(coerceSetting(on, 'yes')).toBe(true)
    expect(coerceSetting(mode, 'b')).toBe('b')
    expect(coerceSetting(mode, 'c')).toBe('a')
    expect(resolveSettings(manifest, { rate: 0, extra: 1 })).toEqual({ rate: 1, on: true, mode: 'a' })
  })
})
