import type { ShellProfile } from './settings'

/** How offscreen frames reach the compositor window in webgl mode. */
export type FrameTransport = 'shared' | 'bitmap'

export interface PtySpawnRequest {
  /** Profile id; omitted = user's default shell. */
  profileId?: string | null
  cols: number
  rows: number
  cwd?: string
}

export interface PtySpawnResult {
  id: number
  pid: number
  profile: Pick<ShellProfile, 'id' | 'name' | 'kind'>
}

export interface ProfileList {
  profiles: ShellProfile[]
  defaultId: string
}

/** Static facts the renderer needs to configure xterm for this machine. */
export interface PlatformInfo {
  windowsBuild: number
  /** This machine's name: a shell's OSC 7 working directory only counts if it names this host. */
  hostname: string
  /**
   * Window chrome:
   * - overlay: tabs in the title bar, native caption buttons drawn by Windows (css renderer)
   * - custom:  the UI draws its own caption buttons, so they go through the CRT too (webgl renderer)
   * - mac:     macOS traffic lights (native, top-left); the tab bar leaves room for them
   */
  frame: 'overlay' | 'custom' | 'mac'
  renderer: 'webgl' | 'css'
  os: 'win32' | 'darwin' | 'linux'
}

/** A rectangle in CSS pixels of the UI. */
export interface UiRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Barrel curvature shared by the shader and the input mapper, so clicks land where they look.
 * `amount` is the 0..1 setting; these are the per-axis coefficients it scales.
 * Must match `curve()` in src/renderer/src/crt/final.frag.
 */
export const CURVATURE_MAX = { x: 0.06, y: 0.09 }

/** Output uv (0..1, top-left origin) → the source uv the shader samples there. */
export function curveUv(u: number, v: number, amount: number): [number, number] {
  const x = u * 2 - 1
  const y = v * 2 - 1
  const ax = amount * CURVATURE_MAX.x
  const ay = amount * CURVATURE_MAX.y
  return [(x * (1 + ax * y * y)) * 0.5 + 0.5, (y * (1 + ay * x * x)) * 0.5 + 0.5]
}

/** Source uv → where it appears on screen (inverse of curveUv, by fixed-point iteration). */
export function uncurveUv(su: number, sv: number, amount: number): [number, number] {
  let u = su
  let v = sv
  for (let i = 0; i < 8; i++) {
    const [cu, cv] = curveUv(u, v, amount)
    u -= cu - su
    v -= cv - sv
  }
  return [u, v]
}
