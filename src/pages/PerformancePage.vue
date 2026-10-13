<script setup>
import { ref, computed, watch } from 'vue';
import { Crosshair, Plus, Minus, Activity, Cpu, ArrowUpFromLine, Leaf, Scale, Rocket, Lock } from 'lucide-vue-next';
import * as C from '../protocol/constants.js';
import {
  state,
  curProfile,
  sensorCfg,
  selectDpi,
  setDpiValue,
  addDpiLevel,
  removeDpiLevel,
  setRate,
  setSensorMode,
  setLod,
} from '../store.js';
import { t } from '../i18n.js';

const pf = curProfile;
const st = sensorCfg;
const editIx = ref(pf.value ? pf.value.curDpi : 0);
watch(
  () => pf.value?.curDpi,
  (v) => {
    if (v != null) editIx.value = v;
  }
);
watch(
  () => pf.value?.dpi.length,
  (n) => {
    if (n != null && editIx.value >= n) editIx.value = n - 1;
  }
);

const stages = computed(() =>
  (pf.value?.dpi || []).map((x, i) => ({
    i,
    x,
    y: pf.value.dpiy[i],
    color: C.colorToCss(pf.value.dpicolor[i] ?? st.value.dpicolor[i] ?? 0xffffff),
    ink: inkFor(pf.value.dpicolor[i] ?? st.value.dpicolor[i] ?? 0xffffff),
    active: pf.value.curDpi === i,
  }))
);

// 编辑中的值（拖动时只改本地，松手才写入）
const dx = ref(0);
const dy = ref(0);
function syncEdit() {
  if (!pf.value) return;
  dx.value = pf.value.dpi[editIx.value] ?? 800;
  dy.value = pf.value.dpiy[editIx.value] ?? dx.value;
  if (dx.value !== dy.value) state.xySplit = true;
}
watch([editIx, () => pf.value && pf.value.dpi.join(','), () => pf.value && pf.value.dpiy.join(',')], syncEdit, { immediate: true });

// DPI 颜色是 0xBBGGRR；根据亮度选择徽标文字颜色
function inkFor(c) {
  const r = c & 255,
    g = (c >> 8) & 255,
    b = (c >> 16) & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
}
function pct(v) {
  return `${((v - st.value.min) / (st.value.max - st.value.min)) * 100}%`;
}
function onStageClick(i) {
  editIx.value = i;
  if (pf.value.curDpi !== i) selectDpi(i);
}
function commit() {
  const x = C.closestDpi(state.info.sensor, Number(dx.value) || st.value.min);
  const y = state.xySplit ? C.closestDpi(state.info.sensor, Number(dy.value) || st.value.min) : x;
  dx.value = x;
  dy.value = y;
  setDpiValue(editIx.value, x, y);
}
function toggleXY() {
  state.xySplit = !state.xySplit;
  if (!state.xySplit && dx.value !== dy.value) {
    dy.value = dx.value;
    commit();
  }
}
function nudge(axis, delta) {
  const r = axis === 'x' ? dx : dy;
  r.value = Math.max(st.value.min, Math.min(st.value.max, (Number(r.value) || 0) + delta));
  commit();
}
const presets = [400, 800, 1200, 1600, 3200, 6400];
function preset(v) {
  dx.value = v;
  if (!state.xySplit) dy.value = v;
  commit();
}

/* 回报率 */
const rates = computed(() => C.RATE_UI.filter((r) => state.info.is8K || !C.RATE_8K_ONLY.includes(r)));
const highRate = computed(() => (pf.value?.usbrate || 0) >= 2000);

/* 传感器模式 */
const modeIcons = [Leaf, Scale, Rocket];

/* LOD */
const lods = computed(() => C.lodOptions(state.info.sensor));

function fmtRate(r) {
  return r >= 1000 ? `${r / 1000}K` : String(r);
}
</script>

<template>
  <div v-if="pf" class="perf">
    <!-- DPI -->
    <section class="card dpi-card">
      <div class="card-head">
        <div>
          <div class="card-title"><Crosshair :size="17" />{{ t.dpiTitle }}</div>
          <div class="card-desc">{{ t.dpiDesc }}</div>
        </div>
        <div class="row levels">
          <span class="label">{{ t.dpiLevels }}</span>
          <button class="btn sm icon" :title="t.dpiRemove" :disabled="pf.dpi.length <= 1" @click="removeDpiLevel"><Minus :size="14" /></button>
          <span class="lv num">{{ pf.dpi.length }}</span>
          <button class="btn sm icon" :title="t.dpiAdd" :disabled="pf.dpi.length >= st.dpi.length" @click="addDpiLevel"><Plus :size="14" /></button>
        </div>
      </div>

      <div class="stages" :style="{ '--n': stages.length }">
        <button
          v-for="s in stages"
          :key="s.i"
          class="stage"
          :class="{ editing: editIx === s.i, active: s.active }"
          :style="{ '--c': s.color, '--ink': s.ink }"
          @click="onStageClick(s.i)"
        >
          <span class="bar"></span>
          <span class="st-top">
            <span class="st-n">{{ s.i + 1 }}</span>
            <span v-if="s.active" class="badge accent">{{ t.dpiCurrent }}</span>
          </span>
          <span class="st-v num">{{ s.x }}</span>
          <span v-if="s.x !== s.y" class="st-y num">Y {{ s.y }}</span>
          <span class="st-meter"><i :style="{ width: pct(s.x) }"></i></span>
        </button>
      </div>

      <div class="editor">
        <div class="ed-head">
          <span class="label">{{ t.dpiEditing }} {{ editIx + 1 }}</span>
          <div class="spacer"></div>
          <span class="label">{{ t.dpiXY }}</span>
          <div class="switch" :class="{ on: state.xySplit }" @click="toggleXY"></div>
        </div>

        <div class="axis">
          <span class="ax">{{ state.xySplit ? t.dpiX : 'DPI' }}</span>
          <button class="btn sm icon" @click="nudge('x', -50)"><Minus :size="13" /></button>
          <input
            v-model.number="dx"
            class="range"
            type="range"
            :min="st.min"
            :max="st.max"
            step="50"
            :style="{ '--pct': pct(dx) }"
            @input="!state.xySplit && (dy = dx)"
            @change="commit"
          />
          <button class="btn sm icon" @click="nudge('x', 50)"><Plus :size="13" /></button>
          <input v-model.number="dx" class="input num" type="number" :min="st.min" :max="st.max" step="50" @change="commit" @keydown.enter="$event.target.blur()" />
        </div>
        <div v-if="state.xySplit" class="axis">
          <span class="ax">{{ t.dpiY }}</span>
          <button class="btn sm icon" @click="nudge('y', -50)"><Minus :size="13" /></button>
          <input v-model.number="dy" class="range" type="range" :min="st.min" :max="st.max" step="50" :style="{ '--pct': pct(dy) }" @change="commit" />
          <button class="btn sm icon" @click="nudge('y', 50)"><Plus :size="13" /></button>
          <input v-model.number="dy" class="input num" type="number" :min="st.min" :max="st.max" step="50" @change="commit" @keydown.enter="$event.target.blur()" />
        </div>
        <div class="presets">
          <button v-for="p in presets" :key="p" class="chip" :class="{ on: dx === p && (!state.xySplit || dy === p) }" @click="preset(p)">{{ p }}</button>
          <span class="spacer"></span>
          <span class="muted range-hint num">{{ st.min }} – {{ st.max }} · step 50</span>
        </div>
      </div>
    </section>

    <div class="grid2">
      <!-- 回报率 -->
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Activity :size="17" />{{ t.rateTitle }}</div>
            <div class="card-desc">{{ t.rateDesc }}</div>
          </div>
        </div>
        <div class="rates">
          <button v-for="r in rates" :key="r" class="rate" :class="{ on: pf.usbrate === r, hot: r >= 4000 }" @click="setRate(r)">
            <span class="rv num">{{ fmtRate(r) }}</span>
            <span class="ru">Hz</span>
          </button>
        </div>
        <div v-if="!state.info.is8K" class="note muted">{{ t.rate8kOnly }}</div>
      </section>

      <!-- LOD -->
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><ArrowUpFromLine :size="17" />{{ t.lodTitle }}</div>
            <div class="card-desc">{{ t.lodDesc }}</div>
          </div>
        </div>
        <div class="seg block lod">
          <button v-for="o in lods" :key="o.value" :class="{ on: pf.lod === o.value }" @click="setLod(o.value)">{{ o.label }}</button>
        </div>
      </section>
    </div>

    <!-- 传感器模式 -->
    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title"><Cpu :size="17" />{{ t.sensorModeTitle }}</div>
          <div v-if="highRate" class="card-desc"><Lock :size="12" /> {{ t.sensorModeHighRate }}</div>
        </div>
      </div>
      <div class="modes">
        <button
          v-for="(name, m) in t.sensorMode"
          :key="m"
          class="mode"
          :class="{ on: highRate ? m === 2 : pf.sensormode === m, locked: highRate && m !== 2 }"
          :disabled="highRate"
          @click="setSensorMode(m)"
        >
          <component :is="modeIcons[m]" :size="20" class="mi" />
          <span class="mn">{{ name }}</span>
          <span class="md">{{ t.sensorModeDesc[m] }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 18px;
}
.levels .lv {
  min-width: 20px;
  text-align: center;
  font-weight: 700;
  font-size: 15px;
}
.stages {
  display: grid;
  grid-template-columns: repeat(var(--n), minmax(0, 1fr));
  gap: 10px;
}
.stage {
  position: relative;
  text-align: left;
  border-radius: var(--r-lg);
  border: 1px solid var(--line);
  background: var(--surface-2);
  padding: 14px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
  color: var(--text);
  transition: all var(--t-fast);
}
.stage:hover {
  background: var(--surface-3);
  transform: translateY(-2px);
}
.stage .bar {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  background: var(--c);
  opacity: 0.85;
}
.stage.editing {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.stage.active {
  background: linear-gradient(180deg, color-mix(in srgb, var(--c) 12%, var(--surface-2)), var(--surface-2));
}
.st-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
}
.st-n {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11.5px;
  font-weight: 700;
  background: var(--c);
  color: var(--ink);
  box-shadow: 0 0 10px color-mix(in srgb, var(--c) 45%, transparent);
}
.st-v {
  font-size: 24px;
  font-weight: 700;
  margin-top: 6px;
  letter-spacing: 0.01em;
}
.st-y {
  font-size: 12px;
  color: var(--text-3);
  margin-top: -2px;
}
.st-meter {
  height: 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  margin-top: 8px;
  overflow: hidden;
}
.st-meter i {
  display: block;
  height: 100%;
  background: var(--c);
  border-radius: 4px;
}
.editor {
  margin-top: 16px;
  padding: 16px 18px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ed-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.axis {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ax {
  width: 46px;
  font-weight: 700;
  font-size: 12.5px;
  color: var(--text-2);
}
.axis .range {
  flex: 1;
}
.presets {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.chip {
  height: 28px;
  padding: 0 12px;
  border-radius: 99px;
  border: 1px solid var(--line-2);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  transition: all var(--t-fast);
}
.chip:hover {
  color: var(--text);
}
.chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.range-hint {
  font-size: 11.5px;
}
.rates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(64px, 1fr));
  gap: 8px;
}
.rate {
  height: 64px;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text);
  transition: all var(--t-fast);
}
.rate:hover {
  background: var(--surface-3);
}
.rate .rv {
  font-size: 18px;
  font-weight: 700;
}
.rate .ru {
  font-size: 11px;
  color: var(--text-3);
}
.rate.on {
  background: linear-gradient(180deg, var(--accent-2), var(--accent));
  border-color: transparent;
  color: var(--accent-ink);
  box-shadow: 0 8px 20px -10px var(--accent);
}
.rate.on .ru {
  color: color-mix(in srgb, var(--accent-ink) 70%, transparent);
}
.note {
  margin-top: 12px;
  font-size: 12px;
}
.lod button {
  height: 40px;
  font-size: 14px;
}
.modes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.mode {
  text-align: left;
  border-radius: var(--r-lg);
  border: 1px solid var(--line);
  background: var(--surface-2);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text);
  transition: all var(--t-fast);
}
.mode:hover:not(:disabled) {
  background: var(--surface-3);
}
.mode .mi {
  color: var(--text-3);
  margin-bottom: 6px;
}
.mode .mn {
  font-weight: 700;
  font-size: 14px;
}
.mode .md {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}
.mode.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.mode.on .mi {
  color: var(--accent);
}
.mode.locked {
  opacity: 0.4;
}
.mode:disabled {
  cursor: not-allowed;
}
.card-desc :deep(svg) {
  vertical-align: -1px;
}
@media (max-width: 1180px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
}
</style>
