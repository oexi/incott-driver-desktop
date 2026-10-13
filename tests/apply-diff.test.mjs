// 差分测试：在沙箱中运行原版网页驱动（classic/js，未修改的混淆代码）的 CBAccess.apply，
// 与本项目移植的 IncottDevice.apply 对比发往鼠标的每一个 HID 报文，要求逐字节一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 让两边的 sleep 都立即返回
globalThis.setTimeout = (f) => setImmediate(f);

const C = await import('../src/protocol/constants.js');
const { IncottDevice } = await import('../src/protocol/device.js');
const { StProfile } = await import('../src/protocol/profile.js');
const { STMacro, STMacroItem, STMacroList, macroToHw } = await import('../src/protocol/macro.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL = ['define-v100.js', 'text_sc-v106.js', 'text_en-v106.js', 'xsed-v100.js', 'dlg-v101.js', 'public-v106.js', 'gvarG23-v102.js', 'mdev-v104.js', 'chunk-v1013.js'];

function loadOriginal() {
  const stub = () =>
    new Proxy(function () {}, {
      get: (_t, k) =>
        k === Symbol.toPrimitive ? () => '' : k === 'children' ? { item: () => stub(), length: 0, namedItem: () => stub() } : stub(),
      apply: () => stub(),
      construct: () => stub(),
      set: () => true,
    });
  const store = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (f) => setImmediate(f),
    clearTimeout() {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)) },
    navigator: { hid: {} },
    self: {},
    location: { search: '' },
    Uint8Array,
    DataView,
    ArrayBuffer,
    Promise,
    Date,
    Math,
    JSON,
  };
  ctx.window = ctx;
  ctx.document = new Proxy({}, { get: (t, k) => (k in t ? t[k] : stub()), set: (t, k, v) => ((t[k] = v), true) });
  vm.createContext(ctx);
  for (const f of ORIGINAL) vm.runInContext(fs.readFileSync(path.join(ROOT, 'classic', 'js', f), 'utf8'), ctx, { filename: f });
  vm.runInContext('initgvarG23(dvar); ace = new CBAccess();', ctx);
  return ctx;
}

function fakeHid(log) {
  return {
    opened: true,
    productId: C.PID_WIRELESS,
    async sendFeatureReport(id, b) {
      log.push(['F', id, ...b]);
    },
    async sendReport(id, b) {
      log.push(['O', id, ...b]);
    },
    async receiveFeatureReport() {
      return new DataView(new Uint8Array(9).buffer);
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

/** 构造一个尽量覆盖各类功能的配置 */
function richProfile(sensor) {
  const p = new StProfile('测试', C.dvar, sensor);
  const kb = new C.KeyInfo(C.fKeyboard, 0x04); // A
  const combo = new C.KeyInfo(C.fKeyboard, 0x06); // Ctrl+Shift+C
  combo.modifer = C.mdfCtrlL | C.mdfShiftL;
  const fire = new C.KeyInfo(C.fMouse, C.favFIRE);
  fire.itemdata = (35 << 16) | 2;
  const macro = new C.KeyInfo(C.fJuji, 0);
  macro.itemdata = 1724000000123;
  p.key = [new C.KeyInfo(C.fMouse, C.fmsCLICK), combo, new C.KeyInfo(C.fMedia, C.fmeVOLINC), fire, macro, kb];
  p.dpi = [450, 1600, 3200, 26000];
  p.dpiy = [450, 800, 3200, 26000];
  p.dpicolor = p.dpicolor.slice(0, 4);
  p.curDpi = 2;
  p.usbrate = 500;
  p.lod = 0;
  p.sensormode = 2;
  p.motion = false;
  p.fixline = true;
  p.ripple = true;
  p.debounce = 3;
  p.sleeptime = 300;
  p.receiverLED = 1;
  return p;
}

function richMacro() {
  const m = new STMacro('combo-macro');
  m.uid = 1724000000123;
  m.looptype = 3;
  m.cycle = 300;
  m.item = [new STMacroItem('A', 15, true), new STMacroItem('A', 300, false), new STMacroItem('LButton', 0, true), new STMacroItem('LButton', 70000 & 0xffff, false), new STMacroItem('Num5', 5, true)];
  return m;
}

async function runBoth({ profile, macro, flag, index, sensor, is8K, curOnBoard, proIndex }) {
  // 原版
  const ctx = loadOriginal();
  const origLog = [];
  ctx.__hid = fakeHid(origLog);
  ctx.__pfText = profile.toText();
  ctx.__macroText = macro ? macro.toText() : '';
  const origOk = await vm.runInContext(
    `(async () => {
      ace.dobj = __hid; ace.opened = true; ace.sensor = ${sensor}; ace.is8KReceiver = ${is8K}; ace.curOnBoard = ${curOnBoard};
      if (__macroText) { const m = new STMacro(''); m.initByText(__macroText); m.uid = ${macro ? macro.uid : 0}; lstMacro.list.push(m); }
      const pf = new StProfile('', dvar, ${sensor}); pf.initByText(__pfText);
      setCurProIndex(${proIndex});
      return await ace.apply(pf, ${flag}, ${index});
    })()`,
    ctx
  );
  const origText = vm.runInContext(`(() => { const p = new StProfile('', dvar, ${sensor}); p.initByText(__pfText); return p.toText(); })()`, ctx);

  // 移植版
  const myLog = [];
  const dev = new IncottDevice(fakeHid(myLog));
  dev.sensor = sensor;
  dev.is8KReceiver = is8K;
  dev.curOnBoard = curOnBoard;
  const pf = new StProfile('', C.dvar, sensor);
  pf.initByText(profile.toText());
  const macros = new STMacroList();
  if (macro) macros.list.push(macro);
  const myOk = await dev.apply(pf, flag, index, { macros, profileIndex: proIndex });

  return { origLog, myLog, origOk, myOk, origText, myText: pf.toText() };
}

const S = [C.SENSOR_3950, C.SENSOR_3395];
const CASES = [
  { name: '全部写入 + 切换配置（默认配置）', rich: false, flag: C.apALL | C.apProSw, index: 255 },
  { name: '全部写入 + 恢复出厂（复杂配置）', rich: true, flag: C.apALL | C.apReset, index: 255 },
  { name: '单个按键：组合键', rich: true, flag: C.apKey, index: 1 },
  { name: '单个按键：火力键', rich: true, flag: C.apKey, index: 3 },
  { name: '单个按键：宏', rich: true, flag: C.apKey, index: 4 },
  { name: '单档 DPI（XY 分离）', rich: true, flag: C.apDpi, index: 1 },
  { name: '全部 DPI + 档位', rich: true, flag: C.apDpi | C.apDpiLevel, index: 255 },
  { name: '传感器开关', rich: true, flag: C.apSensor, index: 7 },
  { name: '回报率 + 传感器模式 + LOD', rich: true, flag: C.apRate | C.apSensorMode | C.apLod, index: 0 },
  { name: '消抖 + 休眠 + 接收器灯', rich: true, flag: C.apDebounce | C.apSleepTime | C.apReceiverLED, index: 0 },
];

for (const sensor of S) {
  for (const is8K of [true, false]) {
    for (const c of CASES) {
      test(`[${sensor.toString(16)}${is8K ? ' 8K' : ''}] ${c.name}`, async () => {
        const profile = c.rich ? richProfile(sensor) : new StProfile('板载配置1', C.dvar, sensor);
        const r = await runBoth({
          profile,
          macro: richMacro(),
          flag: c.flag,
          index: c.index,
          sensor,
          is8K,
          curOnBoard: c.rich ? 1 : null,
          proIndex: 2,
        });
        assert.equal(r.myOk, r.origOk, 'apply 返回值');
        assert.ok(r.origLog.length > 0, '原版应产生报文');
        assert.deepEqual(r.myLog, r.origLog);
        assert.equal(r.myText, r.origText, '配置文本格式');
      });
    }
  }
}

test('宏缓冲区与原版 juji_to_hw 一致', () => {
  const ctx = loadOriginal();
  for (const bid of [0, 3, 5]) {
    for (const looptype of [1, 2, 3]) {
      const m = richMacro();
      m.looptype = looptype;
      ctx.__macroText = m.toText();
      const orig = vm.runInContext(`(() => { const m = new STMacro(''); m.initByText(__macroText); m.uid = ${m.uid}; return Array.from(ace.juji_to_hw(m, ${bid})); })()`, ctx);
      assert.deepEqual(macroToHw(m, bid), [...orig]);
    }
  }
});

test('宏文本格式与原版一致', () => {
  const ctx = loadOriginal();
  const m = richMacro();
  ctx.__macroText = m.toText();
  const orig = vm.runInContext(`(() => { const m = new STMacro(''); m.initByText(__macroText); return m.toText(); })()`, ctx);
  const mine = new STMacro('');
  assert.ok(mine.initByText(m.toText()));
  assert.equal(mine.toText(), orig);
});
