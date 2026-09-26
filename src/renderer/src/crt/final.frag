#version 300 es
// Final CRT pass: curvature, colour fringing, phosphor tint, bloom + haze, scanlines,
// aperture mask, vignette, flicker, noise and the bezel around the curved glass.
precision highp float;

uniform sampler2D uScreen;
uniform bool uScreenFlip; // true when uScreen is the burn-in FBO
uniform bool uBgra;       // CPU bitmap path uploads BGRA bytes as RGBA
uniform sampler2D uBloom; // FBO, flipped, mipmapped
uniform bool uHasBloom;

uniform bool uEnabled;
uniform vec2 uTexSize;    // screen texture, device pixels
uniform float uTime;      // seconds; frozen while paused
uniform vec2 uCurv;       // amount * CURVATURE_MAX (src/shared/types.ts)
uniform float uScanPeriod;
uniform float uScan;
uniform float uBloomAmt;
uniform float uGlow;
uniform float uVignette;
uniform float uFlicker;
uniform float uNoise;
uniform float uShift;
uniform float uChroma;
uniform float uBright;
uniform vec3 uPhosphor;

in vec2 vUv;
out vec4 outColor;

// Must match curveUv() in src/shared/types.ts, which maps clicks the same way.
vec2 curve(vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  c = vec2(c.x * (1.0 + uCurv.x * c.y * c.y), c.y * (1.0 + uCurv.y * c.x * c.x));
  return c * 0.5 + 0.5;
}

vec3 screen(vec2 uv) {
  vec4 c = texture(uScreen, uScreenFlip ? vec2(uv.x, 1.0 - uv.y) : uv);
  return uBgra ? c.bgr : c.rgb;
}

vec3 bloomAt(vec2 uv, float lod) {
  return textureLod(uBloom, vec2(uv.x, 1.0 - uv.y), lod).rgb;
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

vec3 phosphor(vec3 c) {
  return mix(uPhosphor * luma(c) * 1.6, c, uChroma);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  if (!uEnabled) {
    outColor = vec4(screen(vUv), 1.0); // pixel-exact passthrough
    return;
  }

  vec2 uv = curve(vUv);
  bool curved = uCurv.x > 0.0;

  // Rounded glass edge; everything outside is bezel.
  vec2 q = abs(uv - 0.5) * 2.0;
  float cornerR = curved ? 0.04 : 0.0;
  vec2 d = max(q - (1.0 - cornerR), 0.0);
  float edgeDist = length(d) - cornerR; // > 0 outside the glass
  float glass = curved ? 1.0 - smoothstep(-0.004, 0.002, edgeDist) : 1.0;

  // Colour fringing grows toward the edges.
  vec2 fromCenter = uv - 0.5;
  vec2 off = fromCenter * dot(fromCenter, fromCenter) * uShift * 0.02;
  vec3 col = vec3(screen(uv + off).r, screen(uv).g, screen(uv - off).b);
  col = phosphor(col);

  if (uHasBloom) {
    col += phosphor(bloomAt(uv, 0.0)) * uBloomAmt * 1.4;
    col += phosphor(bloomAt(uv, 3.5)) * uGlow * 1.2; // wide haze from a coarse mip
  }

  // Scanlines follow the curved glass; brightness is compensated so text doesn't dim.
  float s = 0.5 + 0.5 * cos(uv.y * uTexSize.y / uScanPeriod * 6.2831853);
  col *= (1.0 - uScan * 0.5 * (1.0 - s)) * (1.0 + uScan * 0.2);

  // Aperture grille, very light: gives texture up close without hurting glyphs.
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 mask = vec3(m < 1.0 ? 1.0 : 0.94, (m >= 1.0 && m < 2.0) ? 1.0 : 0.94, m >= 2.0 ? 1.0 : 0.94);
  col *= mix(vec3(1.0), mask, uScan);

  float vig = 16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y);
  col *= mix(1.0, pow(clamp(vig, 0.0, 1.0), 0.3), uVignette);

  float flick = sin(uTime * 71.0) * 0.5 + (hash(vec2(floor(uTime * 24.0), 3.1)) - 0.5);
  col *= 1.0 + uFlicker * 0.035 * flick;
  col += (hash(gl_FragCoord.xy + fract(uTime * 7.13) * 91.0) - 0.5) * uNoise * 0.07;

  // Faint lit-glass black level, so the tube never reads as flat #000.
  col += uPhosphor * 0.018 * uGlow;
  col *= uBright;

  // Bezel: dark plastic that catches a little of the screen's glow.
  vec3 bezel = vec3(0.035, 0.03, 0.026);
  if (uHasBloom) bezel += phosphor(bloomAt(clamp(uv, 0.0, 1.0), 4.0)) * 0.12 * (0.4 + uGlow);
  outColor = vec4(mix(bezel, col, glass), 1.0);
}
