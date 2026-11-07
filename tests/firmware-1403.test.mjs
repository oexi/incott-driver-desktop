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

/* ------------------------------------------------- 旧固件兼容（GHERO 等） */

test('连接：0x8E 有回包但不是 0x8E 的（固件不认识这条命令）也照样连接，在线状态记为未知', async () => {
  const hid = mouse();
  const recv = hid.receiveFeatureReport;
  hid.receiveFeatureReport = async (id) => {
    const r = await recv(id);
    if (r.getUint8(1) === 0x8e) return dv([9, 0, 0, 0, 0, 0, 0, 0, 0]); // 不回显
    return r;
  };
  await connect(hid);
  assert.equal(store.state.device.linkOnline, null);
  assert.ok(store.state.device.xferLog.some((e) => e.dir === 'NOTE' && /142/.test(e.hex)));
  await store.disconnect('test');
});

test('[3,…]：后三个字节照 0x83 读到的写回（旧版 GHERO 驱动在这里放 DPI 指示灯效果），不再写成 0', async () => {
  const hid = mouse();
  hid.slots[0].ext = [2, 1, 1];
  await connect(hid);
  store.selectDpi(3);
  await idle();
  const w = hid.writes.filter((b) => b[0] === 3);
  assert.deepEqual(w, [[3, 6, 3, 2, 1, 1, 0, 0]]);
  assert.deepEqual(hid.slots[0].ext, [2, 1, 1], '鼠标里的值没被改掉');
  await store.disconnect('test');
});

test('[3,…]：没读到 0x83 时和以前一样写 0', async () => {
  const dev = new IncottDevice(new MockHidDevice());
  const sent = [];
  dev._doTask = async (b) => (sent.push(Array.from(b)), true);
  dev.sensor = C.SENSOR_3950;
  await dev.setDif(1, 4);
  assert.deepEqual(sent, [[3, 4, 1, 0, 0, 0, 0, 0]]);
});

/* ----------------------------------------------------- 3395 / 3950 的差别 */

test('PAW3395 在 8000 Hz：固件强制关掉 Motion Sync，状态包报告的 0 不记进配置', async () => {
  const hid = mouse({ sensor: 240 });
  await connect(hid);
  const pf = store.curProfile.value;
  assert.equal(store.state.info.sensor, C.SENSOR_3395);
  assert.equal(pf.motion, true);
  hid.cur.rateIx = C.RATE_HW.indexOf(8000);
  hid.cur.sensor[3] = 0; // 固件在 8000 Hz 清掉了内存里的 Motion Sync
  hid.emitStatus();
  await idle();
  assert.equal(pf.motion, true, 'Motion Sync 设置保留');
  assert.ok(!hid.writes.some((b) => b[0] === 4 && b[1] === 4), '也没有写回');
  // 1000 Hz 时报告的 0 才是真的关了
  hid.cur.rateIx = C.RATE_HW.indexOf(1000);
  hid.emitStatus();
  await idle();
  assert.equal(pf.motion, false);
  await store.disconnect('test');
});

test('PAW3950「最高性能」（传感器模式最高位）：连接时读进配置，切换不会关掉它，改传感器模式时保留', async () => {
  const hid = mouse();
  for (const sl of hid.slots) sl.sensor[4] = 0x82; // 电竞 + 最高性能（官方新版驱动设的）
  await connect(hid);
  const pf = store.curProfile.value;
  assert.equal(pf.sensormode, 2);
  assert.equal(pf.hifps, true, '读进了配置');
  await store.requestProfile(1);
  await idle();
  await store.requestProfile(0);
  await idle();
  assert.ok(!hid.writes.some((b) => b[0] === 4 && b[1] === 5), '没有写传感器模式');
  assert.equal(hid.slots[0].sensor[4], 0x82);
  store.setSensorMode(1);
  await idle();
  assert.deepEqual(hid.writes.filter((b) => b[0] === 4 && b[1] === 5), [[4, 5, 0x81, 0, 0, 0, 0, 0]]);
  assert.equal(hid.slots[0].sensor[4], 0x81);
  assert.equal(pf.sensormode, 1);
  // 之后再切换也不会因为最高位"不一样"而重写
  hid.writes.length = 0;
  await store.requestProfile(1);
  await idle();
  await store.requestProfile(0);
  await idle();
  assert.ok(!hid.writes.some((b) => b[0] === 4 && b[1] === 5));
  await store.disconnect('test');
});

/* ------------------------------------------------------------ 最高性能开关 */

const { StProfile } = await import('../src/protocol/profile.js');

test('「最高性能」只在 1.4 固件的 PAW3950 上提供：3395、旧固件、0xE1 都不显示', async () => {
  for (const [sensor, fw, want] of [
    [241, 'slots', true],
    [240, 'slots', false],
    [241, 'legacy', false],
    [0xe1, 'slots', false],
  ]) {
    const hid = mouse({ sensor, fw });
    await connect(hid);
    assert.equal(store.hiFpsSupported.value, want, `sensor ${sensor.toString(16)} ${fw}`);
    // 不支持时 setHiFps 什么也不做
    store.setHiFps(true);
    await idle();
    if (!want) {
      assert.ok(!store.curProfile.value.hifps);
      assert.ok(!hid.writes.some((b) => b[0] === 4 && b[1] === 5), '不写传感器模式');
    }
    await store.disconnect('test');
  }
});

test('「最高性能」开关：写 [4,5,模式|0x80]；8000 Hz（模式固定为电竞）也照样写；每个配置各存一份', async () => {
  const hid = mouse();
  for (const sl of hid.slots) sl.sensor[4] = 2;
  await connect(hid);
  const pf = store.curProfile.value;
  assert.equal(pf.hifps, false);
  store.setHiFps(true);
  await idle();
  assert.deepEqual(hid.writes.filter((b) => b[0] === 4 && b[1] === 5), [[4, 5, 0x82, 0, 0, 0, 0, 0]]);
  assert.equal(hid.slots[0].sensor[4], 0x82);
  store.setHiFps(false);
  await idle();
  assert.equal(hid.slots[0].sensor[4], 0x02);

  // 8000 Hz：以前 2000 Hz 以上不写传感器模式，「最高性能」照样要写
  hid.writes.length = 0;
  await store.requestProfile(1);
  await idle();
  hid.cur.rateIx = C.RATE_HW.indexOf(8000);
  hid.emitStatus();
  await idle();
  assert.equal(store.curProfile.value.usbrate, 8000);
  store.setHiFps(true);
  await idle();
  assert.deepEqual(hid.writes.filter((b) => b[0] === 4 && b[1] === 5).at(-1), [4, 5, 0x82, 0, 0, 0, 0, 0]);
  assert.equal(store.state.profiles.list[1].hifps, true);
  assert.equal(store.state.profiles.list[0].hifps, false, '配置 1 不受影响');
  await store.disconnect('test');
});

test('「最高性能」存进配置文件；没开时导出的内容和以前一样', () => {
  const p = new StProfile('p', C.dvar, C.SENSOR_3950);
  assert.ok(!p.toText().includes('hifps'), '没开时不写这个键（网页驱动导入不受影响）');
  p.hifps = true;
  const q = new StProfile('', C.dvar, C.SENSOR_3950);
  assert.equal(q.initByText(p.toText()), true);
  assert.equal(q.hifps, true);
  assert.equal(p.copy().hifps, true);
});
