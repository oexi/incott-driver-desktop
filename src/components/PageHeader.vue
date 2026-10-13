<script setup>
import { computed } from 'vue';
import { FileDown, FileUp, LoaderCircle, CircleCheck } from 'lucide-vue-next';
import { state, switchProfile, importProfile, exportProfile } from '../store.js';
import { t } from '../i18n.js';

const titles = computed(() => ({
  buttons: [t.value.buttonsTitle, t.value.buttonsSub],
  performance: [t.value.perfTitle, t.value.perfSub],
  advanced: [t.value.advTitle, t.value.advSub],
  macros: [t.value.macroTitle, t.value.macroSub],
}));
const head = computed(() => titles.value[state.page] || ['', '']);

function onProfile(i) {
  if (i === state.curIndex || state.pending) return;
  switchProfile(i);
}
</script>

<template>
  <div class="page-header">
    <div class="ttl">
      <h1>{{ head[0] }}</h1>
      <p>{{ head[1] }}</p>
    </div>
    <div class="spacer"></div>

    <div class="sync" :class="{ busy: state.pending > 0 }">
      <LoaderCircle v-if="state.pending > 0" :size="14" class="spin" />
      <CircleCheck v-else :size="14" />
      <span>{{ state.pending > 0 ? t.syncing : t.synced }}</span>
    </div>

    <div class="profiles">
      <span class="label">{{ t.onboardProfile }}</span>
      <div class="seg accent">
        <button v-for="i in 4" :key="i" :class="{ on: state.curIndex === i - 1 }" :disabled="state.pending > 0 && state.curIndex !== i - 1" @click="onProfile(i - 1)">
          {{ i }}
        </button>
      </div>
      <button class="btn icon" :title="t.importProfile" @click="importProfile()"><FileUp :size="16" /></button>
      <button class="btn icon" :title="t.exportProfile" @click="exportProfile()"><FileDown :size="16" /></button>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 28px 18px;
}
h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.ttl p {
  margin: 3px 0 0;
  color: var(--text-3);
  font-size: 12.5px;
}
.profiles {
  display: flex;
  align-items: center;
  gap: 8px;
}
.profiles .label {
  margin-right: 2px;
}
.profiles .seg button {
  width: 40px;
  padding: 0;
}
.sync {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ok);
  padding: 0 10px;
  height: 28px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--ok) 10%, transparent);
  transition: color var(--t), background var(--t);
}
.sync.busy {
  color: var(--accent);
  background: var(--accent-soft);
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
