// 对照官方桌面驱动（GamingMouse.exe / GamingMousePro.exe）核对后修正的问题。

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.setTimeout = (f) => setImmediate(f);

const C = await import('../src/protocol/constants.js');
const { IncottDevice, modelFromCode } = await import('../src/protocol/device.js');
const { StProfile } = await import('../src/protocol/profile.js');

function makeDevice({ is8K = false, sensor = C.SENSOR_3395, reply } = {}) {
  const log = [];
  const listeners = {};
  const hid = {
    opened: true,
    productId: C.PID_WIRELESS,
    async sendFeatureReport(id, b) {
      log.push(['F', ...b]);
    },
    async sendReport(id, b) {
      log.push(['O', ...b]);
    },
    async receiveFeatureReport(id) {
      const last = log.filter((p) => p[0] === 'F').at(-1);
      return new DataView(new Uint8Array([id, ...(reply ? reply(last.slice(1)) : [last[1], 0, 0, 0, 0, 0, 0, 0])]).buffer);
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    removeEventListener() {},
  };
  const dev = new IncottDevice(hid);
  dev.sensor = sensor;
  dev.is8KReceiver = is8K;
  dev.curOnBoard = 0;
  return { dev, log, hid, listeners };
}

const ctx = { macros: null, profileIndex: 0 };

test('型号码 4 / 5 按 G23 / G24 识别（官方桌面驱动 sub_42F7F0）', () => {
  assert.equal(modelFromCode(2), 'G23');
  assert.equal(modelFromCode(4), 'G23');
  assert.equal(modelFromCode(3), 'G24');
  assert.equal(modelFromCode(5), 'G24');
  assert.equal(modelFromCode(7), '');
});

test('只有 1 个 DPI 档且 curDpi 越界时，档位按最后一档写入，且不中断后续项目', async () => {
  const { dev, log } = makeDevice();
  const pf = new StProfile('', C.dvar, C.SENSOR_3395);
  pf.dpi = [800];
  pf.dpiy = [800];
  pf.curDpi = 1; // 导入的 .ict 缺少 curDpi 时的默认值
  assert.equal(await dev.apply(pf, C.apDpiLevel | C.apRate | C.apLod, 0, ctx), true);
  const f = log.filter((p) => p[0] === 'F').map((p) => p.slice(1, 4));
  assert.deepEqual(f, [
    [3, 1, 0],
    [1, 0, 0],
    [4, 1, 0],
  ]);
});

test('非 8K 连接时 2000+ Hz 按 1000 Hz 写入，并照常写传感器模式', async () => {
  const { dev, log } = makeDevice({ is8K: false });
  const pf = new StProfile('', C.dvar, C.SENSOR_3395);
  pf.usbrate = 8000;
  pf.sensormode = 0;
  assert.equal(await dev.apply(pf, C.apRate | C.apSensorMode, 0, ctx), true);
  assert.deepEqual(
    log.map((p) => p.slice(1, 3)),
    [
      [1, 0],
      [4, 5],
    ]
  );
});

test('8K 接收器上 8000 Hz 原样写入，传感器模式不写（固件固定电竞模式）', async () => {
  const { dev, log } = makeDevice({ is8K: true });
  const pf = new StProfile('', C.dvar, C.SENSOR_3395);
  pf.usbrate = 8000;
  assert.equal(await dev.apply(pf, C.apRate | C.apSensorMode, 0, ctx), true);
  assert.deepEqual(
    log.map((p) => p.slice(1, 3)),
    [[1, 4]]
  );
});

test('只有 Report ID 9 的输入报告才当作状态包', () => {
  const { dev } = makeDevice();
  const got = [];
  dev.addEventListener('status', (e) => got.push(e.detail));
  const data = new DataView(new Uint8Array([0x50, 0x10, 0, 0, 0, 0, 0, 0]).buffer);
  dev._onInput({ device: dev.hid, reportId: 3, data });
  dev._onInput({ device: dev.hid, reportId: 9, data });
  assert.equal(got.length, 1);
  assert.equal(got[0].power, 80);
  assert.deepEqual(
    dev.inputLog.map((e) => e.dir),
    ['in#3', 'in#9']
  );
});

test('宏下发：每包的 Feature 头与 Output 数据之间不会插入其它读写', async () => {
  const { dev, log } = makeDevice();
  const data = new Array(320).fill(0).map((_, i) => i & 255);
  const juji = dev.setJuJi(2, data);
  // 下发过程中并发的读命令（例如板载序号确认）只能排在两包之间
  const reads = [dev.readProfileIndex(), dev.rawQuery([0x8f])];
  await Promise.all([juji, ...reads]);
  for (let i = 0; i < log.length; i++) {
    if (log[i][0] === 'F' && log[i][1] === 7) assert.equal(log[i + 1][0], 'O', `第 ${i} 条 Feature 头后面必须紧跟 Output`);
  }
  assert.equal(log.filter((p) => p[0] === 'O').length, 10);
});

test('rawQuery 原样返回回包（含 Report ID），并记入收发记录', async () => {
  const { dev } = makeDevice({ reply: (b) => [b[0], 1, 2, 0, 2, 0xf1, 0, 0] });
  const r = await dev.rawQuery([0x8f]);
  assert.deepEqual([...r.sent], [0x8f, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...r.recv], [9, 0x8f, 1, 2, 0, 2, 0xf1, 0, 0]);
  assert.deepEqual(
    dev.xferLog.map((e) => [e.dir, e.hex]),
    [
      ['F>', '09 8F 00 00 00 00 00 00 00'],
      ['F<', '09 8F 01 02 00 02 F1 00 00'],
    ]
  );
});
