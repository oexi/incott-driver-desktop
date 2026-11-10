// 应用状态与业务逻辑——对应原版 chunk-v1013.js 中的界面逻辑（connectDevice / onBoardClick /
// assignKEY / dpi* / usbrate_* / chunk86 + SerialProcess 等），去掉 DOM 操作后保留相同的写入行为。

import { reactive, markRaw, computed } from 'vue';
import * as C from './protocol/constants.js';
import { IncottDevice, sleep, keyToHw, hwToKey } from './protocol/device.js';
import { StProfile, StProfileList, saveProfiles, loadProfiles } from './protocol/profile.js';
import { STMacro, STMacroList, saveMacros, loadMacros, macroToHw } from './protocol/macro.js';
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
  curIndex: 0, // 当前配置（板载配置时就是鼠标的硬件槽位；电脑端配置时切换就写进鼠标）
  hwSlots: false, // 板载配置：鼠标固件支持由软件切换硬件槽位（1.4.x），配置 N = 槽位 N
  slot: null, // 鼠标报告的硬件槽位（连接时 [0x85,6] 或状态包）
  switchTo: null, // 正在切换 / 写进鼠标的配置（页头按钮显示转圈）
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
/**
 * 「最高性能」（官方新版桌面驱动 str_Highfps）：只有 1.4.x 固件的 PAW3950 支持（IDA：传感器驱动按传感器模式最高位换参数；
 * 1.3.8 的 3950 固件和所有 3395 固件都没有）。1.4.x 用板载配置是否可用来判断（连接时的槽位探测）。
 * 不支持的固件收到带最高位的模式值可能会配置错传感器，所以不支持时既不显示也不写
 */
export const hiFpsSupported = computed(() => state.hwSlots && state.info.sensor === C.SENSOR_3950);
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
  // 板载配置：点了别的配置、鼠标还没切过去时就改了它——进入那个槽位时以配置为准写进去，不能把槽位里的旧值读回来
  if (state.hwSlots && state.curIndex !== hwSlot) setSlotState(state.curIndex, 'stale');
  return new Promise((resolve) => {
    // profile：这个修改属于哪个配置（板载配置时排队期间可能切走了，写之前核对）
    queue.push({ flag, index, overlay, resolve, profile: state.curIndex });
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
  const all = C.apALL & ~C.apOnboardIndex;
  if ((flag & all) === all) return ['ALL', ...FLAG_NAMES.filter(([b]) => (b > C.apALL || b === C.apOnboardIndex) && flag & b).map(([, n]) => n)].join('+');
  return FLAG_NAMES.filter(([b]) => flag & b).map(([, n]) => n).join('+') || String(flag);
}

/**
 * 把任意异步任务放进写入队列（与 chunk86 串行，执行期间 state.applying = true，状态包暂不处理）。
 * superseded()：任务执行前已经被取代（例如连点了几个配置），执行时会直接跳过，不用先确认鼠标醒着
 */
function enqueue(run, { superseded = null } = {}) {
  return new Promise((resolve) => {
    queue.push({ run, resolve, superseded });
    state.pending++;
    if (!processing) processQueue();
  });
}

async function processQueue() {
  processing = true;
  let allOk = true;
  // 写入开始前记下"没写完"：中途断开的话，下次连接时把配置补写进去
  if (state.device) setPending(true);
  while (queue.length) {
    const job = queue[0];
    const dev = state.device;
    let ok = false;
    if (job.overlay) state.progress = { visible: true, pct: 0 };
    // 要发给鼠标的任务先确认鼠标醒着（只是记下"以后再写"的、已被取代的不用）
    const deferred = !job.run && dev && state.hwSlots && job.profile !== hwSlot;
    const what = job.run ? 'sync' : `apply ${flagNames(job.flag)}`;
    // 不用问时不 await：任务和以前一样立即开始（连点配置时第一个点的已经开始写）
    const awake = !dev || deferred || !!job.superseded?.() || !mayBeAsleep(dev) || (await ensureOnline(dev, what));
    const woke = awake === 'woke';
    if (!awake) {
      logEvent(`${what} skipped: the mouse did not wake up`);
      // 配置里已经是新值、鼠标里还不是：标记这个槽位，下次进入时以配置为准写进去
      if (!job.run && state.hwSlots) setSlotState(job.profile, 'stale');
      // 跳过的是最新的切换任务：它不会再执行，也就不会清掉 syncQueued——不清的话之后的状态包都会被忽略
      if (job.run && !job.superseded?.()) syncQueued = false;
      // 切换配置还没开始就因为鼠标没醒放弃了：界面回到鼠标实际所在的槽位（以前停在新点的配置上，和鼠标对不上；
      // 实测 G23V2：从配置 4 点配置 1 后界面是配置 1、鼠标还在槽位 4）。等待期间又点了别的配置的不退，让新的那个接着来
      if (job.run && state.hwSlots && !job.superseded?.() && state.curIndex !== hwSlot) {
        logEvent(`profile ${state.curIndex + 1} not reached: back to profile ${hwSlot + 1}, where the mouse is`);
        state.curIndex = hwSlot;
        persist();
      }
    } else if (job.run) {
      state.applying = true;
      try {
        ok = !!(await job.run());
      } catch (err) {
        console.error('[queue]', err);
        logEvent(`queue job FAILED: ${err?.message || err}`);
        ok = false;
      }
      state.applying = false;
    } else if (dev && state.hwSlots && job.profile !== hwSlot) {
      // 板载配置：修改的是别的槽位的配置（排队期间切走了）——记下，进入那个槽位时写进去
      setSlotState(job.profile, 'stale');
      logEvent(`apply ${flagNames(job.flag)} for profile ${job.profile + 1} deferred: the mouse is in slot ${hwSlot + 1}`);
      ok = true;
    } else if (dev && state.hwSlots && (woke || slotGuess || slotUnsure) && !(await confirmSlot(dev, job))) {
      ok = true; // 鼠标在别的槽位：修改已记到配置上，进入那个槽位时写进去
    } else if (dev && curProfile.value) {
      const pf = state.hwSlots ? state.profiles.list[job.profile] : curProfile.value;
      // 绑定了已不存在的宏的按键先恢复默认，让界面与写入鼠标的内容一致
      if (job.flag & C.apKey) {
        const fixed = dropMissingMacros(pf, job.index);
        if (fixed.length) {
          persist();
          toast(t.value.macroMissingReset(fixed.length), 'warn', 4500);
        }
      }
      // 板载配置：写入期间槽位不一定和配置一致，写完恢复原来的状态
      const slot = hwSlot;
      const before = slotStates[slot];
      if (state.hwSlots) setSlotState(slot, 'stale');
      state.applying = true;
      const started = Date.now();
      try {
        ok = await applyToMouse(dev, pf, job.flag, job.index, {
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
      // 写入期间鼠标上的键换了槽位：这个修改没写进原来的槽位
      if (state.hwSlots) setSlotState(slot, ok && hwSlot === slot ? before : 'stale');
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
    if (!ok && state.device) {
      if (awake) toast(t.value.applyFailed, 'error', 4500);
      else toast(job.run && state.hwSlots ? t.value.slotSwitchNoWake : t.value.mouseAsleepFailed, 'error', 7000);
    }
    allOk &&= ok;
    const i = queue.indexOf(job);
    if (i >= 0) {
      // 断开连接时队列会被清空，此时任务已在 disconnect 中结算
      queue.splice(i, 1);
      state.pending = Math.max(0, state.pending - 1);
      job.resolve(ok);
    }
    if (queue.length) await sleep(100);
  }
  if (allOk && state.device) setPending(false);
  processing = false;
}

/**
 * 鼠标休眠（或离线）时写命令照样"发送成功"——接收器收下了，但送不送得到鼠标说不准。实测 G23V2 + 8K 接收器：休眠时
 * 8E 01 的在线标志为 0、转发给鼠标的读命令只回全 0；睡着时单独写一条，醒来后生效了，连写 3 条再切换槽位，醒来后全都没生效。
 * 所以无线时写之前先问一次接收器；3 秒内收到过状态包（醒着时约每 2 秒一个）或确认过在线就不用问。
 * 不在线就提示动一下鼠标，最多等 WAKE_TRIES 次（约 15 秒）。
 */
const WAKE_TRIES = 50;
const AWAKE_RECENT = 3000;
/** 需不需要先问：有线、不认识 8E 的固件（没法判断）、刚收到过状态包或刚确认过在线时都不用（1K 接收器收不到状态包，拖动滑块时不必每次都问） */
function mayBeAsleep(dev) {
  return dev.iswireless && dev.linkOnline != null && Date.now() - Math.max(dev.lastInputAt, dev.lastOnlineAt) >= AWAKE_RECENT;
}

/** 返回 true（在线）/ 'woke'（等它醒过来了）/ false（没醒） */
async function ensureOnline(dev, what) {
  if (!(await dev.readMatchInfo()) || dev.linkOnline !== 0) return true;
  logEvent(`${what}: mouse offline (asleep?), waiting for it to wake up`);
  toast(t.value.mouseAsleep, 'warn', 6000);
  const ok = await dev.waitOnline(WAKE_TRIES);
  logEvent(`${what}: mouse ${ok ? 'woke up' : 'did not wake up'} after ${dev.onlineWaitMs}ms`);
  return ok && 'woke';
}

/**
 * 板载配置：鼠标刚醒、或软件还不确定它在哪个槽位时，写之前先读一次槽位。睡着前鼠标可能已经换了槽位（切换后马上睡着、
 * 连接时没回答只能猜），直接写会写进别的槽位，再被那个配置读走。返回能不能照常写；不能时这个修改记到配置上，界面跟到鼠标那里
 */
async function confirmSlot(dev, job) {
  const q = await dev.readHwSlot();
  if (state.device !== dev) return false;
  if (q == null) return true; // 读不到：照旧
  const guessed = slotGuess;
  slotGuess = false;
  slotUnsure = false;
  if (q === hwSlot) {
    if (guessed) {
      logEvent(`onboard slots: slot ${hwSlot + 1} confirmed before writing`);
      queueSync(hwSlot);
    }
    return true;
  }
  setSlotState(job.profile, 'stale');
  logEvent(`apply ${flagNames(job.flag)} for profile ${job.profile + 1} deferred: the mouse is actually in slot ${q + 1}`);
  followHw(q);
  return false;
}

/** 刚才的命令没有回应时，鼠标是不是掉线了（接收器报告不在线）。有线、读不到在线标志时算在线 */
async function mouseWentOffline(dev) {
  if (!dev.iswireless || dev.linkOnline == null) return false;
  return (await dev.readMatchInfo()) && dev.linkOnline === 0;
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

/**
 * 自动扫描已授权设备并连接。同一时间只跑一个：插上接收器时 Windows 会连发好几个 connect 事件（一个接口一个），
 * 以前每个都开始一次连接，第二个 open() 报 InvalidStateError，还把"连接失败"提示留在了连接成功的界面上（issue #11）。
 * 扫描期间又被调用的，等这次扫描结束、还没连上时再扫一次（设备可能是在扫描之后才出现的）。
 */
let autoRun = null;
let autoAgain = false;
export function autoConnect() {
  if (autoRun) {
    autoAgain = true;
    return autoRun;
  }
  autoRun = (async () => {
    try {
      do {
        autoAgain = false;
        await scanAndConnect();
      } while (autoAgain && state.phase === 'welcome');
    } finally {
      autoRun = null;
    }
  })();
  return autoRun;
}

async function scanAndConnect() {
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
  // 诊断正在临时打开设备（见 diagnostics.js probe）：它结束时会关掉设备，这时连接会连上一个随后被关掉的设备
  if (diag.running) return;
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

/** 正在进行的连接：自动连接和用户点击可能同时到达，第二个直接等第一个的结果 */
let connectRun = null;
function connectTo(hid) {
  if (!connectRun) connectRun = doConnect(hid).finally(() => (connectRun = null));
  return connectRun;
}

async function doConnect(hid) {
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
  // 和官方新版桌面驱动一样，先问鼠标在哪个硬件槽位（[0x85,6]，1.4.x 固件才有）
  let hw = null;
  try {
    hw = await dev.probeHwSlot();
  } catch (err) {
    console.warn('[probeHwSlot]', err);
  }
  // 和官方桌面驱动一样，连接时先读出鼠标里的全部设置（sub_4323B0）
  let raw = null;
  try {
    raw = await dev.readSlot(C.getStDPI(dev.sensor)?.dpi.length ?? 6);
  } catch (err) {
    console.warn('[readSlot]', err);
  }
  const waited = dev.onlineWaitMs == null ? '' : ` (mouse ${dev.linkOnline === 0 ? 'still offline' : 'came online'} after ${dev.onlineWaitMs}ms)`;
  logEvent(
    `connected ${dev.devname} code=${dev.modelCode} sensor=${dev.sensor.toString(16)} wireless=${dev.iswireless} 8K=${dev.is8KReceiver} rate=${dev.curUSBRate} dpi=${dev.curDpi}/${dev.dpiLevels} power=${dev.power} onboard=${dev.curOnBoard} hwSlot=${hw == null ? '-' : hw + 1}${waited}`
  );
  if (raw) {
    const keys = raw.keys.map((c) => (c == null ? '-' : (c >>> 0).toString(16))).join(' ');
    const star = raw.starZero ? ' (desktop-driver read commands replied all zeros: treated as unknown)' : '';
    logEvent(`mouse settings: rate=${raw.rate} dpi=${raw.cur}/${raw.levels} [${raw.dpi.join(' ')}] lod=${raw.lod} debounce=${raw.debounce} sleep=${raw.sleeptime} keys=${keys}${star}`);
  }
  diag.connecting = null;
  enterDevice(dev, raw, hw);
  if (dev.iswireless && dev.linkOnline === 0) watchOnline(dev);
}

/**
 * 连接时等了几秒鼠标还是不在线（鼠标没开、在蓝牙模式、配对丢失）：照旧进入界面，但读到的设置都是空的。
 * 之后每隔 OFFLINE_POLL 问一次接收器，鼠标一上线就重新连接，把设置重新读一遍。写入、诊断进行中时不问。
 */
const OFFLINE_POLL = 2000;
function watchOnline(dev) {
  logEvent(`mouse offline at connect: checking every ${OFFLINE_POLL / 1000} s, will reconnect when it comes online`);
  const tick = async () => {
    if (state.device !== dev) return;
    if (!diag.running && !state.applying && state.pending === 0) {
      await dev.readMatchInfo();
      if (state.device !== dev) return;
      if (dev.linkOnline === 1) {
        logEvent('mouse came online: reconnecting to read its settings');
        await disconnect('mouse came online');
        return autoConnect();
      }
    }
    setTimeout(tick, OFFLINE_POLL);
  };
  setTimeout(tick, OFFLINE_POLL);
}

/* ------------------------------------------------------------- 板载配置 */

// 连接时按固件决定用哪种方式（state.hwSlots）：
//
// 一、板载配置（固件 1.4.x，与官方新版桌面驱动 incott-app 1.4.0.3 相同，IDA 分析）：配置 1–4 就是鼠标里的硬件槽位 1–4，
//    每个槽位各存一整套设置（回报率、DPI、传感器、消抖、休眠、按键与宏），关掉软件后鼠标上的「配置切换」键照样能用。
//   · 连接时用 [0x85,6] 读出鼠标在哪个槽位，直接显示那个配置，不用等状态包；
//   · 点击配置 N 发 [5,6,N]，鼠标自己载入槽位 N，并发一个状态包（据此确认切换成功，顺便得到电量）。官方随后把整个槽位
//     读回来；这里记着本次连接中每个槽位里写过 / 读过什么，已知的槽位不用再读，配置在别的槽位时改过的项进入时补写；
//   · 鼠标上的「配置切换」键换了槽位：界面跟着切（状态包第 3 字节高 2 位）；
//   · 「配置切换」键由固件统一保存（设上或换掉时 4 个槽位一起改），软件里的 4 个配置也一起改；和官方一样不能设在左 / 右键上。
//   每个槽位记一个状态（hwslots_<型号>）：
//     fresh  —— 配置还没有内容（首次使用）：第一次进入时把槽位读进配置，不写入；
//     synced —— 上次离开时槽位就是这个配置：进入时把软件外改过的项（鼠标上的 DPI 键、别的驱动……）读进配置；
//     stale  —— 槽位里不一定是这个配置（写到一半断开、从电脑端配置升级、在别的槽位时改了它）：进入时把配置写进去。
//   切换没有得到鼠标确认（固件其实不支持）时，本次连接退回电脑端配置。
//
// 二、电脑端配置（更早的固件，软件不能换槽位）：与官方旧版桌面驱动 GamingMouse.exe 相同（IDA 分析）：配置 1–4 保存在电脑上，
//    鼠标只用它当前所在的那一个槽位。
//   · 连接时（sub_436430 → 线程 sub_4323B0）把鼠标里的设置读进当前配置，不写入；
//   · 切换 / 导入 / 恢复默认时（线程 StartAddress）把整套设置写进鼠标；
//   · 不看状态包里的槽位序号，不发 [6,9,序号]，没有「配置切换」键。
//   在官方做法上的改进：
//   · 软件记着鼠标里现在的设置（mouse），切换配置时只写不一样的项，不用先读，一般零点几秒（官方每次整套重写）；
//   · 写入前记下"没写完"，写完才清除：中途断开（关软件、拔接收器）的话下次连接把配置补写完，
//     不会像官方那样把写了一半的鼠标设置读回配置；
//   · 连接时只把软件外改过的项读进当前配置，X / Y 分开的 DPI 不受影响；
//   · 鼠标仍有按键是「配置切换」时：连接时恢复成该键默认功能；用它换了槽位就立即把当前配置补写进新槽位；
//   · 连点几个配置时只写最后点的那个。

const WRITE_ALL = C.apALL & ~C.apOnboardIndex; // 整套写入，不含 [6,9,序号]（官方桌面驱动不发）
const SWITCH_CODE = keyToHw(new C.KeyInfo(C.fMouse, C.favProfile), 0) >>> 0;

let mouse = null; // 软件所知的鼠标当前槽位的设置（readSlot 的格式，读不到的项为 null；整个为 null = 不知道，写之前先读）
let lastHwSlot = null; // 电脑端配置：状态包报告的槽位序号，只用来发现鼠标换了槽位
let syncToken = 0; // 写配置任务的序号：新的取代还没开始的旧任务
let syncQueued = false; // 有排队还没开始的写配置任务
let macroHw = {}; // 鼠标（板载配置时是当前槽位）里每个按键当前装着的宏（签名）：宏的按键码只含按键序号，读回来分不出是哪个宏

// 板载配置
let hwSlot = 0; // 鼠标实际所在的硬件槽位（state.curIndex 是界面上的，点击后先变，切换完成才一致）
let slotMem = [null, null, null, null]; // 其它槽位里已知的设置（mouse 是当前槽位那一份，切走时存到这里）
let slotStates = ['fresh', 'fresh', 'fresh', 'fresh'];
let switching = null; // 正在由软件切换到的槽位
let switchSeen = false; // 已收到确认切换的状态包
let followAfter = null; // 切换期间鼠标上的键又换到的槽位
let slotGuess = false; // 槽位是按上次的记录猜的（无线时鼠标没回答，可能在休眠），等第一个状态包确认
let slotUnsure = false; // 切换后鼠标睡着了、界面退回了原来的配置：鼠标实际可能已经在新槽位，下一个状态包或写入前读一次确认
const SLOT_STATES = ['fresh', 'synced', 'stale'];

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function saveJson(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key, v) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

// 宏签名：电脑端配置一份；板载配置每个槽位一份
const macroHwKey = (devname, slot = null) => (slot == null ? `macrohw_${devname}` : `macrohw_${devname}@${slot + 1}`);
const pendingKey = (devname) => `pendingwrite_${devname}`;
const modeKey = (devname) => `profilemode_${devname}`; // 'pc' | 'slots'
const slotStateKey = (devname) => `hwslots_${devname}`;
// 首次使用时鼠标不在线（无线鼠标在休眠 / 没开）：配置只是默认值，下次连上时仍按首次使用从鼠标读进来
const unreadKey = (devname) => `profilesunread_${devname}`;
// 旧版本（跟随硬件槽位）留下的记录
const LEGACY_KEYS = ['slotsync_', 'slotstate_', 'softswitch_', 'statusseen_'];

function loadMacroHw(slot) {
  const mh = loadJson(macroHwKey(state.info.devname, slot));
  return mh && typeof mh === 'object' && !Array.isArray(mh) ? mh : {};
}
function saveMacroHw() {
  saveJson(macroHwKey(state.info.devname, state.hwSlots ? hwSlot : null), macroHw);
}

/** 电脑端配置：鼠标可能和当前配置不一致（写入开始时记下，全部写完才清除；下次连接时据此补写）。板载配置用槽位状态 */
function setPending(on) {
  if (state.info.devname && !state.hwSlots) lsSet(pendingKey(state.info.devname), on ? String(state.curIndex) : null);
}

function setSlotState(p, st) {
  if (slotStates[p] === st) return;
  slotStates[p] = st;
  saveJson(slotStateKey(state.info.devname), slotStates);
}

export const isSwitchKey = (k) => !!k && k.major === C.fMouse && k.minor === C.favProfile;
const isLeftKey = (k) => !!k && k.major === C.fMouse && k.minor === C.fmsCLICK;
const sameKey = (a, b) => a.major === b.major && a.minor === b.minor && (a.modifer || 0) === (b.modifer || 0) && a.itemdata === b.itemdata;

/** 这个按键能不能设成「配置切换」：只有板载配置有；和官方一样左 / 右键不行（官方提示 str_msg13） */
export const canSwitchKey = (btn) => state.hwSlots && btn >= 2;

/** 电脑端配置不支持「配置切换」：恢复为该键的默认功能，返回改动的按键序号 */
export function dropSwitchKeys(pf) {
  const out = [];
  pf.key.forEach((k, i) => {
    if (!isSwitchKey(k)) return;
    pf.key[i] = C.dvar.key[i].copy();
    out.push(i);
  });
  return out;
}

/** 板载配置：左 / 右键上的「配置切换」（例如网页驱动导出的配置）恢复为默认功能 */
function dropSwitchOnMainKeys(pf) {
  const out = [];
  pf.key.forEach((k, i) => {
    if (i >= 2 || !isSwitchKey(k)) return;
    pf.key[i] = C.dvar.key[i].copy();
    out.push(i);
  });
  return out;
}

/**
 * 板载配置：配置 p 的按键 b 改成了 / 不再是「配置切换」——固件把这个按键写进全部 4 个槽位，
 * 别的配置也改成一样的；那些槽位里记着的按键码作废，进入时照写一次（是宏时连宏一起写）。
 */
function shareKey(p, b) {
  const k = state.profiles.list[p].key[b];
  state.profiles.list.forEach((o, q) => {
    if (q === p) return;
    o.key[b] = k.copy();
    if (slotMem[q]) slotMem[q].keys[b] = null;
  });
}

/** 板载配置：old 是配置 p 改动前的按键；涉及「配置切换」的按键同步到全部配置 */
function shareSwitchChanges(p, old) {
  const pf = state.profiles.list[p];
  let n = 0;
  pf.key.forEach((k, b) => {
    if ((isSwitchKey(k) || isSwitchKey(old[b])) && !sameKey(k, old[b])) {
      shareKey(p, b);
      n++;
    }
  });
  return n;
}

/** 板载配置：从槽位读进配置 p 之后，让「配置切换」键在 4 个配置里一致（以刚读到的为准） */
function alignSwitchKeys(p) {
  const pf = state.profiles.list[p];
  pf.key.forEach((k, b) => {
    const others = state.profiles.list.filter((o, q) => q !== p);
    if (isSwitchKey(k) ? others.some((o) => !sameKey(o.key[b], k)) : others.some((o) => isSwitchKey(o.key[b]))) shareKey(p, b);
  });
}

/** 宏写进鼠标的内容签名（按键序号也编在里面） */
function macroSig(m, i) {
  const b = m && macroToHw(m, i);
  if (!b) return null;
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193);
  return (h >>> 0).toString(16);
}

/** 实际写入的按键：绑定的宏已不存在时按默认功能（与 device.apply 一致） */
function effectiveKey(pf, i) {
  const k = pf.key[i];
  return k.major === C.fJuji && !state.macros.find(k.itemdata) ? C.dvar.key[i] : k;
}

const blankMouse = () => ({ rate: null, levels: null, cur: null, dpi: [], dpiy: [], lod: null, ripple: null, fixline: null, motion: null, sensormode: null, debounce: null, fire: null, sleeptime: null, keys: [], receiverLED: null });

/** 写入成功后更新 mouse：与 device.apply 写入的项目一一对应 */
function trackWrite(m, pf, flag, index, dev, { sensorModeHi = 0, sensorModeAnyRate = false } = {}) {
  if (flag & C.apKey) {
    pf.key.forEach((_, i) => {
      if (index !== 255 && i !== index) return;
      const k = effectiveKey(pf, i);
      m.keys[i] = keyToHw(k, i);
      if (k.major === C.fMouse && k.minor === C.favFIRE) m.fire = [Math.min(k.itemdata & 65535, 3), Math.min((k.itemdata >> 16) & 65535, 255)];
    });
  }
  if (flag & C.apDpi) {
    pf.dpi.forEach((x, i) => {
      if (index !== 255 && i !== index) return;
      m.dpi[i] = C.getHwForDpi(x, dev.sensor);
      (m.dpiy ||= [])[i] = C.getHwForDpi(pf.dpiy[i], dev.sensor);
    });
  }
  if (flag & C.apDpiLevel) {
    m.levels = pf.dpi.length;
    m.cur = Math.min(pf.curDpi, pf.dpi.length - 1);
  }
  const rate = dev.writableRate(pf.usbrate);
  if (flag & C.apRate) m.rate = rate;
  // 与 device.apply 写的字节一致（含最高位：PAW3950「最高性能」）
  if (flag & C.apSensorMode && (rate < 2000 || sensorModeAnyRate)) m.sensormode = pf.sensormode | (sensorModeHi & C.SENSOR_MODE_HIFPS);
  if (flag & C.apLod) m.lod = C.lodToHw(pf.lod, dev.sensor);
  if (flag & C.apSensor) {
    if (index & 1) m.ripple = pf.ripple ? 1 : 0;
    if (index & 2) m.fixline = pf.fixline ? 1 : 0;
    if (index & 4) m.motion = pf.motion ? 1 : 0;
  }
  if (flag & C.apReceiverLED && dev.is8KReceiver) m.receiverLED = pf.receiverLED;
  if (flag & C.apDebounce) m.debounce = Math.min(pf.debounce, C.DEBOUNCE_MAX);
  if (flag & C.apSleepTime) m.sleeptime = Math.max(pf.sleeptime, 10);
}

/** dev.apply 的包装：记下写进鼠标的内容；写入失败时鼠标里是什么就不确定了 */
async function applyToMouse(dev, pf, flag, index, opts = {}) {
  // profileIndex: null —— 不写 [6,9,序号]
  // 传感器模式的最高位（PAW3950「最高性能」）：支持时按配置写；不支持时照鼠标（当前槽位）里原来的带上，免得关掉官方驱动开的
  const sensorModeAnyRate = hiFpsSupported.value;
  const sensorModeHi = sensorModeAnyRate ? (pf.hifps ? C.SENSOR_MODE_HIFPS : 0) : (mouse?.sensormode ?? 0) & C.SENSOR_MODE_HIFPS;
  const ok = await dev.apply(pf, flag, index, { macros: state.macros, ...opts, profileIndex: null, sensorModeHi, sensorModeAnyRate });
  if (flag & C.apKey) {
    pf.key.forEach((k, i) => {
      if (index !== 255 && i !== index) return;
      const m = k.major === C.fJuji ? state.macros.find(k.itemdata) : null;
      macroHw[i] = ok ? macroSig(m, i) : '?';
    });
    saveMacroHw();
  }
  if (!ok) mouse = null;
  else {
    // 整套写成功：不管之前知不知道，鼠标里现在就是这个配置
    if (!mouse && (flag & WRITE_ALL) === WRITE_ALL && index === 255) mouse = blankMouse();
    if (mouse) trackWrite(mouse, pf, flag, index, dev, { sensorModeHi, sensorModeAnyRate });
  }
  return ok;
}

/** 配置与鼠标里的设置比对，返回需要写入的 [flag, index]；不知道的项按需要写入处理 */
export function mouseDiff(pf, raw, dev) {
  const neq = (a, b) => a == null || a !== b;
  const jobs = [];
  const keys = [];
  pf.key.forEach((k0, i) => {
    const k = effectiveKey(pf, i);
    const code = keyToHw(k, i);
    if (code === -1) return;
    let diff = raw.keys[i] == null || raw.keys[i] >>> 0 !== code >>> 0;
    if (!diff && k.major === C.fMouse && k.minor === C.favFIRE) {
      const lp = Math.min(k.itemdata & 65535, 3);
      const ir = Math.min((k.itemdata >> 16) & 65535, 255);
      diff = !raw.fire || raw.fire[0] !== lp || raw.fire[1] !== ir;
    }
    // 按键码只说明这个键是宏，装的是哪个宏要看记录
    if (!diff && k0 === k && k.major === C.fJuji) diff = macroHw[i] !== macroSig(state.macros.find(k.itemdata), i);
    // 鼠标里是软件还原不了的按键码（例如官方驱动设的宏），软件也没往这里写过宏，而配置里这个键还是默认功能：是在别的驱动里
    // 设的，保留，不用默认功能把它覆盖掉（以前切换一次配置再切回来就被覆盖）。用户自己在软件里改这个键时照常写入（不经过这里）
    if (diff && raw.keys[i] != null && keyFromHw(raw.keys[i], raw.fire) == null && macroHw[i] == null && code >>> 0 === keyToHw(C.dvar.key[i], i) >>> 0) diff = false;
    if (diff) keys.push(i);
  });
  if (keys.length) jobs.push([C.apKey, keys.length === 1 ? keys[0] : 255]);
  const dpis = [];
  pf.dpi.forEach((x, i) => {
    const hw = C.getHwForDpi(x, dev.sensor);
    // 读到了 Y 就比 Y；没读到（旧版本记下的镜像、不分轴的传感器）时 X / Y 分开的档照写
    const ry = raw.dpiy?.[i];
    const yDiff = ry != null ? ry !== C.getHwForDpi(pf.dpiy[i], dev.sensor) : pf.dpiy[i] !== x;
    if (hw !== -1 && (yDiff || neq(raw.dpi[i], hw))) dpis.push(i);
  });
  if (dpis.length) jobs.push([C.apDpi, dpis.length === 1 ? dpis[0] : 255]);
  let flag = 0;
  if (neq(raw.levels, pf.dpi.length) || neq(raw.cur, Math.min(pf.curDpi, pf.dpi.length - 1))) flag |= C.apDpiLevel;
  const rate = dev.writableRate(pf.usbrate);
  if (neq(raw.rate, rate)) flag |= C.apRate;
  if (hiFpsSupported.value) {
    // 1.4 固件的 PAW3950：模式和「最高性能」一起比，回报率多少都写
    if (neq(raw.sensormode, pf.sensormode | (pf.hifps ? C.SENSOR_MODE_HIFPS : 0))) flag |= C.apSensorMode;
  } else if (rate < 2000 && neq(C.sensorModeOf(raw.sensormode), pf.sensormode)) flag |= C.apSensorMode;
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

/** 从鼠标读回的按键码还原按键功能（火力键带上读到的参数）；还原不了（宏）时为 null */
function keyFromHw(code, fire) {
  if (code == null) return null;
  if (code >>> 0 === keyToHw(new C.KeyInfo(C.fMouse, C.favFIRE), 0) >>> 0) {
    const k = new C.KeyInfo(C.fMouse, C.favFIRE);
    k.itemdata = fire ? ((fire[1] & 255) << 16) | (fire[0] & 3) : 40 << 16;
    return k;
  }
  return hwToKey(code);
}

/**
 * 把鼠标里和配置不一样的项读进配置（只改不一样的项，读不到的不动），返回改了哪些。
 * 对应官方连接时的 sub_4323B0（它整套读进来）；这里只动不同的项，X / Y 分开的 DPI 在 X 没变时保留。
 */
function adoptFromMouse(pf, raw, dev, { receiverLED = true } = {}) {
  const changed = new Set();
  const st = C.getStDPI(dev.sensor);
  const toUi = (hw) => {
    const j = st ? st.dpiHW.indexOf(hw) : -1;
    return j >= 0 ? st.dpiUI[j] : null;
  };
  const lv = raw.levels;
  if (st && lv >= 1 && lv <= st.dpi.length && lv !== pf.dpi.length) {
    for (let i = pf.dpi.length; i < lv; i++) {
      pf.dpi.push(st.dpi[i]);
      pf.dpiy.push(st.dpi[i]);
    }
    pf.dpi.length = lv;
    pf.dpiy.length = lv;
    pf.dpicolor = st.dpicolor.slice(0, lv);
    changed.add('dpi');
  }
  pf.dpi.forEach((x, i) => {
    const ui = raw.dpi[i] == null ? null : toUi(raw.dpi[i]);
    // 读到了 Y（能分轴的传感器）就分别采用；读不到时和以前一样 Y 跟着 X
    const uy = st?.xy && raw.dpiy?.[i] != null ? toUi(raw.dpiy[i]) : null;
    if (ui != null && C.getHwForDpi(x, dev.sensor) !== raw.dpi[i]) {
      pf.dpi[i] = ui;
      if (uy == null) pf.dpiy[i] = ui;
      changed.add('dpi');
    }
    if (uy != null && C.getHwForDpi(pf.dpiy[i], dev.sensor) !== raw.dpiy[i]) {
      pf.dpiy[i] = uy;
      changed.add('dpi');
    }
  });
  if (raw.cur != null && raw.cur < pf.dpi.length && raw.cur !== pf.curDpi) {
    pf.curDpi = raw.cur;
    changed.add('curDpi');
  }
  // 非 8K 连接下 2000+ Hz 的配置按 1000 Hz 写入，读到 1000 不算改过
  if (raw.rate && dev.writableRate(pf.usbrate) !== raw.rate) {
    pf.usbrate = raw.rate;
    changed.add('rate');
  }
  const lod = [0, 1, 2].find((l) => C.lodToHw(l, dev.sensor) === raw.lod && (l !== 0 || dev.sensor === C.SENSOR_3950));
  if (lod != null && C.lodToHw(pf.lod, dev.sensor) !== raw.lod) {
    pf.lod = lod;
    changed.add('lod');
  }
  for (const f of ['ripple', 'fixline', 'motion']) {
    if (raw[f] != null && !!raw[f] !== !!pf[f]) {
      pf[f] = !!raw[f];
      changed.add(f);
    }
  }
  const sm = C.sensorModeOf(raw.sensormode);
  if (sm != null && sm <= 2 && dev.writableRate(pf.usbrate) < 2000 && sm !== pf.sensormode) {
    pf.sensormode = sm;
    changed.add('sensormode');
  }
  if (hiFpsSupported.value && raw.sensormode != null && !!(raw.sensormode & C.SENSOR_MODE_HIFPS) !== !!pf.hifps) {
    pf.hifps = !!(raw.sensormode & C.SENSOR_MODE_HIFPS);
    changed.add('hifps');
  }
  if (raw.debounce != null && raw.debounce !== Math.min(pf.debounce, C.DEBOUNCE_MAX)) {
    pf.debounce = raw.debounce;
    changed.add('debounce');
  }
  if (raw.sleeptime && raw.sleeptime !== Math.max(pf.sleeptime, 10)) {
    pf.sleeptime = raw.sleeptime;
    changed.add('sleeptime');
  }
  if (receiverLED && dev.is8KReceiver && raw.receiverLED != null && raw.receiverLED !== pf.receiverLED) {
    pf.receiverLED = raw.receiverLED;
    changed.add('receiverLED');
  }
  // 全部读成"禁用"不合理（多半是读取异常），此时不采用按键
  const keys = raw.keys.map((code) => keyFromHw(code, raw.fire));
  if (keys.some((k) => k && !(k.major === C.fMouse && k.minor === C.favOFF))) {
    keys.forEach((k, i) => {
      if (!k) return; // 宏等还原不了的保持原样
      const cur = effectiveKey(pf, i);
      const same = keyToHw(cur, i) >>> 0 === keyToHw(k, i) >>> 0 && (k.minor !== C.favFIRE || cur.itemdata === k.itemdata);
      if (same) return;
      pf.key[i] = k;
      changed.add('key');
    });
  }
  return [...changed];
}

/** 排队把配置 p 写进鼠标（板载配置：切到槽位 p 并对齐）；新的取代还没开始的旧任务。settle：鼠标刚换了硬件槽位，先等一下再读 */
function queueSync(p, { settle = false } = {}) {
  const token = ++syncToken;
  syncQueued = true;
  return enqueue(
    async () => {
      if (token !== syncToken) return true; // 已被新的任务取代（连点了几个配置）
      syncQueued = false;
      if (!state.device) return false;
      return state.hwSlots ? enterSlot(state.device, p) : writeProfile(state.device, p, { settle });
    },
    { superseded: () => token !== syncToken }
  );
}

/**
 * 把配置 p 和 mouse 不一样的项写进鼠标；写的过程中又切到了别的配置时停下（不算失败）。
 * 返回 'done' | 'stopped' | 'failed'
 */
async function pushDiff(dev, p, head, note, started) {
  const pf = state.profiles.list[p];
  const ms = () => `${Date.now() - started}ms`;
  const fixed = dropMissingMacros(pf);
  if (fixed.length) {
    persist();
    toast(t.value.macroMissingReset(fixed.length), 'warn', 4500);
  }
  const jobs = mouseDiff(pf, mouse, dev);
  if (!jobs.length) return logEvent(`${head}: already in the mouse${note} ${ms()}`), 'done';
  // 宏要分 10 包写，比较慢：显示进度
  const slow = jobs.some(([f, i]) => f & C.apKey && pf.key.some((k, b) => (i === 255 || i === b) && k.major === C.fJuji));
  if (slow) state.progress = { visible: true, pct: 0 };
  let ok = true;
  let stopped = false;
  for (let j = 0; j < jobs.length && ok; j++) {
    // 写的过程中又点了别的配置 / 鼠标上的键换了槽位：停下（不算失败），接着处理新的那个
    if (state.curIndex !== p || (state.hwSlots && hwSlot !== p)) {
      stopped = true;
      break;
    }
    const [flag, index] = jobs[j];
    ok = await applyToMouse(dev, pf, flag, index, {
      onProgress: (v) => slow && (state.progress.pct = ((j + v / 100) / jobs.length) * 100),
    });
  }
  if (slow) {
    state.progress.pct = 100;
    await sleep(250);
    state.progress = { visible: false, pct: 0 };
  }
  const what = jobs.map(([f, i]) => (i === 255 ? `${flagNames(f)}(all)` : i ? `${flagNames(f)}#${i}` : flagNames(f))).join(', ');
  const end = stopped ? ' → stopped, another profile was picked' : ok ? '' : ` → FAILED at ${dev.applyError || '?'}`;
  logEvent(`${head}: wrote ${what}${note}${end} ${ms()}`);
  return stopped ? 'stopped' : ok ? 'done' : 'failed';
}

/** 电脑端配置：把配置 p 写进鼠标，只写和鼠标不一样的项（不知道鼠标里是什么时先读一遍） */
async function writeProfile(dev, p, { settle = false } = {}) {
  if (state.curIndex !== p) return true; // 又切到了别的配置，它的任务在后面
  if (!state.profiles.list[p]) return false;
  const started = Date.now();
  let note = '';
  if (!mouse) {
    // 实测 G23V2：刚换完硬件槽位时最初几次读取会失败
    if (settle) await sleep(400);
    mouse = await dev.readSlot(C.getStDPI(dev.sensor)?.dpi.length ?? 6);
    if (state.device !== dev) return false;
    note = ' (read the mouse first)';
  }
  return (await pushDiff(dev, p, `write profile ${p + 1}`, note, started)) !== 'failed';
}

/** 板载配置：鼠标换到了槽位 p，交换各槽位的已知设置 */
function moveToSlot(p) {
  slotMem[hwSlot] = mouse;
  // 接收器灯效存在接收器里、各槽位共用：带到新槽位那份记录里（不知道时记成不知道）
  const led = mouse ? mouse.receiverLED : null;
  hwSlot = p;
  mouse = slotMem[p];
  slotMem[p] = null;
  if (mouse) mouse.receiverLED = led;
  slotUnsure = false;
  macroHw = loadMacroHw(p);
  state.slot = p;
}

/** 板载配置：本次连接改用电脑端配置（切换没有得到鼠标确认） */
function leaveSlotMode(why) {
  logEvent(`onboard slots off for this connection: ${why}`);
  state.hwSlots = false;
  slotMem = [null, null, null, null];
  lastHwSlot = null;
  lsSet(modeKey(state.info.devname), 'pc');
}

/** 板载配置：切到槽位 p（还不在那里时发 [5,6,p] 并确认），再把配置 p 和槽位对齐 */
async function enterSlot(dev, p) {
  if (state.curIndex !== p) return true; // 又切到了别的配置，它的任务在后面
  const started = Date.now();
  if (hwSlot !== p) {
    const from = hwSlot;
    switching = p;
    switchSeen = false;
    followAfter = null;
    // why：没切成的原因。'send' 写命令发不出去；'asleep' 切换后鼠标掉线、一直没醒；'unsupported' 鼠标在线却没切过去
    let why = null;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const seen = dev.waitStatus((s) => s.profileIndex === p, 800);
      const sent = await dev.setHwSlot(p);
      ok = sent && !!(await seen);
      // 没等到状态包（丢包等）：读回槽位确认
      if (sent && !ok) ok = (await dev.readHwSlot()) === p;
      if (ok || state.device !== dev) break;
      if (!sent) {
        why = 'send';
        break;
      }
      // 鼠标在线、能回答，却还在原来的槽位：固件不支持切换
      if (!(await mouseWentOffline(dev))) {
        why = 'unsupported';
        break;
      }
      // 切换后鼠标马上掉线：多半是切到了休眠时间更短的槽位，鼠标已经闲置得比它久，一切过去就睡着了（实测 G23V2：
      // 从休眠 15 分钟的配置切到 1 分钟的）。不是固件不支持——等鼠标醒来再看它在哪个槽位，还没切过去就再发一次
      why = 'asleep';
      logEvent(`slot ${from + 1} → ${p + 1}: mouse went offline right after the switch (asleep?), waiting for it`);
      toast(t.value.slotSwitchAsleep(p + 1), 'warn', 8000);
      if (!(await dev.waitOnline(WAKE_TRIES))) break;
      ok = (await dev.readHwSlot()) === p;
    }
    switching = null;
    if (state.device !== dev) return false;
    if (!ok && why !== 'unsupported') {
      logEvent(`slot ${from + 1} → ${p + 1}: ${why === 'send' ? 'write failed' : 'mouse did not wake up'}`);
      toast(why === 'send' ? t.value.applyFailed : t.value.slotSwitchNoWake, 'warn', 8000);
      if (state.curIndex === p) {
        state.curIndex = from; // 界面回到鼠标确认过的配置；鼠标醒来后的状态包会带着它实际所在的槽位（见 followHw）
        persist();
      }
      // 鼠标可能已经切过去了才睡着：之后写入前先确认（见 confirmSlot）
      if (why === 'asleep') slotUnsure = true;
      return false;
    }
    if (!ok) {
      leaveSlotMode(`slot ${from + 1} → ${p + 1} was not confirmed by the mouse`);
      toast(t.value.slotSwitchFailed, 'warn', 8000);
      return writeProfile(dev, p);
    }
    moveToSlot(p);
    logEvent(`slot ${from + 1} → ${p + 1} ${Date.now() - started}ms`);
  }
  const ok = await syncSlot(dev, p, started);
  // 切换过程中又按了鼠标上的「配置切换」键
  if (followAfter != null && followAfter !== hwSlot && state.hwSlots) followHw(followAfter);
  followAfter = null;
  return ok;
}

/** 板载配置：鼠标已在槽位 p，按槽位状态把配置 p 和槽位对齐（见本节开头） */
async function syncSlot(dev, p, started = Date.now()) {
  if (state.curIndex !== p || hwSlot !== p) return true;
  const pf = state.profiles.list[p];
  if (!pf) return false;
  const head = `slot ${p + 1}`;
  let note = '';
  let read = false;
  if (!mouse) {
    mouse = await dev.readSlot(C.getStDPI(dev.sensor)?.dpi.length ?? 6);
    if (state.device !== dev) return false;
    if (hwSlot !== p) return true; // 读的时候鼠标上的键又换了槽位
    note = ' (read the slot first)';
    read = true;
  }
  // 读的时候又改了这个配置（修改还在队列里）：以配置为准写进去，不能把槽位里的旧值读回来。
  // 第一次进入（fresh）的配置还只是默认值，仍然读进来
  if (read && slotStates[p] === 'synced' && queue.some((j) => !j.run && j.profile === p)) setSlotState(p, 'stale');
  const st = slotStates[p];
  if (st === 'fresh') {
    adoptFromMouse(pf, mouse, dev);
    alignSwitchKeys(p);
    setSlotState(p, 'synced');
    persist();
    logEvent(`${head}: first visit, profile ${p + 1} taken from the slot (rate=${mouse.rate} dpi=${mouse.cur}/${mouse.levels}) ${Date.now() - started}ms`);
    return true;
  }
  if (st === 'synced' && read) {
    // 接收器灯效不属于槽位：读到的是上一个配置写的，不算这个配置在软件外改过，按配置写（mouseDiff）
    const changed = adoptFromMouse(pf, mouse, dev, { receiverLED: false });
    alignSwitchKeys(p);
    if (changed.length) {
      persist();
      logEvent(`${head}: changed outside the app, taken into profile ${p + 1}: ${changed.join(', ')}`);
      if (changed.some((c) => c !== 'curDpi')) toast(t.value.adoptedOutside(p + 1), 'info', 5000);
    }
  }
  setSlotState(p, 'stale');
  const res = await pushDiff(dev, p, head, note, started);
  if (res === 'done') setSlotState(p, 'synced');
  return res !== 'failed';
}

/** 板载配置：鼠标上的「配置切换」键换到了槽位 q：界面跟着切，随后把配置和槽位对齐 */
function followHw(q) {
  const from = hwSlot;
  moveToSlot(q);
  logEvent(`mouse switched slot ${from + 1} → ${q + 1} (Profile Switch button)`);
  if (state.curIndex !== q) {
    state.curIndex = q;
    persist();
  }
  toast(t.value.slotFollowed(q + 1), 'info', 2500);
  queueSync(q);
}

/** 点击配置 p：界面立即切换，切换 / 写入在队列里进行 */
export function requestProfile(p) {
  if (!state.device || p < 0 || p >= C.MAX_ONBOARD || p === state.curIndex) return;
  logEvent(`switch profile ${state.curIndex + 1} → ${p + 1}`);
  state.curIndex = p;
  state.switchTo = p;
  persist();
  return queueSync(p).finally(() => {
    if (state.switchTo === p) state.switchTo = null;
  });
}

/** 原版 connectDevice 的第二阶段：载入本地配置，进入设置界面；raw 是连接时从鼠标读到的设置，hw 是读到的硬件槽位 */
function enterDevice(dev, raw, hw = null) {
  state.device = dev;
  state.error = null; // 连上了：之前（例如并发的另一次连接）留下的失败提示不再成立
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

  const name = dev.devname;
  const st = C.getStDPI(dev.sensor);
  const list = new StProfileList();
  const { count, index } = loadProfiles(name, list);
  // 上次首次使用时鼠标不在线，配置只是默认值：这次仍按首次使用，从鼠标读进来
  state.firstRun = count <= 0 || lsGet(unreadKey(name)) != null;
  // 这次也读不到（无线鼠标还在休眠 / 没开）：先用默认配置，但不能当成"鼠标里就是这些"——之后连上时会被写进各个槽位
  const unreachable = !raw || (dev.iswireless && dev.linkOnline === 0);
  if (state.firstRun) lsSet(unreadKey(name), unreachable ? '1' : null);
  for (let i = list.list.length; i < C.MAX_ONBOARD; i++) {
    const p = new StProfile(`${t.value.onboardProfile}${i + 1}`, C.dvar, dev.sensor);
    p.inside = true;
    list.add(p);
  }
  // 换了传感器的配置：超出范围的 DPI 恢复为该档默认值，这个传感器没有的取值就近（例如步进 100 的传感器上的 450）；
  // 不能分开设 X / Y 的传感器 Y 跟着 X
  for (const pf of list.list) {
    if (pf.dpisensor !== dev.sensor) {
      for (let k = 0; k < pf.dpi.length; k++) {
        if (pf.dpi[k] > st.max) pf.dpi[k] = st.dpi[k] ?? st.dpi[0];
        if (pf.dpiy[k] > st.max) pf.dpiy[k] = st.dpi[k] ?? st.dpi[0];
        pf.dpi[k] = C.closestDpi(dev.sensor, pf.dpi[k]);
        pf.dpiy[k] = C.closestDpi(dev.sensor, pf.dpiy[k]);
      }
    }
    if (!st.xy) pf.dpiy = pf.dpi.slice();
  }
  state.profiles = list;
  let idx = index;
  if (idx == null || idx < 0 || idx > 3) idx = 0;
  state.curIndex = idx;
  state.switchTo = null;
  state.slot = null;
  lastHwSlot = null;
  syncQueued = false;
  syncToken++;
  switching = null;
  followAfter = null;
  slotMem = [null, null, null, null];
  slotUnsure = false;
  mouse = raw ? { ...raw, dpi: raw.dpi.slice(), dpiy: (raw.dpiy || []).slice(), keys: raw.keys.slice(), fire: raw.fire && raw.fire.slice() } : null;

  const mode = lsGet(modeKey(name));
  // 无线时鼠标可能在休眠，没回答 [0x85,6]：上次是板载配置就沿用，等第一个状态包确认槽位
  const slots = hw != null || (mode === 'slots' && dev.iswireless);
  const push = slots ? enterSlotMode(dev, raw, hw, idx, mode) : enterPcMode(dev, raw, idx, mode);
  for (const k of LEGACY_KEYS) lsSet(`${k}${name}`, null);
  // GHERO 等读不到当前档时，沿用连接时 0x83 读到的
  if (!raw || raw.cur == null) setCurDpi(dev.curDpi);
  persist();

  lastStatus = null;
  dev.addEventListener('status', onStatus);
  state.phase = 'ready';
  if (push) queueSync(state.curIndex);
}

/** 电脑端配置的连接处理，返回是否要把当前配置写进鼠标 */
function enterPcMode(dev, raw, idx, mode) {
  const name = dev.devname;
  const list = state.profiles;
  state.hwSlots = false;
  macroHw = loadMacroHw(null);
  const pf = list.list[idx];
  const pending = lsGet(pendingKey(name)) != null;
  // 从旧版本（跟随硬件槽位）升级，或上次用板载配置时当前槽位没对齐：鼠标里不一定是当前配置
  const savedSlots = loadJson(slotStateKey(name));
  const legacy = !state.firstRun && (mode === 'slots' ? !Array.isArray(savedSlots) || savedSlots[idx] !== 'synced' : mode !== 'pc');
  let push = false;
  if (state.firstRun && lsGet(unreadKey(name)) != null) {
    // 首次使用但鼠标不在线：什么都没读到，先用默认配置、不写入；鼠标上线后重新连接时再从鼠标读进来
    logEvent('first run: the mouse is offline, profiles stay at defaults until it can be read');
  } else if (state.firstRun) {
    // 首次使用：4 个配置都从鼠标现在的设置开始，切换配置不会突然变回默认值
    if (raw) for (const p of list.list) adoptFromMouse(p, raw, dev);
    logEvent(`first run: all 4 profiles start from the mouse (rate=${raw?.rate} dpi=${raw?.cur}/${raw?.levels})`);
  } else if (pending || legacy) {
    // 上次没写完，或者从别的方式升级：鼠标里不一定是当前配置，把当前配置写进去
    push = true;
    logEvent(`connect: ${pending ? 'last write did not finish' : `switched from ${mode === 'slots' ? 'onboard slots' : 'the slot-following version'}`}, writing profile ${idx + 1} to the mouse`);
  } else if (raw) {
    // 和官方一样以鼠标为准，但只读进软件外改过的项
    const changed = adoptFromMouse(pf, raw, dev);
    if (changed.length) logEvent(`connect: changed outside the app, taken into profile ${idx + 1}: ${changed.join(', ')}`);
    const shown = changed.filter((c) => c !== 'curDpi');
    if (shown.length) toast(t.value.adoptedOutside(idx + 1), 'info', 5000);
  }
  // 「配置切换」键这里不支持：配置里和鼠标里的都恢复成该键默认功能
  const dropped = new Set();
  for (const p of list.list) dropSwitchKeys(p).forEach((b) => dropped.add(b));
  (raw?.keys || []).forEach((code, b) => code != null && code >>> 0 === SWITCH_CODE && dropped.add(b));
  if (dropped.size) {
    push = true;
    const names = [...dropped].sort().map((b) => t.value.btnName[b]);
    logEvent(`connect: Profile Switch removed from button(s) ${[...dropped].map((b) => b + 1).join(', ')}`);
    toast(t.value.switchKeyRemoved(names.join('、')), 'warn', 9000);
  }
  lsSet(modeKey(name), 'pc');
  return push;
}

/** 板载配置的连接处理：界面切到鼠标所在的槽位，返回是否要排队对齐 */
function enterSlotMode(dev, raw, hw, idx, mode) {
  const name = dev.devname;
  state.hwSlots = true;
  slotGuess = hw == null;
  hwSlot = hw ?? idx;
  state.curIndex = hwSlot;
  state.slot = hw;
  const saved = loadJson(slotStateKey(name));
  if (mode === 'slots' && Array.isArray(saved) && saved.length === C.MAX_ONBOARD && saved.every((x) => SLOT_STATES.includes(x))) {
    slotStates = saved;
  } else {
    // 首次使用：4 个配置都从各自的槽位读进来。从电脑端配置升级：鼠标当前槽位里是上次的当前配置 idx（没写完的话也不一定），
    // 其它槽位里不知道是什么——进入时把配置写进去
    const pending = lsGet(pendingKey(name)) != null;
    slotStates = [0, 1, 2, 3].map((p) => (state.firstRun ? 'fresh' : p === hwSlot && p === idx && mode === 'pc' && !pending ? 'synced' : 'stale'));
    saveJson(slotStateKey(name), slotStates);
    // 电脑端配置记的宏签名就是鼠标当前槽位里的
    if (slotStates[hwSlot] === 'synced' && lsGet(macroHwKey(name, hwSlot)) == null) saveJson(macroHwKey(name, hwSlot), loadJson(macroHwKey(name)) || {});
    logEvent(`onboard slots: ${state.firstRun ? 'first run' : `switched from ${mode === 'pc' ? 'PC-side profiles' : 'an older version'}`}, slot states ${slotStates.join(' ')}`);
  }
  lsSet(pendingKey(name), null);
  lsSet(modeKey(name), 'slots');
  macroHw = loadMacroHw(hwSlot);
  // 网页驱动导出 / 别的驱动留下的左右键「配置切换」不支持
  for (const p of state.profiles.list) dropSwitchOnMainKeys(p);
  const p = hwSlot;
  logEvent(`onboard slots: mouse is in slot ${p + 1}${slotGuess ? ' (no answer, assumed from last time)' : ''}, ${slotStates[p]}`);
  if (slotGuess) {
    mouse = null;
    return false; // 等状态包
  }
  if (!raw) return true;
  const pf = state.profiles.list[p];
  if (slotStates[p] === 'fresh') {
    adoptFromMouse(pf, raw, dev);
    alignSwitchKeys(p);
    setSlotState(p, 'synced');
    logEvent(`first run: profile ${p + 1} starts from onboard slot ${p + 1} (rate=${raw.rate} dpi=${raw.cur}/${raw.levels})`);
    return false;
  }
  if (slotStates[p] === 'synced') {
    // 和官方一样以鼠标为准，但只读进软件外改过的项
    const changed = adoptFromMouse(pf, raw, dev);
    alignSwitchKeys(p);
    if (changed.length) logEvent(`connect: changed outside the app, taken into profile ${p + 1}: ${changed.join(', ')}`);
    if (changed.some((c) => c !== 'curDpi')) toast(t.value.adoptedOutside(p + 1), 'info', 5000);
  }
  // 还有和槽位不一样的（例如在别的槽位时改了宏）就补写；stale 时整个写进去
  return true;
}

/** 原版 dpiSetCurDPI：只更新界面/配置，不写入 */
function setCurDpi(index) {
  const pf = curProfile.value;
  if (!pf || index == null || index < 0) return;
  if (index >= pf.dpi.length) index = pf.dpi.length - 1;
  pf.curDpi = index;
}

/** 状态包里的回报率 / DPI 档 / 槽位 / 充电变化记入事件日志（例如按鼠标上的回报率键会体现在这里） */
let lastStatus = null;
function logStatusChange(s) {
  const p = lastStatus;
  lastStatus = s;
  if (!p) return logEvent(`status first: rate=${s.rate} dpi#=${s.dpiIndex} slot=${s.profileIndex} power=${s.power} charging=${s.charging}`);
  const diff = [];
  if (p.rate !== s.rate) diff.push(`rate ${p.rate}→${s.rate}`);
  if (p.dpiIndex !== s.dpiIndex) diff.push(`dpi# ${p.dpiIndex}→${s.dpiIndex}`);
  if (p.profileIndex !== s.profileIndex) diff.push(`slot ${p.profileIndex}→${s.profileIndex}`);
  if (p.charging !== s.charging) diff.push(`charging ${p.charging}→${s.charging}`);
  if (diff.length) logEvent(`status: ${diff.join(', ')}${state.applying ? ' (while applying)' : ''}`);
}

/** 原版 irServer：处理鼠标主动上报的状态 */
function onStatus(e) {
  const s = e.detail;
  logStatusChange(s);
  // 界面显示的电量 / 充电 / 回报率随时更新（写入期间也一样），只有改写配置要等写入结束
  state.info.charging = s.charging;
  state.info.power = s.power;
  if (s.rate) state.info.rate = s.rate;
  // 旧布局的状态包里没有槽位
  if (s.profileIndex != null) {
    state.slot = s.profileIndex;
    slotUnsure = false; // 状态包带着鼠标实际所在的槽位，下面据此跟随
  }
  if (s.profileIndex == null) {
    /* 没有槽位信息：不处理槽位 */
  } else if (state.hwSlots) {
    // 正在由软件切换：等的就是新槽位的状态包；之后又报告别的槽位 = 鼠标上的键又换了，切换完成后跟过去
    if (switching != null) {
      if (s.profileIndex === switching) switchSeen = true;
      else if (switchSeen) followAfter = s.profileIndex;
      return;
    }
    if (slotGuess) {
      slotGuess = false;
      if (s.profileIndex === hwSlot) {
        logEvent(`onboard slots: slot ${hwSlot + 1} confirmed by the first status report`);
        queueSync(hwSlot);
        return;
      }
    }
    // 鼠标上的「配置切换」键换了槽位：界面跟着切。这个状态包里的回报率 / DPI 档属于新槽位，对齐时一并处理
    if (s.profileIndex !== hwSlot) return followHw(s.profileIndex);
  } else {
    // 电脑端配置，鼠标却换了槽位：它还有按键是「配置切换」（例如之后用别的驱动设的）。新槽位里是别的设置，
    // 状态包里的回报率 / DPI 也是那个槽位的，不能记进当前配置——把当前配置补写进去
    if (lastHwSlot != null && s.profileIndex !== lastHwSlot) {
      lastHwSlot = s.profileIndex;
      mouse = null;
      logEvent(`mouse moved to hardware slot ${s.profileIndex + 1}: writing profile ${state.curIndex + 1} into it`);
      toast(t.value.hwSlotMoved, 'warn', 7000);
      queueSync(state.curIndex, { settle: true });
      return;
    }
    lastHwSlot = s.profileIndex;
  }
  // 队列里还有没写完的修改（包括正等鼠标醒来的）：这时鼠标里还是旧值，读回来会把刚改的值改回去
  if (state.applying || syncQueued || state.pending) return;
  const pf = curProfile.value;
  if (!pf) return;
  if (s.rate) {
    // 非 8K 连接下配置里的 2000+ Hz 按 1000 Hz 写入（writableRate），鼠标随后上报的 1000 只是降级，
    // 不能据此改写配置：否则在 1K 接收器下切到这些配置后，换回 8K 接收器时原来的回报率就丢了
    if (pf.usbrate !== s.rate && state.device?.writableRate(pf.usbrate) !== s.rate) {
      pf.usbrate = s.rate;
      persist();
    }
    if (mouse) mouse.rate = s.rate;
  }
  // 鼠标上的 DPI 键
  if (s.dpiIndex != null && s.dpiIndex < pf.dpi.length) {
    setCurDpi(s.dpiIndex);
    if (mouse) mouse.cur = s.dpiIndex;
  }
  // 紧凑布局还带着消抖、LOD、Motion Sync：在软件外改过（例如鼠标上设了这些功能的按键）时配置跟随，不用再读
  const changed = adoptStatusExtras(pf, s, state.device);
  if (changed.length) {
    persist();
    logEvent(`status: profile ${state.curIndex + 1} follows the mouse: ${changed.join(', ')}`);
  }
}

/** 状态包里的消抖 / LOD / Motion Sync 读进配置（与 adoptFromMouse 的同名项一致），返回改了哪些 */
function adoptStatusExtras(pf, s, dev) {
  if (!dev || s.layout !== 'packed') return [];
  const out = [];
  if (s.debounce != null && s.debounce <= C.DEBOUNCE_MAX) {
    if (s.debounce !== Math.min(pf.debounce, C.DEBOUNCE_MAX)) {
      out.push(`debounce ${pf.debounce}→${s.debounce}`);
      pf.debounce = s.debounce;
    }
    if (mouse) mouse.debounce = s.debounce;
  }
  if (s.lod != null) {
    const lod = [0, 1, 2].find((l) => C.lodToHw(l, dev.sensor) === s.lod && (l !== 0 || dev.sensor === C.SENSOR_3950));
    if (lod != null && C.lodToHw(pf.lod, dev.sensor) !== s.lod) {
      out.push(`lod ${pf.lod}→${lod}`);
      pf.lod = lod;
    }
    if (lod != null && mouse) mouse.lod = s.lod;
  }
  // PAW3395 在 8000 Hz 下固件强制关掉 Motion Sync（只清内存里的，保存的设置不变，IDA：传感器驱动 sub_1000F550），
  // 这时状态包报告的 0 不是用户改的，不能记进配置
  const motionForced = dev.sensor === C.SENSOR_3395 && s.rate === 8000;
  if (s.motion != null && !motionForced) {
    if (!!s.motion !== !!pf.motion) {
      out.push(`motion ${pf.motion ? 1 : 0}→${s.motion}`);
      pf.motion = !!s.motion;
    }
    if (mouse) mouse.motion = s.motion;
  }
  return out;
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
  state.switchTo = null;
  state.hwSlots = false;
  syncQueued = false;
  switching = null;
  mouse = null;
  slotMem = [null, null, null, null];
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

/** 把当前配置整套写入鼠标（导入 / 复制，对应官方的"应用"） */
export function writeCurrentProfile() {
  logEvent(`write the whole profile ${state.curIndex + 1}`);
  return chunk86(WRITE_ALL, 255, { overlay: true });
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
  const ok = await replaceCurrentProfile(p);
  if (ok) toast(t.value.importOk, 'success');
}

/** 用 p 替换当前配置并整套写入（网页驱动导出的配置里可能有「配置切换」键，恢复为默认功能） */
function replaceCurrentProfile(p) {
  const cur = curProfile.value;
  p.name = cur.name;
  p.uid = cur.uid;
  p.inside = true;
  // 电脑端配置没有「配置切换」；板载配置时它不能在左 / 右键上
  const dropped = state.hwSlots ? dropSwitchOnMainKeys(p) : dropSwitchKeys(p);
  if (dropped.length) logEvent(`Profile Switch on button(s) ${dropped.map((b) => b + 1).join(', ')} restored to default`);
  state.profiles.list[state.curIndex] = p;
  // 板载配置：「配置切换」键 4 个槽位共用，换进来的配置在这些键上不同时 4 个配置一起改
  if (state.hwSlots && shareSwitchChanges(state.curIndex, cur.key)) toast(t.value.switchKeyShared, 'info', 5000);
  state.firstRun = false;
  return writeCurrentProfile();
}

/** 把配置 from 的全部设置复制到当前配置并写入鼠标 */
export async function copyProfile(from) {
  const src = state.profiles.list[from];
  if (!src || !curProfile.value || from === state.curIndex || !state.device) return;
  const ok = await confirmDialog({
    title: t.value.ovCopyTitle,
    message: t.value.ovCopyMsg(from + 1, state.curIndex + 1),
    okText: t.value.ovCopyOk,
    icon: 'warn',
  });
  if (!ok) return;
  logEvent(`copy profile ${from + 1} into ${state.curIndex + 1}`);
  const done = await replaceCurrentProfile(src.copy());
  if (done) toast(t.value.ovCopyDone(from + 1, state.curIndex + 1), 'success');
  return done;
}

/* ------------------------------------------------------------------ 按键 */

export const UI_KEY_NUM = C.dvar.key.length;

/** 原版 assignKEY：至少保留一个左键 */
export async function assignKey(btn, kf) {
  const pf = curProfile.value;
  if (!pf || btn < 0 || btn >= UI_KEY_NUM) return;
  if (isSwitchKey(kf) && !canSwitchKey(btn)) return void toast(t.value.switchKeyNotHere, 'warn');
  const otherLeft = pf.key.some((k, i) => i !== btn && isLeftKey(k));
  if (!otherLeft && !isLeftKey(kf)) {
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

/**
 * 原版 onButtonSet：只改当前配置。设上 / 换掉「配置切换」时与原版、官方新版桌面驱动和固件一致：
 * 固件把这个按键写进全部 4 个槽位，4 个配置一起改。
 */
function setButton(btn, kf) {
  const pf = curProfile.value;
  const old = pf.key[btn];
  pf.key[btn] = kf.copy();
  if (state.hwSlots && (isSwitchKey(kf) || isSwitchKey(old))) {
    shareKey(state.curIndex, btn);
    toast(t.value.switchKeyShared, 'info', 5000);
  }
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
  if (C.getStDPI(state.info.sensor)?.xy === false) y = x; // 这个传感器不能分开设 X / Y
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

/** PAW3950「最高性能」（只在 hiFpsSupported 时提供） */
export function setHiFps(on) {
  const pf = curProfile.value;
  if (!pf || !hiFpsSupported.value || !!pf.hifps === !!on) return;
  pf.hifps = !!on;
  chunk86(C.apSensorMode, 0);
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
  const oldKeys = pf.key.slice();
  pf.reset(C.dvar, state.info.sensor);
  // 板载配置：「配置切换」键恢复成默认功能时，固件把 4 个槽位一起改
  if (state.hwSlots) shareSwitchChanges(state.curIndex, oldKeys);
  return chunk86(WRITE_ALL | C.apReset, 255, { overlay: true });
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
  // 只重写当前配置里用到这个宏的按键；板载配置时别的槽位里的旧宏在进入那个槽位时重写（签名对不上）
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
