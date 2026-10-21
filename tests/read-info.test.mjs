// readInfo 回报率解析：用实测 G23V2 的 137 回包（去掉 Report ID 后的 8 字节）校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.setTimeout = (f) => setImmediate(f);

const { IncottDevice } = await import('../src/protocol/device.js');

// 回包第 0 字节为命令回显
const DIF = [0x83, 6, 2, 0, 0, 0, 1, 0];
const WIRELESS = { 125: 3, 250: 2, 500: 1, 1000: 0, 2000: 6, 4000: 5, 8000: 4 };

function fakeHid(info) {
  let last = 0;
  return {
    async sendFeatureReport(_id, b) {
      last = b[0];
    },
    async receiveFeatureReport(id) {
      const data = last === 137 ? info : last === 131 ? DIF : [last, 0, 0, 0, 0, 0, 0, 0];
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
