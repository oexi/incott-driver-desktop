<script setup>
defineProps({ size: { type: Number, default: 24 } });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="lg-logo" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="var(--accent-2)" />
        <stop offset="1" stop-color="var(--accent)" />
      </linearGradient>
    </defs>
    <path d="M12 2.2c-3.9 0-6.6 2.8-6.6 6.9v6.1c0 3.6 2.8 6.6 6.6 6.6s6.6-3 6.6-6.6V9.1c0-4.1-2.7-6.9-6.6-6.9z" fill="url(#lg-logo)" />
    <rect x="11" y="5" width="2" height="4.2" rx="1" fill="#16181e" />
    <path d="M12 2.4v7" stroke="#16181e" stroke-opacity=".35" stroke-width=".8" />
  </svg>
</template>
