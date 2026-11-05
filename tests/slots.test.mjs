// 板载配置与硬件槽位（实测 G23V2）：鼠标里有 4 个硬件槽位，只能用鼠标上的「配置切换」键切换，软件的写入只进入当前硬件槽位。
// 与官方网页驱动相同，板载配置 N 对应硬件槽位 N：按切换键到槽位 N = 切到配置 N（只写不一样的项，已一致就不写）；
// 点击配置 N = 写进当前硬件槽位（不像官方那样跳回），回到这个槽位时恢复它自己的配置。按键与接收器灯效 4 个槽位共用。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 短定时器立即执行；提示条的自动消失（3 秒以上）不执行，便于检查弹出过的提示
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
const { StProfile, StProfileList, saveProfiles } = await import('../src/protocol/profile.js');
const { MockHidDevice } = await import('../src/protocol/mock.js');
const store = await import('../src/store.js');

const tick = () => new Promise((r) => setImmediate(r));
async function idle() {
  for (let i = 0; i < 5000; i++) {
    await tick();
    if (!store.state.pending && !store.state.applying) return;
  }
  throw new Error('queue did not drain');
}

/** 模拟鼠标（G23 型号码、PAW3950）：记录写命令；is8K = false 时为 1K 接收器 */
function mouse({ is8K = true } = {}) {
  const hid = new MockHidDevice();
  // 状态包由测试手动发送，不用模拟设备的定时器（否则测试失败时进程不会退出）
  const open = hid.open.bind(hid);
  hid.open = async () => {
    await open();
    clearInterval(hid.timer);
  };
  hid.writes = [];
  const send = hid.sendFeatureReport.bind(hid);
  hid.sendFeatureReport = (id, b) => {
    if (b[0] < 0x80) hid.writes.push(Array.from(b));
    return send(id, b);
  };
  const recv = hid.receiveFeatureReport.bind(hid);
  hid.busy = 0; // 接下来这么多次读取失败（实测：刚换完槽位时最初几次读取会失败）
  hid.reads = 0;
  hid.onRead = null;
  hid.receiveFeatureReport = async (id) => {
    const dv = await recv(id);
    if (dv.getUint8(1) === 143) dv.setUint8(4, is8K ? 2 : 1);
    if (dv.getUint8(1) >= 0x80) {
      hid.reads++;
      hid.onRead?.(hid.reads);
      if (hid.busy > 0) {
        hid.busy--;
        return new DataView(new Uint8Array(9).buffer);
      }
    }
    return dv;
  };
  hid.rates = () => hid.writes.filter((b) => b[0] === 1).map((b) => C.RATE_HW[b[1]]);
  return hid;
}

async function connect(hid) {
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  granted = [];
  assert.equal(store.state.phase, 'ready');
  hid.emitStatus(); // 第一个状态包：得知当前槽位并同步
  await idle();
}

async function pressTo(hid, slot) {
  hid.setSlot(slot);
  await idle();
}

/** 已有本地配置：回报率 1000 / 2000 / 4000 / 8000 */
function storeProfiles(rates = [1000, 2000, 4000, 8000]) {
  for (const k of Object.keys(mem)) delete mem[k];
  const list = new StProfileList();
  rates.forEach((r, i) => {
    const p = new StProfile(`板载配置${i + 1}`, C.dvar, C.SENSOR_3950);
    p.inside = true;
    p.usbrate = r;
    list.add(p);
  });
  saveProfiles('G23', list, 0);
}

const rates = () => store.state.profiles.list.map((p) => p.usbrate);

const RATES = [0, 6, 5, 4].map((i) => i); // 1000 / 2000 / 4000 / 8000 的硬件编码，与 4 个配置槽位一致
const hwRates = (hid) => hid.slots.map((sl) => C.RATE_HW[sl.rateIx]);

test('按鼠标上的切换键：到硬件槽位 N 就是板载配置 N；槽位里已经是它时不写入', async () => {
  storeProfiles();
  const hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  assert.equal(store.state.curIndex, 0);
  const seen = [];
  for (const s of [1, 2, 3, 0]) {
    await pressTo(hid, s);
    seen.push(store.state.curIndex + 1);
  }
  assert.deepEqual(seen, [2, 3, 4, 1]);
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');
});

test('点击板载配置：写进当前硬件槽位、不跳回；按键后按官方编号走，回到这个槽位时恢复它自己的配置', async () => {
  storeProfiles();
  const hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  await store.requestProfile(2); // 鼠标在硬件槽位 1，点配置 3（4000 Hz）
  await idle();
  assert.equal(store.state.curIndex, 2);
  assert.deepEqual(hid.writes, [[1, C.RATE_HW.indexOf(4000), 0, 0, 0, 0, 0, 0]], '只写回报率');

  hid.writes.length = 0;
  hid.emitStatus(); // 仍在同一硬件槽位：不会跳回
  await idle();
  assert.equal(store.state.curIndex, 2);
  assert.deepEqual(hid.writes, []);

  const seen = [];
  for (const s of [1, 2, 3, 0]) {
    await pressTo(hid, s);
    seen.push(store.state.curIndex + 1);
  }
  assert.deepEqual(seen, [2, 3, 4, 1], '按键后编号与硬件槽位一致');
  assert.deepEqual(hid.rates(), [1000], '回到硬件槽位 1 时恢复配置 1 的 1000 Hz');
  assert.deepEqual(hwRates(hid), [1000, 2000, 4000, 8000]);

  hid.writes.length = 0;
  for (const s of [1, 2, 3, 0]) await pressTo(hid, s);
  assert.deepEqual(hid.writes, [], '各槽位一致后按键不再写入');
  await store.disconnect('test');
});

test('首次使用（软件里只有默认值）：第一次用到某个配置槽位时，用鼠标里的设置初始化，不写入', async () => {
  for (const k of Object.keys(mem)) delete mem[k];
  const hid = mouse();
  Object.assign(hid.slots[1], { rateIx: 6, debounce: 12, sleep: 300, levels: 4, dpiIx: 3 });
  hid.slots[1].sensor[0] = 1; // LOD 2 mm
  hid.slots[1].dpi[3] = 39; // 2000 DPI
  await connect(hid);
  assert.equal(store.state.firstRun, true);
  await pressTo(hid, 1);
  assert.deepEqual(hid.writes, []);
  assert.equal(store.state.curIndex, 1);
  const pf = store.state.profiles.list[1];
  assert.equal(pf.usbrate, 2000);
  assert.equal(pf.debounce, 12);
  assert.equal(pf.sleeptime, 300);
  assert.equal(pf.lod, 2);
  assert.deepEqual(pf.dpi, [400, 800, 1600, 2000]);
  assert.equal(pf.curDpi, 3);
  assert.deepEqual(JSON.parse(mem.slotsync_G23), [true, true, false, false]);
  await store.disconnect('test');
});

test('1K 接收器：8000 Hz 的槽位只写入 1000 Hz，配置里仍保留 8000；换回 8K 接收器后恢复', async () => {
  storeProfiles();
  let hid = mouse({ is8K: false });
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  await pressTo(hid, 3); // 硬件槽位 4 里原来是 8000 Hz
  assert.equal(store.state.curIndex, 3);
  assert.deepEqual(hid.rates(), [1000], '1K 接收器下不会写入 1000 Hz 以上');
  hid.emitStatus(); // 鼠标上报 1000
  await idle();
  assert.equal(store.state.profiles.list[3].usbrate, 8000, '降级不改写配置');
  assert.equal(store.effectiveRate.value, 1000);
  await store.disconnect('test');

  const slots = hid.slots;
  hid = mouse({ is8K: true });
  hid.slots = slots;
  hid.state.slot = 3;
  await connect(hid);
  assert.equal(store.state.curIndex, 3);
  assert.deepEqual(hid.rates(), [8000]);
  assert.deepEqual(rates(), [1000, 2000, 4000, 8000]);
  await store.disconnect('test');
});

test('鼠标的回报率在软件外真的变了（不是降级）时，配置跟随', async () => {
  storeProfiles();
  const hid = mouse();
  await connect(hid);
  hid.cur.rateIx = C.RATE_HW.indexOf(500);
  hid.emitStatus();
  await idle();
  assert.equal(store.state.profiles.list[0].usbrate, 500);
  await store.disconnect('test');
});

test('按键：只有「配置切换」同步到 4 个配置，其余按键与接收器灯效只改当前配置（与原版一致）', async () => {
  storeProfiles();
  const hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  const pl = store.state.profiles.list;

  // 普通按键：只改当前配置
  await store.assignKey(2, new C.KeyInfo(C.fKeyboard, 0x04));
  await idle();
  assert.equal(pl[0].key[2].major, C.fKeyboard);
  assert.equal(pl[1].key[2].minor, C.fmsMIDDLE, '其它配置不变');
  assert.equal(pl[2].key[2].minor, C.fmsMIDDLE);

  // 左右键互换：只改当前配置
  store.swapLeftRight();
  await idle();
  assert.equal(pl[0].key[0].minor, C.fmsMENU);
  assert.equal(pl[1].key[0].minor, C.fmsCLICK);

  // 接收器灯效：只改当前配置
  store.setReceiverLED(2);
  await idle();
  assert.equal(pl[0].receiverLED, 2);
  assert.ok(pl.slice(1).every((p) => p.receiverLED === 0));

  // "配置切换"键：同步到 4 个配置
  await store.assignKey(5, new C.KeyInfo(C.fMouse, C.favProfile));
  await idle();
  assert.ok(pl.every((p) => p.key[5].minor === C.favProfile), '4 个配置都设为配置切换');
  // 取消它：其它配置恢复默认，当前配置改为新功能
  await store.assignKey(5, new C.KeyInfo(C.fMouse, C.favDPIDEC));
  await idle();
  assert.equal(pl[0].key[5].minor, C.favDPIDEC);
  assert.ok(pl.slice(1).every((p) => p.key[5].minor === C.dvar.key[5].minor), '其余配置恢复默认');
  await store.disconnect('test');
});

test('刚换完槽位时读取失败：重试后读到实际内容，不会误写', async () => {
  storeProfiles();
  const hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  hid.slots[1].dpiIx = 2; // 鼠标里在第 3 档，软件里槽位 2 是第 2 档
  await connect(hid);
  hid.busy = 2; // 每项最多重试 3 次；换槽位后另有 0.4 秒的等待
  await pressTo(hid, 1);
  assert.equal(store.state.curIndex, 1);
  assert.equal(store.state.profiles.list[1].curDpi, 2, '当前 DPI 档以鼠标为准');
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');
});

test('点击后读取期间又按了切换键：取消这次点击，按按键切到下一个槽位', async () => {
  storeProfiles();
  const hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  hid.reads0 = hid.reads;
  hid.onRead = (n) => n === hid.reads0 + 5 && hid.setSlot(1);
  store.requestProfile(2);
  await idle();
  await idle();
  assert.deepEqual(hid.writes, [], '没有把槽位 3 写进去');
  assert.equal(store.state.curIndex, 1, '从槽位 1 按键到槽位 2');
  await store.disconnect('test');
});

test('重启软件：鼠标仍在点选时的槽位就保持点选的配置；软件关闭期间换过槽位则切到同编号的配置', async () => {
  storeProfiles();
  let hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  await store.requestProfile(3); // 硬件槽位 1 里装配置 4
  await idle();
  await store.disconnect('test');

  const slots = hid.slots;
  hid = mouse();
  hid.slots = slots;
  await connect(hid); // 仍在硬件槽位 1
  assert.equal(store.state.curIndex, 3, '保持点选的配置 4');
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');

  hid = mouse();
  hid.slots = slots;
  hid.state.slot = 2; // 软件关闭期间按了两次键
  await connect(hid);
  assert.equal(store.state.curIndex, 2, '硬件槽位 3 → 配置 3');
  assert.deepEqual(hid.writes, [], '槽位 3 里本来就是配置 3');
  await store.disconnect('test');
});

test('软件关闭期间按了切换键：重新连接时不等状态包，立即显示鼠标所在槽位的配置', async () => {
  storeProfiles();
  let hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  await store.disconnect('test');

  const slots = hid.slots;
  hid = mouse();
  hid.slots = slots;
  hid.state.slot = 2; // 关闭期间按了两次切换键
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect(); // 不发状态包
  granted = [];
  assert.equal(store.state.phase, 'ready');
  assert.equal(store.state.curIndex, 2, '界面一出现就是配置 3');
  hid.emitStatus(); // 之后的状态包只是确认
  await idle();
  assert.equal(store.state.curIndex, 2);
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');

  // 几个槽位的设置一样、认不出时：照旧等状态包
  storeProfiles([1000, 1000, 1000, 1000]);
  hid = mouse();
  hid.state.slot = 1;
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  granted = [];
  assert.equal(store.state.curIndex, 0, '认不出时先用上次的配置');
  hid.emitStatus();
  await idle();
  assert.equal(store.state.curIndex, 1, '状态包到达后切到配置 2');
  await store.disconnect('test');
});

test('按切换键后界面与左上角的回报率立即更新，不等读取完成', async () => {
  storeProfiles();
  const hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  await connect(hid);
  assert.equal(store.state.info.rate, 1000);
  hid.setSlot(1); // 只发状态包，不等队列
  assert.equal(store.state.curIndex, 1);
  assert.equal(store.state.info.rate, 2000);
  await idle();
  await store.disconnect('test');
});

test('连续快速按切换键：不会提示写入失败，最后停在正确的配置', async () => {
  storeProfiles();
  const hid = mouse();
  RATES.forEach((r, i) => (hid.slots[i].rateIx = r));
  hid.slots[2].rateIx = 0; // 槽位 3 需要写入，便于在写入中途再按
  await connect(hid);
  store.state.toasts.length = 0;
  // 读取中途按一次、写入中途再按一次
  hid.reads0 = hid.reads;
  hid.onRead = (n) => n === hid.reads0 + 3 && hid.setSlot(2);
  const send = hid.sendFeatureReport;
  let pressed = false;
  hid.sendFeatureReport = (id, b) => {
    if (b[0] === 1 && !pressed) {
      pressed = true;
      setImmediate(() => hid.setSlot(3));
    }
    return send(id, b);
  };
  await pressTo(hid, 1);
  await idle();
  await idle();
  assert.equal(store.state.curIndex, 3);
  assert.ok(!store.state.toasts.some((x) => /失败/.test(x.message)), '没有失败提示');
  // 槽位 3 写入被打断：下次切回去时补齐
  hid.writes.length = 0;
  await pressTo(hid, 2);
  assert.equal(hid.slots[2].rateIx, C.RATE_HW.indexOf(4000));
  await store.disconnect('test');
});
