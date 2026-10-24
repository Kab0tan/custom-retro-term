import quadVert from './quad.vert?raw'
import burnFrag from './burnin.frag?raw'
import brightFrag from './bright.frag?raw'
import blurFrag from './blur.frag?raw'
import finalFrag from './final.frag?raw'
import { CURVATURE_MAX } from '@shared/types'
import { UNFOCUSED_FPS, type CrtSettings } from '@shared/settings'

type Uniforms = Record<string, WebGLUniformLocation | null>

interface Program {
  prog: WebGLProgram
  u: Uniforms
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

/**
 * Multi-pass CRT renderer (a pipeline in the spirit of cool-retro-term):
 *   source → [burn-in feedback] → screen → bright/downsample → blur H → blur V (+mips) → final
 * Draws only when something changed or an effect is animating; see `needsAnimation`.
 */
export class CrtRenderer {
  private gl: WebGL2RenderingContext
  private src: WebGLTexture
  private srcW = 0
  private srcH = 0
  private srcBgra = false
  private hasFrame = false
  private burn: [Target | null, Target | null] = [null, null]
  private burnIndex = 0
  private bloomA: Target | null = null
  private bloomB: Target | null = null
  private pBurn: Program
  private pBright: Program
  private pBlur: Program
  private pFinal: Program
  private lastContentAt = 0
  private lastDrawAt = 0
  private dirty = true
  /** Shader tint, from the phosphor tokens (src/shared/phosphor.ts). */
  private phosphor: [number, number, number] = [1, 1, 1]
  draws = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private settings: CrtSettings
  ) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, desynchronized: true, preserveDrawingBuffer: false })
    if (!gl) throw new Error('WebGL2 unavailable')
    this.gl = gl
    this.pBurn = this.program(burnFrag, ['uSrc', 'uSrcBgra', 'uPrev', 'uFade'])
    this.pBright = this.program(brightFrag, ['uScreen', 'uFlip', 'uBgra', 'uTexel'])
    this.pBlur = this.program(blurFrag, ['uTex', 'uDir'])
    this.pFinal = this.program(finalFrag, [
      'uScreen', 'uScreenFlip', 'uBgra', 'uBloom', 'uHasBloom', 'uEnabled', 'uTexSize', 'uTime', 'uCurv',
      'uScanPeriod', 'uScan', 'uBloomAmt', 'uGlow', 'uVignette', 'uFlicker', 'uNoise', 'uShift', 'uChroma',
      'uBright', 'uPhosphor'
    ])
    this.src = this.texture()
  }

  // ------------------------------------------------------------------ setup
  private program(frag: string, uniforms: string[]): Program {
    const gl = this.gl
    const compile = (type: number, source: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, source)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, quadVert))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error')
    const u: Uniforms = {}
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name)
    return { prog, u }
  }

  private texture(mipmaps = false): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  private target(prev: Target | null, w: number, h: number, mipmaps = false): Target {
    if (prev && prev.w === w && prev.h === h) return prev
    const gl = this.gl
    if (prev) {
      gl.deleteTexture(prev.tex)
      gl.deleteFramebuffer(prev.fbo)
    }
    const tex = this.texture(mipmaps)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fbo, w, h }
  }

  // ------------------------------------------------------------------ input frames
  uploadVideoFrame(frame: VideoFrame): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.src)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    this.srcW = frame.displayWidth
    this.srcH = frame.displayHeight
    this.srcBgra = false
    this.contentChanged()
  }

  uploadBitmap(w: number, h: number, bgra: Uint8Array): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.src)
    if (w === this.srcW && h === this.srcH && this.srcBgra) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bgra)
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bgra)
    this.srcW = w
    this.srcH = h
    this.srcBgra = true
    this.contentChanged()
  }

  private contentChanged(): void {
    this.hasFrame = true
    this.dirty = true
    this.lastContentAt = performance.now()
  }

  /** `s` must already be the effective values (toggled-off effects at 0). */
  setSettings(s: CrtSettings, phosphor: [number, number, number]): void {
    this.settings = s
    this.phosphor = phosphor
    this.dirty = true
  }

  invalidate(): void {
    this.dirty = true
  }

  // ------------------------------------------------------------------ scheduling
  private burnFadeSeconds(): number {
    return 0.15 + this.settings.burnIn * 1.6
  }

  /** Whether frames must keep coming even without new content. */
  needsAnimation(focused: boolean): boolean {
    const s = this.settings
    if (!s.enabled || !this.hasFrame) return false
    const burning = s.burnIn > 0 && performance.now() - this.lastContentAt < this.burnFadeSeconds() * 1000 + 100
    const live = (s.flicker > 0 || s.noise > 0) && (focused || !s.pauseWhenUnfocused)
    return burning || live
  }

  wantsDraw(now: number, focused: boolean): boolean {
    if (!this.hasFrame) return false
    const s = this.settings
    const fps = focused || !s.pauseWhenUnfocused ? s.fpsCap : Math.min(UNFOCUSED_FPS, s.fpsCap)
    if (now - this.lastDrawAt < 1000 / fps - 2) return false
    return this.dirty || this.needsAnimation(focused)
  }

  // ------------------------------------------------------------------ drawing
  draw(now: number, time: number): void {
    const gl = this.gl
    const s = this.settings
    const dt = this.lastDrawAt ? Math.min(0.1, (now - this.lastDrawAt) / 1000) : 1 / 60
    this.lastDrawAt = now
    this.dirty = false
    this.draws++

    const dpr = window.devicePixelRatio
    const cw = Math.round(this.canvas.clientWidth * dpr)
    const ch = Math.round(this.canvas.clientHeight * dpr)
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw
      this.canvas.height = ch
    }

    // Which texture holds "the screen": the raw frame, or the burn-in accumulation.
    let screenTex = this.src
    let screenFlip = false
    let screenBgra = this.srcBgra
    const burnOn = s.enabled && s.burnIn > 0
    if (burnOn) {
      const next = this.burnIndex ^ 1
      this.burn[next] = this.target(this.burn[next], this.srcW, this.srcH)
      this.burn[this.burnIndex] = this.target(this.burn[this.burnIndex], this.srcW, this.srcH)
      const p = this.pBurn
      gl.useProgram(p.prog)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.burn[next]!.fbo)
      gl.viewport(0, 0, this.srcW, this.srcH)
      this.bind(0, this.src, p.u.uSrc)
      this.bind(1, this.burn[this.burnIndex]!.tex, p.u.uPrev)
      gl.uniform1i(p.u.uSrcBgra, this.srcBgra ? 1 : 0)
      gl.uniform1f(p.u.uFade, dt / this.burnFadeSeconds())
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      this.burnIndex = next
      screenTex = this.burn[next]!.tex
      screenFlip = true
      screenBgra = false
    } else if (this.burn[0]) {
      for (const t of this.burn) {
        if (!t) continue
        gl.deleteTexture(t.tex)
        gl.deleteFramebuffer(t.fbo)
      }
      this.burn = [null, null]
    }

    // Bloom at quarter resolution; its mip chain doubles as the wide glow.
    const bloomOn = s.enabled && (s.bloom > 0 || s.glow > 0)
    if (bloomOn) {
      const bw = Math.max(1, Math.round(this.srcW / 4))
      const bh = Math.max(1, Math.round(this.srcH / 4))
      this.bloomA = this.target(this.bloomA, bw, bh, true)
      this.bloomB = this.target(this.bloomB, bw, bh)
      gl.viewport(0, 0, bw, bh)

      let p = this.pBright
      gl.useProgram(p.prog)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo)
      this.bind(0, screenTex, p.u.uScreen)
      gl.uniform1i(p.u.uFlip, screenFlip ? 1 : 0)
      gl.uniform1i(p.u.uBgra, screenBgra ? 1 : 0)
      gl.uniform2f(p.u.uTexel, 1 / this.srcW, 1 / this.srcH)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      p = this.pBlur
      gl.useProgram(p.prog)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fbo)
      this.bind(0, this.bloomA.tex, p.u.uTex)
      gl.uniform2f(p.u.uDir, 1 / bw, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo)
      this.bind(0, this.bloomB.tex, p.u.uTex)
      gl.uniform2f(p.u.uDir, 0, 1 / bh)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex)
      gl.generateMipmap(gl.TEXTURE_2D)
    }

    // Final pass to the canvas.
    const p = this.pFinal
    gl.useProgram(p.prog)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, cw, ch)
    this.bind(0, screenTex, p.u.uScreen)
    gl.uniform1i(p.u.uScreenFlip, screenFlip ? 1 : 0)
    gl.uniform1i(p.u.uBgra, screenBgra ? 1 : 0)
    gl.uniform1i(p.u.uHasBloom, bloomOn ? 1 : 0)
    if (bloomOn) this.bind(1, this.bloomA!.tex, p.u.uBloom)
    else this.bind(1, this.src, p.u.uBloom) // keep the sampler bound to something valid
    gl.uniform1i(p.u.uEnabled, s.enabled ? 1 : 0)
    gl.uniform2f(p.u.uTexSize, this.srcW, this.srcH)
    gl.uniform1f(p.u.uTime, time)
    gl.uniform2f(p.u.uCurv, s.curvature * CURVATURE_MAX.x, s.curvature * CURVATURE_MAX.y)
    // One scanline every ~2 CSS px: dense enough to read as a tube, sparse enough for small text.
    gl.uniform1f(p.u.uScanPeriod, Math.max(2, 2 * dpr))
    gl.uniform1f(p.u.uScan, s.scanlines)
    gl.uniform1f(p.u.uBloomAmt, s.bloom)
    gl.uniform1f(p.u.uGlow, s.glow)
    gl.uniform1f(p.u.uVignette, s.vignette)
    gl.uniform1f(p.u.uFlicker, s.flicker)
    gl.uniform1f(p.u.uNoise, s.noise)
    gl.uniform1f(p.u.uShift, s.rgbShift)
    gl.uniform1f(p.u.uChroma, s.chroma)
    gl.uniform1f(p.u.uBright, s.brightness)
    gl.uniform3f(p.u.uPhosphor, ...this.phosphor)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private bind(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(loc, unit)
  }
}
