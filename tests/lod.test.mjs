// LOD 写入值：以官方 Windows 桌面驱动（Gaming Mouse Driver）为准。
// 固件编码 0 = 1 mm，1 = 2 mm，2 = 0.7 mm（仅 PAW3950），两种传感器相同（issue #7）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.setTimeout = (f) => setImmediate(f);

const C = await import('../src/protocol/constants.js');
const { IncottDevice } = await import('../src/protocol/device.js');
const { StProfile } = await import('../src/protocol/profile.js');

const HW = { '0.7 mm': 2, '1 mm': 0, '2 mm': 1 };

async function sentLod(sensor, lod) {
  const log = [];
  const dev = new IncottDevice({
    opened: true,
    async sendFeatureReport(_id, b) {
      log.push([...b]);
    },
    addEventListener() {},
    removeEventListener() {},
  });
  dev.sensor = sensor;
  dev.curOnBoard = 0;
  const pf = new StProfile('', C.dvar, sensor);
  pf.lod = lod;
  assert.equal(await dev.apply(pf, C.apLod, 0, { macros: null, profileIndex: 0 }), true);
  const lodPackets = log.filter((b) => b[0] === 4 && b[1] === 1);
  assert.equal(lodPackets.length, 1);
  assert.deepEqual(lodPackets[0].slice(3), [0, 0, 0, 0, 0]);
  return lodPackets[0][2];
}

for (const sensor of [C.SENSOR_3395, C.SENSOR_3950]) {
  test(`[${sensor.toString(16)}] 界面每个 LOD 选项都写入对应的固件值`, async () => {
    const opts = C.lodOptions(sensor);
    for (const o of opts) assert.equal(await sentLod(sensor, o.value), HW[o.label], o.label);
    // 各选项写入的值互不相同，切换才会生效
    const sent = await Promise.all(opts.map((o) => sentLod(sensor, o.value)));
    assert.equal(new Set(sent).size, opts.length);
  });
}

test('[3395] 与官方桌面驱动一致：1 mm → 0，2 mm → 1', async () => {
  assert.equal(await sentLod(C.SENSOR_3395, 1), 0);
  assert.equal(await sentLod(C.SENSOR_3395, 2), 1);
});

test('[3395] 不提供 0.7 mm：导入的 lod = 0 按 1 mm 写入', async () => {
  assert.equal(await sentLod(C.SENSOR_3395, 0), HW['1 mm']);
});

test('非法 lod 值按 1 mm 写入', async () => {
  for (const sensor of [C.SENSOR_3395, C.SENSOR_3950]) {
    for (const lod of [-1, 3, 99, undefined]) assert.equal(await sentLod(sensor, lod), HW['1 mm']);
  }
});
