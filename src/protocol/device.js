// INCOTT 鼠标通信——逐条移植自原版网页驱动 CBAccess（chunk-v1013.js）。
// 所有命令均为 8 字节 Feature Report（ID 9）；读取时先发命令，再 receiveFeatureReport。
// 宏数据额外通过 Output Report（ID 9）分 10 包、每包 32 字节下发。

import {
  REPORT_ID,
  PID_WIRELESS,
  KeyInfo,
  RATE_HW,
  RATE_8K_ONLY,
  SENSOR_3395,
  SENSOR_3950,
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
    case 6:
      return 'G29';
    case 8:
    case 14:
      return 'G23V2';
    case 9:
      return 'FM23';
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

/** 解析设备主动上报的状态（原版 irServer） */
export function parseInputReport(data) {
  const b0 = data.getUint8(0);
  const b1 = data.getUint8(1);
  const b2 = data.getUint8(2);
  const rate = b1 & 15;
  return {
    profileIndex: (b2 & 192) >> 6,
    charging: (b0 & 128) !== 0,
    power: Math.floor((b0 & 127) / 10) * 10,
    rate: rate <= 6 ? RATE_HW[rate] : null,
    dpiIndex: (b1 & 240) >> 4,
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
    this.linkOnline = null; // 142（8E 01）回包 r[6]：接收器报告的鼠标在线标志（原版读了但被覆盖，含义待实机确认）
    this._macroPacket = 0;
    this._onInput = (e) => {
      if (e.device !== this.hid) return;
      this.inputCount++;
      this.inputById[e.reportId] = (this.inputById[e.reportId] || 0) + 1;
      this.lastInputAt = Date.now();
      this._push(this.inputLog, INPUT_LOG_MAX, { t: Date.now() - this._t0, dir: `in#${e.reportId}`, hex: toHex(e.data) });
      // 官方驱动的读线程只处理 Report ID 9（GamingMouse.exe sub_446200），其它报告不是状态包
      if (e.reportId !== REPORT_ID) return;
      this.dispatchEvent(new CustomEvent('status', { detail: parseInputReport(e.data) }));
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
      await this.close();
      throw new Error('READ_FAILED');
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

  async readDps() {
    const r = await this._fromData(143);
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
    if (r[i] === 241) this.sensor = SENSOR_3950;
    else this.sensor = SENSOR_3395; // 240 或未知
    return true;
  }

  async readMatchInfo() {
    const r = await this._fromData(142, 1);
    if (!r) return false;
    this.online = r[6] === 1;
    // 原版随后无条件把 online 设为 true；这里另存原值，诊断时用来判断"接收器在、鼠标不在线"（例如配对丢失）
    this.linkOnline = r[6];
    return true;
  }

  async readDif() {
    const r = await this._fromData(131);
    if (!r) return null;
    return [r[2], r[1]]; // [当前档位, 档位数]
  }

  /**
   * 137（0x89）设备信息。原版把它当成和状态包一样的布局（r[0] 电量、r[1] 回报率），但 r[0] 其实是命令回显。
   * 实际布局以官方桌面驱动为准（GamingMouse.exe sub_4455E0 / sub_4344A0），与实测 G23V2 回包一致：
   * r[1] 电量  r[2] 充电状态  r[3] 回报率  r[4] 当前 DPI 档  r[7] 固定 0x5A（官方驱动据此判断回包有效）
   */
  async readInfo() {
    const r = await this._fromData(137);
    if (!r) return false;
    await sleep(100);
    const di = await this.readDif();
    if (di != null && di.length <= 0) return false;
    const rate = r[3] & 15;
    if (rate <= 6) this.curUSBRate = RATE_HW[rate];
    // 充电状态的取值含义未确认，不据此显示充电；电量与状态包一样按 10% 取整。
    // 实测 G23V2 无线（8K 接收器）时整包除 0x5A 外全为 0，此时电量未知，等待状态包
    if (r[7] === 0x5a && r[1] > 0 && r[1] <= 100) this.power = Math.floor(r[1] / 10) * 10;
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
    return this.readKEY(9);
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
  async _retry(fn, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const r = await fn();
      if (r != null) return r;
      if (i < tries - 1) await sleep(60);
    }
    return null;
  }

  /**
   * 读出鼠标当前板载配置（槽位）里的全部设置，读不到的项为 null。
   * 实测 G23V2：回报率、DPI 数值 / 档位数 / 当前档、LOD、传感器开关、传感器模式、消抖、休眠每个槽位各一份，
   * 按键与接收器灯效由固件共用（软件里每个配置各记一份，与原版一致）。读命令与官方桌面驱动一致（GamingMouse.exe sub_4447C0 / sub_445B50 / sub_444900 …）。
   * @param dpiCount 读取前几档 DPI 数值
   * @param quick    只读用于区分槽位的几项（回报率、DPI、LOD、消抖、休眠），约 0.4 秒
   */
  async readSlot(dpiCount = 6, { quick = false } = {}) {
    const out = { rate: null, levels: null, cur: null, dpi: [], lod: null, ripple: null, fixline: null, motion: null };
    Object.assign(out, { sensormode: null, debounce: null, fire: null, sleeptime: null, keys: [], receiverLED: null });
    const read = (cmd) => this._retry(() => this._fromData(cmd));
    const readSub = (cmd, sub) => this._retry(() => this._readSub(cmd, sub));
    let r = await read(0x81);
    if (r && (r[1] & 15) <= 6) out.rate = RATE_HW[r[1] & 15];
    r = await read(0x83);
    if (r) [out.levels, out.cur] = [r[1], r[2]];
    for (let i = 0; i < dpiCount; i++) {
      r = await readSub(0x82, i);
      out.dpi.push(r ? r[2] | (r[3] << 8) : null);
    }
    const sensorKeys = quick ? ['lod'] : ['lod', 'ripple', 'fixline', 'motion', 'sensormode'];
    for (let i = 0; i < sensorKeys.length; i++) {
      r = await readSub(0x84, i + 1);
      if (r) out[sensorKeys[i]] = r[2];
    }
    r = await readSub(0x85, 1);
    if (r) out.debounce = r[2];
    r = await readSub(0x85, 3);
    if (r) out.sleeptime = (r[3] << 8) | r[2];
    if (quick) return out;
    r = await readSub(0x85, 2);
    if (r) out.fire = [r[2], r[3]];
    for (let i = 0; i < dvar.key.length; i++) out.keys.push(await this._retry(() => this.readKEY(dvar.key[i].matrix)));
    r = await read(0x88);
    if (r) out.receiverLED = r[1];
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
    return this._doTask(new Uint8Array([3, levels, ix, 0, 0, 0, 0, 0]));
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

    if (flag & apSensorMode && rate < 2000) {
      await sleep(waitT);
      if (!(await this.setSM(pf.sensormode))) return fail(`sensor mode ${pf.sensormode}`);
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

    if (flag & apOnboardIndex || this.curOnBoard == null) {
      await sleep(waitT);
      if (await this.setProfileIndex(ctx.profileIndex)) this.curOnBoard = ctx.profileIndex;
    }
    progress(100);
    return true;
  }
}
