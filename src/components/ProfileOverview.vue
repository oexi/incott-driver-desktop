<script setup>
// 板载配置一览：并排显示 4 个配置各自保存的内容；可以把其它配置整个复制到当前配置
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { TableProperties, X, Copy } from 'lucide-vue-next';
import * as C from '../protocol/constants.js';
import { state, copyProfile, hiFpsSupported } from '../store.js';
import { t } from '../i18n.js';
import { keyLabel } from '../functions.js';

const open = ref(false);
const root = ref(null);

function onDocDown(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false;
}
function onKey(e) {
  if (e.key === 'Escape') open.value = false;
}
watch(open, (v) => {
  const fn = v ? 'addEventListener' : 'removeEventListener';
  document[fn]('pointerdown', onDocDown, true);
  document[fn]('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true);
  document.removeEventListener('keydown', onKey);
});

function copyFrom(p) {
  open.value = false;
  copyProfile(p);
}

const writable = (r) => (!state.info.is8K && C.RATE_8K_ONLY.includes(r) ? 1000 : r);
const onOff = (v) => (v ? t.value.on : t.value.off);
const dpiText = (pf, i) => (pf.dpiy[i] != null && pf.dpiy[i] !== pf.dpi[i] ? `${pf.dpi[i]}/${pf.dpiy[i]}` : String(pf.dpi[i]));
function fmtSleep(sec) {
  return sec < 60 ? `${sec} ${t.value.seconds}` : `${sec / 60} ${t.value.minutes}`;
}
function lodText(pf) {
  // 与 lodToHw 一致：PAW3395 没有 0.7 mm，按 1 mm 写入
  const opts = C.lodOptions(state.info.sensor);
  return (opts.find((x) => x.value === pf.lod) || opts.find((x) => x.value === 1))?.label ?? String(pf.lod);
}

/** 每行：label + 每个配置的 { text, sub?, chips?, lines? }；key 用于判断各配置是否不同 */
const rows = computed(() => {
  const T = t.value;
  const list = state.profiles.list.slice(0, C.MAX_ONBOARD);
  const row = (label, cell) => {
    const cells = list.map((pf) => cell(pf));
    const keys = cells.map((c) => c.key ?? c.text);
    return { label, cells, diff: new Set(keys).size > 1 };
  };
  const out = [
    row(T.ovRate, (pf) => {
      const eff = writable(pf.usbrate);
      return { text: `${pf.usbrate} Hz`, sub: eff !== pf.usbrate ? T.ovRateClamped : null, warn: eff !== pf.usbrate, key: pf.usbrate };
    }),
    row(T.ovCurDpi, (pf) => {
      const i = Math.min(pf.curDpi, pf.dpi.length - 1);
      return { text: dpiText(pf, i), sub: T.ovStage(i + 1) };
    }),
    row(T.ovDpiStages, (pf) => {
      const cur = Math.min(pf.curDpi, pf.dpi.length - 1);
      const chips = pf.dpi.map((_, i) => ({ text: dpiText(pf, i), on: i === cur, color: C.colorToCss(pf.dpicolor[i] ?? 0) }));
      return { chips, key: chips.map((c) => c.text).join(',') };
    }),
    row(T.ovLod, (pf) => ({ text: lodText(pf) })),
    row(T.ovSensorMode, (pf) => {
      const locked = writable(pf.usbrate) >= 2000;
      return locked ? { text: T.sensorMode[2], sub: T.ovSensorLocked } : { text: T.sensorMode[pf.sensormode] ?? String(pf.sensormode) };
    }),
    // 「高帧率」只有支持的鼠标才列出（1.4.x 固件的 PAW3950）
    ...(hiFpsSupported.value ? [row(T.hiFps, (pf) => ({ text: onOff(pf.hifps) }))] : []),
    row(T.ovMotion, (pf) => ({ text: onOff(pf.motion) })),
    row(T.ovAngle, (pf) => ({ text: onOff(pf.fixline) })),
    row(T.ovRipple, (pf) => ({ text: onOff(pf.ripple) })),
    row(T.ovDebounce, (pf) => ({ text: `${pf.debounce} ms` })),
    row(T.ovSleep, (pf) => ({ text: fmtSleep(pf.sleeptime) })),
  ];
  if (state.info.is8K) out.push(row(T.ovReceiverLed, (pf) => ({ text: T.receiverLed[pf.receiverLED] ?? String(pf.receiverLED) })));
  out.push(
    row(T.ovKeys, (pf) => {
      const lines = pf.key
        .map((k, i) => (k.equals(C.dvar.key[i]) ? null : `${T.btnName[i]} → ${keyLabel(k, T, state.macros) || '?'}`))
        .filter(Boolean);
      return lines.length ? { lines, key: lines.join('|') } : { text: T.ovKeysDefault, muted: true };
    })
  );
  return out;
});
</script>

<template>
  <div ref="root" class="ov-root">
    <button class="btn icon" :class="{ active: open }" :title="t.ovOpen" @click="open = !open"><TableProperties :size="16" /></button>
    <Transition name="fade">
      <div v-if="open" class="ov-pop">
        <div class="ov-head">
          <div class="ov-title"><TableProperties :size="16" />{{ t.ovTitle }}</div>
          <span class="muted small"><i class="dot"></i>{{ t.ovDiffHint }}</span>
          <div class="spacer"></div>
          <button class="btn ghost sm icon" :title="t.close" @click="open = false"><X :size="15" /></button>
        </div>
        <div class="ov-scroll">
          <table class="ov-table">
            <thead>
              <tr>
                <th></th>
                <th v-for="(pf, p) in state.profiles.list.slice(0, 4)" :key="p" :class="{ cur: p === state.curIndex }">
                  {{ t.profileN(p + 1) }}
                  <span v-if="p === state.curIndex" class="badge accent">{{ t.ovCurrent }}</span>
                  <button v-else class="copy" :disabled="state.pending > 0" :title="t.ovCopyTip(state.curIndex + 1)" @click="copyFrom(p)">
                    <Copy :size="12" />{{ t.ovCopy }}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.label" :class="{ diff: r.diff }">
                <th>
                  <i v-if="r.diff" class="dot"></i>{{ r.label }}
                </th>
                <td v-for="(c, p) in r.cells" :key="p" :class="{ cur: p === state.curIndex }">
                  <div v-if="c.chips" class="chips">
                    <span v-for="(ch, i) in c.chips" :key="i" class="chip num" :class="{ on: ch.on }"><i :style="{ background: ch.color }"></i>{{ ch.text }}</span>
                  </div>
                  <div v-else-if="c.lines" class="lines">
                    <div v-for="l in c.lines" :key="l">{{ l }}</div>
                  </div>
                  <template v-else>
                    <div class="val num" :class="{ muted: c.muted }">{{ c.text }}</div>
                    <div v-if="c.sub" class="sub" :class="{ warn: c.warn }">{{ c.sub }}</div>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ov-root {
  position: relative;
}
.btn.active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}
.ov-pop {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 60;
  width: min(820px, calc(100vw - 320px));
  max-height: calc(100vh - 170px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
  padding: 14px 16px 12px;
}
.ov-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.ov-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 14px;
}
.ov-title svg {
  color: var(--accent);
}
.small {
  font-size: 12px;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin-right: 6px;
  vertical-align: middle;
}
.ov-scroll {
  overflow: auto;
  min-height: 0;
}
.ov-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  font-size: 12.5px;
}
.ov-table th,
.ov-table td {
  padding: 7px 10px;
  text-align: left;
  vertical-align: top;
  border-top: 1px solid var(--line);
}
.ov-table thead th {
  border-top: 0;
  font-weight: 700;
  font-size: 12.5px;
  white-space: nowrap;
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
}
.ov-table thead th .badge {
  height: 18px;
  margin-left: 4px;
  font-size: 10.5px;
}
.ov-table tbody th {
  width: 118px;
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}
.ov-table thead th:first-child {
  width: 118px;
}
.ov-table tbody tr.diff th {
  color: var(--text);
}
.ov-table td {
  color: var(--text-2);
}
.ov-table tr.diff td {
  color: var(--text);
  font-weight: 600;
}
.ov-table .cur {
  background: var(--accent-soft);
}
.ov-table thead th.cur {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface));
  border-radius: var(--r-sm) var(--r-sm) 0 0;
}
.copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  margin-left: 4px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
.copy:hover {
  background: var(--surface-3);
  color: var(--text);
}
.copy:disabled {
  opacity: 0.45;
  pointer-events: none;
}
.sub {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
  margin-top: 1px;
}
.sub.warn {
  color: var(--warn);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--surface-3);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}
.chip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.chip.on {
  background: var(--accent);
  color: var(--accent-ink);
}
.lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
