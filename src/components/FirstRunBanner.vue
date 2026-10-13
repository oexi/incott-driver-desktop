<script setup>
import { Info, FileUp } from 'lucide-vue-next';
import { state, settings, saveSettings, importProfile } from '../store.js';
import { t } from '../i18n.js';

function dismiss() {
  settings.firstRunAck = true;
  saveSettings();
}
</script>

<template>
  <div v-if="state.firstRun && !settings.firstRunAck" class="banner">
    <Info :size="17" class="ic" />
    <span class="txt">{{ t.firstRunNotice }}</span>
    <button class="btn sm" @click="importProfile()"><FileUp :size="13" />{{ t.import }}</button>
    <button class="btn sm ghost" @click="dismiss">{{ t.gotIt }}</button>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 28px 16px;
  padding: 11px 14px;
  border-radius: var(--r-md);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  font-size: 12.5px;
}
.ic {
  color: var(--accent);
  flex: none;
}
.txt {
  flex: 1;
  color: var(--text-2);
  line-height: 1.55;
}
</style>
