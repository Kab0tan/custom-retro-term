#version 300 es
// Fullscreen triangle. vUv is in image space: (0,0) = top-left of the picture.
// Note: anything rendered into an FBO therefore ends up upside down in texture space,
// which the fragment shaders undo with their `*Flip` uniforms.
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
