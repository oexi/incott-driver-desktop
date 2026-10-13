<script setup>
import { computed } from 'vue';
import { MousePointerClick, Gauge, SlidersHorizontal, Workflow, Unplug, Usb, Radio, BatteryCharging, Zap } from 'lucide-vue-next';
import { state, curProfile, disconnect, isMock } from '../store.js';
import { t } from '../i18n.js';
import { productImage, displayName } from '../assets.js';
import BatteryIcon from './BatteryIcon.vue';

const nav = computed(() => [
  { id: 'buttons', label: t.value.navButtons, icon: MousePointerClick },
  { id: 'performance', label: t.value.navPerformance, icon: Gauge },
  { id: 'advanced', label: t.value.navAdvanced, icon: SlidersHorizontal },
  { id: 'macros', label: t.value.navMacros, icon: Workflow },
]);

const curDpi = computed(() => {
  const pf = curProfile.value;
  if (!pf) return '—';
  return pf.dpi[pf.curDpi] ?? '—';
});
const rate = computed(() => state.info.rate || curProfile.value?.usbrate || 0);
const rateLabel = computed(() => (rate.value >= 1000 ? `${rate.value / 1000}K` : rate.value));
const dpiColor = computed(() => {
  const pf = curProfile.value;
  if (!pf) return 'var(--accent)';
  const c = pf.dpicolor[pf.curDpi];
  if (c == null) return 'var(--accent)';
  return `rgb(${c & 255}, ${(c >> 8) & 255}, ${(c >> 16) & 255})`;
});
</script>

<template>
  <aside class="sidebar">
    <div class="device">
      <div class="glow"></div>
      <img class="product" :src="productImage" alt="" />
      <div class="dev-name">{{ displayName(state.info.devname) }}</div>
      <div class="badges">
        <span class="badge">
          <Radio v-if="state.info.wireless" :size="12" />
          <Usb v-else :size="12" />
          {{ state.info.wireless ? t.wireless : t.wired }}
        </span>
        <span v-if="state.info.is8K" class="badge accent"><Zap :size="12" />8K</span>
        <span v-if="isMock" class="badge">MOCK</span>
      </div>

      <div class="battery">
        <template v-if="state.info.power >= 0">
          <BatteryIcon :level="state.info.power" :charging="state.info.charging" />
          <span class="pct num">{{ state.info.power }}%</span>
          <span v-if="state.info.charging" class="muted chg"><BatteryCharging :size="13" /> {{ t.charging }}</span>
        </template>
        <span v-else class="muted sync"><span class="dot-pulse"></span>{{ t.batteryUnknown }}</span>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="v num"><i class="dpi-dot" :style="{ background: dpiColor }"></i>{{ curDpi }}</div>
          <div class="k">DPI</div>
        </div>
        <div class="stat">
          <div class="v num">{{ rateLabel }}</div>
          <div class="k">Hz</div>
        </div>
        <div class="stat">
          <div class="v num">{{ state.curIndex + 1 }}</div>
          <div class="k">{{ t.profile }}</div>
        </div>
      </div>
    </div>

    <nav class="nav">
      <button v-for="n in nav" :key="n.id" class="nav-item" :class="{ on: state.page === n.id }" @click="state.page = n.id">
        <component :is="n.icon" :size="18" />
        <span>{{ n.label }}</span>
      </button>
    </nav>

    <div class="foot">
      <button class="btn ghost sm" @click="disconnect()"><Unplug :size="14" />{{ t.disconnect }}</button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 248px;
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 6px 14px 14px;
  gap: 14px;
}
.device {
  position: relative;
  border-radius: var(--r-xl);
  background: linear-gradient(180deg, var(--surface-2), var(--surface));
  border: 1px solid var(--line);
  padding: 18px 16px 14px;
  text-align: center;
  overflow: hidden;
}
.glow {
  position: absolute;
  left: 50%;
  top: 70px;
  width: 200px;
  height: 140px;
  transform: translateX(-50%);
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 35%, transparent), transparent);
  filter: blur(8px);
  pointer-events: none;
}
.product {
  position: relative;
  height: 128px;
  object-fit: contain;
  filter: drop-shadow(0 14px 18px rgba(0, 0, 0, 0.35));
  animation: float 6s ease-in-out infinite;
}
@keyframes float {
  50% {
    transform: translateY(-4px);
  }
}
.dev-name {
  position: relative;
  margin-top: 10px;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.badges {
  display: flex;
  gap: 6px;
  justify-content: center;
  margin-top: 8px;
  flex-wrap: wrap;
}
.battery {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
  height: 22px;
  font-size: 12.5px;
}
.pct {
  font-weight: 700;
}
.chg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.sync {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dot-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.25;
    transform: scale(0.7);
  }
}
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.stat .v {
  font-weight: 700;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.stat .k {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 1px;
}
.dpi-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 8px currentColor;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 42px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-2);
  font-weight: 600;
  font-size: 14px;
  position: relative;
  transition: background var(--t-fast), color var(--t-fast);
}
.nav-item:hover {
  background: var(--surface);
  color: var(--text);
}
.nav-item.on {
  background: var(--surface);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--line);
}
.nav-item.on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 11px;
  bottom: 11px;
  width: 3px;
  border-radius: 3px;
  background: var(--accent);
}
.nav-item.on svg {
  color: var(--accent);
}
.foot {
  margin-top: auto;
  display: flex;
  justify-content: center;
}
</style>
