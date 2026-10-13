<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { Plus, FileUp, FileDown, Trash2, Workflow, Circle, Square, Keyboard, MousePointer2, ArrowDown, ArrowUp, Timer, X, Save, Hourglass } from 'lucide-vue-next';
import { keycodeToKeyname } from '../protocol/keytable.js';
import { STMacroItem, MAX_ACTION, MAX_DELAY, MAX_CYCLE, lpCycle } from '../protocol/macro.js';
import { state, createMacro, updateMacro, deleteMacro, importMacro, exportMacro, macroButtons, toast } from '../store.js';
import { t } from '../i18n.js';

const selUid = ref(state.macros.list[0]?.uid ?? null);
const draft = ref(null);
const dirty = ref(false);

const selected = computed(() => (selUid.value == null ? null : state.macros.find(selUid.value)));

function loadDraft() {
  stopRecord();
  const m = selected.value;
  if (!m) {
    draft.value = null;
    return;
  }
  draft.value = {
    name: m.name,
    looptype: m.looptype,
    cycle: m.cycle,
    item: m.item.map((i) => ({ key: i.key, delay: Number(i.delay), press: i.press })),
  };
  dirty.value = false;
}

function markDirty() {
  dirty.value = true;
}

function newMacro() {
  const m = createMacro(`${t.value.macroUntitled} ${state.macros.list.length + 1}`);
  selUid.value = m.uid;
}

async function doImport() {
  const uid = await importMacro();
  if (uid != null) selUid.value = uid;
}

async function doDelete() {
  if (!selected.value) return;
  const ok = await deleteMacro(selUid.value);
  if (ok) selUid.value = state.macros.list[0]?.uid ?? null;
}

async function removeFromList(uid) {
  const ok = await deleteMacro(uid);
  // eslint-disable-next-line eqeqeq
  if (ok && uid == selUid.value) selUid.value = state.macros.list[0]?.uid ?? null;
}

async function save() {
  const d = draft.value;
  if (!d) return;
  let cycle = d.looptype === lpCycle ? Math.max(1, Math.min(MAX_CYCLE, Number(d.cycle) || 1)) : 1;
  await updateMacro(selUid.value, {
    name: (d.name || '').replace(/[;|:]/g, '').trim() || t.value.macroUntitled,
    looptype: d.looptype,
    cycle,
    item: d.item.map((i) => new STMacroItem(i.key, Math.max(0, Math.min(MAX_DELAY, Number(i.delay) || 0)), i.press)),
  });
  loadDraft();
}

/* ---------------- 录制（原版 macroDialog_Record / ProcessKey / AddItem） */
const recording = ref(false);
let preKey = null;
let preStatus = null;
let preMS = 0;

function addRecorded(keyname, press) {
  const items = draft.value.item;
  if (items.length + 1 > MAX_ACTION) {
    stopRecord();
    toast(t.value.macroMaxActions, 'warn');
    return;
  }
  const now = Date.now();
  if (items.length > 0) items[items.length - 1].delay = Math.min(MAX_DELAY, now - preMS);
  preMS = now;
  items.push({ key: keyname, delay: 0, press });
  markDirty();
  requestAnimationFrame(() => {
    const el = document.querySelector('.actions-list .act:last-child');
    el && el.scrollIntoView({ block: 'nearest' });
  });
}

function onKey(e, press) {
  if (!recording.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === preKey && press === preStatus) return; // 过滤按住时的自动重复
  preKey = e.code;
  preStatus = press;
  const name = keycodeToKeyname(e.code);
  if (!name) return;
  addRecorded(name, press);
}
const kd = (e) => onKey(e, true);
const ku = (e) => onKey(e, false);

function onPadMouse(e, press) {
  if (!recording.value) return;
  const name = ['LButton', 'MButton', 'RButton'][e.button];
  if (!name) return;
  e.preventDefault();
  addRecorded(name, press);
}

function startRecord() {
  if (!draft.value) return;
  draft.value.item = [];
  preKey = preStatus = null;
  recording.value = true;
  window.addEventListener('keydown', kd, true);
  window.addEventListener('keyup', ku, true);
}
function stopRecord() {
  if (!recording.value) return;
  recording.value = false;
  window.removeEventListener('keydown', kd, true);
  window.removeEventListener('keyup', ku, true);
}
onBeforeUnmount(stopRecord);

/* ---------------- 手动编辑 */
const capIndex = ref(-1); // 正在为哪一行捕获按键；-2 表示新增

function captureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  const name = keycodeToKeyname(e.code);
  if (!name) return;
  applyCaptured(name);
}
function applyCaptured(name) {
  const items = draft.value.item;
  if (capIndex.value === -2) {
    if (items.length + 2 > MAX_ACTION) {
      toast(t.value.macroMaxActions, 'warn');
    } else {
      items.push({ key: name, delay: 20, press: true }, { key: name, delay: 20, press: false });
    }
  } else if (capIndex.value >= 0) {
    items[capIndex.value].key = name;
  }
  capIndex.value = -1;
  markDirty();
}
function beginCapture(i) {
  capIndex.value = i;
  window.addEventListener('keydown', onCapKey, true);
}
function onCapKey(e) {
  window.removeEventListener('keydown', onCapKey, true);
  if (capIndex.value === -1) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    capIndex.value = -1;
    return;
  }
  captureKey(e);
}
function cancelCapture() {
  window.removeEventListener('keydown', onCapKey, true);
  capIndex.value = -1;
}
onBeforeUnmount(cancelCapture);

function removeItem(i) {
  draft.value.item.splice(i, 1);
  markDirty();
}
function togglePress(i) {
  draft.value.item[i].press = !draft.value.item[i].press;
  markDirty();
}

// 必须放在 recording 等状态声明之后：立即执行时 loadDraft 会用到它们
watch(selUid, loadDraft, { immediate: true });

const usedBy = computed(() => (selUid.value == null ? [] : macroButtons(selUid.value)));
const totalTime = computed(() => (draft.value ? draft.value.item.reduce((s, i) => s + (Number(i.delay) || 0), 0) : 0));
const isMouseKey = (k) => /Button$/.test(k);
</script>

<template>
  <div class="macros">
    <!-- 宏列表 -->
    <section class="card list-card">
      <div class="list-actions">
        <button class="btn primary sm" @click="newMacro"><Plus :size="14" />{{ t.macroNew }}</button>
        <button class="btn sm" @click="doImport"><FileUp :size="14" />{{ t.macroImport }}</button>
      </div>
      <div class="mlist">
        <button v-for="m in state.macros.list" :key="m.uid" class="mitem" :class="{ on: m.uid == selUid }" @click="selUid = m.uid">
          <Workflow :size="16" />
          <span class="mn">{{ m.name }}</span>
          <span v-if="macroButtons(m.uid).length" class="badge accent">{{ t.macroInUse }}</span>
          <span class="muted num cnt">{{ m.item.length }}</span>
          <span class="row-del" :title="t.delete" @click.stop="removeFromList(m.uid)"><Trash2 :size="14" /></span>
        </button>
        <div v-if="!state.macros.list.length" class="empty muted">
          <Workflow :size="28" />
          {{ t.macroListEmpty }}
        </div>
      </div>
    </section>

    <!-- 编辑器 -->
    <section v-if="draft" class="card editor">
      <div class="ed-top">
        <input v-model="draft.name" class="input name" :placeholder="t.macroName" maxlength="40" @input="markDirty" />
        <div class="spacer"></div>
        <button class="btn sm" @click="exportMacro(selUid)"><FileDown :size="14" />{{ t.macroExport }}</button>
        <button class="btn sm icon danger" :title="t.delete" @click="doDelete"><Trash2 :size="14" /></button>
        <button class="btn primary sm" :disabled="!dirty" @click="save"><Save :size="14" />{{ t.save }}</button>
      </div>

      <div v-if="usedBy.length" class="used muted">{{ t.macroUsedBy }}：{{ usedBy.map((i) => t.btnName[i]).join('、') }}</div>

      <div class="loop">
        <span class="label">{{ t.macroLoop }}</span>
        <div class="seg">
          <button v-for="(n, i) in t.macroLoopTypes" :key="i" :class="{ on: draft.looptype === i + 1 }" @click="(draft.looptype = i + 1), markDirty()">{{ n }}</button>
        </div>
        <template v-if="draft.looptype === 3">
          <input v-model.number="draft.cycle" class="input num" type="number" min="1" :max="MAX_CYCLE" @input="markDirty" />
          <span class="muted">{{ t.macroCycles }}</span>
        </template>
      </div>

      <div
        class="pad"
        :class="{ rec: recording }"
        @mousedown="onPadMouse($event, true)"
        @mouseup="onPadMouse($event, false)"
        @contextmenu.prevent
      >
        <div class="pad-head">
          <span class="label">{{ t.macroActions }} · <span class="num">{{ draft.item.length }}/{{ MAX_ACTION }}</span> · <Hourglass :size="11" /> <span class="num">{{ totalTime }}ms</span></span>
          <div class="spacer"></div>
          <template v-if="!recording">
            <button class="btn sm" @mousedown.stop @click="beginCapture(-2)"><Keyboard :size="14" />{{ t.macroAddKey }}</button>
            <button class="btn sm rec-btn" @mousedown.stop @click="startRecord"><Circle :size="12" fill="currentColor" />{{ t.macroRecord }}</button>
          </template>
          <button v-else class="btn sm danger" @mousedown.stop @click="stopRecord"><Square :size="12" fill="currentColor" />{{ t.macroStop }}</button>
        </div>
        <div v-if="recording" class="rec-hint"><span class="rec-dot"></span>{{ t.macroRecording }}</div>
        <div v-if="capIndex !== -1" class="rec-hint cap">
          <Keyboard :size="14" />{{ t.keyCapture }}
          <button v-for="b in ['LButton', 'RButton', 'MButton']" :key="b" class="btn sm" @mousedown.stop @click="applyCaptured(b)">{{ b }}</button>
          <button class="btn sm ghost icon" @mousedown.stop @click="cancelCapture"><X :size="14" /></button>
        </div>

        <div class="actions-list">
          <div v-if="!draft.item.length" class="empty muted">{{ recording ? '' : t.macroNoActions }}</div>
          <div v-for="(it, i) in draft.item" :key="i" class="act" @mousedown.stop>
            <span class="ai num">{{ i + 1 }}</span>
            <span class="ak-ic"><MousePointer2 v-if="isMouseKey(it.key)" :size="14" /><Keyboard v-else :size="14" /></span>
            <button class="kbd ak" :class="{ capping: capIndex === i }" :disabled="recording" @click="beginCapture(i)">{{ it.key }}</button>
            <button class="dir" :class="{ up: !it.press }" :disabled="recording" @click="togglePress(i)">
              <ArrowDown v-if="it.press" :size="13" /><ArrowUp v-else :size="13" />
              {{ it.press ? t.macroPress : t.macroRelease }}
            </button>
            <span class="spacer"></span>
            <span class="delay">
              <Timer :size="13" />
              <input v-model.number="it.delay" class="input dl num" type="number" min="0" :max="MAX_DELAY" :disabled="recording" @input="markDirty" />
              <span class="muted">ms</span>
            </span>
            <button class="btn sm ghost icon" :disabled="recording" @click="removeItem(i)"><X :size="14" /></button>
          </div>
        </div>
        <div class="muted pad-foot">{{ t.macroRecordHint }}</div>
      </div>
    </section>
    <section v-else class="card editor placeholder">
      <Workflow :size="36" />
      <div>{{ t.macroSelect }}</div>
      <button class="btn primary" @click="newMacro"><Plus :size="15" />{{ t.macroNew }}</button>
    </section>
  </div>
</template>

<style scoped>
.macros {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 18px;
  align-items: start;
}
.list-card {
  padding: 14px;
}
.list-actions {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.list-actions .btn {
  flex: 1;
}
.mlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: calc(100vh - 260px);
  overflow-y: auto;
}
.mitem {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-2);
  text-align: left;
  transition: all var(--t-fast);
}
.mitem:hover {
  background: var(--surface-2);
  color: var(--text);
}
.mitem.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--text);
}
.mitem.on svg {
  color: var(--accent);
}
.row-del {
  display: none;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  place-items: center;
  color: var(--text-3);
}
.row-del:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.mitem:hover .row-del {
  display: grid;
}
.mitem:hover .cnt {
  display: none;
}
.mn {
  flex: 1;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 30px 0;
  font-size: 12.5px;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.placeholder {
  align-items: center;
  justify-content: center;
  min-height: 360px;
  color: var(--text-3);
}
.ed-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.input.name {
  font-size: 16px;
  font-weight: 700;
  width: 320px;
  height: 38px;
}
.used {
  font-size: 12px;
  margin-top: -6px;
}
.loop {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.pad {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--bg-2);
  padding: 14px;
  transition: border-color var(--t), box-shadow var(--t);
}
.pad.rec {
  border-color: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 15%, transparent);
}
.pad-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.pad-head .label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.rec-btn svg {
  color: var(--danger);
}
.rec-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--danger);
  padding: 8px 10px;
  margin-bottom: 10px;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.rec-hint.cap {
  color: var(--accent);
  background: var(--accent-soft);
}
.rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  animation: blink 1s infinite;
}
@keyframes blink {
  50% {
    opacity: 0.2;
  }
}
.actions-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: calc(100vh - 470px);
  min-height: 160px;
  overflow-y: auto;
  padding-right: 4px;
}
.act {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 6px 10px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--line);
}
.ai {
  width: 22px;
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
}
.ak-ic {
  color: var(--text-3);
  display: grid;
}
.ak {
  min-width: 64px;
  height: 26px;
  cursor: pointer;
}
.ak.capping {
  border-color: var(--accent);
  color: var(--accent);
}
.dir {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: 99px;
  border: 0;
  font-size: 11.5px;
  font-weight: 700;
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok);
}
.dir.up {
  background: color-mix(in srgb, var(--text-3) 18%, transparent);
  color: var(--text-2);
}
.delay {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
}
.input.dl {
  width: 76px;
  height: 28px;
}
.pad-foot {
  font-size: 11.5px;
  margin-top: 10px;
}
</style>
