import { NEUTRAL_CHROME, phosphorChrome, PHOSPHORS } from '@shared/phosphor'
import type { Settings } from '@shared/settings'
import { uiVariables } from '../theme'

/** The theme object plugins receive (PluginTheme in plugin-runtime/crt-plugin.d.ts). */
export function pluginTheme(s: Settings): unknown {
  const t = PHOSPHORS[s.phosphor]
  const { shader, ...tokens } = t
  return {
    colorScheme: s.colorScheme,
    phosphor: { ...tokens, rgb: shader },
    chrome: s.colorScheme === 'campbell' ? NEUTRAL_CHROME : phosphorChrome(t),
    fonts: { mono: 'IBM Plex Mono', ui: s.colorScheme === 'phosphor' ? 'Share Tech Mono' : 'IBM Plex Mono' },
    cssVariables: uiVariables(s)
  }
}
