// 电量修正：固件的负载补偿只剩两档（IDA：338.bin sub_1000C3D0 @ 0xC412），电量从 57% 直接掉到 45%。
// correctPower 反推 adc，在 adc 510–546 之间连续过渡后重新换算。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { correctPower } = await import('../src/protocol/battery.js');
const { parseInputReport } = await import('../src/protocol/device.js');

const dv = (a) => new DataView(new Uint8Array(a).buffer);
// 固件补偿后能出现的值（46–56 只来自没补偿的开机读数）
const COMPENSATED = [...Array(101).keys()].filter((p) => p < 46 || p > 56);

test('固件的 57% → 45% 变成 52% → 50%', () => {
  assert.equal(correctPower(57), 52);
  assert.equal(correctPower(45), 50);
});

test('两端与固件相同：35% 及以下、67% 及以上不变', () => {
  for (let p = 0; p <= 35; p++) assert.equal(correctPower(p), p, `${p}%`);
  for (let p = 67; p <= 100; p++) assert.equal(correctPower(p), p, `${p}%`);
});

test('补偿后的读数修正后单调，相邻两个值最多差 2', () => {
  const out = COMPENSATED.map(correctPower);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i] >= out[i - 1], `固件 ${COMPENSATED[i - 1]}%→${COMPENSATED[i]}% 修正后 ${out[i - 1]}→${out[i]}`);
    assert.ok(out[i] - out[i - 1] <= 2, `固件 ${COMPENSATED[i - 1]}%→${COMPENSATED[i]}% 修正后 ${out[i - 1]}→${out[i]}`);
  }
});

test('46–56%（没补偿的开机读数）按不补偿反推，和十几秒后固件补偿后的值接近', () => {
  // 例：adc 506 不补偿是 50%，补偿后固件报 33%（修正后仍是 33%）
  assert.equal(correctPower(50), 33);
  for (let p = 46; p <= 56; p++) assert.ok(correctPower(p) < p, `${p}%`);
});

test('不在 0–100 的值原样返回', () => {
  assert.equal(correctPower(-1), -1);
  assert.equal(correctPower(101), 101);
  assert.equal(correctPower(undefined), undefined);
});

test('状态包：电量补平，powerFw 是固件原值，充电位不受影响', () => {
  const s = parseInputReport(dv([0x80 | 57, 0x20, 0x48, 0, 0x1f, 0x1f, 0x01, 0]));
  assert.equal(s.power, 52);
  assert.equal(s.powerFw, 57);
  assert.equal(s.charging, true);
});

test('旧布局（更早的固件）不修正', () => {
  const s = parseInputReport(dv([0, 57, 1, 0, 0, 0, 0, 0]));
  assert.equal(s.layout, 'old');
  assert.equal(s.power, 57);
  assert.equal(s.powerFw, 57);
});
