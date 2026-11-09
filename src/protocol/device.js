// INCOTT 鼠标通信——逐条移植自原版网页驱动 CBAccess（chunk-v1013.js）。
// 所有命令均为 8 字节 Feature Report（ID 9）；读取时先发命令，再 receiveFeatureReport。
// 宏数据额外通过 Output Report（ID 9）分 10 包、每包 32 字节下发。

import {
  REPORT_ID,
  PID_WIRELESS,
  KeyInfo,
  RATE_HW,
  RATE_8K_ONLY,
  sensorFromByte,
  dvar,
  getStDPI,
  getHwForDpi,
  lodToHw,
  fMouse,
  fKeyboard,
  fMedia,
  fJuji,
  fmsCLICK,
  fmsMENU,
  fmsMIDDLE,
  fmsFORWARD,
  fmsBACK,
  favDPI,
  favDPIINC,
  favDPIDEC,
  favProfile,
  favFIRE,
  favOFF,
  fmePLAYER,
  fmePLAYPAUSE,
  fmeSTOP,
  fmePREVIOUS,
  fmeNEXT,
  fmeVOLINC,
  fmeVOLDEC,
  fmeMUTE,
  fmeEMAIL,
  fmeCAL,
  fmeEXPLORER,
  fmeHOME,
  fmeREFRESH,
  fmeFORWARD,
  fmeBACK,
  fmeSEARCH,
  apKey,
  apDpi,
  apRate,
  apLod,
  apSensor,
  apSensorMode,
  apDpiLevel,
  apOnboardIndex,
  apReceiverLED,
  apDebounce,
  apSleepTime,
} from './constants.js';
import { macroToHw } from './macro.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 设备型号识别（readDps 中 rData[2]） */
export function modelFromCode(code) {
  switch (code) {
    case 1:
      return 'Ghero';
    // 4 / 5 网页驱动不认，官方桌面驱动 GamingMouse.exe 分别按 G23 / G24 处理（sub_42F7F0）
    case 2:
    case 4:
      return 'G23';
    case 3:
    case 5:
      return 'G24';
    // 6 / 9 的 G29 / FM23 是网页驱动代码里的内部名，网页驱动界面、官方新版桌面驱动和升级包都叫零29 / 零39。
    // 内部名还用作本地配置的存储键和图片目录，保持不变；界面上显示的名字见 i18n 的 modelNames
    case 6:
      return 'G29';
    // 12 / 13 是官方新版桌面驱动 incott-app 1.4.0.3 新增的（网页驱动不认）：12 按 G23V2，13 是 G39
    case 8:
    case 12:
    case 14:
      return 'G23V2';
    case 9:
      return 'FM23';
    case 13:
      return 'G39';
    default:
      return '';
  }
}

/** 按键功能 → 32 位硬件码（原版 kf_hw） */
export function keyToHw(kf, index) {
  const { major, minor } = kf;
  if (major === fMouse) {
    switch (minor) {
      case fmsCLICK:
        return 0x00f00001;
      case fmsMENU:
        return 0x00f10001;
      case fmsMIDDLE:
        return 0x00f20001;
      case fmsFORWARD:
        return 0x00f40001;
      case fmsBACK:
        return 0x00f30001;
      case favDPI:
        return 0x00030007;
      case favDPIINC:
        return 0x00010007;
      case favDPIDEC:
        return 0x00020007;
      case favProfile:
        return 61706;
      case favFIRE:
        return 0x0218f00a;
      case favOFF:
        return 0;
      default:
    }
  } else if (major === fKeyboard) {
    if (kf.modifer) return ((kf.minor & 255) << 16) | ((kf.modifer & 255) << 8);
    return ((kf.minor & 255) << 8) | 128;
  } else if (major === fMedia) {
    switch (minor) {
      case fmePLAYER:
        return 0x01830003;
      case fmePLAYPAUSE:
        return 0x00cd0003;
      case fmeSTOP:
        return 0x00b70003;
      case fmePREVIOUS:
        return 0x00b60003;
      case fmeNEXT:
        return 0x00b50003;
      case fmeVOLINC:
        return 0x00e90003;
      case fmeVOLDEC:
        return 0x00ea0003;
      case fmeMUTE:
        return 0x00e20003;
      case fmeEMAIL:
        return 0x018a0003;
      case fmeCAL:
        return 0x01920003;
      case fmeEXPLORER:
        return 0x01940003;
      case fmeHOME:
        return 0x02230003;
      case fmeREFRESH:
        return 0x02270003;
      case fmeFORWARD:
        return 0x02250003;
      case fmeBACK:
        return 0x02240003;
      case fmeSEARCH:
        return 0x02210003;
      default:
    }
  } else if (major === fJuji) {
    return (index << 16) | 9;
  }
  return -1;
}

/** 32 位硬件码 → 按键功能（keyToHw 的逆运算，用于首次连接时读取鼠标现有映射）；无法还原时返回 null */
export function hwToKey(code) {
  code = code >>> 0;
  if (code === 0) return new KeyInfo(fMouse, favOFF);
  const low = code & 0xff;
  if (low === 0x01 || low === 0x07 || code === 61706) {
    for (const m of [fmsCLICK, fmsMENU, fmsMIDDLE, fmsFORWARD, fmsBACK, favDPI, favDPIINC, favDPIDEC, favProfile]) {
      if (keyToHw(new KeyInfo(fMouse, m), 0) === code) return new KeyInfo(fMouse, m);
    }
    return null;
  }
  if (low === 0x03) {
    for (let m = 1; m <= 17; m++) {
      if (keyToHw(new KeyInfo(fMedia, m), 0) === code) return new KeyInfo(fMedia, m);
    }
    return null;
  }
  if (low === 0x80 && code >>> 16 === 0) return new KeyInfo(fKeyboard, (code >> 8) & 255);
  if (low === 0x00 && code >>> 24 === 0) {
    const k = new KeyInfo(fKeyboard, (code >> 16) & 255);
    k.modifer = (code >> 8) & 255;
    return k;
  }
  return null; // 宏 / 火力键等参数无法从按键码还原
}

/**
 * 状态包（输入报告 9）有两种布局，按内容判断（layout 为这次连接之前判断出的，可为 null）：
 *
 * 紧凑布局（原版网页驱动 irServer；固件 1.3.8 / 1.4.0.3 都是，IDA：sub_1000E410 / sub_1000E364）：
 *   d0 电量 | 充电 << 7   d1 回报率 | DPI 档 << 4   d2 消抖 | 槽位 << 6（1.3.8 没有槽位，最高位恒 0）
 *   d3 X >> 8 | (Y >> 8) << 4   d4 X 低字节   d5 Y 低字节（当前档的 DPI 硬件值）   d6 Motion Sync | LOD << 4
 *   官方新版桌面驱动只认这种。
 * 更早的固件（旧版官方桌面驱动 sub_434610；1K 接收器收到 5 字节状态时原样转发，issue #11）：
 *   d0 充电（非 0）  d1 电量  d2 DPI 档  d3 回报率，其余为 0。
 *
 * 判断：两种都说得通时，紧凑布局意味着电量只有 0–1%（不可能还在正常用），所以按旧布局；
 * 只有一种说得通时据此定下来，后面说不准的状态包沿用。
 */
export function statusLayoutOf(d, layout = null) {
  const packed = (d[0] & 127) <= 100 && (d[1] & 15) <= 6 && d[1] >> 4 <= 5 && (d[2] & 63) <= 30;
  const old = d[0] <= 1 && d[1] <= 100 && d[2] <= 5 && d[3] <= 6 && !d[5] && !d[6];
  if (packed && !old) return { layout: 'packed', sure: true };
  if (old && !packed) return { layout: 'old', sure: true };
  return { layout: layout || (old ? 'old' : 'packed'), sure: false };
}

/** 解析设备主动上报的状态（原版 irServer）；layout 见 statusLayoutOf */
export function parseInputReport(data, layout = null) {
  const d = Array.from({ length: 8 }, (_, i) => (i < data.byteLength ? data.getUint8(i) : 0));
  const lay = statusLayoutOf(d, layout);
  if (lay.layout === 'old') {
    return {
      layout: 'old',
      layoutSure: lay.sure,
      profileIndex: null,
      charging: d[0] !== 0,
      power: Math.min(d[1], 100),
      rate: d[3] <= 6 ? RATE_HW[d[3]] : null,
      dpiIndex: d[2],
      debounce: null,
      lod: null,
      motion: null,
    };
  }
  const rate = d[1] & 15;
  const lod = d[6] >> 4;
  const motion = d[6] & 15;
  return {
    layout: 'packed',
    layoutSure: lay.sure,
    profileIndex: (d[2] & 192) >> 6,
    charging: (d[0] & 128) !== 0,
    // 固件已经做了平滑（每 3 次采样一次、连续 5 次不同才改，IDA：sub_1000C0B4），直接显示
    power: Math.min(d[0] & 127, 100),
    rate: rate <= 6 ? RATE_HW[rate] : null,
    dpiIndex: (d[1] & 240) >> 4,
    debounce: d[2] & 63,
    lod: lod <= 2 ? lod : null, // 固件 LOD 值（0 = 1 mm，1 = 2 mm，2 = 0.7 mm）
    motion: motion <= 1 ? motion : null,
    dpiX: d[4] | ((d[3] & 15) << 8),
    dpiY: d[5] | ((d[3] >> 4) << 8),
  };
}

/** 字节数组 / DataView → "09 8F 01 …" */
export function toHex(data) {
  if (!data) return '';
  const u8 = data instanceof DataView ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : Uint8Array.from(data);
  return Array.from(u8, (v) => v.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

const XFER_LOG_MAX = 160;
const INPUT_LOG_MAX = 40;
const ERR_LOG_MAX = 30;

/**
 * 单次 HID 调用的超时。正常往返只要几毫秒；接收器或固件不响应时 WebHID 可能很久都不返回，
 * 以前界面会一直停在"连接中 / 写入中"，连诊断信息都复制不了。
 */
export const HID_TIMEOUT = 3000;
const OPEN_TIMEOUT = 5000;

/**
 * 无线连接时接收器报告鼠标不在线（8E 01 r[6] = 0），先每隔 ONLINE_POLL 问一次，最多 ONLINE_TRIES 次（约 6 秒）。
 * 刚插上接收器、刚打开鼠标要过几秒才连上，这期间接收器对读命令只回全 0（issue #11：插回接收器后约 3.6 秒鼠标才上线，
 * 之前读到的设置全是空的）。按次数而不是按时间限制，测试里计时器立即到期时也不会空转。
 */
export const ONLINE_POLL = 300;
export const ONLINE_TRIES = 20;

/** 超时后原调用仍挂在后台，但调用方会拿到错误，不再卡住 */
export function withTimeout(p, ms, what = 'hid') {
  let timer;
  const limit = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timeout ${ms}ms`)), ms)));
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const isTimeout = (err) => /timeout/i.test(String(err?.message || err));

export class IncottDevice extends EventTarget {
  constructor(hid) {
    super();
    this.hid = hid;
    this.clearState();
    this._chain = Promise.resolve();
    // 原始收发记录（诊断信息用）：不随 clearState 清空，连接失败后仍可导出
    this._t0 = Date.now();
    this.xferLog = [];
    this.inputLog = [];
    this.modelCode = null; // 143 回包里的型号码；识别失败关闭设备后仍保留，供诊断信息使用
    this.replies = {}; // 每条读命令第一次的回包（即连接时的 143 / 142 / 137 / 131 …），不会被收发记录挤掉
    this.inputCount = 0; // 打开设备后收到的输入报告总数
    this.inputById = {};
    this.lastInputAt = 0;
    this.connectedAt = 0;
    this.errLog = []; // HID 错误 / 超时单独保留，不会被大量正常收发挤掉
    this.lastHidError = null;
    this.applyError = null; // 最近一次 apply 失败在哪一步
    this.linkOnline = null; // 142（8E 01）回包 r[6]：接收器报告的鼠标在线标志（原版读了但被覆盖）。issue #11 实机：为 0 时读命令只回全 0
    this.onlineWaitMs = null; // 连接时等鼠标上线等了多久（见 waitOnline），没等过为 null
    this.lastOnlineAt = 0; // 最近一次接收器报告鼠标在线（8E 01 r[6] = 1）的时间
    this.statusLayout = null; // 状态包布局：'packed' | 'old'（见 statusLayoutOf）
    this._macroPacket = 0;
    this._onInput = (e) => {
      if (e.device !== this.hid) return;
      this.inputCount++;
      this.inputById[e.reportId] = (this.inputById[e.reportId] || 0) + 1;
      this.lastInputAt = Date.now();
      this._push(this.inputLog, INPUT_LOG_MAX, { t: Date.now() - this._t0, dir: `in#${e.reportId}`, hex: toHex(e.data) });
      // 官方驱动的读线程只处理 Report ID 9（GamingMouse.exe sub_446200），其它报告不是状态包
      if (e.reportId !== REPORT_ID) return;
      const s = parseInputReport(e.data, this.statusLayout);
      if (s.layoutSure) this.statusLayout = s.layout;
      this.dispatchEvent(new CustomEvent('status', { detail: s }));
    };
  }

  _push(list, max, entry) {
    list.push(entry);
    if (list.length > max) list.splice(0, list.length - max);
  }

  _log(dir, data) {
    this._push(this.xferLog, XFER_LOG_MAX, { t: Date.now() - this._t0, dir, hex: typeof data === 'string' ? data : toHex(data) });
  }

  _hidError(what, err) {
    const msg = `${what}: ${err?.message || err}`;
    this.lastHidError = msg;
    this._log('ERR', msg);
    this._push(this.errLog, ERR_LOG_MAX, { t: Date.now() - this._t0, dir: 'ERR', hex: msg });
  }

  clearState() {
    this.opened = false;
    this.curpid = 0;
    this.online = false;
    this.power = -1;
    this.charging = false;
    this.curDpi = -1;
    this.dpiLevels = -1;
    this.curUSBRate = 0;
    this.iswireless = false;
    this.is8KReceiver = false;
    this.isPink = false;
    this.psd = 0;
    this.sensor = 0;
    this.devname = '';
    this.curOnBoard = null;
    this.dpiExtra = null; // 0x83 回包里 [3,…] 的后三个字节（见 _keepDpiExtra）
  }

  get isOpen() {
    return !!this.hid && this.hid.opened;
  }

  /* ------------------------------------------------------------ 传输层 */

  /** 串行化：保证"发命令→读回包"不会被其它请求插入 */
  _exclusive(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  /** 原版 transferDevice：sendFeatureReport，失败重试 3 次 */
  async _sendFeature(b) {
    this._log('F>', [REPORT_ID, ...b]);
    for (let i = 0; i < 3; i++) {
      try {
        await withTimeout(this.hid.sendFeatureReport(REPORT_ID, b), HID_TIMEOUT, 'sendFeatureReport');
        return true;
      } catch (err) {
        // 超时不再重试：上一次调用还挂着，再发只会继续排队
        if (i >= 2 || isTimeout(err)) {
          if (isTimeout(err)) this._timedOut = true;
          console.warn('[hid] sendFeatureReport failed', err);
          this._hidError(`sendFeatureReport ${toHex([b[0], b[1]])}${i ? ` (try ${i + 1})` : ''}`, err);
          return false;
        }
        await sleep(100);
      }
    }
    return false;
  }

  /** 原版 elsDevice：sendReport（Output Report） */
  async _sendOutput(b) {
    this._log('O>', [REPORT_ID, ...b]);
    try {
      await withTimeout(this.hid.sendReport(REPORT_ID, b), HID_TIMEOUT, 'sendReport');
      return true;
    } catch (err) {
      console.warn('[hid] sendReport failed', err);
      this._hidError('sendReport', err);
      return false;
    }
  }

  /** 原版 recvDevice + readData：返回去掉 Report ID 的数据，第 0 字节为命令回显 */
  async _readData(md) {
    let r;
    try {
      r = await withTimeout(this.hid.receiveFeatureReport(REPORT_ID), HID_TIMEOUT, 'receiveFeatureReport');
    } catch (err) {
      console.warn('[hid] receiveFeatureReport failed', err);
      this._hidError(`receiveFeatureReport${md != null ? ` (cmd ${md})` : ''}`, err);
      if (isTimeout(err)) this._timedOut = true;
      return null;
    }
    if (!r) return null;
    this._log('F<', r);
    // 回显不对也记下来：识别失败时正需要这份原始数据
    const key = md ?? r.getUint8(1);
    if (!(key in this.replies)) this.replies[key] = { t: Date.now() - this._t0, hex: toHex(r) };
    if (md !== undefined && md !== r.getUint8(1)) return null;
    return new Uint8Array(r.buffer.slice(r.byteOffset + 1, r.byteOffset + r.byteLength));
  }

  _doTask(b) {
    return this._exclusive(() => this._sendFeature(b));
  }

  /** 原版 fromData：发送读命令，等待 25ms，再读回 */
  _fromData(m, f1, f2, f3, f4) {
    return this._exclusive(async () => {
      const b = new Uint8Array([m, 0, 0, 0, 0, 0, 0, 0]);
      if (f1 != null) b[1] = f1;
      if (f2 != null) b[2] = f2;
      if (f3 != null) b[3] = f3;
      if (f4 != null) b[4] = f4;
      if (!(await this._sendFeature(b))) return null;
      await sleep(25);
      const ret = await this._readData(m);
      if (!ret || ret.length <= 0) return null;
      return ret;
    });
  }

  /**
   * 诊断用：发送任意 8 字节读命令，原样返回回包（含 Report ID，不校验回显）。
   * 只应传入 0x80–0x8F 的读命令。
   */
  rawQuery(bytes) {
    return this._exclusive(async () => {
      const b = new Uint8Array(8);
      b.set(bytes.slice(0, 8));
      const t = Date.now();
      if (!(await this._sendFeature(b))) return { sent: b, recv: null, error: 'sendFeatureReport failed', ms: Date.now() - t };
      await sleep(25);
      try {
        const r = await withTimeout(this.hid.receiveFeatureReport(REPORT_ID), HID_TIMEOUT, 'receiveFeatureReport');
        if (r) this._log('F<', r);
        const recv = r ? new Uint8Array(r.buffer, r.byteOffset, r.byteLength).slice() : null;
        return { sent: b, recv, error: null, ms: Date.now() - t };
      } catch (err) {
        this._hidError(`receiveFeatureReport (diag ${toHex([b[0], b[1]])})`, err);
        return { sent: b, recv: null, error: String(err?.message || err), ms: Date.now() - t };
      }
    });
  }

  /* -------------------------------------------------------------- 连接 */

  /** 原版 innerE */
  async open() {
    if (!this.hid.opened) await withTimeout(this.hid.open(), OPEN_TIMEOUT, 'open');
    this.opened = true;
    this.curpid = this.hid.productId;
    this.iswireless = this.hid.productId === PID_WIRELESS;
    this.hid.addEventListener('inputreport', this._onInput);

    if (!(await this.readDps()) || this.devname === '') {
      await this.close();
      // 143 一个回包都没收到是"没有响应"（接收器 / 鼠标无响应、读写超时），收到了但不认识才是"不支持"
      throw new Error(this.replies[143] ? 'UNSUPPORTED_DEVICE' : 'NO_RESPONSE');
    }
    if (!(await this.readMatchInfo())) {
      // 有回包、只是不是 0x8E 的（固件不认识这条命令；旧版 GHERO 专用官方驱动从不发它）：照样连接，在线状态记为未知。
      // 一个回包都没有（超时 / 读写错误）才算读取失败，免得连上一个根本不响应的设备
      if (!this.replies[142]) {
        await this.close();
        throw new Error('READ_FAILED');
      }
      this.linkOnline = null;
      this._log('NOTE', `142 (8E 01) not understood, connecting anyway: ${this.replies[142].hex}`);
    } else if (this.iswireless && this.linkOnline === 0) {
      await this.waitOnline();
    }
    this.online = true;
    await this.readInfo();
    const k = await this.readProfileIndex();
    this.curOnBoard = k == null || k < 0 || k > 3 ? null : k;
    this.connectedAt = Date.now();
    return true;
  }

  async close() {
    try {
      this.hid.removeEventListener('inputreport', this._onInput);
      if (this.hid.opened) await this.hid.close();
    } catch {
      /* ignore */
    }
    this.clearState();
  }

  /* -------------------------------------------------------------- 读取 */

  // 连接时的这几条读命令失败（回包读不到 / 回显不对）时重试：Windows 上 receiveFeatureReport 偶尔报
  // NotAllowedError "Failed to receive the feature report"，以前第一条 0x8F 失败就直接"没有响应"、连接失败（实测 G23V2 + 8K 接收器）
  async readDps() {
    const r = await this._retry(() => this._fromData(143));
    if (!r) return false;
    // 先记下型号码：psd 不对时诊断信息里也需要它
    this.psd = r[1];
    this.modelCode = r[2];
    if (r[1] !== 1) return false;
    this.devname = modelFromCode(r[2]);
    if (!this.devname) return false;
    if (r[2] === 6) {
      const i1 = this.iswireless ? 6 : 5;
      this.isPink = r[i1] === 2;
    }
    this.is8KReceiver = r[3] === 2;
    const i = this.iswireless ? 5 : 4;
    this.sensor = sensorFromByte(r[i]);
    return true;
  }

  async readMatchInfo() {
    const r = await this._retry(() => this._fromData(142, 1));
    if (!r) return false;
    this.online = r[6] === 1;
    // 原版随后无条件把 online 设为 true；这里另存原值，诊断时用来判断"接收器在、鼠标不在线"（例如配对丢失）
    this.linkOnline = r[6];
    if (r[6] === 1) this.lastOnlineAt = Date.now();
    return true;
  }

  /**
   * 等鼠标连上接收器（见 ONLINE_POLL）。等不到就照旧连接：配对丢失时会一直不在线（issue #6），
   * 连接后由 store 继续等它上线再重新连接。返回是否在线，等了多久记在 onlineWaitMs
   */
  async waitOnline(tries = ONLINE_TRIES) {
    const started = Date.now();
    let polls = 0;
    while (this.linkOnline === 0 && polls < tries) {
      await sleep(ONLINE_POLL);
      polls++;
      if (!(await this.readMatchInfo())) break;
    }
    this.onlineWaitMs = Date.now() - started;
    const online = this.linkOnline !== 0;
    this._log('NOTE', `mouse ${online ? 'came online' : 'still offline'} after ${polls} poll(s) of 8E 01, ${this.onlineWaitMs}ms`);
    return online;
  }

  async readDif() {
    const r = await this._retry(() => this._fromData(131));
    if (!r) return null;
    this._keepDpiExtra(r);
    return [r[2], r[1]]; // [当前档位, 档位数]
  }

  /**
   * 0x83 回包 r[3..5] 是 [3, 档位数, 当前档, a, b, c] 后三个字节里写进去的值。旧版 GHERO 专用官方驱动用 a 设 DPI 指示灯效果
   * （0 常亮 / 1 呼吸 / 2 关），b、c 默认 1；官方新版桌面驱动先读出来，写的时候原样带上（sub_44A390 → sub_44A300）。
   * 固件 1.4.0.3（IDA）只是存起来、读的时候回给电脑，不用于别的。这里也照原样带上，不再写成 0。
   */
  _keepDpiExtra(r) {
    if (r && r.length >= 6) this.dpiExtra = [r[3], r[4], r[5]];
  }

  /**
   * 137（0x89）设备信息。原版把它当成和状态包一样的布局（r[0] 电量、r[1] 回报率），但 r[0] 其实是命令回显。
   * 实际布局以官方桌面驱动为准（GamingMouse.exe sub_4455E0 / sub_4344A0），与实测 G23V2 回包一致：
   * r[1] 电量  r[2] 充电状态  r[3] 回报率  r[4] 当前 DPI 档  r[7] 固定 0x5A（官方驱动据此判断回包有效）
   * 固件 1.4.0.3（IDA）：有线时由鼠标实时回答；接收器不转发 0x89，用最近一个状态包里的电量 / DPI 档回答，
   * 收到过状态包才有 r[7] = 0x5A。r[2] 其实是连接方式（有线 2 / 1K 接收器 1 / 8K 接收器 0），不是充电状态。
   */
  async readInfo() {
    const r = await this._retry(() => this._fromData(137));
    if (!r) return false;
    await sleep(100);
    const di = await this.readDif();
    if (di != null && di.length <= 0) return false;
    const rate = r[3] & 15;
    if (rate <= 6) this.curUSBRate = RATE_HW[rate];
    // r[2] 不是充电状态，不据此显示充电。电量和状态包一样显示原值（固件已平滑）。
    // 实测 G23V2 无线（8K 接收器）时整包除 0x5A 外全为 0，此时电量未知，等待状态包
    if (r[7] === 0x5a && r[1] > 0 && r[1] <= 100) this.power = r[1];
    this.curDpi = di != null ? di[0] : -1;
    this.dpiLevels = di != null ? di[1] : -1;
    return true;
  }

  async readKEY(index) {
    const r = await this._fromData(134, index);
    if (!r || r[1] !== index) return null;
    return (r[5] << 24) | (r[4] << 16) | (r[3] << 8) | r[2];
  }

  readProfileIndex() {
    return this._retry(() => this.readKEY(9));
  }

  /* ---------------------------------------------------------- 硬件槽位 */
  // 1.4.x 固件（升级包 1.4.0.3，IDA 分析）有 4 个硬件槽位，官方新版桌面驱动 incott-app 1.4.0.3 用下面两条命令：
  //   · [0x85,6] 读当前槽位。有线回包 [0x85, 槽位]（不回显子序号）；经 1K / 8K 接收器时接收器原样转发鼠标的无线回包，
  //     是 [0x85, 6, 槽位]。官方驱动两种情况都取 r[1]，无线时总读成槽位 0。
  //   · [5,6,N] 切到槽位 N：鼠标存下槽位号，重新载入这个槽位的全部设置，并主动发一个状态包。
  // 更早的固件（例如 1.3.8）没有槽位：有线时 [0x85,6] / [0x85,7] 回全 0；无线时照样回显子序号，后面跟着上一条
  // 无线回包留下的字节——所以无线下要先做一次已知结果的读取，确认读到的不是残留。

  /** 读当前硬件槽位（0–3）；固件不支持或读不到时为 null */
  async readHwSlot() {
    if (!this.iswireless) {
      const r = await this._retry(() => this._fromData(0x85, 6));
      return r && r[1] <= 3 ? r[1] : null;
    }
    // 无线：先读一项（回包第 2 字节就是它在鼠标无线缓冲区里留下的值），再读槽位；读到的和这个值相同时可能只是残留，
    // 换一个值不同的项再试。真支持的固件两次都回同一个槽位，不支持的会跟着残留变
    const seen = new Set();
    for (const [cmd, sub] of [[0x85, 1], [0x85, 3], [0x84, 1], [0x84, 5], ...[0, 1, 2, 3, 4, 5].map((k) => [0x86, k])]) {
      const p = await this._retry(() => this._readSub(cmd, sub));
      if (!p || seen.has(p[2])) continue;
      const r = await this._retry(() => this._readSub(0x85, 6));
      if (!r) return null;
      if (r[2] !== p[2]) return r[2] <= 3 ? r[2] : null;
      seen.add(p[2]);
      if (seen.size >= 2) return null; // 两次都跟着残留变：固件不认识这条命令
    }
    return null;
  }

  /**
   * 固件能否由软件切换硬件槽位：能则返回当前槽位（0–3），否则 null。
   * 有线时 [0x85,7] 在 1.4.x 固件上回显 7（更早的固件回 0），用它区分"槽位 0"和"不支持"。
   */
  async probeHwSlot() {
    if (!this.iswireless) {
      const r = await this._retry(() => this._fromData(0x85, 7));
      if (!r || r[1] !== 7) return null;
    }
    return this.readHwSlot();
  }

  /** [5,6,N]：切到硬件槽位 N（官方新版桌面驱动 sub_44A1C0） */
  setHwSlot(n) {
    if (n < 0 || n > 3) return Promise.resolve(false);
    return this._doTask(new Uint8Array([5, 6, n, 0, 0, 0, 0, 0]));
  }

  /** 等一个满足 pred 的状态包；ms 内没等到返回 null */
  waitStatus(pred, ms) {
    return new Promise((resolve) => {
      let timer;
      const on = (e) => {
        if (!pred(e.detail)) return;
        clearTimeout(timer);
        this.removeEventListener('status', on);
        resolve(e.detail);
      };
      this.addEventListener('status', on);
      timer = setTimeout(() => {
        this.removeEventListener('status', on);
        resolve(null);
      }, ms);
    });
  }

  /** 读取鼠标当前的按键映射（按界面按键顺序），无法识别的项为 null */
  async readKeyMap() {
    const out = [];
    for (let i = 0; i < dvar.key.length; i++) {
      const code = await this.readKEY(dvar.key[i].matrix);
      out.push(code == null ? null : hwToKey(code));
    }
    return out;
  }

  /** 带子序号的读命令（0x82 / 0x84 / 0x85 …）：回包 r[1] 必须回显子序号 */
  async _readSub(cmd, sub) {
    const r = await this._fromData(cmd, sub);
    return r && r[1] === sub ? r : null;
  }

  /** 读取失败时重试：实测 G23V2 刚换完槽位时最初几次读取会失败 */
  /**
   * 读不到时再试几次。超时不重试：超时的那次调用还挂在 WebHID 里，再发只会继续排队，
   * 接收器卡住时连接要多等好几个 HID_TIMEOUT
   */
  async _retry(fn, tries = 3) {
    for (let i = 0; i < tries; i++) {
      this._timedOut = false;
      const r = await fn();
      if (r != null) return r;
      if (this._timedOut) return null;
      if (i < tries - 1) await sleep(60);
    }
    return null;
  }

  /**
   * 读出鼠标当前的全部设置（对应官方桌面驱动连接时的 sub_4323B0），读不到的项为 null。
   * 实测 G23V2：回报率、DPI 数值 / 档位数 / 当前档、LOD、传感器开关、传感器模式、消抖、休眠每个硬件槽位各一份，
   * 按键与接收器灯效由固件共用。读命令与官方桌面驱动一致（GamingMouse.exe sub_4447C0 / sub_445B50 / sub_444900 …）。
   * 网页驱动只用 0x83 / 0x86 / 0x85-3，其余几条（0x81 / 0x82 / 0x84 / 0x85-1、2 / 0x88，诊断里标 *）在不支持的固件上
   * 只回全 0：全都是 0 时（6 档 DPI 不可能都是 50）这些项按"读不到"处理，并标记 starZero。
   * @param dpiCount 读取前几档 DPI 数值
   * @param quick    只读回报率、DPI、LOD、消抖、休眠，约 0.4 秒
   */
  async readSlot(dpiCount = 6, { quick = false } = {}) {
    const out = { rate: null, levels: null, cur: null, dpi: [], lod: null, ripple: null, fixline: null, motion: null };
    Object.assign(out, { sensormode: null, debounce: null, fire: null, sleeptime: null, keys: [], receiverLED: null, starZero: false });
    const read = (cmd) => this._retry(() => this._fromData(cmd));
    const readSub = (cmd, sub) => this._retry(() => this._readSub(cmd, sub));
    const star = []; // 标 * 的命令读到的数值
    let r = await read(0x81);
    if (r) star.push(r[1]);
    if (r && (r[1] & 15) <= 6) out.rate = RATE_HW[r[1] & 15];
    r = await read(0x83);
    if (r) [out.levels, out.cur] = [r[1], r[2]];
    this._keepDpiExtra(r);
    for (let i = 0; i < dpiCount; i++) {
      r = await readSub(0x82, i);
      if (r) star.push(r[2], r[3]);
      out.dpi.push(r ? r[2] | (r[3] << 8) : null);
    }
    const sensorKeys = quick ? ['lod'] : ['lod', 'ripple', 'fixline', 'motion', 'sensormode'];
    for (let i = 0; i < sensorKeys.length; i++) {
      r = await readSub(0x84, i + 1);
      if (r) star.push(r[2]);
      if (r) out[sensorKeys[i]] = r[2];
    }
    r = await readSub(0x85, 1);
    if (r) star.push(r[2]);
    if (r) out.debounce = r[2];
    r = await readSub(0x85, 3);
    if (r) out.sleeptime = (r[3] << 8) | r[2];
    if (!quick) {
      r = await readSub(0x85, 2);
      if (r) star.push(r[2], r[3]);
      if (r) out.fire = [r[2], r[3]];
      for (let i = 0; i < dvar.key.length; i++) out.keys.push(await this._retry(() => this.readKEY(dvar.key[i].matrix)));
      // 接收器灯效只有 8K 接收器有（写入、对照也只在 8K 时做）。1K 接收器（276.bin）不认识 0x88，
      // 只回上一条的残留，回显对不上要重试 3 次（issue #11 诊断里白白多了约 300ms）
      if (this.is8KReceiver) {
        r = await read(0x88);
        if (r) star.push(r[1]);
        if (r) out.receiverLED = r[1];
      }
    }
    if (star.length && star.every((v) => v === 0)) {
      out.starZero = true;
      out.rate = out.lod = out.ripple = out.fixline = out.motion = out.sensormode = out.debounce = out.fire = out.receiverLED = null;
      out.dpi = out.dpi.map(() => null);
    }
    return out;
  }

  /** 133,3（0x85/3）读休眠时间（秒）。原版命名 getSl，并非无线信号：官方桌面驱动读出后原样用 [5,3] 写回 */
  async readSleepTime() {
    const r = await this._fromData(133, 3);
    if (!r || r[1] !== 3) return null;
    return (r[3] << 8) | r[2];
  }

  /* -------------------------------------------------------------- 写入 */

  /** 2000 Hz 以上只有 8K 接收器支持（官方驱动同样只在 8K 接收器下开放），其它连接方式写入时按 1000 Hz */
  writableRate(rate) {
    return !this.is8KReceiver && RATE_8K_ONLY.includes(rate) ? 1000 : rate;
  }

  setRte(rate) {
    const val = RATE_HW.indexOf(rate);
    if (val < 0) return Promise.resolve(false);
    return this._doTask(new Uint8Array([1, val, 0, 0, 0, 0, 0, 0]));
  }

  async setResolution(ix, d1, d2) {
    if (ix < 0) return false;
    const flag = d1 === d2 ? 0 : 1;
    let result = await this._doTask(new Uint8Array([2, ix, d1 & 255, (d1 >> 8) & 255, 0, 0, 0, flag]));
    if (d1 !== d2) {
      await sleep(100);
      result = await this._doTask(new Uint8Array([2, ix, d2 & 255, (d2 >> 8) & 255, 0, 0, 0, 2]));
    }
    return result;
  }

  setDif(ix, levels) {
    const s = getStDPI(this.sensor);
    if (!s || ix < 0 || ix >= s.dpi.length) return Promise.resolve(false);
    // 后三个字节照读到的写回（见 _keepDpiExtra）；没读到时和以前一样写 0
    const [a, b, c] = this.dpiExtra || [0, 0, 0];
    return this._doTask(new Uint8Array([3, levels, ix, a, b, c, 0, 0]));
  }

  setLD(t) {
    if (t < 0 || t > 2) return Promise.resolve(false);
    return this._doTask(new Uint8Array([4, 1, t, 0, 0, 0, 0, 0]));
  }
  setRi(on) {
    return this._doTask(new Uint8Array([4, 2, on ? 1 : 0, 0, 0, 0, 0, 0]));
  }
  setFix(on) {
    return this._doTask(new Uint8Array([4, 3, on ? 1 : 0, 0, 0, 0, 0, 0]));
  }
  setMt(on) {
    return this._doTask(new Uint8Array([4, 4, on ? 1 : 0, 0, 0, 0, 0, 0]));
  }
  setSM(mode) {
    return this._doTask(new Uint8Array([4, 5, mode, 0, 0, 0, 0, 0]));
  }
  setDce(t) {
    if (t > 30) t = 30;
    return this._doTask(new Uint8Array([5, 1, t, 0, 0, 0, 0, 0]));
  }
  setFKeyPm(lp, t) {
    return this._doTask(new Uint8Array([5, 2, lp, t, 0, 0, 0, 0]));
  }
  setSep(t) {
    if (t < 10) t = 10;
    return this._doTask(new Uint8Array([5, 3, t & 255, (t >> 8) & 255, 0, 0, 0, 0]));
  }
  setMsK(index, code) {
    if (index < 0 || index >= dvar.key.length) return Promise.resolve(false);
    return this._doTask(
      new Uint8Array([6, index, code & 255, (code >> 8) & 255, (code >> 16) & 255, (code >>> 24) & 255, 0, 0])
    );
  }
  setProfileIndex(index) {
    return this._doTask(new Uint8Array([6, 9, index, 0, 0, 0, 0, 0]));
  }
  setReceiverLED(mode) {
    return this._doTask(new Uint8Array([8, mode, 0, 0, 0, 0, 0, 0]));
  }

  /**
   * 宏下发：10 包，每包先发 Feature 头 [7,10,i,32,bID]，80ms 后发 32 字节 Output。
   * 每包的头与数据放在同一个互斥段里，避免期间插入其它读写（例如板载序号确认）打乱固件的收包顺序。
   */
  async setJuJi(bID, data) {
    const count = 10;
    for (let i = 0; i < count; i++) {
      this._macroPacket = i;
      const ok = await this._exclusive(async () => {
        if (!(await this._sendFeature(new Uint8Array([7, count, i, 32, bID, 0, 0, 0])))) return false;
        await sleep(80);
        return this._sendOutput(new Uint8Array(data.slice(i * 32, i * 32 + 32)));
      });
      if (!ok) return false;
    }
    return true;
  }

  /* ---------------------------------------------------- 应用配置（apply） */

  /**
   * 把配置文件写入鼠标，逐项对应原版 CBAccess.apply。
   * @param pf       StProfile
   * @param flag     ap* 标志组合
   * @param index    按键/DPI 序号（255 = 全部）；apSensor 时为位掩码
   * @param ctx      { macros: STMacroList, profileIndex: number, onProgress?: (pct)=>void }
   */
  async apply(pf, flag, index, ctx) {
    // 记下失败在哪一步（诊断用）：原版只返回 false，看不出是哪条命令、因为什么失败
    this.applyError = null;
    this.lastHidError = null;
    const fail = (step) => {
      this.applyError = this.lastHidError ? `${step} — ${this.lastHidError}` : step;
      return false;
    };
    if (!this.isOpen || !pf) return fail('device not open');
    const waitT = 200;
    const progress = (v) => ctx.onProgress && ctx.onProgress(Math.min(100, v));
    let pg = 0;
    const pgstep = 60 / (dvar.key.length + pf.dpi.length);
    const klen = dvar.key.length;

    if (flag & apKey) {
      for (let i = 0; i < klen; i++) {
        progress((pg += pgstep));
        if (index !== 255 && i !== index) continue;
        let k = pf.key[i];
        // 与原版不同：宏库里找不到绑定的宏（已删除 / 来自导入的配置）时，原版直接中断整个写入，
        // 导致后面的按键、DPI、回报率等都写不进去。这里改为按该键的默认功能写入，继续后续项目。
        if (k.major === fJuji && !ctx.macros?.find(k.itemdata)) k = dvar.key[i];
        if (k.major === fMouse && k.minor === favFIRE) {
          let lp = k.itemdata & 65535;
          let ir = (k.itemdata >> 16) & 65535;
          if (lp > 3) lp = 3;
          if (ir > 255) ir = 255;
          await sleep(waitT);
          if (!(await this.setFKeyPm(lp, ir))) return fail(`key ${i + 1}: fire key params`);
        } else if (k.major === fJuji) {
          const t = ctx.macros.find(k.itemdata);
          const b = macroToHw(t, i);
          if (!b) return fail(`key ${i + 1}: macro encode`);
          await sleep(waitT);
          if (!(await this.setJuJi(i, b))) return fail(`key ${i + 1}: macro packet ${this._macroPacket + 1}/10`);
        }
        const pos = dvar.key[i].matrix;
        const code = keyToHw(k, i);
        if (code !== -1) {
          await sleep(waitT);
          if (!(await this.setMsK(pos, code))) return fail(`key ${i + 1}: code 0x${(code >>> 0).toString(16)} → matrix ${pos}`);
        }
      }
    }

    if (flag & apDpi) {
      for (let i = 0; i < pf.dpi.length; i++) {
        progress((pg += pgstep));
        if (index !== 255 && i !== index) continue;
        const dx = getHwForDpi(pf.dpi[i], this.sensor);
        const dy = getHwForDpi(pf.dpiy[i], this.sensor);
        if (dx !== -1 && dy !== -1) {
          await sleep(waitT);
          if (!(await this.setResolution(i, dx, dy))) return fail(`dpi #${i + 1} ${pf.dpi[i]}/${pf.dpiy[i]}`);
        }
      }
    }

    if (flag & apDpiLevel) {
      const levels = pf.dpi.length;
      let cur = pf.curDpi;
      // 原版这里取 1，只有 1 档时必然越界，导致整个写入中断（后面的回报率、LOD 等都写不进去）
      if (cur >= levels) cur = levels - 1;
      if (levels <= 0 || cur < 0) return fail(`dpi level: invalid current ${cur} / ${levels} stages`);
      await sleep(waitT);
      if (!(await this.setDif(cur, levels))) return fail(`dpi level ${cur + 1}/${levels}`);
    }
    progress((pg += 5));

    // 配置里可能是在 8K 接收器下保存的 2000+ Hz，换成有线 / 1K 接收器时不能原样写入
    const rate = this.writableRate(pf.usbrate);
    if (flag & apRate) {
      await sleep(waitT);
      if (!(await this.setRte(rate))) return fail(`rate ${rate}`);
    }
    progress((pg += 5));

    // sensorModeAnyRate：1.4 固件的 PAW3950 在 2000 Hz 以上也写（模式由固件固定为电竞，「最高性能」照样生效）
    if (flag & apSensorMode && (rate < 2000 || ctx.sensorModeAnyRate)) {
      await sleep(waitT);
      // 最高位（PAW3950「最高性能」）：支持时按配置，不支持时按鼠标里原来的带上，见 SENSOR_MODE_HIFPS
      const sm = pf.sensormode | ((ctx.sensorModeHi || 0) & 0x80);
      if (!(await this.setSM(sm))) return fail(`sensor mode ${sm}`);
    }
    progress((pg += 5));

    if (flag & apLod) {
      // 与原版不同：原版 3395 分支映射错误，这里以官方桌面驱动为准（见 lodToHw）
      await sleep(waitT);
      if (!(await this.setLD(lodToHw(pf.lod, this.sensor)))) return fail(`LOD ${pf.lod}`);
    }
    progress((pg += 5));

    if (flag & apSensor) {
      if (index & 1) {
        await sleep(waitT);
        if (!(await this.setRi(pf.ripple))) return fail('ripple');
      }
      if (index & 2) {
        await sleep(waitT);
        if (!(await this.setFix(pf.fixline))) return fail('angle snap');
      }
      if (index & 4) {
        await sleep(waitT);
        if (!(await this.setMt(pf.motion))) return fail('motion sync');
      }
    }
    if (flag & apReceiverLED && this.is8KReceiver) {
      await sleep(waitT);
      if (!(await this.setReceiverLED(pf.receiverLED))) return fail('receiver LED');
    }
    progress((pg += 5));

    if (flag & apDebounce) {
      await sleep(waitT);
      if (!(await this.setDce(pf.debounce))) return fail(`debounce ${pf.debounce}`);
    }
    if (flag & apSleepTime) {
      await sleep(waitT);
      if (!(await this.setSep(pf.sleeptime))) return fail(`sleep time ${pf.sleeptime}`);
    }
    pg += 5;
    progress(pg);

    // profileIndex 为 null 时不写 [6,9,序号]（以前读不到 curOnBoard 时会写成 [6,9,0]）
    if (ctx.profileIndex != null && (flag & apOnboardIndex || this.curOnBoard == null)) {
      await sleep(waitT);
      if (await this.setProfileIndex(ctx.profileIndex)) this.curOnBoard = ctx.profileIndex;
    }
    progress(100);
    return true;
  }
}
