// 模拟设备：仅用于在普通浏览器里预览/调试界面（地址加 ?mock），不会出现在正式连接流程中。

import { PID_WIRELESS, VENDOR_ID, RATE_HW } from './constants.js';

export class MockHidDevice extends EventTarget {
  constructor() {
    super();
    this.vendorId = VENDOR_ID;
    this.productId = PID_WIRELESS;
    this.productName = 'incott 8K wireless mouse (mock)';
    this.collections = [{ usagePage: 0xff05, usage: 1 }];
    this.opened = false;
    this.last = null;
    this.state = { power: 80, charging: false, rateIx: 0, dpiIx: 1, levels: 6, profile: 0, lod: 1 };
    this.timer = null;
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
  emitStatus() {
    const s = this.state;
    // 与实测 G23V2 一致：状态包第 3 字节恒为 8，不含板载序号
    const data = new DataView(new Uint8Array([(s.charging ? 128 : 0) | s.power, (s.dpiIx << 4) | s.rateIx, 8, 0, 0, 0, 0, 0]).buffer);
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
    if (b[0] === 1) s.rateIx = b[1];
    if (b[0] === 3) {
      s.levels = b[1];
      s.dpiIx = b[2];
    }
    if (b[0] === 6 && b[1] === 9) s.profile = b[2];
    if (b[0] === 4 && b[1] === 1) s.lod = b[2];
  }
  async sendReport() {
    await new Promise((r) => setTimeout(r, 2));
  }
  async receiveFeatureReport(id) {
    const cmd = this.last ? this.last[0] : 0;
    const s = this.state;
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
        r[4] = s.rateIx; // 实测回报率在 data[3]
        r[7] = s.lod << 4;
        break;
      case 131:
        r[2] = s.levels;
        r[3] = s.dpiIx;
        break;
      case 134: {
        // 按键码（按矩阵位置）：左/右/中/后退/前进/DPI 循环
        const codes = [0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007];
        const ix = this.last[1];
        const code = ix === 9 ? s.profile : codes[ix] || 0;
        r[2] = ix;
        r[3] = code & 255;
        r[4] = (code >> 8) & 255;
        r[5] = (code >> 16) & 255;
        r[6] = (code >>> 24) & 255;
        break;
      }
      case 133:
        r[3] = 0x40;
        break;
      default:
    }
    return new DataView(new Uint8Array(r).buffer);
  }
}

export const mockRateLabel = (ix) => RATE_HW[ix];
