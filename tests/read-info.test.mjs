// readInfo 回报率解析：用实测 G23V2 的 137 回包（去掉 Report ID 后的 8 字节）校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.setTimeout = (f) => setImmediate(f);

const { IncottDevice } = await import('../src/protocol/device.js');

// 回包第 0 字节为命令回显
const DIF = [0x83, 6, 2, 0, 0, 0, 1, 0];
const WIRELESS = { 125: 3, 250: 2, 500: 1, 1000: 0, 2000: 6, 4000: 5, 8000: 4 };

function fakeHid(info, dif = DIF) {
  let last = 0;
  return {
    async sendFeatureReport(_id, b) {
      last = b[0];
    },
    async receiveFeatureReport(id) {
      const data = last === 137 ? info : last === 131 ? dif : [last, 0, 0, 0, 0, 0, 0, 0];
      return new DataView(new Uint8Array([id, ...data]).buffer);
    },
  };
}

async function readRate(info) {
  const dev = new IncottDevice(fakeHid(info));
  assert.equal(await dev.readInfo(), true);
  return dev.curUSBRate;
}

test('无线：回报率取自 r[3]', async () => {
  for (const [hz, ix] of Object.entries(WIRELESS)) {
    assert.equal(await readRate([0x89, 0, 0, ix, 0, 0, 0, 0x5a]), Number(hz));
  }
});

test('有线：r[1] 为电量时仍取 r[3]', async () => {
  assert.equal(await readRate([0x89, 0x61, 0x02, 3, 0x02, 0, 0, 0x5a]), 125);
  assert.equal(await readRate([0x89, 0x61, 0x02, 0, 0x02, 0, 0, 0x5a]), 1000);
});

// 电量：官方桌面驱动按 r[1] 读取，并要求 r[7] 为 0x5A（GamingMouse.exe sub_4455E0）
async function readPower(info) {
  const dev = new IncottDevice(fakeHid(info));
  assert.equal(await dev.readInfo(), true);
  return dev.power;
}

test('电量取自 r[1]（实测 G23V2 有线回包：0x61 = 97%）', async () => {
  assert.equal(await readPower([0x89, 0x61, 0x02, 3, 0x02, 0, 0, 0x5a]), 100, '固件 97% 高于充满点（约 94%），按电压换算是 100%');
  assert.equal(await readPower([0x89, 100, 0, 0, 0, 0, 0, 0x5a]), 100);
});

test('没有 0x5A 标记或电量越界时不采用', async () => {
  assert.equal(await readPower([0x89, 0x61, 0x02, 3, 0x02, 0, 0, 0]), -1);
  assert.equal(await readPower([0x89, 0xc8, 0x02, 3, 0x02, 0, 0, 0x5a]), -1);
});

test('实测 G23V2 无线（8K 接收器）回包除 0x5A 外全为 0：电量未知，不显示 0%', async () => {
  assert.equal(await readPower([0x89, 0, 0, 0, 0, 0, 0, 0x5a]), -1);
});

// Measured on a first-generation G23 Pro (PAW3950) behind its 8K receiver (093A:522C): 0x89 kept answering 58%
// while the mouse's status report said 73%
const G23PRO_8K_INFO = [0x89, 0x3a, 0x00, 0x00, 0x3b, 0x00, 0x00, 0x5a];
const G23PRO_8K_STATUS = [0x49, 0x40, 0x04, 0x00, 0x3f, 0x3f, 0x21, 0x00];

async function readPowerVia(info, { wireless, is8K, dif }) {
  const dev = new IncottDevice(fakeHid(info, dif));
  dev.iswireless = wireless;
  dev.is8KReceiver = is8K;
  assert.equal(await dev.readInfo(), true);
  return dev.power;
}

test('8K receiver: the frozen 58% from a first-generation G23 Pro is not used (r[4] is not a DPI stage), wait for a status report', async () => {
  assert.equal(await readPowerVia(G23PRO_8K_INFO, { wireless: true, is8K: true }), -1);
  const { parseInputReport } = await import('../src/protocol/device.js');
  const s = parseInputReport(new DataView(new Uint8Array(G23PRO_8K_STATUS).buffer));
  assert.equal(s.powerFw, 73);
  assert.equal(s.power, 74); // 按电压换算（battery.js）
  assert.equal(s.charging, false);
});

test('cable and 1K receiver still use the 0x89 battery', async () => {
  assert.equal(await readPowerVia([0x89, 0x61, 0x02, 3, 0x02, 0, 0, 0x5a], { wireless: false, is8K: false }), 100); // 固件 97%，按电压换算
  assert.equal(await readPowerVia([0x89, 0x3a, 0x01, 0, 0x02, 0, 0, 0x5a], { wireless: true, is8K: false }), 46); // 固件 58%，按电压换算
});

// 实测：给 278 补上电量 / DPI 档写入后，8K 接收器回 89 3B 00 00 02 00 00 5A，同期状态包 3B 20 08 00 1F 1F 01（59%，DPI 档 2）
const PATCHED_278_INFO = [0x89, 0x3b, 0x00, 0x00, 0x02, 0x00, 0x00, 0x5a];
const EIGHT_K = { wireless: true, is8K: true };

test('8K 接收器：0x89 的 DPI 档与 0x83 当前档一致时采用电量', async () => {
  assert.equal(await readPowerVia(PATCHED_278_INFO, EIGHT_K), 47); // DIF 当前档为 2；固件 59%，按电压换算
});

test('8K 接收器：DPI 档对不上、0x83 读取失败或原厂 278 回 0 时不采用', async () => {
  assert.equal(await readPowerVia(PATCHED_278_INFO, { ...EIGHT_K, dif: [0x83, 6, 3, 0, 0, 0, 1, 0] }), -1);
  assert.equal(await readPowerVia(PATCHED_278_INFO, { ...EIGHT_K, dif: [0, 0, 0, 0, 0, 0, 0, 0] }), -1);
  assert.equal(await readPowerVia([0x89, 0, 0, 0, 0, 0, 0, 0x5a], { ...EIGHT_K, dif: [0x83, 6, 0, 0, 0, 0, 1, 0] }), -1);
});
