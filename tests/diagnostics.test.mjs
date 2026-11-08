// 「复制诊断信息」：只发读命令；包含型号码、PID、连接时 143/142/137 原文、状态包数量与最近几包，
// 以及解码、对照、事件、失败现场等。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 诊断查询的超时（3000ms）不触发，其余定时器立即执行
globalThis.setTimeout = (f, ms) => (ms >= 3000 ? 0 : setImmediate(f));
globalThis.clearTimeout = () => {};
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
const { IncottDevice } = await import('../src/protocol/device.js');
const { StProfile, StProfileList } = await import('../src/protocol/profile.js');
const store = await import('../src/store.js');
const { collectDiagnostics, DIAG_QUERIES, buildFindings } = await import('../src/diagnostics.js');
const { logEvent, events, consoleLog } = await import('../src/diaglog.js');
const { STMacro, STMacroItem } = await import('../src/protocol/macro.js');
const { t } = await import('../src/i18n.js');
const { markRaw } = await import('vue');

/** 按实测 G23V2（无线 8K）回包构造的假设备 */
function fakeHid({ model = 14, keys: keyOverride = {}, online = 1, zeroStar = false, rx1k = false, stages = 6 } = {}) {
  const sent = [];
  const keys = { ...[0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007], ...keyOverride };
  // zeroStar：模拟不支持官方桌面驱动专用读命令的固件（回包除回显外全 0）
  const isStar = (b) => [0x80, 0x81, 0x82, 0x84, 0x88].includes(b[0]) || (b[0] === 0x85 && b[1] !== 3);
  let prev = [0, 0, 0, 0, 0, 0, 0, 0];
  const reply = (b) => (prev = answer(b));
  const answer = (b) => {
    if (zeroStar && isStar(b)) return [b[0], b[1], 0, 0, 0, 0, 0, 0];
    switch (b[0]) {
      case 0x8f:
        // rx1k：issue #11 的 G24（PAW3395、1K 接收器）
        return rx1k ? [0x8f, 1, model, 1, 0, 0xf0, 0, 0] : [0x8f, 1, model, 2, 0xf0, 0xf1, 0, 0];
      case 0x8e:
        return [0x8e, b[1], 0xc8, 0xd3, 0x2f, 0x63, b[1] === 1 ? online : 0, 0];
      case 0x89:
        // 1K 接收器用最近一个状态包回答：[89, 电量, 1, 回报率, 状态包 d2, 0, 链路, 5A]（issue #11 原文）
        return rx1k ? [0x89, 3, 1, 3, 8, 0, 1, 0x5a] : [0x89, 0, 0, 0, 0, 0, 0, 0x5a];
      case 0x83:
        return [0x83, stages, stages > 2 ? 2 : 0, 0, 0, 0, 0, 0];
      case 0x88:
        // 1K 接收器不认识 0x88：回上一条的残留
        return rx1k ? prev : [0x88, 0, 0, 0, 0, 0, 0, 0];
      case 0x82:
        return [0x82, b[1], [7, 15, 31, 47, 63, 127][b[1]], 0, 0, 0, 0, 0];
      case 0x84:
        return [0x84, b[1], [0, 0, 0, 0, 1, 1][b[1]], 0, 0, 0, 0, 0];
      case 0x85:
        // 不认识的子序号（例如 [0x85,6]）：和旧固件经接收器时一样，回显子序号，其余是上一条回包的残留
        if (b[1] < 1 || b[1] > 3) return [0x85, b[1], ...prev.slice(2)];
        return [[0x85, 1, 8, 0], [0x85, 2, 3, 10, 0], [0x85, 3, 60, 0]][b[1] - 1].concat([0, 0, 0, 0]).slice(0, 8);
      case 0x86: {
        const c = b[1] === 9 ? 0 : keys[b[1]] || 0;
        return [0x86, b[1], c & 255, (c >> 8) & 255, (c >> 16) & 255, c >>> 24, 0, 0];
      }
      default:
        return [b[0], b[1], 0, 0, 0, 0, 0, 0];
    }
  };
  const listeners = new Set();
  return {
    sent,
    listeners,
    opened: false,
    vendorId: C.VENDOR_ID,
    productId: C.PID_WIRELESS,
    productName: 'incott 8K wireless mouse',
    collections: [{ usagePage: 0xff05, usage: 1, type: 1, inputReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 32 }] }], outputReports: [], featureReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 8 }] }] }],
    async open() {
      this.opened = true;
    },
    async close() {
      this.opened = false;
    },
    async sendFeatureReport(_id, b) {
      sent.push([...b]);
    },
    async receiveFeatureReport(id) {
      return new DataView(new Uint8Array([id, ...reply(sent.at(-1))]).buffer);
    },
    addEventListener(_t, fn) {
      listeners.add(fn);
    },
    removeEventListener(_t, fn) {
      listeners.delete(fn);
    },
  };
}

const STATUS = [0x3c, 0x20, 0x48, 0x00, 0x1f, 0x1f, 0x01, 0x00]; // 实测 G23V2 状态包前 8 字节
const statusEvent = (hid, reportId = 9) => ({ device: hid, reportId, data: new DataView(new Uint8Array(STATUS).buffer) });

test('诊断查询全部是 0x80–0x8F 的读命令', () => {
  for (const q of DIAG_QUERIES) assert.ok(q.cmd[0] >= 0x80 && q.cmd[0] <= 0x8f, q.label);
});

test('已连接：汇总里有型号码、PID、连接时 143/142/137 原文、状态包数量与最近几包，且只发读命令', async () => {
  const hid = fakeHid();
  granted = [hid];
  const dev = new IncottDevice(hid);
  await dev.open();
  for (let i = 0; i < 3; i++) dev._onInput(statusEvent(hid));
  dev._onInput(statusEvent(hid, 1));
  const list = new StProfileList();
  for (let i = 0; i < 4; i++) list.add(new StProfile(`板载配置${i + 1}`, C.dvar, C.SENSOR_3950));
  store.state.profiles = list;
  store.state.curIndex = 0;
  store.state.device = markRaw(dev);
  store.state.info.is8K = true;
  store.state.phase = 'ready';
  logEvent('test event');

  const before = hid.sent.length;
  const text = await collectDiagnostics();
  const diagSent = hid.sent.slice(before);
  assert.equal(diagSent.length, DIAG_QUERIES.length);
  assert.ok(diagSent.every((b) => b[0] >= 0x80), '只允许读命令');

  // 汇总
  assert.match(text, /model code {5}14 → G23V2/);
  assert.match(text, /vid:pid {8}093a:522c \(2\.4G receiver\)/);
  assert.match(text, /receiver {7}r3=02 r4=F0 → 8K receiver/);
  assert.match(text, /sensor byte {4}F1 → PAW3950/);
  assert.match(text, /143 \(8F\) +\+ *\d+ms {2}09 8F 01 0E 02 F0 F1 00 00/);
  assert.match(text, /142 \(8E 01\) +\+ *\d+ms {2}09 8E 01 C8 D3 2F 63 01 00/);
  assert.match(text, /137 \(89\) +\+ *\d+ms {2}09 89 00 00 00 00 00 00 5A/);
  assert.match(text, /134 \(86 09\) +\+ *\d+ms {2}09 86 09 00 00 00 00 00 00/);
  assert.match(text, /input reports {2}4 total \(id1:1 id9:3\)/);
  assert.match(text, /last input reports:\n {2}\+ *\d+ms in#9 {2}3C 20 48 00 1F 1F 01 00/);
  // 解码与对照
  assert.match(text, /\*packed: pwr=60% chg=0 rate=1000Hz dpi#=2 profile=1 deb=8 x\/y=31\/31 lod=0 motion=1 \| old: chg=60 bat=32% dpi#=72 rate=1000Hz/);
  assert.match(text, /✓ dpi #6 x \* +device 6400 +profile 6400/);
  assert.match(text, /✓ debounce \* +device 8 +profile 8/);
  assert.match(text, /≠ dpi current +device 2 +profile 1/);
  assert.match(text, /✓ key 4 \(m4\) +device 0xf40001 +profile 0xf40001/);
  assert.match(text, /= psd=1 model=14→G23V2 r3=02\(8K\)/);
  assert.match(text, /= 0x00f40001 前进/);
  // 其它
  assert.match(text, /test event/);
  assert.match(text, /\[4\] magic:incott_magic102;name:板载配置4/);
  // 自动判断：在线、有状态包；配置里没有火力键时火力键参数不算不一致
  assert.match(text, /### 自动判断\n- · 连接 \d+ 秒内收到 3 个状态包/);
  assert.doesNotMatch(text, /不在线/);
  assert.match(text, /⚠ 鼠标里的值与当前配置不一致：dpi current\n/);
  assert.match(text, /· fire \(global\) \* +device 3x\/10ms +profile -/);
  assert.match(text, /ff05:0001 type=1 in\[9:32B\] out\[\] feat\[9:8B\]/);
  assert.match(text, /### Recent transfers \(raw\)/);

  store.state.device = null;
  store.state.phase = 'welcome';
  granted = [];
});

test('未连接：临时打开设备探测，用完关闭', async () => {
  const hid = fakeHid({ model: 7 });
  granted = [hid];
  const text = await collectDiagnostics();
  granted = [];
  assert.equal(hid.opened, false, '探测后应关闭设备');
  assert.equal(hid.listeners.size, 0);
  assert.ok(hid.sent.every((b) => b[0] >= 0x80));
  assert.match(text, /### Probe 093a:522c "incott 8K wireless mouse" \(not connected\)/);
  assert.match(text, /model code {5}7 → UNSUPPORTED/);
  assert.match(text, /143 \(8F\) .*09 8F 01 07 02 F0 F1 00 00/);
});

test('连接失败（型号码不认识）：失败现场带型号码与 143 原文', async () => {
  const hid = fakeHid({ model: 7 });
  granted = [];
  const dev = new IncottDevice(hid);
  await assert.rejects(dev.open(), /UNSUPPORTED_DEVICE/);
  store.diag.lastFailure = {
    time: 'T',
    productId: hid.productId,
    productName: hid.productName,
    error: 'UNSUPPORTED_DEVICE',
    modelCode: dev.modelCode,
    replies: { ...dev.replies },
    inputCount: dev.inputCount,
    inputById: { ...dev.inputById },
    xferLog: dev.xferLog.slice(),
    inputLog: dev.inputLog.slice(),
  };
  const text = await collectDiagnostics();
  assert.match(text, /### Last connect failure \(T\)/);
  assert.match(text, /error UNSUPPORTED_DEVICE/);
  assert.match(text, /model code {5}7 → UNSUPPORTED/);
  assert.match(text, /143 \(8F\) +\+ *\d+ms {2}09 8F 01 07 02 F0 F1 00 00/);
  store.diag.lastFailure = null;
});

test('issue #10 场景：额外按键槽位、写入是否生效、按键导致的回报率变化都能从诊断信息里看出来', async () => {
  // 假设：按键 6 已被改成配置切换（写进了槽位 5），而滚轮后方的回报率键其实在槽位 6
  const hid = fakeHid({ model: 2, keys: { 5: 61706, 6: 0x05040007 } });
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  assert.equal(store.state.phase, 'ready');
  // 「配置切换」已不再支持：连接时恢复成该键默认功能并写入鼠标（这个假设备不会因写入而改变读到的值）
  while (store.state.pending) await new Promise((r) => setImmediate(r));
  assert.ok(hid.sent.some((b) => b[0] === 6 && b[1] === 5 && b[2] === 7 && b[4] === 3), '写入了 DPI 循环');
  const status = (rateIx) => ({ device: hid, reportId: 9, data: new DataView(new Uint8Array([0x50, 0x20 | rateIx, 0, 0, 0, 0, 0, 0]).buffer) });
  for (const fn of hid.listeners) {
    fn(status(0));
    fn(status(6)); // 用户按了一下滚轮后方的键：1000 → 2000 Hz
  }
  const text = await collectDiagnostics();
  assert.match(text, /status first: rate=1000/);
  assert.match(text, /status: rate 1000→2000/);
  assert.match(text, /86 06 00 00 00 00 00 00 → 09 86 06 07 00 04 05 .*= 0x05040007 unknown: type=07 b1=00 b2=04 b3=05/);
  assert.match(text, /• extra slot m6 +device 0x5040007 +unknown: type=07/);
  // 槽位 5 里读到的仍是"配置切换"，和配置（已恢复为 DPI 循环）不一致：写入没有生效时诊断里看得出
  assert.match(text, /≠ key 6 \(m5\) +device 0xf10a +profile 0x30007/);
  assert.match(text, /86 05 00 00 00 00 00 00 → 09 86 05 0A F1 00 00 00 00 .*= 0x0000f10a 配置切换/);
  await store.disconnect('test');
  granted = [];
});

/** 连上一个假设备（经过 store 的完整连接流程） */
async function connectFake(opts) {
  const hid = fakeHid(opts);
  granted = [hid];
  store.state.phase = 'welcome';
  await store.autoConnect();
  assert.equal(store.state.phase, 'ready');
  return hid;
}

async function cleanup() {
  await store.disconnect('test');
  store.diag.lastFailure = null;
  granted = [];
}

test('鼠标正忙（写入卡住）：不发送任何命令，只导出现有记录', async () => {
  const hid = await connectFake();
  const before = hid.sent.length;
  const text = await collectDiagnostics({ busy: 'writing to the mouse (applying=true, pending=1)' });
  assert.equal(hid.sent.length, before, '忙时不能发命令');
  assert.match(text, /- busy: writing to the mouse/);
  assert.match(text, /⚠ 鼠标正忙（writing to the mouse/);
  assert.match(text, /### Summary \(connected, busy\)/);
  assert.doesNotMatch(text, /### Raw queries/);
  assert.match(text, /### Recent transfers \(raw\)/);
  await cleanup();
});

test('连接卡住：导出正在进行的连接现场，不另外打开设备', async () => {
  const hid = fakeHid();
  granted = [hid];
  const dev = new IncottDevice(hid);
  await dev.readDps();
  dev._hidError('receiveFeatureReport (cmd 142)', new Error('receiveFeatureReport timeout 3000ms'));
  store.diag.connecting = { dev, since: Date.now() - 12000 };
  store.state.phase = 'connecting';
  const before = hid.sent.length;
  const text = await collectDiagnostics({ busy: 'connecting for 12 s' });
  store.diag.connecting = null;
  store.state.phase = 'welcome';
  granted = [];
  assert.equal(hid.sent.length, before);
  assert.match(text, /### Connecting 093a:522c "incott 8K wireless mouse" \(in progress for 12 s\)/);
  assert.match(text, /model code {5}14 → G23V2/);
  assert.match(text, /### HID errors \/ timeouts\n```text\n\[connecting device\]\n.*receiveFeatureReport \(cmd 142\): receiveFeatureReport timeout 3000ms/);
  assert.match(text, /⚠ HID 读写错误 \/ 超时 1 次/);
  assert.match(text, /### Connecting: transfers so far/);
});

test('宏只导出结构，不含录制的按键内容；配置里引用了已删除的宏会指出来', async () => {
  await connectFake();
  const m = new STMacro('my login');
  m.uid = 4242;
  for (const k of ['P', 'A', 'S', 'S']) m.item.push(new STMacroItem(k, 10, true), new STMacroItem(k, 20, false));
  m.item.push(new STMacroItem('Q', 5, true)); // 没有抬起
  store.state.macros.list.push(m);
  const pf = store.state.profiles.list[0];
  pf.key[3] = new C.KeyInfo(C.fJuji, 0);
  pf.key[3].itemdata = 4242;
  pf.key[4] = new C.KeyInfo(C.fJuji, 0);
  pf.key[4].itemdata = 999; // 宏库里没有
  const text = await collectDiagnostics();
  assert.doesNotMatch(text, /item\[/);
  assert.doesNotMatch(text, /my login/);
  assert.match(text, /#1 uid=4242 actions=9\/71 unbalanced=1 total-delay=125ms loop=cycle×1 bound=P1-B4 hw=ok/);
  assert.match(text, /⚠ 配置里绑定的宏已不在宏库中：P1-B5 uid=999/);
  store.state.macros.list.splice(0);
  await cleanup();
});

test('诊断信息总长度不超过上限，超出时从最早的记录截掉', async () => {
  await connectFake();
  const ev = events.length;
  const co = consoleLog.length;
  for (let i = 0; i < 200; i++) logEvent(`filler event ${i} ${'x'.repeat(380)}`);
  for (let i = 0; i < 80; i++) consoleLog.push({ t: i, level: 'error', msg: 'e'.repeat(500) });
  const text = await collectDiagnostics();
  events.splice(ev);
  consoleLog.splice(co);
  assert.ok(text.length <= 60000, `length ${text.length}`);
  assert.match(text, /older lines omitted/);
  assert.match(text, /filler event 199/, '最新的记录要保留');
  assert.match(text, /### Recent transfers \(raw\)/);
  await cleanup();
});

test('固件不支持 * 命令（全 0 回包）：对照表里这些项目标为 ?，不算不一致', async () => {
  await connectFake({ zeroStar: true });
  store.state.firstRun = false;
  const text = await collectDiagnostics();
  assert.match(text, /note: every \* command replied all zeros/);
  assert.match(text, /\? debounce \* +device 0 +profile 8/);
  assert.match(text, /\? rate \* +device 1000Hz/);
  assert.match(text, /· 固件对官方桌面驱动专用的读命令（标 \*）只回了全 0/);
  assert.doesNotMatch(text, /不一致：.*debounce/);
  assert.doesNotMatch(text, /固件版本/);
  await cleanup();
});

test('issue #6 / #11 场景：接收器报告鼠标不在线、连接后一直没有状态包', async () => {
  await connectFake({ online: 0 });
  store.state.device.connectedAt -= 30000;
  const text = await collectDiagnostics();
  assert.match(text, /mouse online {3}8E01 r6=0 → NOT ONLINE\?/);
  assert.match(text, /⚠ 接收器报告鼠标不在线/);
  assert.match(text, /⚠ 连接 30 秒内没有收到状态包/);
  await cleanup();
});

test('issue #11：1K 接收器连接、配置只有 1 档 DPI——不读 0x88，没用到的档不算不一致，电量已知时不报"同步中"', async () => {
  const hid = fakeHid({ model: 3, rx1k: true, stages: 1 });
  granted = [hid];
  const dev = new IncottDevice(hid);
  await dev.open();
  assert.equal(dev.power, 3);
  assert.equal(dev.is8KReceiver, false);
  const before = hid.sent.length;
  const m = await dev.readSlot(6);
  assert.ok(!hid.sent.slice(before).some((b) => b[0] === 0x88), '1K 接收器上不读接收器灯效');
  assert.equal(m.receiverLED, null);
  assert.deepEqual(m.dpi, [7, 15, 31, 47, 63, 127]); // 硬件值：(v + 1) × 50

  const list = new StProfileList();
  for (let i = 0; i < 4; i++) list.add(new StProfile(`板载配置${i + 1}`, C.dvar, C.SENSOR_3395));
  const pf = list.list[0];
  pf.dpi = [400];
  pf.dpiy = [400];
  pf.curDpi = 0;
  store.state.profiles = list;
  store.state.curIndex = 0;
  store.state.device = markRaw(dev);
  store.state.info.power = dev.power;
  store.state.firstRun = false;
  store.state.phase = 'ready';
  dev.connectedAt = Date.now() - 18000;

  const text = await collectDiagnostics();
  assert.match(text, /✓ dpi stages +device 1 +profile 1/);
  assert.match(text, /✓ dpi #1 x \* +device 400 +profile 400/);
  assert.match(text, /· dpi #2 x \* +device 800 +profile -/);
  assert.match(text, /· dpi #6 x \* +device 6400 +profile -/);
  assert.doesNotMatch(text, /不一致：.*dpi #/);
  assert.doesNotMatch(text, /[✓≠?·] receiver LED/); // 对照表只在 8K 时比较灯效（原始查询里照样探测 0x88）
  assert.match(text, /· 连接 18 秒内还没有收到状态包/);
  assert.doesNotMatch(text, /电量同步中/);

  store.state.device = null;
  store.state.info.power = -1;
  store.state.phase = 'welcome';
  granted = [];
});

test('8K 接收器照常读 0x88', async () => {
  const hid = fakeHid();
  const dev = new IncottDevice(hid);
  await dev.open();
  assert.equal(dev.is8KReceiver, true);
  const before = hid.sent.length;
  await dev.readSlot(6);
  assert.ok(hid.sent.slice(before).some((b) => b[0] === 0x88));
});

test('自动判断：没有状态包时按电量是否已知、等了多久分别处理', () => {
  const tr = t.value;
  const f = (c) => buildFindings({ connected: true, statusCount: 0, prevLog: { cleanExit: true }, ...c }, tr)[0];
  assert.match(f({ sinceConnect: 5, powerKnown: false }), /^· 连接 5 秒内收到 0 个状态包/);
  assert.match(f({ sinceConnect: 18, powerKnown: false }), /^⚠ 连接 18 秒内没有收到状态包.*电量同步中/);
  assert.match(f({ sinceConnect: 18, powerKnown: true }), /^· 连接 18 秒内还没有收到状态包/);
  assert.match(f({ sinceConnect: 130, powerKnown: true }), /^⚠ 连接 130 秒内没有收到状态包：电量只来自连接时的读取/);
  assert.doesNotMatch(f({ sinceConnect: 130, powerKnown: true }), /电量同步中/);
});

test('自动判断：找不到设备、PID 不认识、没有响应、Linux 权限', () => {
  const tr = t.value;
  let f = buildFindings({ noIncott: true, sysHid: { devices: [{ vendorId: 0x046d, productId: 0xc52b }] } }, tr);
  assert.match(f.join('\n'), /软件没有看到任何 INCOTT 设备/);
  assert.match(f.join('\n'), /系统识别到 1 个 HID 设备，但没有 Pixart（093A）设备/);
  f = buildFindings({ noIncott: true, sysHid: { devices: [{ vendorId: 0x093a, productId: 0x5a2c, name: 'incott 8K' }] } }, tr);
  assert.match(f.join('\n'), /PID 不是已知的.*093a:5a2c "incott 8K"/);
  f = buildFindings({ lastFailure: { error: 'NO_RESPONSE' }, linuxDenied: ['/dev/hidraw3'] }, tr);
  assert.match(f.join('\n'), /⚠ 接收器 \/ 鼠标对识别命令（8F）没有任何回应/);
  assert.match(f.join('\n'), /⚠ 没有 \/dev\/hidraw3 的读写权限/);
  f = buildFindings({ lastFailure: { error: 'UNSUPPORTED_DEVICE', modelCode: 7 } }, tr);
  assert.match(f.join('\n'), /型号码 7 不在支持列表中/);
  f = buildFindings({ connected: true, statusCount: 12, sinceConnect: 40, prevLog: { cleanExit: true } }, tr);
  assert.deepEqual(f, ['· 连接 40 秒内收到 12 个状态包', '· 没有发现明显异常']);
});
