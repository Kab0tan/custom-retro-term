#version 300 es
// Bloom input: downsampled screen, dimmer parts suppressed.
precision highp float;
uniform sampler2D uScreen;
uniform bool uFlip;
uniform bool uBgra;
uniform vec2 uTexel; // one source texel in uv
in vec2 vUv;
out vec4 outColor;
vec3 fetch(vec2 uv) {
  vec4 c = texture(uScreen, uFlip ? vec2(uv.x, 1.0 - uv.y) : uv);
  return uBgra ? c.bgr : c.rgb;
}
void main() {
  // 4 bilinear taps = a 4x4 box, so thin glyph strokes aren't lost when downsampling.
  vec3 c = fetch(vUv + uTexel * vec2(-1.0, -1.0)) + fetch(vUv + uTexel * vec2(1.0, -1.0)) +
           fetch(vUv + uTexel * vec2(-1.0, 1.0)) + fetch(vUv + uTexel * vec2(1.0, 1.0));
  c *= 0.25;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  outColor = vec4(c * smoothstep(0.04, 0.5, lum), 1.0);
}
