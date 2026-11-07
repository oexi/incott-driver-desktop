// 电脑端配置（软件不能切换硬件槽位的旧固件，与官方旧版桌面驱动 GamingMouse.exe 相同）：4 套配置保存在电脑上，
// 点击即切换并写进鼠标；不跟随状态包里的槽位，不发 [6,9,序号]，不支持「配置切换」键。板载配置见 slots.test.mjs。改进：只写不一样的项（软件记着鼠标里的设置，不用先读）、
// 没写完的下次连接补写、连接时只读进软件外改过的项、连点只写最后一个。
// 模拟鼠标与实测 G23V2 一致：4 个硬件槽位各存回报率 / DPI / 传感器 / 消抖 / 休眠，按键与接收器灯效共用。

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
const { STMacro, STMacroItem } = await import('../src/protocol/macro.js');
const { MockHidDevice } = await import('../src/protocol/mock.js');
const { keyToHw } = await import('../src/protocol/device.js');
const { MOUSE_FUNCS } = await import('../src/functions.js');
const store = await import('../src/store.js');

const tick = () => new Promise((r) => setImmediate(r));
async function idle() {
  for (let i = 0; i < 5000; i++) {
    await tick();
    if (!store.state.pending && !store.state.applying) return;
  }
  throw new Error('queue did not drain');
}

/** 自动回答确认对话框 */
async function answer(p, yes = true) {
  while (!store.state.dialog) await tick();
  store.state.dialog.resolve(yes);
  return p;
}

const SWITCH = 61706; // 「配置切换」的按键码
const CODE_A = keyToHw(new C.KeyInfo(C.fKeyboard, 0x04), 0);
const hwDpi = (dpi) => C.getHwForDpi(dpi, C.SENSOR_3950);

/** 模拟鼠标（PAW3950）：记录写命令与读次数；model 为型号码（2 = G23，1 = Ghero）；is8K = false 时为 1K 接收器；
 *  fw = 'legacy'：软件不能换槽位的旧固件（本文件测的电脑端配置） */
function mouse({ is8K = true, model = 2, fw = 'legacy' } = {}) {
  const hid = new MockHidDevice({ fw });
  // 状态包由测试手动发送，不用模拟设备的定时器（否则测试失败时进程不会退出）
  const open = hid.open.bind(hid);
  hid.open = async () => {
    await open();
    clearInterval(hid.timer);
  };
  hid.writes = [];
  hid.onWrite = null;
  hid.fail = null; // (bytes) => true 时这条写命令失败
  const send = hid.sendFeatureReport.bind(hid);
  hid.sendFeatureReport = async (id, b) => {
    if (b[0] < 0x80) {
      if (hid.fail?.(Array.from(b))) throw new Error('NotAllowedError: write failed');
      hid.writes.push(Array.from(b));
      hid.onWrite?.(Array.from(b));
    }
    return send(id, b);
  };
  const recv = hid.receiveFeatureReport.bind(hid);
  hid.reads = 0;
  hid.receiveFeatureReport = async (id) => {
    const dv = await recv(id);
    if (dv.getUint8(1) === 143) {
      dv.setUint8(3, model);
      dv.setUint8(4, is8K ? 2 : 1);
    }
    if (dv.getUint8(1) >= 0x80) hid.reads++;
    return dv;
  };
  hid.rates = () => hid.writes.filter((b) => b[0] === 1).map((b) => C.RATE_HW[b[1]]);
  hid.marks = () => hid.writes.filter((b) => b[0] === 6 && b[1] === 9);
  hid.macroHeaders = () => hid.writes.filter((b) => b[0] === 7).length;
  return hid;
}

async function connect(hid) {
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  granted = [];
  assert.equal(store.state.phase, 'ready');
  hid.emitStatus();
  await idle();
}

function reset() {
  for (const k of Object.keys(mem)) delete mem[k];
  store.state.macros.list.length = 0;
  store.state.toasts.length = 0;
}

/** 已有本地配置（本版本保存的）：回报率 1000 / 2000 / 4000 / 8000 */
function storeProfiles(rates = [1000, 2000, 4000, 8000], edit = () => {}, { devname = 'G23', index = 0, mode = 'pc' } = {}) {
  reset();
  const list = new StProfileList();
  rates.forEach((r, i) => {
    const p = new StProfile(`配置${i + 1}`, C.dvar, C.SENSOR_3950);
    p.inside = true;
    p.usbrate = r;
    edit(p, i);
    list.add(p);
  });
  saveProfiles(devname, list, index);
  if (mode) mem[`profilemode_${devname}`] = mode;
}

const pl = () => store.state.profiles.list;
const rates = () => pl().map((p) => p.usbrate);
const toasts = () => store.state.toasts.map((x) => x.message);
const slotRate = (hid) => C.RATE_HW[hid.cur.rateIx];

/* ------------------------------------------------------------ 切换 */

test('点击配置：立即切换，只写和鼠标不一样的项，不用先读鼠标；不发 [6,9,序号]', async () => {
  storeProfiles();
  const hid = mouse();
  await connect(hid);
  assert.deepEqual(hid.writes, [], '连接时不写入');
  const reads = hid.reads;
  const p = store.requestProfile(2);
  assert.equal(store.state.curIndex, 2, '界面立即切换');
  assert.equal(store.state.switchTo, 2);
  await p;
  await idle();
  assert.equal(store.state.switchTo, null);
  assert.deepEqual(hid.rates(), [4000], '只写回报率');
  assert.equal(hid.reads, reads, '没有再读鼠标');
  assert.deepEqual(hid.marks(), []);
  assert.equal(slotRate(hid), 4000);
  assert.equal(mem.onboard_G23, '2', '记住当前配置');
  assert.equal(mem.pendingwrite_G23, undefined, '写完了');

  hid.writes.length = 0;
  await store.requestProfile(0);
  await idle();
  assert.deepEqual(hid.rates(), [1000]);
  hid.writes.length = 0;
  await store.requestProfile(1);
  await store.requestProfile(1); // 已经是它：不处理
  await idle();
  assert.deepEqual(hid.writes, [[1, C.RATE_HW.indexOf(2000), 0, 0, 0, 0, 0, 0]]);
  await store.disconnect('test');
});

test('连点几个配置：界面停在最后一个；正在写的停下，排着的跳过，最后鼠标里是最后点的那个', async () => {
  storeProfiles([1000, 2000, 4000, 8000], (p, i) => (p.debounce = [8, 3, 5, 7][i]));
  const hid = mouse();
  await connect(hid);
  store.requestProfile(1); // 立即开始写（先写回报率）
  store.requestProfile(2);
  store.requestProfile(3);
  await idle();
  assert.equal(store.state.curIndex, 3);
  // 配置 2 的回报率和消抖在同一次写入里，写完这一次就停下；配置 3 整个跳过
  assert.deepEqual(hid.rates(), [2000, 8000]);
  assert.deepEqual(
    hid.writes.filter((b) => b[0] === 5 && b[1] === 1).map((b) => b[2]),
    [3, 7]
  );
  assert.equal(slotRate(hid), 8000);
  assert.equal(hid.cur.debounce, 7);
  await store.disconnect('test');
});

test('状态包里的槽位序号不切换配置；修改设置写进鼠标、只改当前配置', async () => {
  storeProfiles();
  const hid = mouse();
  await connect(hid);
  await store.requestProfile(1);
  await idle();
  hid.emitStatus(); // 鼠标仍报告槽位 1
  await idle();
  assert.equal(store.state.curIndex, 1, '不会跳回配置 1');
  store.setDebounce(4);
  await idle();
  assert.equal(pl()[1].debounce, 4);
  assert.equal(pl()[0].debounce, 8);
  assert.equal(hid.cur.debounce, 4);
  await store.disconnect('test');
});

test('鼠标换了硬件槽位（还有按键是配置切换）：把当前配置写进新槽位并提示，不把那个槽位的设置记进配置', async () => {
  storeProfiles();
  const hid = mouse();
  hid.slots[1].rateIx = C.RATE_HW.indexOf(500);
  await connect(hid);
  hid.setSlot(1);
  await idle();
  assert.equal(store.state.curIndex, 0);
  assert.equal(pl()[0].usbrate, 1000, '没有记成 500');
  assert.equal(C.RATE_HW[hid.slots[1].rateIx], 1000, '配置 1 写进了新槽位');
  assert.ok(toasts().some((m) => m.includes('另一套板载设置')));
  await store.disconnect('test');
});

test('鼠标上的 DPI 键、回报率真的变了：配置跟随；之后切回来按跟随后的写', async () => {
  storeProfiles();
  const hid = mouse();
  await connect(hid);
  hid.cur.dpiIx = 4;
  hid.cur.rateIx = C.RATE_HW.indexOf(500);
  hid.emitStatus();
  await idle();
  assert.equal(pl()[0].curDpi, 4);
  assert.equal(pl()[0].usbrate, 500);
  await store.requestProfile(1);
  await idle();
  hid.writes.length = 0;
  await store.requestProfile(0);
  await idle();
  assert.deepEqual(hid.rates(), [500]);
  assert.ok(hid.writes.some((b) => b[0] === 3 && b[2] === 4), 'DPI 档也写回第 5 档');
  await store.disconnect('test');
});

test('1K 接收器：8000 Hz 的配置只写入 1000 Hz，配置里仍保留 8000；鼠标报告 1000 也不改', async () => {
  storeProfiles();
  const hid = mouse({ is8K: false });
  await connect(hid);
  await store.requestProfile(3);
  await idle();
  assert.deepEqual(hid.rates(), [], '鼠标里本来就是 1000');
  hid.emitStatus();
  await idle();
  assert.equal(pl()[3].usbrate, 8000);
  assert.equal(store.effectiveRate.value, 1000);
  await store.disconnect('test');
});

test('写入失败：提示失败，下次切换先读鼠标再写', async () => {
  storeProfiles();
  const hid = mouse();
  await connect(hid);
  hid.fail = (b) => b[0] === 1;
  await store.requestProfile(1);
  await idle();
  assert.ok(toasts().some((m) => m.includes('写入鼠标失败')));
  assert.ok(mem.pendingwrite_G23 != null, '记下没写完');
  hid.fail = null;
  const reads = hid.reads;
  await store.requestProfile(2);
  await idle();
  assert.ok(hid.reads > reads, '先读了鼠标');
  assert.equal(slotRate(hid), 4000);
  assert.equal(mem.pendingwrite_G23, undefined);
  await store.disconnect('test');
});

/* ------------------------------------------------------------ 连接 */

test('首次使用：从鼠标读取设置，4 个配置都从它开始，不写入', async () => {
  reset();
  const hid = mouse();
  Object.assign(hid.cur, { rateIx: 6, debounce: 12, sleep: 300, levels: 4, dpiIx: 3 });
  hid.cur.sensor[0] = 1; // LOD 2 mm
  hid.cur.dpi[3] = hwDpi(2000);
  hid.state.keys[4] = CODE_A; // 前进键（矩阵 4）
  await connect(hid);
  assert.equal(store.state.firstRun, true);
  for (const pf of pl()) {
    assert.equal(pf.usbrate, 2000);
    assert.equal(pf.debounce, 12);
    assert.equal(pf.sleeptime, 300);
    assert.equal(pf.lod, 2);
    assert.deepEqual(pf.dpi, [400, 800, 1600, 2000]);
    assert.equal(pf.curDpi, 3);
    assert.equal(pf.key[3].major, C.fKeyboard);
  }
  assert.deepEqual(hid.writes, []);
  // 切到别的配置也不会变回默认值
  await store.requestProfile(2);
  await idle();
  assert.deepEqual(hid.writes, []);
  await store.disconnect('test');
});

test('连接：软件外改过的项读进当前配置，不写入；X / Y 分开的 DPI 保留', async () => {
  storeProfiles([1000, 2000, 4000, 8000], (p, i) => {
    if (i === 0) p.dpiy[2] = 2000; // 第 3 档 X 1600 / Y 2000
  });
  const hid = mouse();
  hid.cur.dpiIx = 5; // 软件关着时按了 DPI 键
  hid.cur.debounce = 4; // 用别的驱动改了消抖
  await connect(hid);
  const pf = pl()[0];
  assert.equal(pf.curDpi, 5);
  assert.equal(pf.debounce, 4);
  assert.equal(pf.dpi[2], 1600);
  assert.equal(pf.dpiy[2], 2000, 'Y 保留');
  assert.ok(toasts().some((m) => m.includes('软件外改过')));
  assert.deepEqual(
    hid.writes.filter((b) => b[0] !== 2),
    [],
    '只有 X / Y 分开的档位读不出 Y，不算改过'
  );
  assert.deepEqual(rates(), [1000, 2000, 4000, 8000]);
  await store.disconnect('test');
});

test('上次没写完（中途断开）：连接时把当前配置补写进鼠标，而不是把写了一半的设置读回配置', async () => {
  storeProfiles([1000, 2000, 4000, 8000], undefined, { index: 2 });
  mem.pendingwrite_G23 = '2';
  const hid = mouse(); // 鼠标里还是 1000 Hz
  await connect(hid);
  assert.equal(store.state.curIndex, 2);
  assert.equal(pl()[2].usbrate, 4000, '配置没被改');
  assert.equal(slotRate(hid), 4000, '补写进鼠标');
  assert.equal(mem.pendingwrite_G23, undefined);
  await store.disconnect('test');
});

test('从旧版本升级：配置切换键恢复默认并写入鼠标，把当前配置写进去，清掉旧记录', async () => {
  storeProfiles([1000, 2000, 4000, 8000], (p) => (p.key[1] = new C.KeyInfo(C.fMouse, C.favProfile)), { index: 1, mode: null });
  Object.assign(mem, { slotsync_G23: '[true,true,true,true]', softswitch_G23: 'no', statusseen_G23: '1', slotstate_G23: '{}' });
  const hid = mouse();
  hid.state.keys[1] = SWITCH;
  await connect(hid);
  assert.equal(store.state.curIndex, 1);
  assert.ok(pl().every((p) => p.key[1].minor === C.fmsMENU), '4 个配置的右键都恢复默认');
  assert.equal(hid.state.keys[1], keyToHw(C.dvar.key[1], 1), '鼠标里的也恢复了');
  assert.equal(slotRate(hid), 2000, '当前配置写进鼠标');
  assert.equal(pl()[1].usbrate, 2000);
  assert.ok(toasts().some((m) => m.includes('右键')));
  assert.equal(mem.profilemode_G23, 'pc');
  for (const k of ['slotsync_G23', 'softswitch_G23', 'statusseen_G23', 'slotstate_G23']) assert.equal(mem[k], undefined, k);
  assert.deepEqual(hid.marks(), []);
  await store.disconnect('test');
});

test('首次使用时鼠标里有配置切换键：恢复默认并写入，其余不写', async () => {
  reset();
  const hid = mouse();
  hid.state.keys[5] = SWITCH; // DPI 键
  await connect(hid);
  assert.ok(pl().every((p) => p.key[5].minor === C.favDPI));
  assert.deepEqual(
    hid.writes.map((b) => b.slice(0, 2)),
    [[6, 5]]
  );
  await store.disconnect('test');
});

test('GHERO：同样的配置逻辑', async () => {
  storeProfiles(undefined, undefined, { devname: 'Ghero' });
  const hid = mouse({ model: 1 });
  await connect(hid);
  assert.equal(store.state.info.devname, 'Ghero');
  assert.deepEqual(hid.writes, []);
  await store.requestProfile(2);
  await idle();
  assert.equal(store.state.curIndex, 2);
  assert.deepEqual(hid.rates(), [4000]);
  await store.disconnect('test');
});

/* ------------------------------------------------------------ 宏 */

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

test('同一个按键在两个配置里绑了不同的宏：切换时重写宏（按键码相同，读回来分不出）；同一个宏不重写', async () => {
  storeProfiles([1000, 2000, 4000, 8000], (p, i) => {
    if (i === 0 || i === 2) p.key[3] = macroKey(111);
    if (i === 1) p.key[3] = macroKey(222);
  });
  macro(111, 'A');
  macro(222, 'B');
  const hid = mouse();
  hid.state.keys[4] = (3 << 16) | 9; // 鼠标里前进键是宏，但不知道是哪个
  await connect(hid);
  await store.requestProfile(0); // 已经是它：不处理
  assert.equal(hid.macroHeaders(), 0);
  await store.requestProfile(1);
  await idle();
  assert.equal(hid.macroHeaders(), 10, '配置 2 的宏：写入');
  hid.writes.length = 0;
  await store.requestProfile(3);
  await idle();
  assert.equal(hid.macroHeaders(), 0, '配置 4 没有宏：只写按键码');
  assert.equal(hid.writes.filter((b) => b[0] === 6).length, 1);
  hid.writes.length = 0;
  await store.requestProfile(0);
  await idle();
  assert.equal(hid.macroHeaders(), 10);
  hid.writes.length = 0;
  await store.requestProfile(2);
  await idle();
  assert.equal(hid.macroHeaders(), 0, '配置 3 和配置 1 是同一个宏');
  await store.disconnect('test');
});

/* ------------------------------------------------------------ 按键 / 导入 / 复制 */

test('按键：不再提供配置切换；只改当前配置', async () => {
  assert.ok(!MOUSE_FUNCS.some(([m]) => m === C.favProfile));
  storeProfiles();
  const hid = mouse();
  await connect(hid);
  await store.assignKey(5, new C.KeyInfo(C.fMouse, C.favProfile));
  await idle();
  assert.equal(pl()[0].key[5].minor, C.favDPI, '忽略');
  await store.assignKey(2, new C.KeyInfo(C.fKeyboard, 0x04));
  await idle();
  assert.equal(pl()[0].key[2].major, C.fKeyboard);
  assert.equal(pl()[1].key[2].minor, C.fmsMIDDLE);
  store.swapLeftRight();
  await idle();
  assert.equal(pl()[0].key[0].minor, C.fmsMENU);
  assert.equal(pl()[1].key[0].minor, C.fmsCLICK);
  await store.disconnect('test');
});

test('导入配置：网页驱动导出的配置切换键恢复默认，整套写入（不含 [6,9,序号]）', async () => {
  storeProfiles();
  const hid = mouse();
  await connect(hid);
  const imp = new StProfile('x', C.dvar, C.SENSOR_3950);
  imp.usbrate = 500;
  imp.key[4] = new C.KeyInfo(C.fMouse, C.favProfile);
  await store.importProfile(imp.toText());
  await idle();
  const cur = pl()[0];
  assert.equal(cur.usbrate, 500);
  assert.equal(cur.key[4].minor, C.dvar.key[4].minor);
  assert.equal(cur.name, '配置1');
  assert.equal(slotRate(hid), 500);
  assert.deepEqual(hid.marks(), []);
  await store.disconnect('test');
});

test('复制配置：其它配置的全部设置覆盖当前配置并写入鼠标', async () => {
  storeProfiles([1000, 2000, 4000, 8000], (p, i) => (p.debounce = 4 + i));
  const hid = mouse();
  await connect(hid);
  await answer(store.copyProfile(2));
  await idle();
  const cur = pl()[0];
  assert.equal(cur.usbrate, 4000);
  assert.equal(cur.debounce, 6);
  assert.equal(cur.name, '配置1');
  assert.equal(pl()[2].usbrate, 4000, '来源不变');
  assert.equal(slotRate(hid), 4000);
  assert.equal(store.state.curIndex, 0);
  await store.disconnect('test');
});

test('恢复出厂：整套写入默认值，不含 [6,9,序号]', async () => {
  storeProfiles([2000, 2000, 2000, 2000]);
  const hid = mouse();
  hid.cur.rateIx = C.RATE_HW.indexOf(2000);
  await connect(hid);
  await answer(store.factoryReset());
  await idle();
  assert.equal(pl()[0].usbrate, 1000);
  assert.equal(slotRate(hid), 1000);
  assert.equal(pl()[1].usbrate, 2000);
  assert.deepEqual(hid.marks(), []);
  await store.disconnect('test');
});
