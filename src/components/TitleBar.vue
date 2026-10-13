<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { Minus, Square, Copy, X, Settings } from 'lucide-vue-next';
import { state } from '../store.js';
import { t } from '../i18n.js';
import AppLogo from './AppLogo.vue';

const d = window.desktop;
const isMac = d?.platform === 'darwin';
const showControls = !!d && !isMac;
const maximized = ref(false);
let off;

onMounted(async () => {
  if (!d) return;
  maximized.value = await d.win.isMaximized();
  off = d.win.onState((s) => (maximized.value = s.maximized));
});
onBeforeUnmount(() => off && off());
</script>

<template>
  <header class="titlebar" :class="{ mac: isMac }" @dblclick.self="d?.win.toggleMaximize()">
    <div class="brand">
      <AppLogo :size="20" />
      <span class="word">INCOTT</span>
      <span class="sub">Driver</span>
    </div>
    <div class="drag" @dblclick="d?.win.toggleMaximize()"></div>
    <div class="actions">
      <button class="tb-btn" :title="t.navSettings" @click="state.settingsOpen = true"><Settings :size="16" /></button>
      <template v-if="showControls">
        <span class="sep"></span>
        <button class="tb-btn" @click="d.win.minimize()"><Minus :size="16" /></button>
        <button class="tb-btn" @click="d.win.toggleMaximize()">
          <Copy v-if="maximized" :size="13" style="transform: scaleX(-1)" />
          <Square v-else :size="13" />
        </button>
        <button class="tb-btn close" @click="d.win.close()"><X :size="17" /></button>
      </template>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  padding-left: 16px;
  -webkit-app-region: drag;
  position: relative;
  z-index: 5;
}
.titlebar.mac {
  padding-left: 86px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.word {
  font-weight: 700;
  letter-spacing: 0.18em;
  font-size: 12.5px;
}
.sub {
  font-size: 12px;
  color: var(--text-3);
  letter-spacing: 0.04em;
}
.drag {
  flex: 1;
  height: 100%;
}
.actions {
  display: flex;
  align-items: center;
  height: 100%;
  -webkit-app-region: no-drag;
}
.sep {
  width: 1px;
  height: 16px;
  background: var(--line-2);
  margin: 0 6px;
}
.tb-btn {
  width: 46px;
  height: 100%;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--text-2);
  transition: background var(--t-fast), color var(--t-fast);
}
.tb-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.tb-btn.close:hover {
  background: #e81123;
  color: #fff;
}
.mac .actions {
  padding-right: 8px;
}
.mac .tb-btn {
  width: 36px;
  height: 32px;
  border-radius: 8px;
}
</style>
