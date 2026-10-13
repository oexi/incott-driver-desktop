<script setup>
import { ref, computed, watch } from 'vue';
import { Sparkles, Timer, Moon, Lightbulb, RotateCcw, TriangleAlert, Waves, Ruler, Orbit } from 'lucide-vue-next';
import * as C from '../protocol/constants.js';
import { state, curProfile, setMotion, setFixline, setRipple, setDebounce, setSleepTime, setReceiverLED, factoryReset } from '../store.js';
import { t } from '../i18n.js';
import RangeScale from '../components/RangeScale.vue';

const pf = curProfile;

const algos = computed(() => [
  { key: 'motion', icon: Orbit, name: t.value.motionSync, desc: t.value.motionSyncDesc, on: pf.value?.motion, set: setMotion },
  { key: 'fixline', icon: Ruler, name: t.value.angleSnap, desc: t.value.angleSnapDesc, on: pf.value?.fixline, set: setFixline },
  { key: 'ripple', icon: Waves, name: t.value.ripple, desc: t.value.rippleDesc, on: pf.value?.ripple, set: setRipple },
]);

/* 消抖 */
const deb = ref(pf.value?.debounce ?? 8);
watch(
  () => pf.value?.debounce,
  (v) => v != null && (deb.value = v)
);
const debTicks = [0, 8, 15, 30].map((v) => ({ value: v, label: v === 30 ? '30 ms' : String(v) }));
const debPct = computed(() => `${(deb.value / C.DEBOUNCE_MAX) * 100}%`);

/* 休眠 */
function sleepIndex(sec) {
  const i = C.DORMANCY_TIME.indexOf(sec);
  return i < 0 ? 3 : i;
}
const slp = ref(sleepIndex(pf.value?.sleeptime ?? 60));
watch(
  () => pf.value?.sleeptime,
  (v) => v != null && (slp.value = sleepIndex(v))
);
const slpPct = computed(() => `${(slp.value / (C.DORMANCY_TIME.length - 1)) * 100}%`);
// 休眠滑条按档位序号移动，刻度放在对应档位上
const slpTicks = [
  [10, '10s'],
  [60, '1 min'],
  [300, '5 min'],
  [900, '15 min'],
].map(([sec, label]) => ({ value: C.DORMANCY_TIME.indexOf(sec), label }));
function fmtSleep(sec) {
  if (sec < 60) return `${sec} ${t.value.seconds}`;
  return `${sec / 60} ${t.value.minutes}`;
}

const ledColors = [
  ['#ff3b30', '#3b82f6', '#ffd60a', '#ff9500', '#a855f7', '#34c759', '#ffffff'],
  ['#34c759', '#ffd60a', '#ff9500', '#ff3b30'],
  ['#3a3a3c', '#ff3b30'],
];
</script>

<template>
  <div v-if="pf" class="adv">
    <section class="card">
      <div class="card-head">
        <div class="card-title"><Sparkles :size="17" />{{ t.sensorAlgo }}</div>
      </div>
      <div class="algos">
        <div v-for="a in algos" :key="a.key" class="algo" :class="{ on: a.on }" @click="a.set(!a.on)">
          <div class="algo-top">
            <span class="ic"><component :is="a.icon" :size="18" /></span>
            <div class="switch" :class="{ on: a.on }"></div>
          </div>
          <div class="an">{{ a.name }}</div>
          <div class="ad">{{ a.desc }}</div>
        </div>
      </div>
    </section>

    <div class="grid2">
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Timer :size="17" />{{ t.debounceTitle }}</div>
            <div class="card-desc">{{ t.debounceDesc }}</div>
          </div>
          <div class="big num">{{ deb }}<small>ms</small></div>
        </div>
        <input
          v-model.number="deb"
          class="range"
          type="range"
          :min="C.DEBOUNCE_MIN"
          :max="C.DEBOUNCE_MAX"
          step="1"
          :style="{ '--pct': debPct }"
          @change="setDebounce(deb)"
        />
        <RangeScale :min="C.DEBOUNCE_MIN" :max="C.DEBOUNCE_MAX" :ticks="debTicks" />
        <div v-if="deb < 4" class="warn"><TriangleAlert :size="14" />{{ t.debounceWarn }}</div>
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Moon :size="17" />{{ t.sleepTitle }}</div>
            <div class="card-desc">{{ t.sleepDesc }}</div>
          </div>
          <div class="big num">{{ fmtSleep(C.DORMANCY_TIME[slp]) }}</div>
        </div>
        <input
          v-model.number="slp"
          class="range"
          type="range"
          min="0"
          :max="C.DORMANCY_TIME.length - 1"
          step="1"
          :style="{ '--pct': slpPct }"
          @change="setSleepTime(C.DORMANCY_TIME[slp])"
        />
        <RangeScale :min="0" :max="C.DORMANCY_TIME.length - 1" :ticks="slpTicks" />
      </section>
    </div>

    <section v-if="state.info.is8K" class="card">
      <div class="card-head">
        <div class="card-title"><Lightbulb :size="17" />{{ t.receiverLedTitle }}</div>
      </div>
      <div class="leds">
        <button v-for="(name, i) in t.receiverLed" :key="i" class="led" :class="{ on: pf.receiverLED === i }" @click="setReceiverLED(i)">
          <span class="dots"><i v-for="c in ledColors[i]" :key="c" :style="{ background: c }"></i></span>
          <span class="ln">{{ name }}</span>
          <span class="ld">{{ t.receiverLedDesc[i] }}</span>
        </button>
      </div>
    </section>

    <section class="card danger-zone">
      <div class="setting-row">
        <RotateCcw :size="18" class="dz-ic" />
        <div class="txt">
          <div class="name">{{ t.factoryReset }}</div>
          <div class="desc">{{ t.factoryResetDesc }}</div>
        </div>
        <button class="btn danger" @click="factoryReset()">{{ t.factoryResetOk }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.adv {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.algos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.algo {
  border-radius: var(--r-lg);
  border: 1px solid var(--line);
  background: var(--surface-2);
  padding: 16px;
  cursor: pointer;
  transition: all var(--t-fast);
}
.algo:hover {
  background: var(--surface-3);
}
.algo.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.algo-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.ic {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--surface-3);
  color: var(--text-2);
}
.algo.on .ic {
  background: var(--accent);
  color: var(--accent-ink);
}
.an {
  font-weight: 700;
}
.ad {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 4px;
  line-height: 1.55;
}
.big {
  font-size: 26px;
  font-weight: 700;
  white-space: nowrap;
}
.big small {
  font-size: 13px;
  color: var(--text-3);
  margin-left: 3px;
  font-weight: 600;
}
.warn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--warn);
}
.leds {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.led {
  text-align: left;
  border-radius: var(--r-lg);
  border: 1px solid var(--line);
  background: var(--surface-2);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text);
  transition: all var(--t-fast);
}
.led:hover {
  background: var(--surface-3);
}
.led.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.dots {
  display: flex;
  gap: 5px;
  margin-bottom: 6px;
}
.dots i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: 0 0 6px currentColor, inset 0 0 0 1px rgba(0, 0, 0, 0.15);
}
.ln {
  font-weight: 700;
}
.ld {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.55;
}
.danger-zone {
  border-color: color-mix(in srgb, var(--danger) 22%, var(--line));
  padding: 14px 22px;
}
.dz-ic {
  color: var(--danger);
}
@media (max-width: 1180px) {
  .algos,
  .leds {
    grid-template-columns: 1fr;
  }
}
</style>
