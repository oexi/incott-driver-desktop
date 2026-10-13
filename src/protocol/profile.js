// 配置文件模型——移植自原版 StProfile / StProfileList，文本格式与 .ict 文件完全兼容。

import { KeyInfo, dvar, getStDPI, SENSOR_3395 } from './constants.js';
import { findValForKey, findValForKeyBool, findValForKeyNumber, stringToNumber } from './textfmt.js';

export const MAGIC_PROFILE = 'incott_magic102';

export class StProfile {
  constructor(name, d, sensor) {
    this.inside = false;
    this.name = name;
    this.uid = Date.now();
    this.reset(d, sensor);
  }

  reset(d, sensor) {
    if (d == null) return;
    this.key = d.key.map((k) => k.copy());
    const stDPI = getStDPI(sensor) || d.stDPI[0];
    this.dpicolor = stDPI.dpicolor.concat();
    this.dpi = stDPI.dpi.concat();
    this.dpiy = stDPI.dpi.concat();
    this.dpisensor = sensor;
    this.curDpi = stDPI.defDPIInx;
    this.usbrate = 1000;
    this.lod = 1;
    this.sensormode = 1;
    this.fixline = false;
    this.ripple = false;
    this.motion = true;
    this.debounce = 8;
    this.sleeptime = 60;
    this.receiverLED = 0;
  }

  copy() {
    const t = new StProfile(this.name, null);
    t.uid = Date.now();
    t.inside = this.inside;
    t.key = this.key.map((k) => k.copy());
    t.dpicolor = this.dpicolor.concat();
    t.dpi = this.dpi.concat();
    t.dpiy = this.dpiy.concat();
    t.curDpi = this.curDpi;
    t.dpisensor = this.dpisensor;
    t.usbrate = this.usbrate;
    t.lod = this.lod;
    t.sensormode = this.sensormode;
    t.fixline = this.fixline;
    t.ripple = this.ripple;
    t.motion = this.motion;
    t.debounce = this.debounce;
    t.sleeptime = this.sleeptime;
    t.receiverLED = this.receiverLED;
    return t;
  }

  toText() {
    let s = '';
    s += `magic:${MAGIC_PROFILE};`;
    s += `name:${this.name};`;
    s += `inside:${this.inside};`;
    s += `uid:${this.uid};`;
    s += `usbrate:${this.usbrate};`;
    s += `lod:${this.lod};`;
    s += `sensormode:${this.sensormode};`;
    s += `fixline:${this.fixline};`;
    s += `ripple:${this.ripple};`;
    s += `motion:${this.motion};`;
    s += `debounce:${this.debounce};`;
    s += `sleeptime:${this.sleeptime};`;
    s += `receiverLED:${this.receiverLED};`;
    s += `dpisensor:${this.dpisensor};`;
    s += `curDpi:${this.curDpi};`;
    s += `dpiuinum:${this.dpi.length};`;
    for (let i = 0; i < this.dpi.length; i++) s += `dpi[${i}]:${this.dpi[i]};`;
    for (let i = 0; i < this.dpi.length; i++) s += `dpiy[${i}]:${this.dpiy[i]};`;
    for (let i = 0; i < this.dpicolor.length; i++) s += `dpicolor[${i}]:${this.dpicolor[i]};`;
    for (let i = 0; i < this.key.length; i++) s += `key[${i}]:${this.key[i].toText()};`;
    return s;
  }

  initByText(str) {
    this.reset(dvar, SENSOR_3395);
    let s = findValForKey(str, 'magic');
    if (s == null || s !== MAGIC_PROFILE) return false;
    if ((s = findValForKey(str, 'name')) != null) this.name = s;
    if ((s = findValForKeyBool(str, 'inside')) != null) this.inside = s;
    if ((s = findValForKey(str, 'uid')) != null) this.uid = s;
    if ((s = findValForKeyBool(str, 'fixline')) != null) this.fixline = s;
    if ((s = findValForKeyBool(str, 'ripple')) != null) this.ripple = s;
    if ((s = findValForKeyBool(str, 'motion')) != null) this.motion = s;
    if ((s = findValForKeyNumber(str, 'usbrate')) != null) this.usbrate = s;
    if ((s = findValForKeyNumber(str, 'lod')) != null) this.lod = s;
    if ((s = findValForKeyNumber(str, 'sensormode')) != null) this.sensormode = s;
    if ((s = findValForKeyNumber(str, 'debounce')) != null) this.debounce = s;
    if ((s = findValForKeyNumber(str, 'sleeptime')) != null) this.sleeptime = s;
    if ((s = findValForKeyNumber(str, 'receiverLED')) != null) this.receiverLED = s;
    if ((s = findValForKeyNumber(str, 'dpisensor')) != null) this.dpisensor = s;
    if ((s = findValForKeyNumber(str, 'curDpi')) != null) this.curDpi = s;

    const stDPI = getStDPI(this.dpisensor) || dvar.stDPI[0];
    if ((s = findValForKeyNumber(str, 'dpiuinum')) != null) {
      let dpiNum = stringToNumber(String(s));
      if (dpiNum > stDPI.dpi.length) dpiNum = stDPI.dpi.length;
      for (let i = 0; i < dpiNum; i++) {
        if ((s = findValForKeyNumber(str, `dpi[${i}]`)) != null) this.dpi[i] = s;
        if ((s = findValForKeyNumber(str, `dpicolor[${i}]`)) != null) this.dpicolor[i] = s;
        if ((s = findValForKeyNumber(str, `dpiy[${i}]`)) != null) this.dpiy[i] = s;
        else this.dpiy[i] = this.dpi[i];
      }
      this.dpi.length = dpiNum;
      this.dpiy.length = dpiNum;
      this.dpicolor.length = dpiNum;
    }
    for (let i = 0; i < this.key.length; i++) {
      s = findValForKey(str, `key[${i}]`);
      if (s == null) continue;
      const arr = s.split(',');
      if (arr.length !== 5) continue;
      const k = this.key[i];
      k.major = stringToNumber(arr[0]);
      k.minor = stringToNumber(arr[1]);
      k.modifer = stringToNumber(arr[2]);
      k.macro = stringToNumber(arr[3]);
      k.itemdata = stringToNumber(arr[4]);
    }
    return true;
  }
}

export class StProfileList {
  constructor() {
    this.list = [];
  }
  add(t) {
    if (t instanceof StProfile) this.list.push(t);
  }
  clear() {
    this.list.length = 0;
  }
  toText() {
    return this.list.map((p) => p.toText()).join('|||');
  }
  initByText(str) {
    this.clear();
    for (const part of str.split('|||')) {
      const t = new StProfile('', null);
      if (t.initByText(part)) this.list.push(t);
    }
  }
}

// 原版存储键：profile_<devname> / onboard_<devname>，与经典界面共用 localStorage
export function saveProfiles(devName, list, curIndex) {
  try {
    localStorage.setItem(`profile_${devName}`, list.toText());
    localStorage.setItem(`onboard_${devName}`, String(curIndex));
  } catch {
    /* ignore */
  }
}

export function loadProfiles(devName, list) {
  let idx = null;
  try {
    const raw = localStorage.getItem(`onboard_${devName}`);
    idx = stringToNumber(raw);
    if (idx != null && (idx < 0 || idx > 3)) idx = 0;
    const s = localStorage.getItem(`profile_${devName}`);
    if (s && s.length > 0) list.initByText(s);
  } catch {
    /* ignore */
  }
  return { count: list.list.length, index: idx };
}

export { KeyInfo };
