// 应用状态与业务逻辑——对应原版 chunk-v1013.js 中的界面逻辑（connectDevice / onBoardClick /
// assignKEY / dpi* / usbrate_* / chunk86 + SerialProcess 等），去掉 DOM 操作后保留相同的写入行为。

import { reactive, markRaw, computed } from 'vue';
import * as C from './protocol/constants.js';
import { IncottDevice, sleep } from './protocol/device.js';
import { StProfile, StProfileList, saveProfiles, loadProfiles } from './protocol/profile.js';
import { STMacro, STMacroList, saveMacros, loadMacros } from './protocol/macro.js';
import { MockHidDevice } from './protocol/mock.js';
import { t, setLang } from './i18n.js';

const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
const USE_MOCK = typeof location !== 'undefined' && /[?&]mock\b/.test(location.search);

/* ----------------------------------------------------------- 设置持久化 */

const SETTINGS_KEY = 'incott.desktop.settings';
const defaultSettings = { theme: 'system', accent: 'orange', lang: 'zh', closeToTray: false, firstRunAck: false };

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaultSettings };
  }
}

export const settings = reactive(loadSettings());

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  applySettings();
}

export function applySettings() {
  setLang(settings.lang);
  const root = document.documentElement;
  root.dataset.accent = settings.accent;
  const dark =
    settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  desktop?.setTheme(settings.theme);
  desktop?.setTray(settings.closeToTray);
}

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') applySettings();
  });
}

/* ---------------------------------------------------------------- 状态 */

export const state = reactive({
  phase: 'welcome', // welcome | connecting | ready
  scanning: true,
  error: null,
  linuxPerm: null, // { needsFix, ... }
  device: null, // IncottDevice（markRaw）
  info: {
    devname: '',
    sensor: 0,
    wireless: false,
    is8K: false,
    pink: false,
    power: -1,
    charging: false,
    rate: 0,
    productName: '',
  },
  profiles: new StProfileList(),
  curIndex: 0,
  macros: new STMacroList(),
  firstRun: false,
  page: 'buttons',
  xySplit: false,
  pending: 0,
  applying: false,
  progress: { visible: false, pct: 0 },
  toasts: [],
  dialog: null,
  settingsOpen: false,
  classicOpen: false,
});

loadMacros(state.macros);

export const curProfile = computed(() => state.profiles.list[state.curIndex] || null);
export const sensorCfg = computed(() => C.getStDPI(state.info.sensor) || C.dvar.stDPI[0]);

/* ---------------------------------------------------------- 提示与对话框 */

let toastId = 0;
export function toast(message, type = 'info', ms = 3200) {
  const id = ++toastId;
  state.toasts.push({ id, message, type });
  setTimeout(() => {
    const i = state.toasts.findIndex((x) => x.id === id);
    if (i >= 0) state.toasts.splice(i, 1);
  }, ms);
}

export function confirmDialog(opts) {
  return new Promise((resolve) => {
    state.dialog = {
      title: opts.title,
      message: opts.message,
      okText: opts.okText || t.value.ok,
      cancelText: opts.cancelText === null ? null : opts.cancelText || t.value.cancel,
      danger: !!opts.danger,
      icon: opts.icon || 'info',
      resolve: (v) => {
        state.dialog = null;
        resolve(v);
      },
    };
  });
}

/* ------------------------------------------------------------ 写入队列 */

// 对应原版 SerialProcess(chunk, 100)：串行执行，任务间隔 100ms
const queue = [];
let processing = false;

function persist() {
  if (!state.info.devname) return;
  saveProfiles(state.info.devname, state.profiles, state.curIndex);
}

/** 原版 chunk86：保存配置并排队写入鼠标 */
export function chunk86(flag, index, { overlay = false } = {}) {
  persist();
  return new Promise((resolve) => {
    queue.push({ flag, index, overlay, resolve });
    state.pending++;
    if (!processing) processQueue();
  });
}

async function processQueue() {
  processing = true;
  while (queue.length) {
    const job = queue[0];
    const dev = state.device;
    let ok = false;
    if (job.overlay) state.progress = { visible: true, pct: 0 };
    if (dev && curProfile.value) {
      state.applying = true;
      try {
        ok = await dev.apply(curProfile.value, job.flag, job.index, {
          macros: state.macros,
          profileIndex: state.curIndex,
          onProgress: (p) => {
            if (job.overlay) state.progress.pct = p;
          },
        });
      } catch (err) {
        console.error('[apply]', err);
        ok = false;
      }
      state.applying = false;
    }
    if (job.overlay) {
      state.progress.pct = 100;
      await sleep(350);
      state.progress = { visible: false, pct: 0 };
    }
    if (!ok && state.device) toast(t.value.applyFailed, 'error', 4500);
    const i = queue.indexOf(job);
    if (i >= 0) {
      // 断开连接时队列会被清空，此时任务已在 disconnect 中结算
      queue.splice(i, 1);
      state.pending = Math.max(0, state.pending - 1);
      job.resolve(ok);
    }
    if (queue.length) await sleep(100);
  }
  processing = false;
}

/* ------------------------------------------------------------ 设备发现 */

function isIncottCollection(d) {
  return (
    d.vendorId === C.VENDOR_ID &&
    (d.productId === C.PID_WIRED || d.productId === C.PID_WIRELESS) &&
    (d.collections || []).some((c) => c.usagePage === C.USAGE_PAGE && c.usage === C.USAGE)
  );
}

function pickDevice(list) {
  const valid = list.filter(isIncottCollection);
  // 同时插着线和接收器时优先有线
  return valid.find((d) => d.productId === C.PID_WIRED) || valid[0] || null;
}

async function grantedDevices() {
  if (USE_MOCK) return [markRaw(new MockHidDevice())];
  if (!navigator.hid) return [];
  return navigator.hid.getDevices();
}

export async function checkLinuxPermission() {
  if (!desktop?.linux || desktop.platform !== 'linux') return null;
  try {
    const st = await desktop.linux.hidrawStatus();
    state.linuxPerm = st;
    return st;
  } catch {
    return null;
  }
}

/** 自动扫描已授权设备并连接 */
export async function autoConnect() {
  if (state.phase !== 'welcome') return;
  state.scanning = true;
  try {
    const hid = pickDevice(await grantedDevices());
    if (hid) await connectTo(hid);
    else await checkLinuxPermission();
  } finally {
    state.scanning = false;
  }
}

/** 用户点击"连接设备"：先找已授权设备，找不到再调用 requestDevice */
export async function userConnect() {
  state.error = null;
  let hid = pickDevice(await grantedDevices());
  if (!hid && navigator.hid) {
    try {
      const picked = await navigator.hid.requestDevice({ filters: C.HID_FILTERS });
      hid = pickDevice(picked);
    } catch (err) {
      console.warn(err);
    }
  }
  if (!hid) {
    const perm = await checkLinuxPermission();
    if (!perm?.needsFix) state.error = { title: t.value.noDevice, message: t.value.noDeviceHint };
    return;
  }
  await connectTo(hid);
}

async function connectTo(hid) {
  state.phase = 'connecting';
  state.error = null;
  const dev = markRaw(new IncottDevice(hid));
  try {
    await dev.open();
  } catch (err) {
    console.warn('[connect]', err);
    state.phase = 'welcome';
    const msg = String(err && err.message);
    let message = t.value.unsupportedDevice;
    if (msg === 'READ_FAILED') message = t.value.readFailed;
    else if (/open/i.test(msg)) message = t.value.deviceBusy;
    state.error = { title: t.value.connectFailed, message };
    await checkLinuxPermission();
    return;
  }
  // 首次使用（本地没有该型号的配置记录）：从鼠标读取现有按键映射，尽量还原真实状态
  let keyMap = null;
  if (!hasStoredProfiles(dev.devname)) {
    try {
      keyMap = await dev.readKeyMap();
    } catch (err) {
      console.warn('[readKeyMap]', err);
    }
  }
  enterDevice(dev, keyMap);
}

function hasStoredProfiles(devname) {
  try {
    return !!localStorage.getItem(`profile_${devname}`);
  } catch {
    return false;
  }
}

let statusSeen = false;
let verifying = false;

async function verifyProfileIndex() {
  const dev = state.device;
  if (!dev || verifying) return;
  verifying = true;
  try {
    const k = await dev.readProfileIndex();
    if (state.device !== dev || state.applying || state.pending) return;
    if (k == null || k < 0 || k > 3 || k === state.curIndex) return;
    if (state.firstRun) {
      // 首次使用：直接跟随鼠标，不写入
      state.curIndex = k;
      persist();
    } else {
      switchProfile(k);
    }
  } catch (err) {
    console.warn('[verifyProfileIndex]', err);
  } finally {
    verifying = false;
  }
}

/** 原版 connectDevice 的第二阶段：载入本地配置，进入设置界面 */
function enterDevice(dev, keyMap) {
  state.device = dev;
  Object.assign(state.info, {
    devname: dev.devname,
    sensor: dev.sensor,
    wireless: dev.iswireless,
    is8K: dev.is8KReceiver,
    pink: dev.isPink,
    power: -1, // 电量以设备主动上报为准（原版同样需要等待同步）
    charging: false,
    rate: dev.curUSBRate,
    productName: dev.hid.productName || '',
  });

  const st = C.getStDPI(dev.sensor);
  const list = new StProfileList();
  const { count, index } = loadProfiles(dev.devname, list);
  state.firstRun = count <= 0;
  for (let i = list.list.length; i < C.MAX_ONBOARD; i++) {
    const p = new StProfile(`${t.value.onboardProfile}${i + 1}`, C.dvar, dev.sensor);
    p.inside = true;
    list.add(p);
  }
  // 换了传感器的配置：超出范围的 DPI 恢复为该档默认值
  for (const pf of list.list) {
    if (pf.dpisensor === dev.sensor) continue;
    for (let k = 0; k < pf.dpi.length; k++) {
      if (pf.dpi[k] > st.max) pf.dpi[k] = st.dpi[k] ?? st.dpi[0];
      if (pf.dpiy[k] > st.max) pf.dpiy[k] = st.dpi[k] ?? st.dpi[0];
    }
  }
  state.profiles = list;
  // 首次使用时以鼠标当前板载序号为准，避免一连接就用默认值覆盖鼠标里的设置
  let idx = state.firstRun ? dev.curOnBoard : index ?? dev.curOnBoard;
  if (idx == null || idx < 0 || idx > 3) idx = 0;
  state.curIndex = idx;
  if (state.firstRun) {
    const pf = list.list[idx];
    // 全部读成"禁用"不合理（多半是读取异常），此时不采用
    const plausible = keyMap && keyMap.some((k) => k && !(k.major === C.fMouse && k.minor === C.favOFF));
    if (plausible) keyMap.forEach((k, i) => k && (pf.key[i] = k));
    const lv = dev.dpiLevels;
    if (lv >= 1 && lv <= st.dpi.length && lv !== pf.dpi.length) {
      pf.dpi = st.dpi.slice(0, lv);
      pf.dpiy = st.dpi.slice(0, lv);
      pf.dpicolor = st.dpicolor.slice(0, lv);
    }
  }
  setCurDpi(dev.curDpi);
  statusSeen = false;
  persist();

  dev.addEventListener('status', onStatus);
  state.phase = 'ready';
}

/** 原版 dpiSetCurDPI：只更新界面/配置，不写入 */
function setCurDpi(index) {
  const pf = curProfile.value;
  if (!pf || index == null || index < 0) return;
  if (index >= pf.dpi.length) index = pf.dpi.length - 1;
  pf.curDpi = index;
}

/** 原版 irServer：处理鼠标主动上报的状态 */
function onStatus(e) {
  const s = e.detail;
  if (state.applying) return;
  statusSeen = true;
  // 部分固件（实测 G23V2）的状态包里板载序号位恒为 0，原版直接据此切换会"跳回配置 1"。
  // 这里先向鼠标读取真实序号确认，确实变化（例如按了鼠标上的配置切换键）才切换。
  if (s.profileIndex !== state.curIndex) verifyProfileIndex();
  state.info.charging = s.charging;
  state.info.power = s.power;
  if (s.rate) {
    state.info.rate = s.rate;
    const pf = curProfile.value;
    if (pf && pf.usbrate !== s.rate) {
      pf.usbrate = s.rate;
      persist();
    }
  }
  setCurDpi(s.dpiIndex);
}

export async function disconnect() {
  const dev = state.device;
  for (const job of queue.splice(0)) job.resolve(false);
  if (dev) {
    dev.removeEventListener('status', onStatus);
    await dev.close();
  }
  state.device = null;
  state.phase = 'welcome';
  state.pending = 0;
  state.applying = false;
  state.progress = { visible: false, pct: 0 };
}

export function initHidEvents() {
  if (!navigator.hid || USE_MOCK) return;
  navigator.hid.addEventListener('disconnect', (e) => {
    if (state.device && state.device.hid === e.device) {
      disconnect().then(() => setTimeout(autoConnect, 400));
    }
  });
  navigator.hid.addEventListener('connect', () => {
    if (state.phase === 'welcome') setTimeout(autoConnect, 500);
  });
}

/* --------------------------------------------------------------- 板载配置 */

/** 原版 onBoardClick：切换板载配置并完整写入 */
export function switchProfile(index) {
  if (index < 0 || index > 3) return;
  state.curIndex = index;
  return chunk86(C.apALL | C.apProSw, 255, { overlay: true });
}

export async function exportProfile() {
  const pf = curProfile.value;
  if (!pf || !desktop) return;
  const r = await desktop.saveText({
    defaultName: `${pf.name}.ict`,
    content: pf.toText(),
    filters: [{ name: 'INCOTT Profile', extensions: ['ict'] }],
  });
  if (r.ok) toast(t.value.exportOk, 'success');
}

/** 原版 onBoardImport_SelectFile */
export async function importProfile(text) {
  if (text == null) {
    if (!desktop) return;
    const r = await desktop.openText({ filters: [{ name: 'INCOTT Profile', extensions: ['ict'] }] });
    if (!r.ok) return;
    text = r.content;
  }
  const p = new StProfile('', C.dvar, state.info.sensor);
  if (!p.initByText(text)) return toast(t.value.importFailed, 'error');
  if (p.dpisensor !== state.info.sensor) return toast(t.value.importWrongSensor, 'error');
  const cur = curProfile.value;
  p.name = cur.name;
  p.uid = cur.uid;
  p.inside = true;
  state.profiles.list[state.curIndex] = p;
  state.firstRun = false;
  const ok = await switchProfile(state.curIndex);
  if (ok) toast(t.value.importOk, 'success');
}

/* ------------------------------------------------------------------ 按键 */

export const UI_KEY_NUM = C.dvar.key.length;

/** 原版 assignKEY：至少保留一个左键 */
export async function assignKey(btn, kf) {
  const pf = curProfile.value;
  if (!pf || btn < 0 || btn >= UI_KEY_NUM) return;
  const otherLeft = pf.key.some((k, i) => i !== btn && k.major === C.fMouse && k.minor === C.fmsCLICK);
  if (!otherLeft && !(kf.major === C.fMouse && kf.minor === C.fmsCLICK)) {
    const ok = await confirmDialog({
      title: t.value.leftGuardTitle,
      message: t.value.leftGuardMsg,
      okText: t.value.leftGuardOk,
      danger: true,
      icon: 'warn',
    });
    if (!ok) return;
  }
  return setButton(btn, kf);
}

/** 原版 onButtonSet */
function setButton(btn, kf) {
  const pf = curProfile.value;
  const list = state.profiles.list;
  if (kf.major === C.fMouse && kf.minor === C.favProfile) {
    // "配置切换"键同步到全部 4 个板载配置
    for (let i = 0; i < 4; i++) if (list[i]) list[i].key[btn] = kf.copy();
  } else if (pf.key[btn].major === C.fMouse && pf.key[btn].minor === C.favProfile) {
    // 取消"配置切换"键时，其它配置的该键恢复默认
    // （原版的跳过条件误写成 i==按键序号，会让某个配置残留切换键，这里按本意修正）
    for (let i = 0; i < 4; i++) {
      if (i === state.curIndex || !list[i]) continue;
      list[i].key[btn] = C.dvar.key[btn].copy();
    }
  }
  pf.key[btn] = kf.copy();
  return chunk86(C.apKey, btn, { overlay: kf.major === C.fJuji });
}

/** 原版 keyInvertRL */
export function swapLeftRight() {
  const pf = curProfile.value;
  if (!pf) return;
  const k = pf.key[0].copy();
  pf.key[0] = pf.key[1].copy();
  pf.key[1] = k;
  chunk86(C.apKey, 0);
  chunk86(C.apKey, 1);
}

export function isLRSwapped() {
  const pf = curProfile.value;
  if (!pf) return false;
  return pf.key[0].major === C.fMouse && pf.key[0].minor === C.fmsMENU && pf.key[1].major === C.fMouse && pf.key[1].minor === C.fmsCLICK;
}

/* ------------------------------------------------------------------- DPI */

/** 原版 dpiClick(index, event)：设为当前档位 */
export function selectDpi(index) {
  const pf = curProfile.value;
  if (!pf || index < 0 || index >= pf.dpi.length) return;
  setCurDpi(index);
  chunk86(C.apDpiLevel, index);
}

/** 原版 dpiEditFinish / dpiDragEnd */
export function setDpiValue(index, x, y) {
  const pf = curProfile.value;
  if (!pf || index < 0 || index >= pf.dpi.length) return;
  x = C.closestDpi(state.info.sensor, x);
  y = C.closestDpi(state.info.sensor, y ?? x);
  if (pf.dpi[index] === x && pf.dpiy[index] === y) return;
  pf.dpi[index] = x;
  pf.dpiy[index] = y;
  chunk86(C.apDpi, index);
}

/** 原版 dpiAdd */
export function addDpiLevel() {
  const pf = curProfile.value;
  const st = sensorCfg.value;
  if (!pf) return;
  const n = pf.dpi.length;
  if (n >= st.dpi.length) return toast(t.value.dpiMax, 'warn');
  pf.dpi.push(st.dpi[n]);
  pf.dpiy.push(st.dpi[n]);
  dpiLevelChanged(pf, false);
}

/** 原版 dpiAdd(false)：删除最后一档 */
export function removeDpiLevel() {
  const pf = curProfile.value;
  if (!pf) return;
  const n = pf.dpi.length;
  if (n <= 1) return toast(t.value.dpiMin, 'warn');
  pf.dpi.splice(n - 1, 1);
  pf.dpiy.splice(n - 1, 1);
  dpiLevelChanged(pf, true);
}

/** 原版 dpiLevelMenuClick：直接设定档位数 */
export function setDpiLevels(count) {
  const pf = curProfile.value;
  const st = sensorCfg.value;
  if (!pf) return;
  const n = pf.dpi.length;
  if (count === n || count < 1 || count > st.dpi.length) return;
  const isDel = count < n;
  if (isDel) {
    pf.dpi.length = count;
    pf.dpiy.length = count;
  } else {
    for (let i = n; i < count; i++) {
      pf.dpi.push(st.dpi[i]);
      pf.dpiy.push(st.dpi[i]);
    }
  }
  dpiLevelChanged(pf, isDel);
}

function dpiLevelChanged(pf, isDel) {
  const st = sensorCfg.value;
  const n = pf.dpi.length;
  pf.dpiy.length = n;
  pf.dpicolor.length = n;
  for (let i = 0; i < n; i++) pf.dpicolor[i] = st.dpicolor[i];
  let cur = pf.curDpi;
  if (isDel && cur >= n) cur = n - 1;
  setCurDpi(cur);
  chunk86(C.apDpi, 255);
  chunk86(C.apDpiLevel, pf.curDpi);
}

/* ------------------------------------------------------- 回报率 / 传感器 */

export async function setRate(rate) {
  const pf = curProfile.value;
  if (!pf || pf.usbrate === rate) return;
  if (rate >= 4000) {
    const ok = await confirmDialog({
      title: t.value.highRateTitle,
      message: t.value.highRateMsg,
      okText: t.value.highRateOk,
      icon: 'warn',
    });
    if (!ok) return;
  }
  pf.usbrate = rate;
  chunk86(C.apRate, 0);
}

export function setSensorMode(mode) {
  const pf = curProfile.value;
  if (!pf) return;
  pf.sensormode = mode;
  if (pf.usbrate < 2000) chunk86(C.apSensorMode, 0);
}

export function setLod(lod) {
  const pf = curProfile.value;
  if (!pf || pf.lod === lod) return;
  pf.lod = lod;
  chunk86(C.apLod, 0);
}

export function setMotion(on) {
  const pf = curProfile.value;
  if (!pf) return;
  pf.motion = on;
  chunk86(C.apSensor, 4);
}
export function setFixline(on) {
  const pf = curProfile.value;
  if (!pf) return;
  pf.fixline = on;
  chunk86(C.apSensor, 2);
}
export function setRipple(on) {
  const pf = curProfile.value;
  if (!pf) return;
  pf.ripple = on;
  chunk86(C.apSensor, 1);
}

export function setDebounce(v) {
  const pf = curProfile.value;
  if (!pf) return;
  v = Math.max(C.DEBOUNCE_MIN, Math.min(C.DEBOUNCE_MAX, Math.round(v)));
  if (pf.debounce === v) return;
  pf.debounce = v;
  chunk86(C.apDebounce, 0);
}

export function setSleepTime(sec) {
  const pf = curProfile.value;
  if (!pf || pf.sleeptime === sec) return;
  pf.sleeptime = sec;
  chunk86(C.apSleepTime, 0);
}

export function setReceiverLED(mode) {
  const pf = curProfile.value;
  if (!pf) return;
  pf.receiverLED = mode;
  chunk86(C.apReceiverLED, 0);
}

/** 原版 onRClick：恢复出厂设置 */
export async function factoryReset() {
  const ok = await confirmDialog({
    title: t.value.factoryReset,
    message: t.value.factoryResetMsg,
    okText: t.value.factoryResetOk,
    danger: true,
    icon: 'warn',
  });
  if (!ok) return;
  const pf = curProfile.value;
  if (!pf) return;
  state.xySplit = false;
  pf.reset(C.dvar, state.info.sensor);
  return chunk86(C.apALL | C.apReset, 255, { overlay: true });
}

/* ------------------------------------------------------------------- 宏 */

export function createMacro(name) {
  const m = new STMacro(name || t.value.macroUntitled);
  state.macros.list.push(m);
  saveMacros(state.macros);
  return state.macros.list[state.macros.list.length - 1];
}

export function macroButtons(uid) {
  const pf = curProfile.value;
  if (!pf) return [];
  // eslint-disable-next-line eqeqeq
  return pf.key.map((k, i) => (k.major === C.fJuji && k.itemdata == uid ? i : -1)).filter((i) => i >= 0);
}

export async function updateMacro(uid, data) {
  const m = state.macros.find(uid);
  if (!m) return;
  m.name = data.name;
  m.looptype = data.looptype;
  m.cycle = data.cycle;
  m.item = data.item;
  saveMacros(state.macros);
  const used = macroButtons(uid);
  if (used.length && state.device) {
    toast(t.value.macroResync, 'info');
    for (const i of used) await chunk86(C.apKey, i, { overlay: true });
  } else {
    toast(t.value.macroSaved, 'success');
  }
}

export async function deleteMacro(uid) {
  const ok = await confirmDialog({ title: t.value.delete, message: t.value.macroDeleteMsg, danger: true, okText: t.value.delete, icon: 'warn' });
  if (!ok) return false;
  state.macros.remove(uid);
  saveMacros(state.macros);
  return true;
}

export async function importMacro() {
  if (!desktop) return null;
  const r = await desktop.openText({ filters: [{ name: 'INCOTT Macro', extensions: ['icm'] }] });
  if (!r.ok) return null;
  const m = new STMacro('');
  if (!m.initByText(r.content)) {
    toast(t.value.importFailed, 'error');
    return null;
  }
  m.uid = Date.now();
  state.macros.list.push(m);
  saveMacros(state.macros);
  return m.uid;
}

export async function exportMacro(uid) {
  const m = state.macros.find(uid);
  if (!m || !desktop) return;
  const r = await desktop.saveText({
    defaultName: `${m.name}.icm`,
    content: m.toText(),
    filters: [{ name: 'INCOTT Macro', extensions: ['icm'] }],
  });
  if (r.ok) toast(t.value.exportOk, 'success');
}

/* ------------------------------------------------------------------ 其它 */

export async function openClassic() {
  await disconnect();
  state.classicOpen = true;
  desktop?.openClassic();
}

if (desktop) {
  desktop.onClassicClosed(() => {
    state.classicOpen = false;
    setTimeout(autoConnect, 300);
  });
}

export const isDesktop = !!desktop;
export const isMock = USE_MOCK;

// 仅模拟/调试模式：暴露给截图与调试脚本
if ((USE_MOCK || /[?&]debug\b/.test(location.search)) && typeof window !== 'undefined') window.__app = { state, settings, saveSettings };
