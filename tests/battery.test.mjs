// 电量显示：固件百分比 → adc → 电压 → 锂电池放电曲线（src/protocol/battery.js）。
// 固件的负载补偿只剩两档（IDA：338.bin sub_1000C3D0 @ 0xC412），电量从 57% 直接掉到 45%，
// 高电量段扣 10 使充满只有约 94%，直线换算使低电量段虚高。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { batteryView, firmwareToAdc, adcToPercent, fullAdcFrom, DEFAULT_FULL_ADC } = await import('../src/protocol/battery.js');
const { parseInputReport } = await import('../src/protocol/device.js');

const dv = (a) => new DataView(new Uint8Array(a).buffer);
const show = (fw, opts) => batteryView(fw, opts).power;
// 固件补偿后能出现的值（46–56 只来自没补偿的开机读数）
const COMPENSATED = [...Array(101).keys()].filter((p) => p < 46 || p > 56);

test('还原 adc：固件的 57% 和 45% 只差 2 个 adc，断档消失', () => {
  assert.equal(firmwareToAdc(57), 529);
  assert.equal(firmwareToAdc(45), 527);
  assert.ok(show(57) - show(45) <= 4, `${show(57)} / ${show(45)}`);
});

test('按电压换算单调，0% 对固件 0%，充满（固件约 94%）显示 100%', () => {
  const out = COMPENSATED.map((p) => show(p));
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i] >= out[i - 1], `固件 ${COMPENSATED[i - 1]}%→${COMPENSATED[i]}% 显示 ${out[i - 1]}→${out[i]}`);
    // 电压平台段一个固件百分点（约 12 mV）最多跳 4
    assert.ok(out[i] - out[i - 1] <= 4, `固件 ${COMPENSATED[i - 1]}%→${COMPENSATED[i]}% 显示 ${out[i - 1]}→${out[i]}`);
  }
  assert.equal(show(0), 0);
  assert.equal(show(94), 100);
  assert.equal(show(100), 100);
});

test('低电量段不再虚高：约 3.6 V（固件 33%）显示 13%，约 3.5 V（固件 25%）显示 7%', () => {
  assert.equal(show(33), 13);
  assert.equal(show(25), 7);
});

test('46–56%（没补偿的开机读数）按不补偿还原，和补偿后同一电压的读数一致', () => {
  assert.equal(firmwareToAdc(50), 507); // 不补偿是 50%，补偿后固件报 33%
  assert.equal(firmwareToAdc(33), 507);
  assert.equal(show(50), show(33));
  for (let p = 46; p <= 56; p++) assert.ok(show(p) < 30, `${p}%`);
});

test('满电 adc：学到的值决定 100% 的位置，不可信的值用默认', () => {
  assert.equal(show(90), 96);
  assert.equal(show(90, { fullAdc: firmwareToAdc(90) }), 100);
  assert.equal(show(80, { fullAdc: firmwareToAdc(90) }), 88);
  assert.equal(show(90, { fullAdc: 500 }), show(90), '低于 560 的满电值不用');
  assert.equal(adcToPercent(DEFAULT_FULL_ADC), 100);
});

test('fullAdcFrom：充电结束后固件值 ≥ 85% 才当成充满', () => {
  assert.equal(fullAdcFrom(84), null);
  assert.equal(fullAdcFrom(85), firmwareToAdc(85));
  assert.equal(fullAdcFrom(100), firmwareToAdc(100));
  assert.equal(fullAdcFrom(-1), null);
  assert.equal(fullAdcFrom(undefined), null);
});

test('充电中最多显示 99%；有线、不再充电、固件 ≥ 85% 显示已充满 100%', () => {
  assert.deepEqual(batteryView(97, { charging: true }), { power: 99, full: false });
  assert.deepEqual(batteryView(60, { charging: true }), { power: show(60), full: false });
  assert.deepEqual(batteryView(88, { wired: true }), { power: 100, full: true });
  assert.deepEqual(batteryView(88, { wired: true, charging: true }), { power: show(88), full: false }, '还在充：不算充满');
  assert.deepEqual(batteryView(80, { wired: true }), { power: show(80), full: false }, '低于 85% 不算充满');
  assert.equal(batteryView(88).full, false, '无线时分不清充满还是拔了线');
});

test('不在 0–100 的值原样返回', () => {
  assert.equal(show(-1), -1);
  assert.equal(show(101), 101);
  assert.equal(show(undefined), undefined);
});

test('状态包：按电压换算，powerFw 是固件原值，用连接的满电 adc 和有线标志', () => {
  const s = parseInputReport(dv([0x80 | 57, 0x20, 0x48, 0, 0x1f, 0x1f, 0x01, 0]));
  assert.equal(s.powerFw, 57);
  assert.equal(s.power, 43);
  assert.equal(s.charging, true);
  assert.equal(s.full, false);
  const full = parseInputReport(dv([90, 0x20, 0x48, 0, 0x1f, 0x1f, 0x01, 0]), null, { wired: true });
  assert.deepEqual([full.power, full.full], [100, true]);
  const learned = parseInputReport(dv([90, 0x20, 0x48, 0, 0x1f, 0x1f, 0x01, 0]), null, { fullAdc: firmwareToAdc(90) });
  assert.deepEqual([learned.power, learned.full], [100, false]);
});

test('旧布局（更早的固件）不换算', () => {
  const s = parseInputReport(dv([0, 57, 1, 0, 0, 0, 0, 0]));
  assert.equal(s.layout, 'old');
  assert.equal(s.power, 57);
  assert.equal(s.powerFw, 57);
  assert.equal(s.full, false);
});
