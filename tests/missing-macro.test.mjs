// 按键绑定的宏在宏库里已不存在（删除 / 来自导入的配置）时，完整写入不能中断；
// 删除宏时 4 个板载配置里绑定它的按键都要恢复默认。

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.setTimeout = (f) => setImmediate(f);
globalThis.location = { search: '' };
const mem = {};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] },
});

const C = await import('../src/protocol/constants.js');
const { IncottDevice } = await import('../src/protocol/device.js');
const { StProfile, StProfileList } = await import('../src/protocol/profile.js');
const { STMacro, STMacroList } = await import('../src/protocol/macro.js');
const store = await import('../src/store.js');
const { markRaw } = await import('vue');

const SENSOR = C.SENSOR_3950;
const GONE = 1724000000999; // 宏库里不存在的 uid

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

function macroKey(uid) {
  const k = new C.KeyInfo(C.fJuji, 0);
  k.itemdata = uid;
  return k;
}

function makeDevice(log) {
  const dev = new IncottDevice(fakeHid(log));
  dev.sensor = SENSOR;
  dev.is8KReceiver = false;
  dev.curOnBoard = 0;
  return dev;
}

async function applyLog(pf) {
  const log = [];
  const ok = await makeDevice(log).apply(pf, C.apALL | C.apProSw, 255, { macros: new STMacroList(), profileIndex: 2 });
  return { ok, log };
}

test('完整写入：宏已不存在时按默认功能写入该键，不中断后续项目', async () => {
  const pf = new StProfile('p', C.dvar, SENSOR);
  pf.dpi = [400, 800, 1600, 3200];
  pf.dpiy = pf.dpi.concat();
  pf.usbrate = 500;
  pf.debounce = 3;
  pf.key[3] = macroKey(GONE);
  const r = await applyLog(pf);
  assert.equal(r.ok, true);

  const ref = pf.copy();
  ref.key[3] = C.dvar.key[3].copy();
  const expect = await applyLog(ref);
  assert.deepEqual(r.log, expect.log);
  // 最后一项（板载序号）也写进去了
  assert.deepEqual(r.log.at(-1).slice(2, 5), [6, 9, 2]);
});

function setupStore() {
  const list = new StProfileList();
  for (let i = 0; i < 4; i++) list.add(new StProfile(`板载配置${i + 1}`, C.dvar, SENSOR));
  store.state.profiles = list;
  store.state.curIndex = 0;
  store.state.info.devname = 'TEST';
  store.state.info.sensor = SENSOR;
  store.state.macros = new STMacroList();
  const m = new STMacro('m');
  m.uid = 1724000000123;
  store.state.macros.list.push(m);
  return m;
}

/** 自动确认对话框 */
async function confirming(p) {
  while (!store.state.dialog) await new Promise((r) => setImmediate(r));
  store.state.dialog.resolve(true);
  return p;
}

test('macroUsage 统计全部 4 个配置', () => {
  const m = setupStore();
  store.state.profiles.list[0].key[4] = macroKey(m.uid);
  store.state.profiles.list[2].key[3] = macroKey(String(m.uid)); // 从文本解析的 uid 是字符串
  assert.deepEqual(store.macroUsage(m.uid), [
    { profile: 0, button: 4 },
    { profile: 2, button: 3 },
  ]);
});

test('删除宏：4 个配置里绑定它的按键恢复默认，并重写当前配置的按键', async () => {
  const m = setupStore();
  const pl = store.state.profiles.list;
  pl[0].key[4] = macroKey(m.uid);
  pl[2].key[3] = macroKey(m.uid);
  const log = [];
  store.state.device = markRaw(makeDevice(log));
  try {
    assert.equal(await confirming(store.deleteMacro(m.uid)), true);
    while (store.state.pending) await new Promise((r) => setImmediate(r));
    assert.equal(store.state.macros.list.length, 0);
    assert.deepEqual(pl[0].key[4], C.dvar.key[4]);
    assert.deepEqual(pl[2].key[3], C.dvar.key[3]);
    assert.deepEqual(store.macroUsage(m.uid), []);
    // 当前配置的按键 4 被写回默认功能
    assert.ok(log.some((p) => p[0] === 'F' && p[2] === 6 && p[3] === C.dvar.key[4].matrix));
    // 已持久化
    assert.ok(!mem.profile_TEST.includes(`,${m.uid};`));
  } finally {
    store.state.device = null;
  }
});

test('完整写入配置：遗留的失效宏绑定先恢复默认，整个配置照常写完', async () => {
  setupStore();
  const pl = store.state.profiles.list;
  pl[1].key[3] = macroKey(GONE);
  pl[1].usbrate = 500;
  const log = [];
  store.state.device = markRaw(makeDevice(log));
  try {
    store.state.curIndex = 1;
    assert.equal(await store.writeCurrentProfile(), true);
    assert.deepEqual(pl[1].key[3], C.dvar.key[3]);
    assert.deepEqual(log.at(-1).slice(2, 5), [6, 9, 1]);
  } finally {
    store.state.device = null;
  }
});
