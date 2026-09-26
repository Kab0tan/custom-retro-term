#version 300 es
// Separable 9-tap gaussian (as 5 bilinear taps). Run once horizontally, once vertically.
precision highp float;
uniform sampler2D uTex; // FBO: sampled in its own texture space, no flip needed
uniform vec2 uDir;      // texel step along the blur axis
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 c = texture(uTex, uv).rgb * 0.227027;
  c += (texture(uTex, uv + uDir * 1.384615).rgb + texture(uTex, uv - uDir * 1.384615).rgb) * 0.316216;
  c += (texture(uTex, uv + uDir * 3.230769).rgb + texture(uTex, uv - uDir * 3.230769).rgb) * 0.070270;
  outColor = vec4(c, 1.0);
}
