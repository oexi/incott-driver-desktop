// 对照固件 1.4.0.3 与官方新版桌面驱动 incott-app 1.4.0.3（IDA 分析）补上的协议细节：
// 状态包两种布局（issue #11）、状态包里的消抖 / LOD / Motion Sync、电量原值、型号码 12 / 13、传感器 0xE1 / 0xE2。

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.setTimeout = (f, ms) => (ms >= 1000 ? 0 : setImmediate(f));
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
const { parseInputReport, statusLayoutOf, modelFromCode, IncottDevice } = await import('../src/protocol/device.js');
const { MockHidDevice } = await import('../src/protocol/mock.js');
const store = await import('../src/store.js');

const dv = (bytes) => new DataView(new Uint8Array(bytes).buffer);
const tick = () => new Promise((r) => setImmediate(r));
async function idle() {
  for (let i = 0; i < 5000; i++) {
    await tick();
    if (!store.state.pending && !store.state.applying) return;
  }
  throw new Error('queue did not drain');
}

/* ------------------------------------------------------------ 状态包 */

test('状态包：实测 G23V2 的紧凑布局，带消抖 / 当前档 DPI / LOD / Motion Sync，电量是原值', () => {
  const s = parseInputReport(dv([0x3c, 0x20, 0x48, 0x00, 0x1f, 0x1f, 0x01, 0x00]));
  assert.equal(s.layout, 'packed');
  assert.equal(s.layoutSure, true);
  assert.equal(s.power, 60);
  assert.equal(s.charging, false);
  assert.equal(s.rate, 1000);
  assert.equal(s.dpiIndex, 2);
  assert.equal(s.profileIndex, 1);
  assert.equal(s.debounce, 8);
  assert.equal(s.dpiX, 31);
  assert.equal(s.dpiY, 31);
  assert.equal(s.lod, 0);
  assert.equal(s.motion, 1);
  assert.equal(parseInputReport(dv([0x80 | 97, 0x10, 0, 0x21, 0x2c, 0x01, 0x20, 0])).power, 97);
  const big = parseInputReport(dv([50, 0, 0, 0x21, 0x2c, 0x01, 0x20, 0]));
  assert.deepEqual([big.dpiX, big.dpiY, big.lod, big.motion], [0x12c, 0x201, 2, 0]);
});

test('状态包：旧固件经 1K 接收器的 5 字节布局（issue #11）——充电、电量、DPI 档、回报率', () => {
  const s = parseInputReport(dv([0, 85, 1, 0, 0, 0, 0, 0]));
  assert.equal(s.layout, 'old', '按紧凑布局读电量只有 0%，不可能');
  assert.equal(s.power, 85);
  assert.equal(s.dpiIndex, 1);
  assert.equal(s.rate, 1000);
  assert.equal(s.charging, false);
  assert.equal(s.profileIndex, null);
  assert.equal(s.debounce, null);
  assert.equal(parseInputReport(dv([1, 40, 3, 4, 0, 0, 0, 0])).charging, true);
  assert.equal(parseInputReport(dv([1, 40, 3, 4, 0, 0, 0, 0])).rate, 8000);
  // 只有旧布局说得通（第 2 字节 > 0x56 时回报率 / DPI 档超出范围）
  assert.deepEqual(statusLayoutOf([0, 100, 2, 3, 0, 0, 0, 0]), { layout: 'old', sure: true });
});

test('状态包：说不准时沿用这次连接已经判断出的布局', async () => {
  const ambiguous = [1, 0x21, 3, 0, 0, 0, 0, 0];
  assert.deepEqual(statusLayoutOf(ambiguous), { layout: 'old', sure: false });
  assert.deepEqual(statusLayoutOf(ambiguous, 'packed'), { layout: 'packed', sure: false });
  // 设备上：先收到能确定的紧凑布局，之后说不准的也按紧凑布局
  const hid = new MockHidDevice({ fw: 'slots' });
  const dev = new IncottDevice(hid);
  hid.addEventListener = () => {};
  const got = [];
  dev.addEventListener('status', (e) => got.push(e.detail));
  dev._onInput({ device: hid, reportId: 9, data: dv([0x3c, 0x20, 0x48, 0x00, 0x1f, 0x1f, 0x01, 0x00]) });
  dev._onInput({ device: hid, reportId: 9, data: dv(ambiguous) });
  assert.deepEqual(got.map((s) => s.layout), ['packed', 'packed']);
  assert.equal(dev.statusLayout, 'packed');
});

/* ------------------------------------------------------------ 型号 / 传感器 */

test('型号码 12 / 13（官方新版桌面驱动）：G23V2 / G39', () => {
  assert.equal(modelFromCode(12), 'G23V2');
  assert.equal(modelFromCode(13), 'G39');
  assert.equal(modelFromCode(14), 'G23V2');
});

test('传感器 0xE1 / 0xE2：DPI 换算与官方新版桌面驱动一致，不能分开设 X / Y', () => {
  assert.equal(C.sensorFromByte(0xe1), C.SENSOR_E1);
  assert.equal(C.sensorFromByte(0xe2), C.SENSOR_E2);
  assert.equal(C.sensorFromByte(0xf1), C.SENSOR_3950);
  assert.equal(C.sensorFromByte(0x00), C.SENSOR_3395);
  const e1 = C.getStDPI(C.SENSOR_E1);
  assert.deepEqual([e1.min, e1.max, e1.step, e1.xy], [200, 16000, 100, false]);
  assert.equal(C.getHwForDpi(200, C.SENSOR_E1), 0);
  assert.equal(C.getHwForDpi(16000, C.SENSOR_E1), 158);
  assert.equal(C.getHwForDpi(450, C.SENSOR_E1), -1);
  assert.equal(C.closestDpi(C.SENSOR_E1, 450), 400);
  const e2 = C.getStDPI(C.SENSOR_E2);
  assert.deepEqual([e2.min, e2.max, e2.xy], [50, 12000, false]);
  assert.equal(C.getHwForDpi(10000, C.SENSOR_E2), 199);
  assert.equal(C.getHwForDpi(10100, C.SENSOR_E2), 200);
  assert.equal(C.getHwForDpi(12000, C.SENSOR_E2), 219);
  assert.equal(C.getHwForDpi(10050, C.SENSOR_E2), -1);
  // 默认档位在两种传感器上都有对应的硬件值
  for (const st of [e1, e2]) for (const d of st.dpi) assert.ok(C.getHwForDpi(d, st.sensor) >= 0, `${d}`);
  assert.equal(C.getStDPI(C.SENSOR_3950).xy, true);
});

/* ---------------------------------------------------------------- 连接 */

function mouse({ sensor = 241, fw = 'slots' } = {}) {
  const hid = new MockHidDevice({ fw });
  const open = hid.open.bind(hid);
  hid.open = async () => {
    await open();
    clearInterval(hid.timer);
  };
  const recv = hid.receiveFeatureReport.bind(hid);
  hid.receiveFeatureReport = async (id) => {
    const r = await recv(id);
    if (r.getUint8(1) === 143) r.setUint8(6, sensor); // 无线：传感器在 data[5]
    return r;
  };
  hid.writes = [];
  const send = hid.sendFeatureReport.bind(hid);
  hid.sendFeatureReport = async (id, b) => {
    if (b[0] < 0x80) hid.writes.push(Array.from(b));
    return send(id, b);
  };
  return hid;
}

async function connect(hid) {
  for (const k of Object.keys(mem)) delete mem[k];
  store.state.toasts.length = 0;
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  granted = [];
  assert.equal(store.state.phase, 'ready');
  await idle();
}

test('0xE1 传感器的鼠标：界面范围 200–16000，X / Y 不能分开（设了也按 X 写）', async () => {
  const hid = mouse({ sensor: 0xe1 });
  hid.slots[0].dpi = [2, 6, 14, 22, 30, 62]; // 400 / 800 / 1600 / 2400 / 3200 / 6400
  await connect(hid);
  assert.equal(store.state.info.sensor, C.SENSOR_E1);
  assert.equal(store.sensorCfg.value.max, 16000);
  assert.deepEqual(store.curProfile.value.dpi, [400, 800, 1600, 2400, 3200, 6400]);
  store.setDpiValue(1, 1280, 3000);
  await idle();
  const pf = store.curProfile.value;
  assert.equal(pf.dpi[1], 1300, '就近取到步进 100');
  assert.equal(pf.dpiy[1], 1300, 'Y 跟着 X');
  assert.equal(hid.slots[0].dpi[1], 11); // 100 × (11 + 2) = 1300
  assert.ok(!hid.writes.some((b) => b[0] === 2 && b[7] === 2), '没有单独写 Y');
  await store.disconnect('test');
});

test('状态包里的消抖 / LOD / Motion Sync 变了（软件外改的）：配置跟随，不用再读', async () => {
  const hid = mouse();
  await connect(hid);
  const pf = store.curProfile.value;
  assert.equal(pf.debounce, 8);
  hid.cur.debounce = 14;
  hid.cur.sensor[0] = 1; // LOD 固件值 1 = 2 mm
  hid.cur.sensor[3] = 0; // Motion Sync 关
  hid.emitStatus();
  await idle();
  assert.equal(pf.debounce, 14);
  assert.equal(pf.lod, 2);
  assert.equal(pf.motion, false);
  // 跟随后切走再切回来，不会把旧值写回去
  hid.writes.length = 0;
  await store.requestProfile(1);
  await idle();
  await store.requestProfile(0);
  await idle();
  assert.ok(!hid.writes.some((b) => (b[0] === 5 && b[1] === 1) || b[0] === 4), '没有改写消抖 / LOD / Motion Sync');
  assert.equal(store.state.info.power, 80, '电量是原值');
  await store.disconnect('test');
});

test('旧布局的状态包：没有槽位，不会被当成换了槽位；电量取第 2 字节', async () => {
  const hid = mouse({ fw: 'legacy' });
  hid.emitStatus = () => {}; // 这种固件只发旧布局（不会有紧凑布局的状态包）
  await connect(hid);
  const ev = new Event('inputreport');
  ev.device = hid;
  ev.reportId = 9;
  ev.data = dv([0, 85, 1, 0, 0, 0, 0, 0]);
  hid.dispatchEvent(ev);
  await idle();
  assert.equal(store.state.info.power, 85);
  assert.ok(!store.state.toasts.some((x) => x.message.includes('另一套板载设置')));
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');
});
