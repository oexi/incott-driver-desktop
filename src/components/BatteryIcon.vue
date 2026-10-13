<script setup>
import { computed } from 'vue';
const props = defineProps({ level: { type: Number, default: 0 }, charging: Boolean });
const color = computed(() => {
  if (props.charging) return 'var(--ok)';
  if (props.level <= 20) return 'var(--danger)';
  if (props.level <= 40) return 'var(--warn)';
  return 'var(--ok)';
});
const w = computed(() => Math.max(2, Math.round((Math.min(100, props.level) / 100) * 18)));
</script>

<template>
  <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
    <rect x="0.75" y="0.75" width="23.5" height="12.5" rx="3.5" fill="none" stroke="var(--text-3)" stroke-width="1.5" />
    <rect x="25.5" y="4.5" width="2" height="5" rx="1" fill="var(--text-3)" />
    <rect x="3" y="3" :width="w" height="8" rx="1.8" :fill="color" />
  </svg>
</template>
