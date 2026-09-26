import type { CrtSettings, Settings } from '@shared/settings'

/**
 * Settings change; main merges it (CRT keys individually), validates, saves and broadcasts.
 * The JSON round-trip strips Vue's reactive proxies, which can't be copied across the context bridge.
 */
export const setSettings = (patch: Partial<Settings>): void =>
  void window.crt.settings.set(JSON.parse(JSON.stringify(patch)) as Partial<Settings>)

// Sliders fire an event per pixel of drag; send at most one CRT update per frame.
// Only changed keys are sent, so two quick edits can't overwrite each other with stale values.
let pending: Partial<CrtSettings> = {}
let queued = false

export function setCrt(patch: Partial<CrtSettings>): void {
  pending = { ...pending, ...patch }
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    const crt = pending as CrtSettings // partial: main merges it over the current values
    pending = {}
    setSettings({ crt })
  })
}
