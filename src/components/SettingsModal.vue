<script setup>
import { ref, watch } from 'vue';
import { X, Monitor, Moon, Sun, Languages, Palette, PanelTop } from 'lucide-vue-next';
import { state, settings, saveSettings, isDesktop } from '../store.js';
import { t } from '../i18n.js';
import AppLogo from './AppLogo.vue';

const info = ref(null);
watch(
  () => state.settingsOpen,
  async (open) => {
    if (open && !info.value && window.desktop) info.value = await window.desktop.info();
  }
);

const accents = [
  ['orange', '#ff7a1a'],
  ['pink', '#f03a76'],
  ['blue', '#3b82f6'],
  ['green', '#10b981'],
  ['violet', '#8b5cf6'],
];

function set(k, v) {
  settings[k] = v;
  saveSettings();
}
</script>

<template>
  <Transition name="modal">
    <div v-if="state.settingsOpen" class="overlay" @mousedown.self="state.settingsOpen = false">
      <div class="modal">
        <div class="m-head">
          <h2>{{ t.settingsTitle }}</h2>
          <button class="btn ghost icon" @click="state.settingsOpen = false"><X :size="18" /></button>
        </div>
        <div class="m-body">
          <div class="group-title">{{ t.appearance }}</div>
          <div class="setting-row">
            <Monitor :size="18" class="ic" />
            <div class="txt"><div class="name">{{ t.theme }}</div></div>
            <div class="seg">
              <button :class="{ on: settings.theme === 'system' }" @click="set('theme', 'system')"><Monitor :size="13" /> {{ t.themeSystem }}</button>
              <button :class="{ on: settings.theme === 'dark' }" @click="set('theme', 'dark')"><Moon :size="13" /> {{ t.themeDark }}</button>
              <button :class="{ on: settings.theme === 'light' }" @click="set('theme', 'light')"><Sun :size="13" /> {{ t.themeLight }}</button>
            </div>
          </div>
          <div class="setting-row">
            <Palette :size="18" class="ic" />
            <div class="txt"><div class="name">{{ t.accent }}</div></div>
            <div class="swatches">
              <button
                v-for="[k, c] in accents"
                :key="k"
                class="sw"
                :class="{ on: settings.accent === k }"
                :style="{ background: c }"
                :title="k"
                @click="set('accent', k)"
              ></button>
            </div>
          </div>
          <div class="setting-row">
            <Languages :size="18" class="ic" />
            <div class="txt"><div class="name">{{ t.language }}</div></div>
            <div class="seg">
              <button :class="{ on: settings.lang === 'zh' }" @click="set('lang', 'zh')">简体中文</button>
              <button :class="{ on: settings.lang === 'en' }" @click="set('lang', 'en')">English</button>
            </div>
          </div>

          <template v-if="isDesktop">
            <div class="group-title">{{ t.behavior }}</div>
            <div class="setting-row">
              <PanelTop :size="18" class="ic" />
              <div class="txt">
                <div class="name">{{ t.closeToTray }}</div>
                <div class="desc">{{ t.closeToTrayDesc }}</div>
              </div>
              <div class="switch" :class="{ on: settings.closeToTray }" @click="set('closeToTray', !settings.closeToTray)"></div>
            </div>
          </template>

          <div class="group-title">{{ t.about }}</div>
          <div class="about">
            <AppLogo :size="40" />
            <div>
              <div class="ab-name">INCOTT Driver <span class="muted num" v-if="info">v{{ info.version }}</span></div>
              <div class="muted ab-desc">{{ t.aboutDesc }}</div>
              <div v-if="info" class="muted ab-ver mono">{{ info.platform }}-{{ info.arch }} · Electron {{ info.electron }} · Chromium {{ info.chrome }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(6px);
  display: grid;
  place-items: center;
  z-index: 50;
}
.modal {
  width: min(620px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: var(--r-xl);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.m-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 6px 24px;
}
h2 {
  margin: 0;
  font-size: 18px;
}
.m-body {
  padding: 0 24px 22px;
  overflow-y: auto;
}
.group-title {
  font-size: 11.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
  font-weight: 700;
  margin: 18px 0 4px;
}
.ic {
  color: var(--text-3);
}
.seg button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.swatches {
  display: flex;
  gap: 8px;
}
.sw {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  outline: 2px solid transparent;
  transition: outline-color var(--t-fast), transform var(--t-fast);
}
.sw:hover {
  transform: scale(1.1);
}
.sw.on {
  outline-color: var(--text);
  border-color: var(--surface);
}
.about {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding-top: 8px;
}
.ab-name {
  font-weight: 700;
  font-size: 15px;
}
.ab-desc {
  font-size: 12.5px;
  margin-top: 4px;
  line-height: 1.6;
}
.ab-ver {
  font-size: 11px;
  margin-top: 6px;
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s var(--ease);
}
.modal-enter-active .modal,
.modal-leave-active .modal {
  transition: transform 0.25s var(--ease);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal,
.modal-leave-to .modal {
  transform: translateY(10px) scale(0.98);
}
</style>
