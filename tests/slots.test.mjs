// 板载配置（固件 1.4.x，与官方新版桌面驱动 incott-app 1.4.0.3 相同）：配置 N = 鼠标的硬件槽位 N。
// 连接时用 [0x85,6] 读出槽位、点击配置发 [5,6,N]、跟随鼠标上的「配置切换」键、「配置切换」键 4 个槽位共用。
// 模拟鼠标 fw: 'slots' 与固件 1.4.0.3 的行为一致（IDA 分析）；fw: 'legacy' 是软件不能换槽位的旧固件。

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
const { STMacro, STMacroItem } = await import('../src/protocol/macro.js');
const { IncottDevice } = await import('../src/protocol/device.js');
const store = await import('../src/store.js');

const tick = () => new Promise((r) => setImmediate(r));
async function idle() {
  for (let i = 0; i < 5000; i++) {
    await tick();
    if (!store.state.pending && !store.state.applying) return;
  }
  throw new Error('queue did not drain');
}

const SWITCH = 61706;
const rateIx = (r) => C.RATE_HW.indexOf(r);

/** 模拟鼠标（PAW3950，G23，8K 接收器）：记录写命令与读次数 */
function mouse({ fw = 'slots', wired = false } = {}) {
  const hid = new MockHidDevice({ fw });
  if (wired) hid.productId = C.PID_WIRED;
  // 状态包由测试手动发送，不用模拟设备的定时器
  const open = hid.open.bind(hid);
  hid.open = async () => {
    await open();
    clearInterval(hid.timer);
  };
  hid.writes = [];
  hid.drop = null; // (bytes) => true 时鼠标收到但不执行（模拟固件不认识）
  // 休眠（实测 G23V2 + 8K 接收器）：接收器对 8E 01 报告不在线，其余读命令回全 0，写命令照样"发送成功"但鼠标收不到。
  // asleep：之后还要问几次 8E 01 鼠标才醒；sleepOnSwitch：切换槽位后马上睡着（新槽位的休眠时间更短），来不及发状态包
  hid.asleep = 0;
  hid.sleepOnSwitch = 0;
  const send = hid.sendFeatureReport.bind(hid);
  hid.sendFeatureReport = async (id, b) => {
    if (b[0] < 0x80) {
      hid.writes.push(Array.from(b));
      if (hid.drop?.(Array.from(b))) {
        hid.last = Array.from(b);
        return;
      }
    }
    if (hid.asleep > 0) {
      hid.last = Array.from(b);
      return;
    }
    if (b[0] === 5 && b[1] === 6 && hid.sleepOnSwitch > 0) {
      const emit = hid.emitStatus;
      hid.emitStatus = () => {};
      await send(id, b);
      hid.emitStatus = emit;
      hid.asleep = hid.sleepOnSwitch;
      hid.sleepOnSwitch = 0;
      return;
    }
    return send(id, b);
  };
  const recv = hid.receiveFeatureReport.bind(hid);
  hid.reads = 0;
  hid.readCmds = [];
  hid.receiveFeatureReport = async (id) => {
    if (hid.asleep > 0) {
      const asked = hid.last?.[0] === 0x8e && hid.last?.[1] === 1;
      if (asked) hid.asleep--;
      return new DataView(new Uint8Array(asked ? [id, 0x8e, 1, 0, 0, 0, 0, 0, 0] : [id, 0, 0, 0, 0, 0, 0, 0, 0]).buffer);
    }
    const dv = await recv(id);
    hid.readCmds.push(dv.getUint8(1));
    if (dv.getUint8(1) === 143 && wired) {
      dv.setUint8(4, 0); // 有线：没有接收器
      dv.setUint8(5, 241); // 有线：传感器在 data[4]
    }
    if (dv.getUint8(1) >= 0x80) hid.reads++;
    return dv;
  };
  hid.slotWrites = () => hid.writes.filter((b) => b[0] === 5 && b[1] === 6).map((b) => b[2]);
  hid.rates = () => hid.writes.filter((b) => b[0] === 1).map((b) => C.RATE_HW[b[1]]);
  hid.macroHeaders = () => hid.writes.filter((b) => b[0] === 7).length;
  return hid;
}

async function connect(hid) {
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  granted = [];
  assert.equal(store.state.phase, 'ready');
  await idle();
}

function reset() {
  for (const k of Object.keys(mem)) delete mem[k];
  store.state.macros.list.length = 0;
  store.state.toasts.length = 0;
}

/** 已有本地配置：回报率 1000 / 2000 / 4000 / 8000；mode / states 为上次的方式与槽位状态 */
function storeProfiles({ rates = [1000, 2000, 4000, 8000], index = 0, mode = 'slots', states = ['synced', 'synced', 'synced', 'synced'], edit = () => {} } = {}) {
  reset();
  const list = new StProfileList();
  rates.forEach((r, i) => {
    const p = new StProfile(`配置${i + 1}`, C.dvar, C.SENSOR_3950);
    p.inside = true;
    p.usbrate = r;
    edit(p, i);
    list.add(p);
  });
  saveProfiles('G23', list, index);
  if (mode) mem.profilemode_G23 = mode;
  if (states) mem.hwslots_G23 = JSON.stringify(states);
}

/** 模拟鼠标的 4 个槽位装着和配置一样的回报率 */
function fillSlots(hid, rates = [1000, 2000, 4000, 8000]) {
  rates.forEach((r, i) => (hid.slots[i].rateIx = rateIx(r)));
}

const pl = () => store.state.profiles.list;
const toasts = () => store.state.toasts.map((x) => x.message);
const states = () => JSON.parse(mem.hwslots_G23);

/* ---------------------------------------------------------------- 协议 */

test('协议：读槽位——有线回包 r[1]，无线回包 [0x85,6,槽位]；旧固件无线时的残留不会被当成槽位', async () => {
  for (const wired of [true, false]) {
    const hid = mouse({ wired });
    hid.state.slot = 2;
    const dev = new IncottDevice(hid);
    await dev.open();
    assert.equal(await dev.probeHwSlot(), 2, wired ? '有线' : '无线');
    assert.equal(await dev.readHwSlot(), 2);
    await dev.close();
  }
  for (const wired of [true, false]) {
    for (const debounce of [8, 2, 0]) {
      const hid = mouse({ fw: 'legacy', wired });
      hid.cur.debounce = debounce; // 残留正好在 0–3 也不能当成槽位
      const dev = new IncottDevice(hid);
      await dev.open();
      assert.equal(await dev.probeHwSlot(), null, `旧固件 ${wired ? '有线' : '无线'} 消抖 ${debounce}`);
      await dev.close();
    }
  }
});

/* ---------------------------------------------------------------- 连接 */

test('连接：不等状态包，直接显示鼠标所在槽位的配置；首次使用只读当前槽位，不写入', async () => {
  reset();
  const hid = mouse();
  hid.state.slot = 2;
  hid.slots[2].rateIx = rateIx(500);
  hid.slots[2].debounce = 12;
  await connect(hid); // 没有发状态包
  assert.equal(store.state.hwSlots, true);
  assert.equal(store.state.curIndex, 2);
  assert.equal(store.state.slot, 2);
  assert.equal(pl()[2].usbrate, 500);
  assert.equal(pl()[2].debounce, 12);
  assert.equal(pl()[0].usbrate, 1000, '其它配置还没读');
  assert.deepEqual(hid.writes, []);
  assert.deepEqual(states(), ['fresh', 'fresh', 'synced', 'fresh']);
  assert.equal(mem.profilemode_G23, 'slots');
  assert.equal(mem.onboard_G23, '2');

  // 第一次切到别的槽位：读出它的设置，不写入（只发切换命令）
  hid.slots[0].rateIx = rateIx(250);
  await store.requestProfile(0);
  await idle();
  assert.equal(store.state.curIndex, 0);
  assert.equal(hid.state.slot, 0);
  assert.equal(pl()[0].usbrate, 250);
  assert.deepEqual(hid.writes, [[5, 6, 0, 0, 0, 0, 0, 0]]);
  assert.deepEqual(states(), ['synced', 'fresh', 'synced', 'fresh']);
  await store.disconnect('test');
});

test('有线、固件 1.4：板载配置；电量连接时就从 0x89 读到', async () => {
  reset();
  const hid = mouse({ wired: true });
  hid.state.slot = 1;
  hid.state.power = 70;
  await connect(hid);
  assert.equal(store.state.hwSlots, true);
  assert.equal(store.state.curIndex, 1);
  assert.equal(store.state.info.power, 70);
  await store.disconnect('test');
});

test('旧固件：仍是电脑端配置（不发 [5,6,N]）', async () => {
  storeProfiles({ mode: 'pc', states: null });
  const hid = mouse({ fw: 'legacy' });
  await connect(hid);
  assert.equal(store.state.hwSlots, false);
  await store.requestProfile(2);
  await idle();
  assert.deepEqual(hid.slotWrites(), []);
  assert.deepEqual(hid.rates(), [4000], '把配置写进鼠标当前的槽位');
  await store.disconnect('test');
});

/* ---------------------------------------------------------------- 切换 */

test('点击配置：只发 [5,6,N]，槽位和配置一致时不写；本次已知的槽位不再读', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  assert.deepEqual(hid.writes, [], '连接时一致：不写');
  const p = store.requestProfile(2);
  assert.equal(store.state.curIndex, 2, '界面立即切换');
  assert.equal(store.state.switchTo, 2);
  await p;
  await idle();
  assert.equal(store.state.switchTo, null);
  assert.deepEqual(hid.writes, [[5, 6, 2, 0, 0, 0, 0, 0]]);
  assert.equal(hid.state.slot, 2);
  assert.equal(mem.onboard_G23, '2');

  await store.requestProfile(0);
  await idle();
  hid.readCmds.length = 0;
  hid.writes.length = 0;
  await store.requestProfile(2); // 槽位 3 本次读过
  await idle();
  assert.deepEqual(hid.writes, [[5, 6, 2, 0, 0, 0, 0, 0]]);
  // 测试里等状态包的计时器立即到期，会读回槽位号确认；但不会再读整个槽位（readSlot 从 0x81 开始）
  assert.ok(!hid.readCmds.includes(0x81), '没有再读槽位');
  await store.disconnect('test');
});

test('点击配置：槽位里不是这个配置（stale）时把配置写进去；软件外改过的（synced）读进配置', async () => {
  storeProfiles({ states: ['synced', 'stale', 'synced', 'synced'] });
  const hid = mouse();
  fillSlots(hid, [1000, 500, 4000, 500]);
  await connect(hid);
  await store.requestProfile(1);
  await idle();
  assert.equal(C.RATE_HW[hid.slots[1].rateIx], 2000, '配置 2 写进了槽位 2');
  assert.equal(pl()[1].usbrate, 2000);
  assert.deepEqual(states(), ['synced', 'synced', 'synced', 'synced']);

  await store.requestProfile(3);
  await idle();
  assert.equal(pl()[3].usbrate, 500, '槽位 4 在软件外改过：读进配置 4');
  assert.equal(C.RATE_HW[hid.slots[3].rateIx], 500);
  assert.ok(toasts().some((m) => m.includes('软件外改过')));
  await store.disconnect('test');
});

test('连点几个配置：只切到最后点的那个', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  store.requestProfile(1);
  store.requestProfile(2);
  store.requestProfile(3);
  await idle();
  assert.equal(store.state.curIndex, 3);
  assert.equal(hid.state.slot, 3);
  assert.deepEqual(hid.slotWrites().at(-1), 3);
  assert.ok(!hid.slotWrites().includes(2), '中间的跳过');
  await store.disconnect('test');
});

test('修改设置写进当前槽位；点了别的配置后才改的写进新槽位', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  store.setDebounce(4); // 属于配置 1
  store.requestProfile(1);
  store.setDebounce(6); // 界面已在配置 2
  await idle();
  assert.equal(hid.slots[0].debounce, 4);
  assert.equal(hid.slots[1].debounce, 6);
  assert.equal(pl()[0].debounce, 4);
  assert.equal(pl()[1].debounce, 6);
  assert.deepEqual(states(), ['synced', 'synced', 'synced', 'synced']);
  await store.disconnect('test');
});

test('鼠标上的「配置切换」键：界面跟着切，不发 [5,6,N]；那个槽位的设置不会写进别的配置', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  hid.setSlot(3);
  await idle();
  assert.equal(store.state.curIndex, 3);
  assert.deepEqual(hid.writes, []);
  assert.equal(pl()[0].usbrate, 1000);
  assert.equal(pl()[3].usbrate, 8000);
  assert.ok(toasts().some((m) => m.includes('板载配置 4')));
  // 之后在软件里改的写进槽位 4
  store.setDebounce(3);
  await idle();
  assert.equal(hid.slots[3].debounce, 3);
  await store.disconnect('test');
});

test('切换没有得到鼠标确认：本次改用电脑端配置，把配置写进当前槽位并提示', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  hid.drop = (b) => b[0] === 5 && b[1] === 6; // 固件其实不执行 [5,6,N]
  await connect(hid);
  assert.equal(store.state.hwSlots, true);
  await store.requestProfile(2);
  await idle();
  assert.equal(store.state.hwSlots, false);
  assert.equal(store.state.curIndex, 2);
  assert.equal(C.RATE_HW[hid.cur.rateIx], 4000, '配置 3 写进了鼠标当前的槽位');
  assert.equal(hid.state.slot, 0);
  assert.ok(toasts().some((m) => m.includes('没有响应')));
  assert.equal(mem.profilemode_G23, 'pc');
  await store.disconnect('test');
});

/* ---------------------------------------------------------- 配置切换键 */

test('「配置切换」键：只在板载配置可选，左 / 右键不行；设上后 4 个配置和 4 个槽位一起有', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  assert.equal(store.canSwitchKey(0), false);
  assert.equal(store.canSwitchKey(2), true);
  await store.assignKey(0, new C.KeyInfo(C.fMouse, C.favProfile));
  await idle();
  assert.ok(toasts().some((m) => m.includes('不能设在左键或右键')));
  assert.deepEqual(hid.writes, []);

  await store.assignKey(2, new C.KeyInfo(C.fMouse, C.favProfile)); // 中键
  await idle();
  for (const pf of pl()) assert.ok(store.isSwitchKey(pf.key[2]));
  for (const sl of hid.slots) assert.equal(sl.keys[2], SWITCH);
  assert.equal(hid.writes.filter((b) => b[0] === 6).length, 1, '只写一次，固件写进全部槽位');

  // 按它换槽位，再换掉：4 个配置一起改成新的功能
  hid.setSlot(1);
  await idle();
  await store.assignKey(2, new C.KeyInfo(C.fMouse, C.fmsMIDDLE));
  await idle();
  for (const pf of pl()) assert.ok(!store.isSwitchKey(pf.key[2]));
  for (const sl of hid.slots) assert.equal(sl.keys[2], 0x00f20001);
  // 切到别的槽位不用再写这个键
  hid.writes.length = 0;
  await store.requestProfile(3);
  await idle();
  assert.equal(hid.writes.filter((b) => b[0] === 6).length, 0);
  await store.disconnect('test');
});

test('电脑端配置（旧固件）：「配置切换」不可选', async () => {
  storeProfiles({ mode: 'pc', states: null });
  const hid = mouse({ fw: 'legacy' });
  await connect(hid);
  assert.equal(store.canSwitchKey(2), false);
  await store.assignKey(2, new C.KeyInfo(C.fMouse, C.favProfile));
  await idle();
  assert.ok(!store.isSwitchKey(pl()[0].key[2]));
  await store.disconnect('test');
});

test('连接时鼠标里已有「配置切换」键：保留，4 个配置一起有', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  for (const sl of hid.slots) sl.keys[5] = SWITCH; // DPI 键
  await connect(hid);
  for (const pf of pl()) assert.ok(store.isSwitchKey(pf.key[5]));
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');
});

/* ---------------------------------------------------------------- 升级 */

test('从电脑端配置升级：鼠标所在槽位里是上次的当前配置；其它槽位进入时把配置写进去', async () => {
  storeProfiles({ mode: 'pc', states: null });
  const hid = mouse(); // 4 个槽位都是 1000 Hz
  await connect(hid);
  assert.equal(store.state.hwSlots, true);
  assert.deepEqual(states(), ['synced', 'stale', 'stale', 'stale']);
  assert.deepEqual(hid.writes, []);
  await store.requestProfile(2);
  await idle();
  assert.equal(C.RATE_HW[hid.slots[2].rateIx], 4000);
  assert.equal(pl()[2].usbrate, 4000, '没有把槽位里的 1000 读进配置');
  await store.disconnect('test');
});

test('从电脑端配置升级、鼠标不在上次的槽位：把那个槽位的配置写进去', async () => {
  storeProfiles({ mode: 'pc', states: null, index: 0 });
  const hid = mouse();
  hid.state.slot = 3;
  await connect(hid);
  assert.equal(store.state.curIndex, 3);
  assert.equal(C.RATE_HW[hid.slots[3].rateIx], 8000);
  assert.equal(pl()[3].usbrate, 8000);
  await store.disconnect('test');
});

test('写到一半断开：下次连接把配置补写进槽位，而不是读回配置', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  hid.drop = (b) => b[0] === 1; // 回报率没写进去
  hid.state.slot = 0;
  store.setRate(500);
  await idle();
  await store.disconnect('test'); // 断开时槽位 1 记成 stale
  hid.drop = null;
  assert.deepEqual(states()[0], 'synced', '写入成功返回，记录为一致');

  // 模拟写到一半：槽位状态停在 stale
  mem.hwslots_G23 = JSON.stringify(['stale', 'synced', 'synced', 'synced']);
  hid.writes.length = 0;
  await connect(hid);
  assert.equal(pl()[0].usbrate, 500, '配置没被槽位里的值改掉');
  assert.equal(C.RATE_HW[hid.slots[0].rateIx], 500, '补写进槽位');
  assert.deepEqual(states(), ['synced', 'synced', 'synced', 'synced']);
  await store.disconnect('test');
});

test('无线鼠标连接时没回答（休眠）：沿用板载配置，第一个状态包确认槽位，换了就跟过去', async () => {
  storeProfiles({ index: 1 });
  const hid = mouse();
  fillSlots(hid);
  hid.state.slot = 3;
  const recv = hid.receiveFeatureReport;
  let asleep = true;
  hid.receiveFeatureReport = async (id) => {
    const dv = await recv(id);
    // 休眠时只有接收器回答（0x8F / 0x8E / 0x89），转发给鼠标的读命令没有回包
    if (asleep && ![0x8f, 0x8e, 0x89].includes(dv.getUint8(1))) return new DataView(new Uint8Array(9).buffer);
    return dv;
  };
  await connect(hid);
  assert.equal(store.state.hwSlots, true);
  assert.equal(store.state.curIndex, 1, '先按上次的显示');
  assert.deepEqual(hid.writes, []);
  asleep = false;
  hid.emitStatus(); // 醒了：在槽位 4
  await idle();
  assert.equal(store.state.curIndex, 3);
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');
});

/* ------------------------------------------------------------------ 宏 */

function macro(uid, key) {
  const m = new STMacro(`m${uid}`);
  m.uid = uid;
  m.item = [new STMacroItem(key, 20, true), new STMacroItem(key, 20, false)];
  store.state.macros.list.push(m);
  return m;
}
const macroKey = (uid) => {
  const k = new C.KeyInfo(C.fJuji, 0);
  k.itemdata = uid;
  return k;
};

test('宏：每个槽位各存自己的宏，来回切换不重写；在别的槽位时改了宏，进入用到它的槽位时重写', async () => {
  storeProfiles({
    states: ['synced', 'stale', 'synced', 'synced'],
    edit: (p, i) => {
      if (i === 0) p.key[3] = macroKey(111);
      if (i === 1) p.key[3] = macroKey(222);
    },
  });
  const m1 = macro(111, 'A');
  macro(222, 'B');
  const hid = mouse();
  fillSlots(hid);
  hid.slots[0].keys[4] = (3 << 16) | 9; // 槽位 1 的前进键是宏，宏签名没有记录
  await connect(hid);
  assert.equal(hid.macroHeaders(), 10, '槽位 1 里不知道是哪个宏：写一次');
  await store.requestProfile(1);
  await idle();
  assert.equal(hid.macroHeaders(), 20, '槽位 2 要写进配置 2（stale）');
  hid.writes.length = 0;
  await store.requestProfile(0);
  await store.requestProfile(1);
  await store.requestProfile(0);
  await idle();
  assert.equal(hid.macroHeaders(), 0, '宏已在各自的槽位里');

  await store.requestProfile(2);
  await idle();
  await store.updateMacro(111, { name: m1.name, looptype: m1.looptype, cycle: m1.cycle, item: [new STMacroItem('C', 20, true), new STMacroItem('C', 20, false)] });
  await idle();
  assert.equal(hid.macroHeaders(), 0, '当前槽位没用到这个宏');
  await store.requestProfile(0);
  await idle();
  assert.equal(hid.macroHeaders(), 10, '进入槽位 1 时重写改过的宏');
  await store.disconnect('test');
});

/* ---------------------------------------------------------------- 休眠 */

test('切到休眠时间更短的配置后鼠标马上睡着：不退出板载模式，提示动一下鼠标，醒来后确认切换', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  hid.sleepOnSwitch = 3;
  await store.requestProfile(2);
  await idle();
  assert.equal(hid.state.slot, 2);
  assert.equal(store.state.hwSlots, true, '不能因为鼠标睡着就当成固件不支持');
  assert.equal(store.hiFpsSupported.value, true, '「最高性能」跟着板载模式，不能被藏起来');
  assert.equal(store.state.slot, 2);
  assert.equal(store.state.curIndex, 2);
  assert.equal(mem.profilemode_G23, 'slots');
  assert.ok(toasts().some((m) => /切到配置 3 后进入了休眠/.test(m)));
  assert.ok(!toasts().some((m) => /固件可能不支持/.test(m)));
  assert.deepEqual(hid.slotWrites(), [2], '醒来后读回槽位已经是 3，不再发切换命令');
  await store.disconnect('test');
});

test('切换后鼠标睡着、一直没醒：界面回到原来的配置，仍是板载模式', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  hid.sleepOnSwitch = 1000;
  await store.requestProfile(2);
  await idle();
  assert.equal(store.state.curIndex, 0);
  assert.equal(store.state.hwSlots, true);
  assert.equal(store.hiFpsSupported.value, true);
  assert.equal(mem.profilemode_G23, 'slots');
  assert.ok(toasts().some((m) => /鼠标没有醒来，没能确认切换配置/.test(m)));
  assert.ok(!toasts().some((m) => /固件可能不支持/.test(m)));
  hid.asleep = 0;
  await store.disconnect('test');
});

test('鼠标在休眠时修改设置：先提示动一下鼠标，醒来后再写进去', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  const dev = store.state.device;
  hid.asleep = 3;
  dev.lastInputAt = dev.lastOnlineAt = 0; // 好一会儿没收到状态包
  store.setDebounce(4);
  await idle();
  assert.equal(hid.cur.debounce, 4);
  assert.ok(toasts().some((m) => /鼠标没有响应，可能在休眠/.test(m)));
  assert.ok(!toasts().some((m) => /写入鼠标失败/.test(m)));
  await store.disconnect('test');
});

test('鼠标一直没醒：修改不发给鼠标，提示动一下鼠标后再试', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  const dev = store.state.device;
  hid.asleep = 1000;
  dev.lastInputAt = dev.lastOnlineAt = 0;
  store.setDebounce(5);
  await idle();
  assert.ok(!hid.writes.some((b) => b[0] === 5 && b[1] === 1 && b[2] === 5), '睡着时不发写命令');
  assert.ok(toasts().some((m) => /鼠标一直没有醒来，这次修改没有写进鼠标/.test(m)));
  assert.equal(states()[0], 'stale', '配置是新值、鼠标里不是：下次进入槽位时要写进去');
  hid.asleep = 0;
  await store.disconnect('test');
});

test('鼠标睡着时点别的配置、一直没醒：界面回到鼠标所在的配置，提示没能切换', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  const dev = store.state.device;
  hid.asleep = 1000;
  dev.lastInputAt = dev.lastOnlineAt = 0;
  await store.requestProfile(2);
  await idle();
  assert.equal(hid.state.slot, 0);
  assert.equal(store.state.curIndex, 0, '界面要回到鼠标实际所在的配置');
  assert.equal(store.state.hwSlots, true);
  assert.ok(toasts().some((m) => /鼠标没有醒来，没能确认切换配置/.test(m)));
  assert.ok(!toasts().some((m) => /这次修改没有写进鼠标/.test(m)), '切换配置不是"修改"');
  // 鼠标醒来后，状态包照常处理（在鼠标上按 DPI 键，界面跟着变）
  hid.asleep = 0;
  assert.notEqual(pl()[0].curDpi, 4);
  hid.cur.dpiIx = 4;
  hid.emitStatus();
  await idle();
  assert.equal(pl()[0].curDpi, 4, '跳过切换后不能一直忽略状态包');
  await store.disconnect('test');
});

test('鼠标睡着时连点两个配置：醒来后切到最后点的那个，前一个不再单独等', async () => {
  storeProfiles();
  const hid = mouse();
  fillSlots(hid);
  await connect(hid);
  const dev = store.state.device;
  hid.asleep = 3;
  dev.lastInputAt = dev.lastOnlineAt = 0;
  store.requestProfile(1);
  store.requestProfile(2);
  await idle();
  assert.equal(store.state.curIndex, 2);
  assert.equal(hid.state.slot, 2);
  assert.deepEqual(hid.slotWrites(), [2]);
  await store.disconnect('test');
});
