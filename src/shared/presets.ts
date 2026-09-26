import { DEFAULT_CRT, lookOf, type LookCrt, type LookPreset, type Settings } from './settings'

const look = (values: Partial<LookCrt>): LookCrt => ({ ...lookOf(DEFAULT_CRT), ...values })

/** Built-in looks. User presets are stored in settings.json and listed after these. */
export const BUILTIN_PRESETS: LookPreset[] = [
  {
    id: 'helios-amber',
    name: 'HELIOS-7 Amber',
    phosphor: 'amber',
    colorScheme: 'phosphor',
    crt: look({})
  },
  {
    id: 'vt-green',
    name: 'VT Green',
    phosphor: 'green',
    colorScheme: 'phosphor',
    crt: look({ curvature: 0.45, scanlines: 0.4, bloom: 0.45, glow: 0.3, vignette: 0.45, rgbShift: 0.1, flicker: 0.2, noise: 0.15, burnIn: 0.25, chroma: 0.3 })
  },
  {
    id: 'cyan-ops',
    name: 'Cyan Ops',
    phosphor: 'cyan',
    colorScheme: 'phosphor',
    crt: look({ curvature: 0.25, scanlines: 0.25, bloom: 0.5, glow: 0.35, vignette: 0.35, rgbShift: 0.2, flicker: 0.1, noise: 0.08, chroma: 0.5 })
  },
  {
    // No animated effects, so an idle window costs no GPU at all.
    id: 'clean',
    name: 'Clean (low power)',
    phosphor: 'amber',
    colorScheme: 'phosphor',
    crt: look({ curvature: 0, scanlines: 0.12, bloom: 0.2, glow: 0.1, vignette: 0.15, rgbShift: 0, flicker: 0, noise: 0, burnIn: 0, chroma: 0.7 })
  },
  {
    id: 'full-retro',
    name: 'Full Retro',
    phosphor: 'amber',
    colorScheme: 'phosphor',
    crt: look({ curvature: 0.8, scanlines: 0.6, bloom: 0.6, glow: 0.5, vignette: 0.6, rgbShift: 0.45, flicker: 0.5, noise: 0.4, burnIn: 0.5, chroma: 0.2 })
  }
]

export const allPresets = (s: Settings): LookPreset[] => [...BUILTIN_PRESETS, ...s.presets]

export const isBuiltIn = (id: string): boolean => BUILTIN_PRESETS.some((p) => p.id === id)

/** The settings patch that applies a preset. */
export function applyPreset(s: Settings, p: LookPreset): Partial<Settings> {
  return { phosphor: p.phosphor, colorScheme: p.colorScheme, crt: { ...s.crt, ...p.crt }, activePreset: p.id }
}

/** The current look captured as a preset. */
export function captureLook(s: Settings, id: string, name: string): LookPreset {
  return { id, name, phosphor: s.phosphor, colorScheme: s.colorScheme, crt: lookOf(s.crt) }
}

/** Whether the current look matches the preset exactly. */
export function matchesPreset(s: Settings, p: LookPreset): boolean {
  return (
    s.phosphor === p.phosphor &&
    s.colorScheme === p.colorScheme &&
    JSON.stringify(lookOf(s.crt)) === JSON.stringify(lookOf({ ...s.crt, ...p.crt }))
  )
}
