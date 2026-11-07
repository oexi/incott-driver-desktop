// 模拟设备：仅用于在普通浏览器里预览/调试界面（地址加 ?mock）和自动化测试，不会出现在正式连接流程中。
// fw: 'slots'（默认）—— 与固件 1.4.0.3 一致（IDA 分析）：4 个硬件槽位各存回报率 / DPI / 传感器 / 消抖 / 火力键 /
//   休眠 / 按键；[5,6,N] 切换槽位并发一个状态包，[0x85,6] 读当前槽位（无线时回包 [0x85,6,槽位]），[0x85,7] 回显 7；
//   「配置切换」键（61706）写进或换掉时 4 个槽位一起改。接收器灯效存在接收器里。
// fw: 'legacy' —— 与实测的旧固件 G23V2 一致：槽位只能用鼠标上的「配置切换」键换，按键与接收器灯效共用，
//   [6,9,x] 只是记一个编号；不认识 [0x85,6] / [0x85,7]：有线回 0，无线回显子序号，后面是上一条回包留下的字节。
// 状态包第 3 字节高 2 位为当前槽位。

import { PID_WIRELESS, VENDOR_ID, RATE_HW } from './constants.js';

const SWITCH = 61706;
const DEFAULT_KEYS = [0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007];

function defaultSlot() {
  return { rateIx: 0, levels: 6, dpiIx: 1, dpi: [7, 15, 31, 47, 63, 127], sensor: [0, 0, 0, 1, 1], debounce: 8, fire: [3, 10], sleep: 60, keys: DEFAULT_KEYS.slice() };
}

export class MockHidDevice extends EventTarget {
  constructor({ fw = 'slots' } = {}) {
    super();
    this.fw = fw;
    this.vendorId = VENDOR_ID;
    this.productId = PID_WIRELESS;
    this.productName = 'incott 8K wireless mouse (mock)';
    this.collections = [{ usagePage: 0xff05, usage: 1 }];
    this.opened = false;
    this.last = null;
    this.prev = new Array(8).fill(0); // 上一条回包（去掉 Report ID）：旧固件无线时的残留
    this.slots = [defaultSlot(), defaultSlot(), defaultSlot(), defaultSlot()];
    // legacy 固件的按键共用，存在 state.keys
    this.state = { power: 80, charging: false, slot: 0, mark: 0, led: 0, keys: DEFAULT_KEYS.slice() };
    this.timer = null;
  }
  get cur() {
    return this.slots[this.state.slot];
  }
  get wireless() {
    return this.productId === PID_WIRELESS;
  }
  /** 当前生效的按键表 */
  keys() {
    return this.fw === 'legacy' ? this.state.keys : this.cur.keys;
  }
  async open() {
    this.opened = true;
    this.timer = setInterval(() => this.emitStatus(), 4000);
    setTimeout(() => this.emitStatus(), 600);
  }
  async close() {
    this.opened = false;
    clearInterval(this.timer);
  }
  /** 模拟按下鼠标上的「配置切换」键（直接切到指定槽位） */
  setSlot(i) {
    this.state.slot = i & 3;
    this.emitStatus();
  }
  emitStatus() {
    const s = this.state;
    const c = this.cur;
    // 紧凑布局（固件 sub_1000E410）：d3–d5 当前档的 X / Y 硬件值，d6 = LOD << 4 | Motion Sync
    const x = c.dpi[c.dpiIx] ?? 0;
    const bytes = [(s.charging ? 128 : 0) | s.power, (c.dpiIx << 4) | c.rateIx, (c.debounce & 63) | (s.slot << 6), ((x >> 8) & 15) | (((x >> 8) & 15) << 4), x & 255, x & 255, (c.sensor[0] << 4) | c.sensor[3], 0];
    const data = new DataView(new Uint8Array(bytes).buffer);
    const ev = new Event('inputreport');
    ev.device = this;
    ev.reportId = 9;
    ev.data = data;
    this.dispatchEvent(ev);
  }
  async sendFeatureReport(_id, data) {
    await new Promise((r) => setTimeout(r, 4));
    const b = Array.from(data);
    this.last = b;
    const s = this.state;
    const c = this.cur;
    switch (b[0]) {
      case 1:
        c.rateIx = b[1];
        break;
      case 2:
        if (b[7] !== 2) c.dpi[b[1]] = b[2] | (b[3] << 8);
        break;
      case 3:
        c.levels = b[1];
        c.dpiIx = b[2];
        break;
      case 4:
        if (b[1] >= 1 && b[1] <= 5) c.sensor[b[1] - 1] = b[2];
        break;
      case 5:
        if (b[1] === 1) c.debounce = b[2];
        if (b[1] === 2) c.fire = [b[2], b[3]];
        if (b[1] === 3) c.sleep = b[2] | (b[3] << 8);
        // 固件 1.4.x：切到别的槽位时重新载入并发状态包；已经在这个槽位时什么也不做
        if (b[1] === 6 && this.fw !== 'legacy' && b[2] < 4 && b[2] !== s.slot) this.setSlot(b[2]);
        break;
      case 6: {
        if (b[1] === 9) {
          s.mark = b[2];
          break;
        }
        if (b[1] >= 6) break;
        const code = (b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24)) >>> 0;
        if (this.fw === 'legacy') s.keys[b[1]] = code;
        else if (code === SWITCH || c.keys[b[1]] === SWITCH) for (const sl of this.slots) sl.keys[b[1]] = code;
        else c.keys[b[1]] = code;
        break;
      }
      case 8:
        s.led = b[1];
        break;
      default:
    }
  }
  async sendReport() {
    await new Promise((r) => setTimeout(r, 2));
  }
  async receiveFeatureReport(id) {
    const cmd = this.last ? this.last[0] : 0;
    const sub = this.last ? this.last[1] : 0;
    const s = this.state;
    const c = this.cur;
    const r = new Array(9).fill(0);
    r[0] = id;
    r[1] = cmd;
    switch (cmd) {
      case 143:
        r[2] = 1; // psd
        r[3] = 2; // G23
        r[4] = 2; // 8K 接收器
        r[6] = 241; // 无线：传感器在 data[5]
        break;
      case 142:
        r[7] = 1;
        break;
      case 137:
        // 与实测 G23V2 / 官方桌面驱动一致：data[1] 电量、data[3] 回报率、data[4] 当前档、data[7] = 0x5A
        r[2] = s.power;
        r[3] = s.charging ? 1 : 0;
        r[4] = c.rateIx;
        r[5] = c.dpiIx;
        r[8] = 0x5a;
        break;
      case 0x81:
        r[2] = c.rateIx;
        break;
      case 0x82:
        r[2] = sub;
        r[3] = c.dpi[sub] & 255;
        r[4] = c.dpi[sub] >> 8;
        break;
      case 131:
        r[2] = c.levels;
        r[3] = c.dpiIx;
        break;
      case 0x84:
        r[2] = sub;
        r[3] = c.sensor[sub - 1] ?? 0;
        break;
      case 0x85:
        r[2] = sub;
        if (sub === 1) r[3] = c.debounce;
        else if (sub === 2) [r[3], r[4]] = c.fire;
        else if (sub === 3) [r[3], r[4]] = [c.sleep & 255, c.sleep >> 8];
        else if (this.fw === 'legacy') {
          // 不认识的子序号：有线回 0；无线回显子序号，其余是上一条回包的残留
          if (this.wireless) for (let i = 3; i < 9; i++) r[i] = this.prev[i - 1];
          else r[2] = 0;
        } else if (sub === 6) {
          if (this.wireless) r[3] = s.slot;
          else r[2] = s.slot;
        }
        break;
      case 134: {
        const code = sub === 9 ? s.mark : this.keys()[sub] || 0;
        r[2] = sub;
        r[3] = code & 255;
        r[4] = (code >> 8) & 255;
        r[5] = (code >> 16) & 255;
        r[6] = (code >>> 24) & 255;
        break;
      }
      case 0x88:
        r[2] = s.led;
        break;
      default:
    }
    this.prev = r.slice(1);
    return new DataView(new Uint8Array(r).buffer);
  }
}

export const mockRateLabel = (ix) => RATE_HW[ix];
