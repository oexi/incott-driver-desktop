// 宏模型——移植自原版 mdev-v104.js（STMacro / STMacroList）与 CBAccess.juji_to_hw。

import { keynameToHid } from './keytable.js';
import { findValForKey, findValForKeyNumber, stringToNumber } from './textfmt.js';

export const MAGIC_MACRO = 'macro100';
export const lpUntilKeyRelease = 1; // 按住循环
export const lpUntilAnyKey = 2; // 循环直到任意键按下
export const lpCycle = 3; // 循环 N 次
export const MAX_ACTION = 71;
export const MAX_CYCLE = 65535;
export const MAX_DELAY = 65535;

export class STMacroItem {
  constructor(key, delay, press) {
    this.key = key; // 键名（keytable 的显示名，如 "A"、"LButton"）
    this.delay = delay; // 此动作之后的延迟（ms）
    this.press = press; // true 按下 / false 抬起
  }
}

export class STMacro {
  constructor(name) {
    this.magic = MAGIC_MACRO;
    this.name = name;
    this.uid = Date.now();
    this.looptype = lpCycle;
    this.cycle = 1;
    this.item = [];
  }

  clone() {
    const m = new STMacro(this.name);
    m.uid = this.uid;
    m.looptype = this.looptype;
    m.cycle = this.cycle;
    m.item = this.item.map((i) => new STMacroItem(i.key, i.delay, i.press));
    return m;
  }

  toText() {
    let s = '';
    s += `magic:${MAGIC_MACRO};`;
    s += `name:${this.name};`;
    s += `uid:${this.uid};`;
    s += `looptype:${this.looptype};`;
    s += `cycle:${this.cycle};`;
    this.item.forEach((it, i) => {
      s += `item[${i}]:${it.key},${it.delay},${it.press};`;
    });
    return s;
  }

  initByText(str) {
    let s = findValForKey(str, 'magic');
    if (s == null || s !== MAGIC_MACRO) return false;
    this.item = [];
    if ((s = findValForKey(str, 'name')) != null) this.name = s;
    if ((s = findValForKey(str, 'uid')) != null) this.uid = s;
    s = findValForKeyNumber(str, 'looptype');
    if (s == null || (s !== lpUntilKeyRelease && s !== lpUntilAnyKey && s !== lpCycle)) return false;
    this.looptype = s;
    s = findValForKeyNumber(str, 'cycle');
    if (s == null) return false;
    this.cycle = Math.min(s, MAX_CYCLE);
    for (let i = 0; i < MAX_ACTION; i++) {
      s = findValForKey(str, `item[${i}]`);
      if (s == null) break;
      const arr = s.split(',');
      if (arr.length !== 3) return false;
      if (keynameToHid(arr[0]) === 0) return false;
      const delay = stringToNumber(arr[1]);
      if (delay == null) return false;
      if (arr[2] !== 'true' && arr[2] !== 'false') return false;
      this.item.push(new STMacroItem(arr[0], delay, arr[2] === 'true'));
    }
    return true;
  }
}

export class STMacroList {
  constructor() {
    this.list = [];
  }
  find(uid) {
    // 注意：uid 可能是数字（新建）或字符串（从文本解析），原版用 == 比较
    // eslint-disable-next-line eqeqeq
    return this.list.find((m) => m.uid == uid) || null;
  }
  remove(uid) {
    // eslint-disable-next-line eqeqeq
    const i = this.list.findIndex((m) => m.uid == uid);
    if (i >= 0) this.list.splice(i, 1);
  }
  toText() {
    return this.list.map((m) => m.toText()).join('|||');
  }
  initByText(str) {
    this.list = [];
    for (const part of str.split('|||')) {
      const t = new STMacro('');
      if (t.initByText(part)) this.list.push(t);
    }
  }
}

export function saveMacros(list) {
  try {
    localStorage.setItem('macroLib', list.toText());
  } catch {
    /* ignore */
  }
}

export function loadMacros(list) {
  try {
    const s = localStorage.getItem('macroLib');
    if (s && s.length) list.initByText(s);
  } catch {
    /* ignore */
  }
}

/** 宏 → 320 字节硬件缓冲区（原版 juji_to_hw），bufferID 为按键序号 */
export function macroToHw(t, bufferID) {
  if (t == null || bufferID > 9) return null;
  const b = new Array(320).fill(0);
  let loop = 0;
  if (t.looptype === lpCycle) loop = 2;
  else if (t.looptype === lpUntilKeyRelease) loop = 0;
  else if (t.looptype === lpUntilAnyKey) loop = 1;
  b[0] = bufferID & 255;
  b[1] = loop;
  b[2] = t.cycle & 255;
  b[3] = (t.cycle >> 8) & 255;
  let k = 4;
  for (const it of t.item) {
    b[k] = (it.press ? 0 : 128) | 1;
    b[k + 1] = keynameToHid(it.key);
    b[k + 2] = it.delay & 255;
    b[k + 3] = (it.delay >> 8) & 255;
    k += 4;
  }
  // "Macro" + ('1' + bufferID)
  b[288] = 77;
  b[289] = 97;
  b[290] = 99;
  b[291] = 114;
  b[292] = 111;
  b[293] = 49 + bufferID;
  b[294] = 0;
  const size = (t.item.length + 1) * 4 + 128;
  b[304] = size & 255;
  b[305] = (size >> 8) & 255;
  b[306] = (size >> 16) & 255;
  b[307] = (size >> 24) & 255;
  b[308] = 16;
  b[309] = 0;
  b[310] = 232;
  b[311] = 232;
  // 原版对 uid 直接做位运算（字符串会被隐式转数字）
  const uid = Number(t.uid);
  b[312] = uid & 255;
  b[313] = (uid >> 8) & 255;
  b[314] = (uid >> 16) & 255;
  b[315] = (uid >> 24) & 255;
  const len = t.item.length * 2;
  b[316] = len & 255;
  b[317] = (len >> 8) & 255;
  b[318] = t.item.length;
  b[319] = 0;
  return b;
}
