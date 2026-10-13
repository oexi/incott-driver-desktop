<script setup>
import { computed } from 'vue';
import { state } from '../store.js';
import { t } from '../i18n.js';

const R = 34;
const C = 2 * Math.PI * R;
const dash = computed(() => C * (1 - state.progress.pct / 100));
</script>

<template>
  <Transition name="fade">
    <div v-if="state.progress.visible" class="overlay">
      <div class="box">
        <svg width="88" height="88" viewBox="0 0 88 88">
          <circle cx="44" cy="44" :r="R" fill="none" stroke="var(--surface-3)" stroke-width="6" />
          <circle
            cx="44"
            cy="44"
            :r="R"
            fill="none"
            stroke="var(--accent)"
            stroke-width="6"
            stroke-linecap="round"
            :stroke-dasharray="C"
            :stroke-dashoffset="dash"
            transform="rotate(-90 44 44)"
            style="transition: stroke-dashoffset 0.3s ease"
          />
          <text x="44" y="49" text-anchor="middle" fill="var(--text)" font-size="16" font-weight="700">{{ Math.round(state.progress.pct) }}%</text>
        </svg>
        <div class="msg">{{ t.writingDevice }}</div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  z-index: 70;
}
.box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 36px;
  border-radius: var(--r-xl);
  background: var(--surface);
  border: 1px solid var(--line-2);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
}
.msg {
  color: var(--text-2);
  font-weight: 600;
}
</style>
