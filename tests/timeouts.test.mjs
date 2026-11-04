// HID 调用超时与写入失败定位：接收器不响应时不能让界面一直卡在"连接中 / 写入中"，
// 并且失败原因（哪一步、哪条命令、什么错误）要能从诊断信息里看出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 所有定时器立即执行：超时会立刻触发，挂起的 HID 调用必然输给超时
globalThis.setTimeout = (f) => setImmediate(f);
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
const { StProfile } = await import('../src/protocol/profile.js');
const { STMacroList } = await import('../src/protocol/macro.js');
const store = await import('../src/store.js');
const { events } = await import('../src/diaglog.js');

const never = () => new Promise(() => {});

/**
 * 假设备：hang(b) 为真时该命令的回包永远不来；fail(b) 为真时 sendFeatureReport 抛错；hangOpen 时 open() 不返回
 */
function fakeHid({ hang = () => false, fail = () => false, hangOpen = false } = {}) {
  const sent = [];
  const reply = (b) => {
    switch (b[0]) {
      case 0x8f:
        return [0x8f, 1, 2, 0, 0xf0, 0xf0, 0, 0];
      case 0x8e:
        return [0x8e, b[1], 1, 2, 3, 4, 1, 0];
      case 0x89:
        return [0x89, 80, 0, 0, 1, 0, 0, 0x5a];
      case 0x83:
        return [0x83, 6, 1, 0, 0, 0, 0, 0];
      default:
        return [b[0], b[1], 0, 0, 0, 0, 0, 0];
    }
  };
  return {
    sent,
    opened: false,
    vendorId: C.VENDOR_ID,
    productId: C.PID_WIRED,
    productName: 'incott wired mouse',
    collections: [{ usagePage: 0xff05, usage: 1 }],
    async open() {
      if (hangOpen) return never();
      this.opened = true;
    },
    async close() {
      this.opened = false;
    },
    async sendFeatureReport(_id, b) {
      if (fail([...b])) throw new Error('NotAllowedError: Failed to write the feature report.');
      sent.push([...b]);
    },
    async sendReport() {},
    receiveFeatureReport(id) {
      const b = sent.at(-1);
      if (hang(b)) return never();
      return Promise.resolve(new DataView(new Uint8Array([id, ...reply(b)]).buffer));
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

test('识别命令的回包一直不来：open() 以 NO_RESPONSE 结束而不是卡住，错误记入 errLog', async () => {
  const hid = fakeHid({ hang: (b) => b[0] === 0x8f });
  const dev = new IncottDevice(hid);
  await assert.rejects(dev.open(), /NO_RESPONSE/);
  assert.equal(dev.errLog.length, 1);
  assert.match(dev.errLog[0].hex, /receiveFeatureReport \(cmd 143\): receiveFeatureReport timeout 3000ms/);
  assert.equal(hid.opened, false, '失败后应关闭设备');
});

test('有回包但型号码不认识仍然是 UNSUPPORTED_DEVICE', async () => {
  const hid = fakeHid();
  hid.receiveFeatureReport = async (id) => new DataView(new Uint8Array([id, 0x8f, 1, 0x77, 0, 0xf0, 0xf0, 0, 0]).buffer);
  const dev = new IncottDevice(hid);
  await assert.rejects(dev.open(), /UNSUPPORTED_DEVICE/);
  assert.equal(dev.modelCode, 0x77);
});

test('hid.open() 不返回：以 open timeout 结束（界面提示设备被占用）', async () => {
  const dev = new IncottDevice(fakeHid({ hangOpen: true }));
  await assert.rejects(dev.open(), /open timeout/);
});

test('sendFeatureReport 超时不重试（上一次调用还挂着）', async () => {
  const hid = fakeHid();
  let calls = 0;
  hid.sendFeatureReport = () => {
    calls++;
    return never();
  };
  const dev = new IncottDevice(hid);
  assert.equal(await dev._sendFeature(new Uint8Array([0x8f, 0, 0, 0, 0, 0, 0, 0])), false);
  assert.equal(calls, 1);
  assert.match(dev.lastHidError, /sendFeatureReport 8F 00: sendFeatureReport timeout/);
});

test('连接卡在 142：store 回到欢迎页并给出"没有响应"以外的明确错误，失败现场带 HID 错误', async () => {
  const hid = fakeHid({ hang: (b) => b[0] === 0x8e });
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  granted = [];
  assert.equal(store.state.phase, 'welcome');
  assert.equal(store.diag.connecting, null);
  assert.equal(store.diag.lastFailure.error, 'READ_FAILED');
  assert.match(store.diag.lastFailure.errLog[0].hex, /cmd 142/);
  assert.ok(events.some((e) => /connect FAILED: READ_FAILED .*last HID error: receiveFeatureReport \(cmd 142\)/.test(e.msg)));
  store.diag.lastFailure = null;
});

test('连接时 143 无响应：界面提示"设备没有响应"', async () => {
  const hid = fakeHid({ hang: (b) => b[0] === 0x8f });
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  granted = [];
  assert.equal(store.diag.lastFailure.error, 'NO_RESPONSE');
  assert.match(store.state.error.message, /设备没有响应/);
  store.diag.lastFailure = null;
  store.state.error = null;
});

test('写入失败：applyError 指出失败的步骤和 HID 错误', async () => {
  const hid = fakeHid({ fail: (b) => b[0] === 4 && b[1] === 1 });
  hid.opened = true;
  const dev = new IncottDevice(hid);
  dev.sensor = C.SENSOR_3395;
  const pf = new StProfile('p', C.dvar, C.SENSOR_3395);
  const ok = await dev.apply(pf, C.apRate | C.apLod | C.apDebounce, 0, { macros: new STMacroList(), profileIndex: 0 });
  assert.equal(ok, false);
  assert.match(dev.applyError, /^LOD 1 — sendFeatureReport 04 01 \(try 3\): NotAllowedError/);
  // 失败之前的回报率已写入，失败之后的消抖没有发送
  assert.ok(hid.sent.some((b) => b[0] === 1));
  assert.ok(!hid.sent.some((b) => b[0] === 5));
});

test('写入失败经过 store：事件日志记录失败在哪一步', async () => {
  const hid = fakeHid({ fail: (b) => b[0] === 5 && b[1] === 1 });
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  assert.equal(store.state.phase, 'ready');
  await store.chunk86(C.apDebounce, 0);
  assert.ok(events.some((e) => /apply debounce index=0 profile=\d → FAILED at debounce \d+ — sendFeatureReport 05 01/.test(e.msg)));
  await store.disconnect('test');
  granted = [];
});
