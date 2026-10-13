<script setup>
import { ref, computed, watch } from 'vue';
import { MousePointerClick, Music, Keyboard, Command, Flame, Workflow, RotateCcw, ArrowLeftRight, Search } from 'lucide-vue-next';
import * as C from '../protocol/constants.js';
import { vkPOS, keycodeToHid, hidToKeyname } from '../protocol/keytable.js';
import { state, curProfile, assignKey, swapLeftRight, isLRSwapped, UI_KEY_NUM } from '../store.js';
import { t, i18n } from '../i18n.js';
import { MOUSE_FUNCS, MEDIA_FUNCS, keyLabel, keyCategory, keyboardGroups } from '../functions.js';
import { mouseMapImage } from '../assets.js';

const sel = ref(0);
const tab = ref('mouse');
const pf = curProfile;

const catIcons = { mouse: MousePointerClick, media: Music, keyboard: Keyboard, combo: Command, fire: Flame, macro: Workflow };
const tabs = computed(() => [
  { id: 'mouse', label: t.value.catMouse },
  { id: 'media', label: t.value.catMedia },
  { id: 'keyboard', label: t.value.catKeyboard },
  { id: 'combo', label: t.value.catCombo },
  { id: 'fire', label: t.value.catFire },
  { id: 'macro', label: t.value.catMacro },
]);

const buttons = computed(() =>
  Array.from({ length: UI_KEY_NUM }, (_, i) => {
    const k = pf.value?.key[i];
    return { i, name: t.value.btnName[i], label: keyLabel(k, t.value, state.macros), cat: keyCategory(k) };
  })
);
const selKey = computed(() => pf.value?.key[sel.value]);

// 切换按键时，自动跳到它当前所属的分类
watch(
  sel,
  () => {
    const c = keyCategory(selKey.value);
    tab.value = c;
    loadForms();
  },
  { immediate: true }
);

function isCur(major, minor) {
  const k = selKey.value;
  return !!k && k.major === major && k.minor === minor && !(major === C.fKeyboard && k.modifer);
}

function assign(kf) {
  assignKey(sel.value, kf);
}
function assignMouse(minor) {
  assign(new C.KeyInfo(C.fMouse, minor));
}
function assignMedia(minor) {
  assign(new C.KeyInfo(C.fMedia, minor));
}
function assignKeyboard(hid) {
  assign(new C.KeyInfo(C.fKeyboard, hid));
}
function restoreDefault() {
  assign(C.dvar.key[sel.value].copy());
}

/* 键盘 */
const query = ref('');
const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  return keyboardGroups(vkPOS)
    .map((g) => ({ ...g, keys: q ? g.keys.filter(([code, name]) => name.toLowerCase().includes(q) || code.toLowerCase().includes(q)) : g.keys }))
    .filter((g) => g.keys.length);
});

/* 组合键（原版 onComboSave） */
const mods = ref({ ctrl: false, shift: false, alt: false, win: false });
const comboKey = ref(0);
const capturing = ref(false);
function onComboKeydown(e) {
  e.preventDefault();
  if (['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight'].includes(e.code)) return;
  const hid = keycodeToHid(e.code);
  if (hid) comboKey.value = hid;
}
const comboMod = computed(
  () => (mods.value.ctrl ? C.mdfCtrlL : 0) | (mods.value.shift ? C.mdfShiftL : 0) | (mods.value.alt ? C.mdfAltL : 0) | (mods.value.win ? C.mdfWinL : 0)
);
function applyCombo() {
  if (comboKey.value === 0 && comboMod.value === 0) return;
  const kf = new C.KeyInfo(C.fKeyboard, comboKey.value);
  kf.modifer = comboMod.value;
  assign(kf);
}

/* 火力键（原版 onFireSave） */
const fireInterval = ref(40);
const fireCount = ref(0);
function applyFire() {
  let iv = Math.max(0, Math.min(255, Number(fireInterval.value) || 0));
  let ct = Math.max(0, Math.min(3, Number(fireCount.value) || 0));
  const kf = new C.KeyInfo(C.fMouse, C.favFIRE);
  kf.itemdata = (iv << 16) | (ct & 65535);
  assign(kf);
}

function loadForms() {
  const k = selKey.value;
  if (!k) return;
  if (k.major === C.fKeyboard && k.modifer) {
    mods.value = { ctrl: !!(k.modifer & C.mdfCtrlL), shift: !!(k.modifer & C.mdfShiftL), alt: !!(k.modifer & C.mdfAltL), win: !!(k.modifer & C.mdfWinL) };
    comboKey.value = k.minor;
  }
  if (k.major === C.fMouse && k.minor === C.favFIRE) {
    fireInterval.value = (k.itemdata >> 16) & 65535;
    fireCount.value = k.itemdata & 65535;
  }
}

/* 宏 */
function assignMacro(m) {
  const kf = new C.KeyInfo(C.fJuji, 0);
  kf.itemdata = m.uid;
  assign(kf);
}
function isCurMacro(m) {
  const k = selKey.value;
  // eslint-disable-next-line eqeqeq
  return !!k && k.major === C.fJuji && k.itemdata == m.uid;
}

const swapped = computed(() => isLRSwapped());
</script>

<template>
  <div class="buttons-page">
    <!-- 左：按键列表 + 示意图 -->
    <section class="card map-card">
      <div class="map">
        <div class="btn-list">
          <button v-for="b in buttons" :key="b.i" class="btn-row" :class="{ on: sel === b.i }" @click="sel = b.i">
            <span class="idx">{{ b.i + 1 }}</span>
            <span class="txt">
              <span class="nm">{{ b.name }}</span>
              <span class="fn" :class="'c-' + b.cat">
                <component :is="catIcons[b.cat]" :size="12" />
                {{ b.label || '—' }}
              </span>
            </span>
          </button>
        </div>
        <div class="img-wrap">
          <img v-for="i in UI_KEY_NUM + 1" :key="i" class="mouse-img" :class="{ show: i - 2 === sel }" :src="mouseMapImage(i - 2)" alt="" />
        </div>
      </div>
      <div class="setting-row swap">
        <ArrowLeftRight :size="18" class="accent" />
        <div class="txt">
          <div class="name">{{ t.swapLR }}</div>
          <div class="desc">{{ t.swapLRDesc }}</div>
        </div>
        <div class="switch" :class="{ on: swapped }" @click="swapLeftRight()"></div>
      </div>
    </section>

    <!-- 右：功能选择 -->
    <section class="card picker">
      <div class="picker-head">
        <div>
          <div class="label">{{ t.currentFunction }} · {{ t.btnName[sel] }}</div>
          <div class="cur">
            <component :is="catIcons[keyCategory(selKey)]" :size="18" />
            {{ keyLabel(selKey, t, state.macros) || '—' }}
          </div>
        </div>
        <button class="btn sm" @click="restoreDefault"><RotateCcw :size="13" />{{ t.restoreDefault }}</button>
      </div>

      <div class="tabs">
        <button v-for="tb in tabs" :key="tb.id" class="tab" :class="{ on: tab === tb.id }" @click="tab = tb.id">
          <component :is="catIcons[tb.id]" :size="15" />{{ tb.label }}
        </button>
      </div>

      <div class="picker-body">
        <!-- 鼠标 -->
        <div v-if="tab === 'mouse'" class="tiles">
          <button v-for="[m, k] in MOUSE_FUNCS" :key="m" class="tile" :class="{ on: isCur(C.fMouse, m) }" @click="assignMouse(m)">
            {{ t.fn[k] }}
          </button>
        </div>

        <!-- 多媒体 -->
        <div v-else-if="tab === 'media'" class="tiles">
          <button v-for="[m, k] in MEDIA_FUNCS" :key="m" class="tile" :class="{ on: isCur(C.fMedia, m) }" @click="assignMedia(m)">
            {{ t.fn[k] }}
          </button>
        </div>

        <!-- 键盘 -->
        <div v-else-if="tab === 'keyboard'" class="kb">
          <div class="search">
            <Search :size="15" />
            <input v-model="query" class="input" :placeholder="t.searchKey" />
          </div>
          <div v-for="g in groups" :key="g.id" class="kgroup">
            <div class="label">{{ i18n.lang === 'zh' ? g.zh : g.en }}</div>
            <div class="keys">
              <button v-for="[code, name, hid] in g.keys" :key="code" class="key" :class="{ on: isCur(C.fKeyboard, hid) }" @click="assignKeyboard(hid)">
                {{ name }}
              </button>
            </div>
          </div>
        </div>

        <!-- 组合键 -->
        <div v-else-if="tab === 'combo'" class="form">
          <p class="muted">{{ t.comboHint }}</p>
          <div class="mods">
            <button v-for="(v, k) in mods" :key="k" class="mod" :class="{ on: v }" @click="mods[k] = !v">
              {{ { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win' }[k] }}
            </button>
            <span class="plus">+</span>
            <div class="capture" :class="{ on: capturing }" tabindex="0" @focus="capturing = true" @blur="capturing = false" @keydown="onComboKeydown">
              <span v-if="comboKey" class="kbd">{{ hidToKeyname(comboKey) }}</span>
              <span v-else class="muted">{{ capturing ? t.keyCapture : t.comboPress }}</span>
            </div>
          </div>
          <div class="preview">
            <template v-for="(v, k) in mods" :key="k"><span v-if="v" class="kbd">{{ { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win' }[k] }}</span><span v-if="v" class="muted">+</span></template>
            <span v-if="comboKey" class="kbd">{{ hidToKeyname(comboKey) }}</span>
          </div>
          <button class="btn primary" :disabled="!comboKey && !comboMod" @click="applyCombo">{{ t.comboApply }}</button>
        </div>

        <!-- 火力键 -->
        <div v-else-if="tab === 'fire'" class="form">
          <p class="muted">{{ t.fireDesc }}</p>
          <div class="fire-grid">
            <label>
              <span class="label">{{ t.fireInterval }}</span>
              <div class="row"><input v-model.number="fireInterval" type="number" min="0" max="255" class="input num" /><span class="muted">ms (0–255)</span></div>
            </label>
            <label>
              <span class="label">{{ t.fireCount }}</span>
              <div class="seg">
                <button v-for="n in [0, 1, 2, 3]" :key="n" :class="{ on: fireCount === n }" @click="fireCount = n">{{ n === 0 ? '∞' : n }}</button>
              </div>
            </label>
          </div>
          <p class="muted small">{{ t.fireCountHint }}</p>
          <button class="btn primary" @click="applyFire"><Flame :size="15" />{{ t.fireApply }}</button>
        </div>

        <!-- 宏 -->
        <div v-else-if="tab === 'macro'" class="macro-pick">
          <p class="muted">{{ t.macroPickHint }}</p>
          <div v-if="!state.macros.list.length" class="empty">
            <Workflow :size="28" />
            <div>{{ t.macroEmpty }}</div>
            <button class="btn sm" @click="state.page = 'macros'">{{ t.goMacros }}</button>
          </div>
          <button v-for="m in state.macros.list" :key="m.uid" class="macro-row" :class="{ on: isCurMacro(m) }" @click="assignMacro(m)">
            <Workflow :size="16" />
            <span class="nm">{{ m.name }}</span>
            <span class="muted">{{ m.item.length }} · {{ t.macroLoopTypes[m.looptype - 1] }}</span>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.buttons-page {
  display: grid;
  grid-template-columns: minmax(460px, 1.1fr) minmax(380px, 1fr);
  gap: 18px;
  align-items: start;
}
.map-card {
  padding-bottom: 10px;
}
.map {
  display: flex;
  gap: 14px;
  align-items: center;
}
.btn-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 210px;
  flex: none;
}
.btn-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: var(--r-md);
  border: 1px solid transparent;
  background: var(--surface-2);
  text-align: left;
  transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
}
.btn-row:hover {
  background: var(--surface-3);
}
.btn-row.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.idx {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 12.5px;
  background: var(--surface-3);
  color: var(--text-2);
}
.btn-row.on .idx {
  background: var(--accent);
  color: var(--accent-ink);
}
.txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.nm {
  font-weight: 600;
  font-size: 13px;
}
.fn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn-row.on .fn {
  color: var(--accent);
}
.img-wrap {
  flex: 1;
  position: relative;
  aspect-ratio: 560 / 756;
  max-height: 470px;
}
.mouse-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity 0.25s var(--ease);
}
.mouse-img.show {
  opacity: 1;
}
.swap {
  margin-top: 8px;
}
.accent {
  color: var(--accent);
}

.picker {
  display: flex;
  flex-direction: column;
  min-height: 560px;
}
.picker-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.cur {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 17px;
  font-weight: 700;
}
.cur svg {
  color: var(--accent);
}
.tabs {
  display: flex;
  gap: 4px;
  margin: 14px 0;
  flex-wrap: wrap;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  font-weight: 600;
  font-size: 12.5px;
  transition: all var(--t-fast);
}
.tab:hover {
  color: var(--text);
  background: var(--surface-2);
}
.tab.on {
  background: var(--text);
  color: var(--bg);
  border-color: transparent;
}
.picker-body {
  flex: 1;
  overflow-y: auto;
  max-height: 520px;
  padding-right: 4px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}
.tile {
  height: 46px;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: var(--surface-2);
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  transition: all var(--t-fast);
}
.tile:hover {
  border-color: var(--line-2);
  background: var(--surface-3);
  transform: translateY(-1px);
}
.tile.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: 0;
  background: var(--surface);
  padding-bottom: 10px;
  z-index: 1;
  color: var(--text-3);
}
.search .input {
  flex: 1;
}
.kgroup {
  margin-bottom: 14px;
}
.keys {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.key {
  min-width: 40px;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  border-bottom-width: 3px;
  background: var(--surface-2);
  font-weight: 700;
  font-size: 12.5px;
  color: var(--text);
  transition: all var(--t-fast);
}
.key:hover {
  background: var(--surface-3);
}
.key:active {
  transform: translateY(1px);
  border-bottom-width: 2px;
}
.key.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: flex-start;
}
.form p {
  margin: 0;
}
.small {
  font-size: 12px;
}
.mods {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mod {
  height: 38px;
  padding: 0 14px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--surface-2);
  font-weight: 700;
  color: var(--text-2);
  transition: all var(--t-fast);
}
.mod.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.plus {
  color: var(--text-3);
  font-weight: 700;
}
.capture {
  min-width: 170px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  border: 1px dashed var(--line-2);
  background: var(--bg-2);
  outline: none;
  cursor: pointer;
  padding: 0 12px;
  font-size: 12.5px;
}
.capture.on {
  border-color: var(--accent);
  border-style: solid;
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.preview {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
}
.fire-grid {
  display: flex;
  gap: 28px;
  flex-wrap: wrap;
}
.fire-grid label {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.macro-pick {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.macro-pick p {
  margin: 0 0 4px;
}
.macro-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: var(--surface-2);
  text-align: left;
  color: var(--text);
  transition: all var(--t-fast);
}
.macro-row:hover {
  background: var(--surface-3);
}
.macro-row.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.macro-row .nm {
  flex: 1;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 0;
  color: var(--text-3);
}
@media (max-width: 1220px) {
  .btn-list {
    width: 180px;
  }
}
</style>
