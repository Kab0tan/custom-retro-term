<script setup lang="ts">
import { computed } from 'vue'
import { effectiveCrt, type CrtSettings } from '@shared/settings'

// css renderer: pure CSS layers over the live DOM. Cheap and input-transparent, but it can
// only add on top: no curvature, no real bloom, no burn-in. Strengths follow the same settings.
const props = defineProps<{ crt: CrtSettings }>()

const eff = computed(() => effectiveCrt(props.crt))
const vars = computed(() => ({
  '--scan': String(eff.value.scanlines * 0.35),
  '--vig': String(eff.value.vignette * 0.8),
  '--glow': String(eff.value.bloom * 0.6)
}))
</script>

<template>
  <div class="crt" :class="{ flicker: eff.flicker > 0 }" :style="vars" aria-hidden="true">
    <div class="glow" />
    <div class="scanlines" />
    <div class="vignette" />
  </div>
</template>

<style scoped>
.crt,
.crt > div {
  position: fixed;
  inset: 0;
  pointer-events: none;
}
.crt {
  z-index: 1000;
}
.crt.flicker {
  animation: flicker 0.12s infinite;
}
/* Fake bloom: blurred, brightened copy of what's underneath, screened on top. */
.glow {
  backdrop-filter: blur(3px) brightness(1.6);
  mix-blend-mode: screen;
  opacity: var(--glow);
}
.scanlines {
  background: repeating-linear-gradient(to bottom, transparent 0, transparent 1px, rgba(0, 0, 0, var(--scan)) 2px, rgba(0, 0, 0, var(--scan)) 3px);
}
.vignette {
  background: radial-gradient(ellipse at center, transparent 60%, rgba(0, 0, 0, var(--vig)) 100%);
}
@keyframes flicker {
  0% { opacity: 0.985; }
  50% { opacity: 1; }
  100% { opacity: 0.99; }
}
</style>
