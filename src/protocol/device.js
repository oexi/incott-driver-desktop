// INCOTT 鼠标通信——逐条移植自原版网页驱动 CBAccess（chunk-v1013.js）。
// 所有命令均为 8 字节 Feature Report（ID 9）；读取时先发命令，再 receiveFeatureReport。
// 宏数据额外通过 Output Report（ID 9）分 10 包、每包 32 字节下发。

import {
  REPORT_ID,
  PID_WIRELESS,
  KeyInfo,
  RATE_HW,
  SENSOR_3395,
  SENSOR_3950,
  dvar,
  getStDPI,
  getHwForDpi,
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
function modelFromCode(code) {
  switch (code) {
    case 1:
      return 'Ghero';
    case 2:
      return 'G23';
    case 3:
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

export class IncottDevice extends EventTarget {
  constructor(hid) {
    super();
    this.hid = hid;
    this.clearState();
    this._chain = Promise.resolve();
    this._onInput = (e) => {
      if (e.device !== this.hid) return;
      this.dispatchEvent(new CustomEvent('status', { detail: parseInputReport(e.data) }));
    };
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
    this.curLod = 0;
    this.iswireless = false;
    this.is8KReceiver = false;
    this.isPink = false;
    this.psd = 0;
    this.sensor = 0;
    this.devname = '';
    this.curOnBoard = null;
    this.signal = null;
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
    for (let i = 0; i < 3; i++) {
      try {
        await this.hid.sendFeatureReport(REPORT_ID, b);
        return true;
      } catch (err) {
        if (i >= 2) {
          console.warn('[hid] sendFeatureReport failed', err);
          return false;
        }
        await sleep(100);
      }
    }
    return false;
  }

  /** 原版 elsDevice：sendReport（Output Report） */
  async _sendOutput(b) {
    try {
      await this.hid.sendReport(REPORT_ID, b);
      return true;
    } catch (err) {
      console.warn('[hid] sendReport failed', err);
      return false;
    }
  }

  /** 原版 recvDevice + readData：返回去掉 Report ID 的数据，第 0 字节为命令回显 */
  async _readData(md) {
    let r;
    try {
      r = await this.hid.receiveFeatureReport(REPORT_ID);
    } catch (err) {
      console.warn('[hid] receiveFeatureReport failed', err);
      return null;
    }
    if (!r) return null;
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

  /* -------------------------------------------------------------- 连接 */

  /** 原版 innerE */
  async open() {
    if (!this.hid.opened) await this.hid.open();
    this.opened = true;
    this.curpid = this.hid.productId;
    this.iswireless = this.hid.productId === PID_WIRELESS;
    this.hid.addEventListener('inputreport', this._onInput);

    if (!(await this.readDps()) || this.devname === '') {
      await this.close();
      throw new Error('UNSUPPORTED_DEVICE');
    }
    if (!(await this.readMatchInfo())) {
      await this.close();
      throw new Error('READ_FAILED');
    }
    this.online = true;
    await this.readInfo();
    if (this.iswireless) this.signal = await this.getSl();
    const k = await this.readProfileIndex();
    this.curOnBoard = k == null || k < 0 || k > 3 ? null : k;
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
    if (!r || r[1] !== 1) return false;
    this.psd = r[1];
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
    return true;
  }

  async readDif() {
    const r = await this._fromData(131);
    if (!r) return null;
    return [r[2], r[1]]; // [当前档位, 档位数]
  }

  async readInfo() {
    const r = await this._fromData(137);
    if (!r) return false;
    await sleep(100);
    const di = await this.readDif();
    if (di != null && di.length <= 0) return false;
    this.charging = (r[0] & 128) !== 0;
    this.power = Math.floor((r[0] & 127) / 10) * 10;
    // 原版读 r[1]，但实测（G23V2 有线/无线）回报率编码在 r[3]，r[1] 恒不是回报率
    const rate = r[3] & 15;
    if (rate <= 6) this.curUSBRate = RATE_HW[rate];
    this.curDpi = di != null ? di[0] : -1;
    this.dpiLevels = di != null ? di[1] : -1;
    this.curLod = (r[6] & 240) >> 4;
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

  async getSl() {
    if (!this.iswireless) return null;
    const r = await this._fromData(133, 3);
    if (!r) return null;
    return (r[3] << 8) | r[2];
  }

  /* -------------------------------------------------------------- 写入 */

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

  /** 宏下发：10 包，每包先发 Feature 头 [7,10,i,32,bID]，80ms 后发 32 字节 Output */
  async setJuJi(bID, data) {
    const count = 10;
    for (let i = 0; i < count; i++) {
      if (!(await this._doTask(new Uint8Array([7, count, i, 32, bID, 0, 0, 0])))) return false;
      await sleep(80);
      const ok = await this._exclusive(() => this._sendOutput(new Uint8Array(data.slice(i * 32, i * 32 + 32))));
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
    if (!this.isOpen || !pf) return false;
    const waitT = 200;
    const progress = (v) => ctx.onProgress && ctx.onProgress(Math.min(100, v));
    let pg = 0;
    const pgstep = 60 / (dvar.key.length + pf.dpi.length);
    const klen = dvar.key.length;

    if (flag & apKey) {
      for (let i = 0; i < klen; i++) {
        progress((pg += pgstep));
        if (index !== 255 && i !== index) continue;
        const k = pf.key[i];
        if (k.major === fMouse && k.minor === favFIRE) {
          let lp = k.itemdata & 65535;
          let ir = (k.itemdata >> 16) & 65535;
          if (lp > 3) lp = 3;
          if (ir > 255) ir = 255;
          await sleep(waitT);
          if (!(await this.setFKeyPm(lp, ir))) return false;
        } else if (k.major === fJuji) {
          const t = ctx.macros.find(k.itemdata);
          const b = macroToHw(t, i);
          if (!t || !b) return false;
          await sleep(waitT);
          if (!(await this.setJuJi(i, b))) return false;
        }
        const pos = dvar.key[i].matrix;
        const code = keyToHw(k, i);
        if (code !== -1) {
          await sleep(waitT);
          if (!(await this.setMsK(pos, code))) return false;
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
          if (!(await this.setResolution(i, dx, dy))) return false;
        }
      }
    }

    if (flag & apDpiLevel) {
      const levels = pf.dpi.length;
      let cur = pf.curDpi;
      if (cur >= levels) cur = 1;
      if (levels < 0 || cur < 0 || cur >= levels) return false;
      await sleep(waitT);
      if (!(await this.setDif(cur, levels))) return false;
    }
    progress((pg += 5));

    if (flag & apRate) {
      await sleep(waitT);
      if (!(await this.setRte(pf.usbrate))) return false;
    }
    progress((pg += 5));

    if (flag & apSensorMode && pf.usbrate < 2000) {
      await sleep(waitT);
      if (!(await this.setSM(pf.sensormode))) return false;
    }
    progress((pg += 5));

    if (flag & apLod) {
      let lod = null;
      if (this.sensor === SENSOR_3950) {
        if (pf.lod === 0) lod = 2;
        else if (pf.lod === 1) lod = 0;
        else if (pf.lod === 2) lod = 1;
      } else {
        lod = pf.lod;
      }
      if (lod == null) lod = 0;
      await sleep(waitT);
      if (!(await this.setLD(lod))) return false;
    }
    progress((pg += 5));

    if (flag & apSensor) {
      if (index & 1) {
        await sleep(waitT);
        if (!(await this.setRi(pf.ripple))) return false;
      }
      if (index & 2) {
        await sleep(waitT);
        if (!(await this.setFix(pf.fixline))) return false;
      }
      if (index & 4) {
        await sleep(waitT);
        if (!(await this.setMt(pf.motion))) return false;
      }
    }
    if (flag & apReceiverLED && this.is8KReceiver) {
      await sleep(waitT);
      if (!(await this.setReceiverLED(pf.receiverLED))) return false;
    }
    progress((pg += 5));

    if (flag & apDebounce) {
      await sleep(waitT);
      if (!(await this.setDce(pf.debounce))) return false;
    }
    if (flag & apSleepTime) {
      await sleep(waitT);
      if (!(await this.setSep(pf.sleeptime))) return false;
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
