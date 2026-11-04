// 「复制诊断信息」：只发读命令；包含型号码、PID、连接时 143/142/137 原文、状态包数量与最近几包，
// 以及解码、对照、事件、失败现场等。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 诊断查询的超时（3000ms）不触发，其余定时器立即执行
globalThis.setTimeout = (f, ms) => (ms >= 3000 ? 0 : setImmediate(f));
globalThis.clearTimeout = () => {};
globalThis.location = { search: '' };
const mem = {};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] },
});
let granted = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'node-test', hid: { getDevices: async () => granted } },
});

const C = await import('../src/protocol/constants.js');
const { IncottDevice } = await import('../src/protocol/device.js');
const { StProfile, StProfileList } = await import('../src/protocol/profile.js');
const store = await import('../src/store.js');
const { collectDiagnostics, DIAG_QUERIES } = await import('../src/diagnostics.js');
const { logEvent } = await import('../src/diaglog.js');
const { markRaw } = await import('vue');

/** 按实测 G23V2（无线 8K）回包构造的假设备 */
function fakeHid({ model = 14, keys: keyOverride = {} } = {}) {
  const sent = [];
  const keys = { ...[0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007], ...keyOverride };
  const reply = (b) => {
    switch (b[0]) {
      case 0x8f:
        return [0x8f, 1, model, 2, 0xf0, 0xf1, 0, 0];
      case 0x8e:
        return [0x8e, b[1], 0xc8, 0xd3, 0x2f, 0x63, 1, 0];
      case 0x89:
        return [0x89, 0, 0, 0, 0, 0, 0, 0x5a];
      case 0x83:
        return [0x83, 6, 2, 0, 0, 0, 0, 0];
      case 0x82:
        return [0x82, b[1], [7, 15, 31, 47, 63, 127][b[1]], 0, 0, 0, 0, 0];
      case 0x84:
        return [0x84, b[1], [0, 0, 0, 0, 1, 1][b[1]], 0, 0, 0, 0, 0];
      case 0x85:
        return [[0x85, 1, 8, 0], [0x85, 2, 3, 10, 0], [0x85, 3, 60, 0]][b[1] - 1].concat([0, 0, 0, 0]).slice(0, 8);
      case 0x86: {
        const c = b[1] === 9 ? 0 : keys[b[1]] || 0;
        return [0x86, b[1], c & 255, (c >> 8) & 255, (c >> 16) & 255, c >>> 24, 0, 0];
      }
      default:
        return [b[0], b[1], 0, 0, 0, 0, 0, 0];
    }
  };
  const listeners = new Set();
  return {
    sent,
    listeners,
    opened: false,
    vendorId: C.VENDOR_ID,
    productId: C.PID_WIRELESS,
    productName: 'incott 8K wireless mouse',
    collections: [{ usagePage: 0xff05, usage: 1, type: 1, inputReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 32 }] }], outputReports: [], featureReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 8 }] }] }],
    async open() {
      this.opened = true;
    },
    async close() {
      this.opened = false;
    },
    async sendFeatureReport(_id, b) {
      sent.push([...b]);
    },
    async receiveFeatureReport(id) {
      return new DataView(new Uint8Array([id, ...reply(sent.at(-1))]).buffer);
    },
    addEventListener(_t, fn) {
      listeners.add(fn);
    },
    removeEventListener(_t, fn) {
      listeners.delete(fn);
    },
  };
}

const STATUS = [0x3c, 0x20, 0x48, 0x00, 0x1f, 0x1f, 0x01, 0x00]; // 实测 G23V2 状态包前 8 字节
const statusEvent = (hid, reportId = 9) => ({ device: hid, reportId, data: new DataView(new Uint8Array(STATUS).buffer) });

test('诊断查询全部是 0x80–0x8F 的读命令', () => {
  for (const q of DIAG_QUERIES) assert.ok(q.cmd[0] >= 0x80 && q.cmd[0] <= 0x8f, q.label);
});

test('已连接：汇总里有型号码、PID、连接时 143/142/137 原文、状态包数量与最近几包，且只发读命令', async () => {
  const hid = fakeHid();
  granted = [hid];
  const dev = new IncottDevice(hid);
  await dev.open();
  for (let i = 0; i < 3; i++) dev._onInput(statusEvent(hid));
  dev._onInput(statusEvent(hid, 1));
  const list = new StProfileList();
  for (let i = 0; i < 4; i++) list.add(new StProfile(`板载配置${i + 1}`, C.dvar, C.SENSOR_3950));
  store.state.profiles = list;
  store.state.curIndex = 0;
  store.state.device = markRaw(dev);
  store.state.info.is8K = true;
  store.state.phase = 'ready';
  logEvent('test event');

  const before = hid.sent.length;
  const text = await collectDiagnostics();
  const diagSent = hid.sent.slice(before);
  assert.equal(diagSent.length, DIAG_QUERIES.length);
  assert.ok(diagSent.every((b) => b[0] >= 0x80), '只允许读命令');

  // 汇总
  assert.match(text, /model code {5}14 → G23V2/);
  assert.match(text, /vid:pid {8}093a:522c \(2\.4G receiver\)/);
  assert.match(text, /receiver {7}r3=02 r4=F0 → 8K receiver/);
  assert.match(text, /sensor byte {4}F1 → PAW3950/);
  assert.match(text, /143 \(8F\) +\+ *\d+ms {2}09 8F 01 0E 02 F0 F1 00 00/);
  assert.match(text, /142 \(8E 01\) +\+ *\d+ms {2}09 8E 01 C8 D3 2F 63 01 00/);
  assert.match(text, /137 \(89\) +\+ *\d+ms {2}09 89 00 00 00 00 00 00 5A/);
  assert.match(text, /134 \(86 09\) +\+ *\d+ms {2}09 86 09 00 00 00 00 00 00/);
  assert.match(text, /input reports {2}4 total \(id1:1 id9:3\)/);
  assert.match(text, /last input reports:\n {2}\+ *\d+ms in#9 {2}3C 20 48 00 1F 1F 01 00/);
  // 解码与对照
  assert.match(text, /web: pwr=60% chg=0 rate=1000Hz dpi#=2 profile=1 \| desktop: state=60 bat=32% dpi#=72 rate=1000Hz/);
  assert.match(text, /✓ dpi #6 x +device 6400 +profile 6400/);
  assert.match(text, /✓ debounce +device 8 +profile 8/);
  assert.match(text, /≠ dpi current +device 2 +profile 1/);
  assert.match(text, /✓ key 4 \(m4\) +device 0xf40001 +profile 0xf40001/);
  assert.match(text, /= psd=1 model=14→G23V2 r3=02\(8K\)/);
  assert.match(text, /= 0x00f40001 前进/);
  // 其它
  assert.match(text, /test event/);
  assert.match(text, /\[4\] magic:incott_magic102;name:板载配置4/);
  assert.match(text, /ff05:0001 type=1 in\[9:32B\] out\[\] feat\[9:8B\]/);
  assert.match(text, /### Recent transfers \(raw\)/);

  store.state.device = null;
  store.state.phase = 'welcome';
  granted = [];
});

test('未连接：临时打开设备探测，用完关闭', async () => {
  const hid = fakeHid({ model: 7 });
  granted = [hid];
  const text = await collectDiagnostics();
  granted = [];
  assert.equal(hid.opened, false, '探测后应关闭设备');
  assert.equal(hid.listeners.size, 0);
  assert.ok(hid.sent.every((b) => b[0] >= 0x80));
  assert.match(text, /### Probe 093a:522c "incott 8K wireless mouse" \(not connected\)/);
  assert.match(text, /model code {5}7 → UNSUPPORTED/);
  assert.match(text, /143 \(8F\) .*09 8F 01 07 02 F0 F1 00 00/);
});

test('连接失败（型号码不认识）：失败现场带型号码与 143 原文', async () => {
  const hid = fakeHid({ model: 7 });
  granted = [];
  const dev = new IncottDevice(hid);
  await assert.rejects(dev.open(), /UNSUPPORTED_DEVICE/);
  store.diag.lastFailure = {
    time: 'T',
    productId: hid.productId,
    productName: hid.productName,
    error: 'UNSUPPORTED_DEVICE',
    modelCode: dev.modelCode,
    replies: { ...dev.replies },
    inputCount: dev.inputCount,
    inputById: { ...dev.inputById },
    xferLog: dev.xferLog.slice(),
    inputLog: dev.inputLog.slice(),
  };
  const text = await collectDiagnostics();
  assert.match(text, /### Last connect failure \(T\)/);
  assert.match(text, /error UNSUPPORTED_DEVICE/);
  assert.match(text, /model code {5}7 → UNSUPPORTED/);
  assert.match(text, /143 \(8F\) +\+ *\d+ms {2}09 8F 01 07 02 F0 F1 00 00/);
  store.diag.lastFailure = null;
});

test('issue #10 场景：额外按键槽位、写入是否生效、按键导致的回报率变化都能从诊断信息里看出来', async () => {
  // 假设：按键 6 已被改成配置切换（写进了槽位 5），而滚轮后方的回报率键其实在槽位 6
  const hid = fakeHid({ model: 2, keys: { 5: 61706, 6: 0x05040007 } });
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  assert.equal(store.state.phase, 'ready');
  const status = (rateIx) => ({ device: hid, reportId: 9, data: new DataView(new Uint8Array([0x50, 0x20 | rateIx, 0, 0, 0, 0, 0, 0]).buffer) });
  for (const fn of hid.listeners) {
    fn(status(0));
    fn(status(6)); // 用户按了一下滚轮后方的键：1000 → 2000 Hz
  }
  const text = await collectDiagnostics();
  assert.match(text, /status first: rate=1000/);
  assert.match(text, /status: rate 1000→2000/);
  assert.match(text, /86 06 00 00 00 00 00 00 → 09 86 06 07 00 04 05 .*= 0x05040007 unknown: type=07 b1=00 b2=04 b3=05/);
  assert.match(text, /• extra slot m6 +device 0x5040007 +unknown: type=07/);
  // 槽位 5 里确实是"配置切换"（写入生效），说明物理按键不在槽位 5
  assert.match(text, /✓ key 6 \(m5\) +device 0xf10a +profile 0xf10a/);
  assert.match(text, /86 05 00 00 00 00 00 00 → 09 86 05 0A F1 00 00 00 00 .*= 0x0000f10a 配置切换/);
  await store.disconnect('test');
  granted = [];
});
