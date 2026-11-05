// 应用状态与业务逻辑——对应原版 chunk-v1013.js 中的界面逻辑（connectDevice / onBoardClick /
// assignKEY / dpi* / usbrate_* / chunk86 + SerialProcess 等），去掉 DOM 操作后保留相同的写入行为。

import { reactive, markRaw, computed } from 'vue';
import * as C from './protocol/constants.js';
import { IncottDevice, sleep, keyToHw } from './protocol/device.js';
import { StProfile, StProfileList, saveProfiles, loadProfiles } from './protocol/profile.js';
import { STMacro, STMacroList, saveMacros, loadMacros } from './protocol/macro.js';
import { MockHidDevice } from './protocol/mock.js';
import { t, setLang } from './i18n.js';
import { logEvent } from './diaglog.js';

const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
const USE_MOCK = typeof location !== 'undefined' && /[?&]mock\b/.test(location.search);

/* ----------------------------------------------------------- 设置持久化 */

const SETTINGS_KEY = 'incott.desktop.settings';
const defaultSettings = { theme: 'system', accent: 'orange', lang: 'zh', closeToTray: false, firstRunAck: false, shell: {} };

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
  curIndex: 0, // 当前配置槽位
  slot: null, // 鼠标实际所在的硬件槽位（0–3，未知时为 null；仅用于诊断）
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
  diagRunning: false,
});

loadMacros(state.macros);

export const curProfile = computed(() => state.profiles.list[state.curIndex] || null);
export const sensorCfg = computed(() => C.getStDPI(state.info.sensor) || C.dvar.stDPI[0]);
/** 实际写入鼠标的回报率：非 8K 连接下配置里的 2000+ Hz 按 1000 Hz（与 IncottDevice.writableRate 一致） */
export const effectiveRate = computed(() => {
  const r = curProfile.value?.usbrate || 0;
  return !state.info.is8K && C.RATE_8K_ONLY.includes(r) ? 1000 : r;
});

/* -------------------------------------------------------------- 诊断 */

// 不进入响应式系统：供「复制诊断信息」读取
export const diag = markRaw({
  running: false,
  connecting: null, // 正在连接的 { dev, since }：连接卡住时诊断信息靠它导出现场
  lastFailure: null, // { time, productId, productName, error, modelCode, linkOnline, replies, inputCount, inputById, xferLog, inputLog, errLog }
});

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

const FLAG_NAMES = [
  [C.apKey, 'key'],
  [C.apDpi, 'dpi'],
  [C.apRate, 'rate'],
  [C.apLod, 'lod'],
  [C.apSensor, 'sensor'],
  [C.apSensorMode, 'sensorMode'],
  [C.apDpiLevel, 'dpiLevel'],
  [C.apOnboardIndex, 'onboard'],
  [C.apReceiverLED, 'rxLed'],
  [C.apDebounce, 'debounce'],
  [C.apSleepTime, 'sleep'],
  [C.apReset, 'RESET'],
  [C.apProSw, 'profileSwitch'],
];
export function flagNames(flag) {
  if ((flag & C.apALL) === C.apALL) return ['ALL', ...FLAG_NAMES.filter(([b]) => b > C.apALL && flag & b).map(([, n]) => n)].join('+');
  return FLAG_NAMES.filter(([b]) => flag & b).map(([, n]) => n).join('+') || String(flag);
}

/** 把任意异步任务放进写入队列（与 chunk86 串行，执行期间 state.applying = true，状态包暂不处理） */
function enqueue(run) {
  return new Promise((resolve) => {
    queue.push({ run, resolve });
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
    if (job.run) {
      state.applying = true;
      try {
        ok = !!(await job.run());
      } catch (err) {
        console.error('[queue]', err);
        logEvent(`queue job FAILED: ${err?.message || err}`);
        ok = false;
      }
      state.applying = false;
    } else if (dev && curProfile.value) {
      // 绑定了已不存在的宏的按键先恢复默认，让界面与写入鼠标的内容一致
      if (job.flag & C.apKey) {
        const fixed = dropMissingMacros(curProfile.value, job.index);
        if (fixed.length) {
          persist();
          toast(t.value.macroMissingReset(fixed.length), 'warn', 4500);
        }
      }
      state.applying = true;
      const started = Date.now();
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
        dev.applyError = `exception: ${err?.message || err}`;
        ok = false;
      }
      state.applying = false;
      const why = ok ? 'ok' : `FAILED at ${dev.applyError || '?'}`;
      logEvent(`apply ${flagNames(job.flag)} index=${job.index} profile=${state.curIndex + 1} → ${why} ${Date.now() - started}ms`);
    } else {
      logEvent(`apply ${flagNames(job.flag)} skipped (no device/profile)`);
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
  if (state.phase !== 'welcome' || diag.running) return;
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
  logEvent(`connect start ${hid.productId?.toString(16)} "${hid.productName || ''}" opened=${hid.opened}`);
  diag.connecting = { dev, since: Date.now() };
  try {
    await dev.open();
  } catch (err) {
    console.warn('[connect]', err);
    logEvent(`connect FAILED: ${err?.message || err} (modelCode=${dev.modelCode}${dev.lastHidError ? `, last HID error: ${dev.lastHidError}` : ''})`);
    diag.lastFailure = {
      time: new Date().toISOString(),
      productId: hid.productId,
      productName: hid.productName || '',
      error: String(err?.message || err),
      modelCode: dev.modelCode,
      linkOnline: dev.linkOnline,
      replies: { ...dev.replies },
      inputCount: dev.inputCount,
      inputById: { ...dev.inputById },
      xferLog: dev.xferLog.slice(),
      inputLog: dev.inputLog.slice(),
      errLog: dev.errLog.slice(),
    };
    state.phase = 'welcome';
    const msg = String(err && err.message);
    let message = t.value.unsupportedDevice;
    if (msg === 'READ_FAILED') message = t.value.readFailed;
    else if (msg === 'NO_RESPONSE') message = t.value.noResponse;
    else if (/open/i.test(msg)) message = t.value.deviceBusy;
    state.error = { title: t.value.connectFailed, message };
    diag.connecting = null;
    await checkLinuxPermission();
    return;
  }
  // 首次使用（本地没有该型号的配置记录）：从鼠标读取现有按键映射，尽量还原真实状态
  let keyMap = null;
  let quick = null;
  if (!hasStoredProfiles(dev.devname)) {
    try {
      keyMap = await dev.readKeyMap();
    } catch (err) {
      console.warn('[readKeyMap]', err);
    }
    logEvent(`first run: key map read ${keyMap ? keyMap.map((k) => (k ? k.toText() : 'null')).join(' | ') : 'failed'}`);
  } else {
    // 读出鼠标当前硬件槽位里的几项设置：软件关闭期间按过切换键时，不用等状态包就能认出所在槽位
    try {
      quick = await dev.readSlot(C.getStDPI(dev.sensor)?.dpi.length ?? 6, { quick: true });
    } catch (err) {
      console.warn('[readSlot]', err);
    }
  }
  logEvent(
    `connected ${dev.devname} code=${dev.modelCode} sensor=${dev.sensor.toString(16)} wireless=${dev.iswireless} 8K=${dev.is8KReceiver} rate=${dev.curUSBRate} dpi=${dev.curDpi}/${dev.dpiLevels} power=${dev.power} onboard=${dev.curOnBoard}`
  );
  diag.connecting = null;
  enterDevice(dev, keyMap, quick);
}

function hasStoredProfiles(devname) {
  try {
    return !!localStorage.getItem(`profile_${devname}`);
  } catch {
    return false;
  }
}

let statusSeen = false;

/* ------------------------------------------------------------- 配置槽位 */

// 实测 G23V2：鼠标里有 4 个硬件槽位，各存回报率 / DPI / 传感器 / 消抖 / 休眠；按键与接收器灯效由固件共用，
// 但软件里仍按原版每个配置各记一份（写入时按键 / 灯效会同时影响 4 个硬件槽位）。
// 硬件槽位只能用鼠标上的「配置切换」键切换（鼠标没有由软件换槽位的命令，原版的 [6,9,序号] 只是记一个编号），
// 状态包第 3 字节高 2 位报告当前硬件槽位；软件的任何写入都只进入当前硬件槽位。
// 与官方网页驱动相同，板载配置 N 对应硬件槽位 N：
//   · 按鼠标上的切换键到硬件槽位 N = 切到板载配置 N，把它写进这个槽位（官方整套重写；这里先读出槽位，
//     只写不一样的项，已经一致就不写）；
//   · 点击板载配置 N = 写进鼠标当前所在的硬件槽位（官方随后会因槽位号对不上而跳回原配置，这里不跳回，
//     保持到下次按切换键；之后回到这个硬件槽位时恢复它自己的配置）。

let slotKnown = false; // 连接后是否已从状态包得知当前硬件槽位
let slotPending = null; // 已排队的任务
let slotToken = 0;
let lastSlotSeen = null; // 最近一个状态包里的硬件槽位（写入期间也更新）
let hwSlot = 0; // 鼠标实际所在的硬件槽位（最近一次得知的）
// 每个硬件槽位里装着哪个配置槽位的设置（null = 不确定）
let slotContent = [0, 1, 2, 3];
const SLOT_SETTLE_MS = 400; // 实测 G23V2：刚换完槽位时最初几次读取会失败
// 配置槽位 N 是否已有用户的内容：false（首次使用，只是默认值）时第一次用到它，用鼠标里的设置初始化
let slotSynced = [true, true, true, true];

const slotSyncKey = (devname) => `slotsync_${devname}`;
function loadSlotSynced(devname, firstRun) {
  try {
    const v = JSON.parse(localStorage.getItem(slotSyncKey(devname)) || 'null');
    if (Array.isArray(v) && v.length === C.MAX_ONBOARD) return v.map(Boolean);
  } catch {
    /* ignore */
  }
  return Array(C.MAX_ONBOARD).fill(!firstRun);
}
function markSlotSynced(i) {
  if (slotSynced[i]) return;
  slotSynced[i] = true;
  try {
    localStorage.setItem(slotSyncKey(state.info.devname), JSON.stringify(slotSynced));
  } catch {
    /* ignore */
  }
}

const slotStateKey = (devname) => `slotstate_${devname}`;
function loadSlotState(devname) {
  try {
    const v = JSON.parse(localStorage.getItem(slotStateKey(devname)) || 'null');
    if (!v || !(v.hw >= 0 && v.hw < C.MAX_ONBOARD)) return null;
    const ok = (p) => (Number.isInteger(p) && p >= 0 && p < C.MAX_ONBOARD ? p : null);
    const content = Array.isArray(v.content) ? v.content.map(ok) : [0, 1, 2, 3].map((i) => (v.dirty?.[i] ? null : i));
    return { hw: v.hw, content };
  } catch {
    return null;
  }
}
function saveSlotState() {
  try {
    localStorage.setItem(slotStateKey(state.info.devname), JSON.stringify({ hw: hwSlot, content: slotContent }));
  } catch {
    /* ignore */
  }
}

/** 当前配置槽位刚完整写入鼠标当前硬件槽位 */
function markWritten() {
  markSlotSynced(state.curIndex);
  slotContent[hwSlot] = state.curIndex;
  saveSlotState();
}

/** 比对配置与硬件槽位的实际内容，返回需要写入的 [flag, index]；读不到的项按需要写入处理 */
export function slotDiff(pf, raw, dev) {
  const neq = (a, b) => a == null || a !== b;
  const jobs = [];
  const keys = [];
  pf.key.forEach((k0, i) => {
    const k = k0.major === C.fJuji && !state.macros.find(k0.itemdata) ? C.dvar.key[i] : k0;
    const code = keyToHw(k, i);
    if (code === -1) return;
    let diff = raw.keys[i] == null || raw.keys[i] >>> 0 !== code >>> 0;
    if (!diff && k.major === C.fMouse && k.minor === C.favFIRE) {
      const lp = Math.min(k.itemdata & 65535, 3);
      const ir = Math.min((k.itemdata >> 16) & 65535, 255);
      diff = !raw.fire || raw.fire[0] !== lp || raw.fire[1] !== ir;
    }
    if (diff) keys.push(i);
  });
  if (keys.length) jobs.push([C.apKey, keys.length === 1 ? keys[0] : 255]);
  const dpis = [];
  pf.dpi.forEach((x, i) => {
    const hw = C.getHwForDpi(x, dev.sensor);
    // X / Y 分开的档位读不出 Y，照写
    if (hw !== -1 && (pf.dpiy[i] !== x || neq(raw.dpi[i], hw))) dpis.push(i);
  });
  if (dpis.length) jobs.push([C.apDpi, dpis.length === 1 ? dpis[0] : 255]);
  let flag = 0;
  if (neq(raw.levels, pf.dpi.length) || neq(raw.cur, Math.min(pf.curDpi, pf.dpi.length - 1))) flag |= C.apDpiLevel;
  const rate = dev.writableRate(pf.usbrate);
  if (neq(raw.rate, rate)) flag |= C.apRate;
  if (rate < 2000 && neq(raw.sensormode, pf.sensormode)) flag |= C.apSensorMode;
  if (neq(raw.lod, C.lodToHw(pf.lod, dev.sensor))) flag |= C.apLod;
  if (neq(raw.debounce, Math.min(pf.debounce, C.DEBOUNCE_MAX))) flag |= C.apDebounce;
  if (neq(raw.sleeptime, Math.max(pf.sleeptime, 10))) flag |= C.apSleepTime;
  if (dev.is8KReceiver && neq(raw.receiverLED, pf.receiverLED)) flag |= C.apReceiverLED;
  if (flag) jobs.push([flag, 0]);
  let mask = 0;
  if (neq(raw.ripple, pf.ripple ? 1 : 0)) mask |= 1;
  if (neq(raw.fixline, pf.fixline ? 1 : 0)) mask |= 2;
  if (neq(raw.motion, pf.motion ? 1 : 0)) mask |= 4;
  if (mask) jobs.push([C.apSensor, mask]);
  return jobs;
}

/** 首次使用：用硬件槽位里的实际设置初始化配置槽位（按键与接收器灯效由固件共用，不在这里处理） */
function adoptSlot(pf, raw, dev) {
  const st = C.getStDPI(dev.sensor);
  if (raw.rate) pf.usbrate = raw.rate;
  const lv = raw.levels;
  if (st && lv >= 1 && lv <= st.dpi.length) {
    const dpi = [];
    for (let i = 0; i < lv; i++) {
      const j = raw.dpi[i] == null ? -1 : st.dpiHW.indexOf(raw.dpi[i]);
      dpi.push(j >= 0 ? st.dpiUI[j] : pf.dpi[i] ?? st.dpi[i]);
    }
    pf.dpi = dpi;
    pf.dpiy = dpi.slice();
    pf.dpicolor = st.dpicolor.slice(0, lv);
  }
  if (raw.cur != null) pf.curDpi = Math.min(raw.cur, pf.dpi.length - 1);
  const lod = [0, 1, 2].find((l) => C.lodToHw(l, dev.sensor) === raw.lod && (l !== 0 || dev.sensor === C.SENSOR_3950));
  if (lod != null) pf.lod = lod;
  if (raw.ripple != null) pf.ripple = !!raw.ripple;
  if (raw.fixline != null) pf.fixline = !!raw.fixline;
  if (raw.motion != null) pf.motion = !!raw.motion;
  if (raw.sensormode != null && raw.sensormode <= 2) pf.sensormode = raw.sensormode;
  if (raw.debounce != null) pf.debounce = raw.debounce;
  if (raw.sleeptime) pf.sleeptime = raw.sleeptime;
}

/** 硬件槽位读到的设置是否就是配置 pf（读不到的项不算不一致；不比较当前 DPI 档、按键与灯效） */
function slotMatches(pf, raw, dev) {
  const eq = (a, b) => a == null || a === b;
  if (raw.rate == null) return false;
  if (!eq(raw.rate, dev.writableRate(pf.usbrate)) || !eq(raw.levels, pf.dpi.length)) return false;
  for (let i = 0; i < pf.dpi.length; i++) if (!eq(raw.dpi[i], C.getHwForDpi(pf.dpi[i], dev.sensor))) return false;
  if (!eq(raw.lod, C.lodToHw(pf.lod, dev.sensor))) return false;
  if (!eq(raw.debounce, Math.min(pf.debounce, C.DEBOUNCE_MAX))) return false;
  return eq(raw.sleeptime, Math.max(pf.sleeptime, 10));
}

/** 连接时认出鼠标所在的硬件槽位：读到的设置只和一个硬件槽位里装的配置一致时返回 { slot, profile } */
function identifySlot(raw, dev) {
  if (!raw) return null;
  const hits = [];
  slotContent.forEach((p, h) => {
    if (p != null && state.profiles.list[p] && slotMatches(state.profiles.list[p], raw, dev)) hits.push({ slot: h, profile: p });
  });
  return hits.length === 1 ? hits[0] : null;
}

/** 同步期间鼠标又换了硬件槽位：结束当前任务后立即处理新的槽位 */
function slotMoved(slot) {
  if (lastSlotSeen == null || lastSlotSeen === slot) return false;
  const next = lastSlotSeen;
  // 状态包处理时通常已经切过去了；没有的话补上
  if (hwSlot !== next) setTimeout(() => queueSlotEnter(next), 0);
  return true;
}

/** 排队执行槽位相关任务；新的任务会取代还没开始的旧任务 */
function queueSlotJob(key, run) {
  if (slotPending === key) return Promise.resolve(true);
  slotPending = key;
  const token = ++slotToken;
  return enqueue(async () => {
    if (token !== slotToken) return true;
    slotPending = null;
    if (!state.device) return false;
    return run(state.device);
  });
}

/** 读出当前硬件槽位，把配置槽位 p 写进去（只写不一样的项）；aligned：槽位里本来就是 p，当前 DPI 档以鼠标为准 */
async function loadIntoSlot(dev, p, head, { aligned = false, settle = false } = {}) {
  const slot = hwSlot;
  const pf = state.profiles.list[p];
  const started = Date.now();
  if (settle) await sleep(SLOT_SETTLE_MS);
  const raw = await dev.readSlot(C.getStDPI(dev.sensor)?.dpi.length ?? 6);
  if (state.device !== dev) return false;
  // 读取期间又按了切换键：放弃这次（不算失败），改为处理新的槽位
  if (slotMoved(slot)) return logEvent(`${head}: slot changed again while reading, skipped`), true;
  if (state.curIndex !== p) {
    state.curIndex = p;
    persist();
  }
  // 首次使用：配置槽位还只是默认值，用鼠标里的设置初始化，不写入
  if (!slotSynced[p]) {
    adoptSlot(pf, raw, dev);
    markSlotSynced(p);
    slotContent[slot] = p;
    saveSlotState();
    persist();
    logEvent(`${head}: initialised from mouse (rate=${raw.rate} dpi=${raw.cur}/${raw.levels}) ${Date.now() - started}ms`);
    return true;
  }
  // 当前 DPI 档以鼠标为准（鼠标上的 DPI 键随时会改它）
  if (aligned && raw.cur != null) setCurDpi(raw.cur);
  const fixed = dropMissingMacros(pf);
  if (fixed.length) toast(t.value.macroMissingReset(fixed.length), 'warn', 4500);
  const jobs = slotDiff(pf, raw, dev);
  let ok = true;
  let stopped = false;
  if (jobs.length) {
    state.progress = { visible: true, pct: 0 };
    for (let j = 0; j < jobs.length && ok; j++) {
      // 写入期间又按了切换键：停止（不算失败），改为处理新的槽位；这个槽位下次切回来时再补齐
      if (slotMoved(slot)) {
        stopped = true;
        break;
      }
      const [flag, index] = jobs[j];
      ok = await dev.apply(pf, flag, index, {
        macros: state.macros,
        profileIndex: p,
        onProgress: (v) => (state.progress.pct = ((j + v / 100) / jobs.length) * 100),
      });
    }
    state.progress.pct = 100;
    await sleep(250);
    state.progress = { visible: false, pct: 0 };
  }
  slotContent[slot] = ok && !stopped ? p : null;
  saveSlotState();
  persist();
  const what = jobs.length ? `wrote ${jobs.map(([f, i]) => (i ? `${flagNames(f)}#${i}` : flagNames(f))).join(', ')}` : 'in sync';
  const end = stopped ? ' → stopped, slot changed again' : ok ? '' : ` → FAILED at ${dev.applyError || '?'}`;
  logEvent(`${head}: ${what}${end} ${Date.now() - started}ms`);
  return ok;
}

/** 鼠标换到硬件槽位 slot（按了切换键）：切到板载配置 slot；keep：鼠标仍在原来的槽位（刚连接），保持当前配置 */
function queueSlotEnter(slot, keep = false) {
  const fromSlot = hwSlot;
  const from = state.curIndex;
  const p = keep ? from : slot;
  // 界面立即切换，读取 / 写入在队列里进行
  hwSlot = slot;
  state.slot = slot;
  saveSlotState();
  if (state.curIndex !== p) {
    state.curIndex = p;
    persist();
  }
  const head = `hw slot ${fromSlot + 1} → ${slot + 1}, profile ${from + 1} → ${p + 1}`;
  return queueSlotJob(`enter:${slot}:${p}`, (dev) =>
    loadIntoSlot(dev, p, head, { aligned: slotContent[slot] === p, settle: fromSlot !== slot })
  );
}

/** 点击板载配置 p：写进鼠标当前所在的硬件槽位 */
function queueProfileLoad(p) {
  const from = state.curIndex;
  state.curIndex = p; // 界面立即切换，写入在队列里进行
  persist();
  return queueSlotJob(`load:${p}`, (dev) => {
    const head = `click profile ${from + 1} → ${p + 1} (hw slot ${hwSlot + 1})`;
    return loadIntoSlot(dev, p, head, { aligned: slotContent[hwSlot] === p });
  });
}

/** 原版 connectDevice 的第二阶段：载入本地配置，进入设置界面 */
function enterDevice(dev, keyMap, quick = null) {
  state.device = dev;
  Object.assign(state.info, {
    devname: dev.devname,
    sensor: dev.sensor,
    wireless: dev.iswireless,
    is8K: dev.is8KReceiver,
    pink: dev.isPink,
    power: dev.power, // 取自 137 回包（无效时为 -1，等待设备主动上报）
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
  // 先用上次记住的配置；连接时读到的设置能认出硬件槽位时以它为准，否则等第一个状态包
  let idx = index;
  if (idx == null || idx < 0 || idx > 3) idx = 0;
  state.curIndex = idx;
  state.slot = null;
  slotSynced = loadSlotSynced(dev.devname, state.firstRun);
  const ss = loadSlotState(dev.devname);
  hwSlot = ss ? ss.hw : idx;
  slotContent = ss ? ss.content : [0, 1, 2, 3];
  // 连接时读到的设置正好只和某一个硬件槽位里装的配置一致：鼠标多半就在那个槽位，先这样显示，不用等状态包。
  // 还在上次的槽位：保持上次的配置；换过槽位（软件关闭期间按了切换键）：切到同编号的板载配置。
  // 这只用于显示：是否需要写入仍以随后的状态包为准（例如换过接收器时可能认错），认错了状态包到达时会纠正
  const found = identifySlot(quick, dev);
  if (found) {
    logEvent(`connect: settings match hw slot ${found.slot + 1} (holds profile ${found.profile + 1}), last known hw slot ${hwSlot + 1} (profile ${idx + 1})`);
    if (found.slot !== hwSlot) idx = found.slot;
    hwSlot = found.slot;
    state.curIndex = idx;
    state.slot = hwSlot;
    saveSlotState();
  }
  slotKnown = false;
  slotPending = null;
  lastSlotSeen = null;
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

  lastStatus = null;
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

/** 状态包里的回报率 / DPI 档 / 板载序号 / 充电变化记入事件日志（例如按鼠标上的回报率键会体现在这里） */
let lastStatus = null;
function logStatusChange(s) {
  const p = lastStatus;
  lastStatus = s;
  if (!p) return logEvent(`status first: rate=${s.rate} dpi#=${s.dpiIndex} profile=${s.profileIndex} power=${s.power} charging=${s.charging}`);
  const diff = [];
  if (p.rate !== s.rate) diff.push(`rate ${p.rate}→${s.rate}`);
  if (p.dpiIndex !== s.dpiIndex) diff.push(`dpi# ${p.dpiIndex}→${s.dpiIndex}`);
  if (p.profileIndex !== s.profileIndex) diff.push(`profile ${p.profileIndex}→${s.profileIndex}`);
  if (p.charging !== s.charging) diff.push(`charging ${p.charging}→${s.charging}`);
  if (diff.length) logEvent(`status: ${diff.join(', ')}${state.applying ? ' (while applying)' : ''}`);
}

/** 原版 irServer：处理鼠标主动上报的状态 */
function onStatus(e) {
  const s = e.detail;
  logStatusChange(s);
  lastSlotSeen = s.profileIndex;
  // 界面显示的电量 / 充电 / 回报率随时更新（写入期间、换槽位时也一样），只有改写配置要等写入结束
  state.info.charging = s.charging;
  state.info.power = s.power;
  if (s.rate) state.info.rate = s.rate;
  // 鼠标换了硬件槽位（按了鼠标上的配置切换键）：界面立即切到同编号的板载配置（写入期间也一样，
  // 正在进行的写入会自行停止）；刚连接、鼠标仍在上次的槽位时保持上次的配置（可能是点选的）
  if (!slotKnown || s.profileIndex !== hwSlot) {
    const keep = !slotKnown && s.profileIndex === hwSlot;
    slotKnown = true;
    queueSlotEnter(s.profileIndex, keep);
    return; // 这个状态包里的回报率 / DPI 档属于新槽位，读取时一并处理
  }
  if (state.applying || slotPending != null) return;
  statusSeen = true;
  if (s.rate) {
    const pf = curProfile.value;
    // 非 8K 连接下配置里的 2000+ Hz 按 1000 Hz 写入（writableRate），鼠标随后上报的 1000 只是降级，
    // 不能据此改写配置：否则在 1K 接收器下切到这些配置后，换回 8K 接收器时原来的回报率就丢了
    if (pf && pf.usbrate !== s.rate && state.device?.writableRate(pf.usbrate) !== s.rate) {
      pf.usbrate = s.rate;
      persist();
    }
  }
  setCurDpi(s.dpiIndex);
}

export async function disconnect(reason = 'user') {
  const dev = state.device;
  logEvent(`disconnect (${reason})${queue.length ? `, ${queue.length} pending job(s) dropped` : ''}`);
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
    logEvent(`hid disconnect event ${e.device.productId?.toString(16)} "${e.device.productName || ''}"`);
    if (state.device && state.device.hid === e.device) {
      disconnect('device removed').then(() => setTimeout(autoConnect, 400));
    }
  });
  navigator.hid.addEventListener('connect', (e) => {
    logEvent(`hid connect event ${e.device.productId?.toString(16)} "${e.device.productName || ''}"`);
    if (state.phase === 'welcome') setTimeout(autoConnect, 500);
  });
}

/* --------------------------------------------------------------- 板载配置 */

/** 点击界面上的配置槽位：把它写进鼠标当前所在的硬件槽位（鼠标没有由软件换槽位的命令） */
export function requestProfile(index) {
  if (index === state.curIndex || index < 0 || index > 3 || !state.device) return;
  return queueProfileLoad(index);
}

/** 把当前配置完整写入鼠标当前槽位 */
export function writeCurrentProfile() {
  markWritten();
  logEvent(`write profile ${state.curIndex + 1} into hw slot ${hwSlot + 1}`);
  return chunk86(C.apALL, 255, { overlay: true });
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
  if (!p.initByText(text)) {
    logEvent('import profile: parse failed');
    return toast(t.value.importFailed, 'error');
  }
  if (p.dpisensor !== state.info.sensor) {
    logEvent(`import profile: wrong sensor ${p.dpisensor} ≠ ${state.info.sensor}`);
    return toast(t.value.importWrongSensor, 'error');
  }
  logEvent(`import profile into ${state.curIndex + 1}`);
  const cur = curProfile.value;
  p.name = cur.name;
  p.uid = cur.uid;
  p.inside = true;
  state.profiles.list[state.curIndex] = p;
  state.firstRun = false;
  const ok = await writeCurrentProfile();
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
    // "配置切换"键同步到全部 4 个板载配置（原版 onButtonSet：只有这一个键会同步）
    for (let i = 0; i < C.MAX_ONBOARD; i++) if (list[i]) list[i].key[btn] = kf.copy();
  } else if (pf.key[btn].major === C.fMouse && pf.key[btn].minor === C.favProfile) {
    // 取消"配置切换"键时，其它配置的该键恢复默认
    // （原版的跳过条件误写成 i==按键序号，会让某个配置残留切换键，这里按本意修正）
    for (let i = 0; i < C.MAX_ONBOARD; i++) {
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
  if (effectiveRate.value < 2000) chunk86(C.apSensorMode, 0);
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
  // 原版 receiverLEDClick：只改当前配置（配置文件里每个配置各记一份）
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
  logEvent(`factory reset profile ${state.curIndex + 1}`);
  pf.reset(C.dvar, state.info.sensor);
  markWritten();
  return chunk86(C.apALL | C.apReset, 255, { overlay: true });
}

/* ------------------------------------------------------------------- 宏 */

export function createMacro(name) {
  const m = new STMacro(name || t.value.macroUntitled);
  state.macros.list.push(m);
  saveMacros(state.macros);
  return state.macros.list[state.macros.list.length - 1];
}

/** 宏在全部 4 个板载配置中的使用情况：[{ profile, button }] */
export function macroUsage(uid) {
  const out = [];
  state.profiles.list.forEach((pf, p) =>
    pf.key.forEach((k, i) => {
      // eslint-disable-next-line eqeqeq
      if (k.major === C.fJuji && k.itemdata == uid) out.push({ profile: p, button: i });
    })
  );
  return out;
}

/** 配置 pf 里绑定了宏 uid 的按键序号 */
function macroButtons(pf, uid) {
  // eslint-disable-next-line eqeqeq
  return pf ? pf.key.map((k, i) => (k.major === C.fJuji && k.itemdata == uid ? i : -1)).filter((i) => i >= 0) : [];
}

/** 把绑定了宏库中已不存在的宏的按键恢复为默认功能（index = 255 表示全部按键），返回被恢复的按键序号 */
function dropMissingMacros(pf, index = 255) {
  const fixed = [];
  pf.key.forEach((k, i) => {
    if ((index === 255 || i === index) && k.major === C.fJuji && !state.macros.find(k.itemdata)) {
      pf.key[i] = C.dvar.key[i].copy();
      fixed.push(i);
    }
  });
  return fixed;
}

export async function updateMacro(uid, data) {
  const m = state.macros.find(uid);
  if (!m) return;
  m.name = data.name;
  m.looptype = data.looptype;
  m.cycle = data.cycle;
  m.item = data.item;
  saveMacros(state.macros);
  // 按键写进鼠标后 4 个硬件槽位都生效（固件共用）：只重写当前配置里用到这个宏的按键
  const used = macroButtons(curProfile.value, uid);
  if (used.length && state.device) {
    toast(t.value.macroResync, 'info');
    for (const b of used) await chunk86(C.apKey, b, { overlay: true });
  } else {
    toast(t.value.macroSaved, 'success');
  }
}

export async function deleteMacro(uid) {
  const n = macroUsage(uid).length;
  const message = n ? t.value.macroDeleteUsedMsg(n) : t.value.macroDeleteMsg;
  const ok = await confirmDialog({ title: t.value.delete, message, danger: true, okText: t.value.delete, icon: 'warn' });
  if (!ok) return false;
  const used = macroUsage(uid);
  state.macros.remove(uid);
  saveMacros(state.macros);
  if (!used.length) return true;
  // 与原版不同：绑定该宏的按键恢复默认，否则界面仍显示"宏"，鼠标里也还是旧宏
  const inMouse = macroButtons(curProfile.value, uid);
  for (const pf of state.profiles.list) for (const b of macroButtons(pf, uid)) pf.key[b] = C.dvar.key[b].copy();
  persist();
  if (state.device) for (const b of inMouse) chunk86(C.apKey, b);
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

export const isDesktop = !!desktop;
export const isMock = USE_MOCK;

// 仅模拟/调试模式：暴露给截图与调试脚本
if ((USE_MOCK || /[?&]debug\b/.test(location.search)) && typeof window !== 'undefined') window.__app = { state, settings, saveSettings };
