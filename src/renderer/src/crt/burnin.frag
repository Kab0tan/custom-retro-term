#version 300 es
// Burn-in: phosphor that was lit keeps glowing and fades linearly
// (linear, not multiplicative, so 8-bit values actually reach zero).
precision highp float;
uniform sampler2D uSrc;
uniform bool uSrcBgra;
uniform sampler2D uPrev; // previous burn-in frame (FBO, flipped)
uniform float uFade;     // brightness lost this frame
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 s = texture(uSrc, vUv);
  vec3 src = uSrcBgra ? s.bgr : s.rgb;
  vec3 prev = texture(uPrev, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  outColor = vec4(max(src, prev - uFade), 1.0);
}
