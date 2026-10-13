// 协议常量——全部移植自原版网页驱动（define-v100.js / public-v106.js / gvarG23-v102.js / chunk-v1013.js）。

export const VENDOR_ID = 0x093a;
export const PID_WIRED = 0x622c; // 25132
export const PID_WIRELESS = 0x522c; // 21036
export const USAGE_PAGE = 0xff05;
export const USAGE = 0x01;
export const REPORT_ID = 9;

export const HID_FILTERS = [
  { vendorId: VENDOR_ID, productId: PID_WIRED, usagePage: USAGE_PAGE, usage: USAGE },
  { vendorId: VENDOR_ID, productId: PID_WIRELESS, usagePage: USAGE_PAGE, usage: USAGE },
];

// 按键功能大类
export const fMouse = 1;
export const fKeyboard = 2;
export const fMedia = 3;
export const fJuji = 4; // 宏
export const fAdv = 5;
export const fCmd = 6;

// 鼠标功能
export const fmsCLICK = 1;
export const fmsMENU = 2;
export const fmsMIDDLE = 3;
export const fmsFORWARD = 4;
export const fmsBACK = 5;
export const fmsDBCLICK = 6;
export const fmsSU = 8;
export const fmsSD = 9;
export const fmsTL = 10;
export const fmsTR = 11;
export const favDPI = 12;
export const favDPIINC = 13;
export const favDPIDEC = 14;
export const favOFF = 15;
export const favSNIPE = 16;
export const favFIRE = 17;
export const favProfile = 18;

// 多媒体
export const fmePLAYER = 1;
export const fmePLAYPAUSE = 2;
export const fmeSTOP = 3;
export const fmePREVIOUS = 4;
export const fmeNEXT = 5;
export const fmeVOLINC = 6;
export const fmeVOLDEC = 7;
export const fmeMUTE = 8;
export const fmeEMAIL = 9;
export const fmeCAL = 10;
export const fmeEXPLORER = 11;
export const fmeHOME = 12;
export const fmeFAVOR = 13;
export const fmeREFRESH = 14;
export const fmeFORWARD = 15;
export const fmeBACK = 16;
export const fmeSEARCH = 17;

// 修饰键
export const mdfCtrlL = 1;
export const mdfShiftL = 2;
export const mdfAltL = 4;
export const mdfWinL = 8;
export const mdfCtrlR = 16;
export const mdfShiftR = 32;
export const mdfAltR = 64;
export const mdfWinR = 128;

// 写入标志（ChunkParam.flag）
export const apKey = 2;
export const apDpi = 4;
export const apLed = 8;
export const apRate = 16;
export const apLod = 32;
export const apSensor = 64;
export const apSensorMode = 128;
export const apDpiLevel = 256;
export const apOnboardIndex = 512;
export const apReceiverLED = 1024;
export const apDebounce = 2048;
export const apSleepTime = 4096;
export const apALL = 65535;
export const apReset = 0x10000;
export const apProSw = 0x20000;

// 回报率：硬件编码顺序
export const RATE_HW = [1000, 500, 250, 125, 8000, 4000, 2000];
// 界面显示顺序
export const RATE_UI = [125, 250, 500, 1000, 2000, 4000, 8000];
export const RATE_8K_ONLY = [2000, 4000, 8000];

// 休眠时间（秒）
export const DORMANCY_TIME = [10, 20, 30, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900];

export const DEBOUNCE_MIN = 0;
export const DEBOUNCE_MAX = 30;

export const SENSOR_3395 = 0x3395; // 13205
export const SENSOR_3950 = 0x3950; // 14672

export const MAX_ONBOARD = 4;

export class KeyInfo {
  constructor(major, minor) {
    this.major = major;
    this.minor = minor;
    this.modifer = 0;
    this.macro = 0;
    this.itemdata = 0;
    this.matrix = -1;
    this.hide = false;
  }
  copy() {
    const o = new KeyInfo(this.major, this.minor);
    o.modifer = this.modifer;
    o.macro = this.macro;
    o.itemdata = this.itemdata;
    o.matrix = this.matrix;
    return o;
  }
  toText() {
    return `${this.major},${this.minor},${this.modifer},${this.macro},${this.itemdata}`;
  }
  equals(k) {
    return !!k && k.major === this.major && k.minor === this.minor && k.modifer === this.modifer && k.itemdata === this.itemdata;
  }
}

function rgb(r, g, b) {
  // 与原版 rgb() 相同的打包方式：0xBBGGRR（配置文件里保存的就是这个数值）
  return ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
}

function buildDpiTable(max) {
  const ui = [];
  const hw = [];
  for (let val = 50, h = 0; val <= max; val += 50, h++) {
    ui.push(val);
    hw.push(h);
  }
  return { ui, hw };
}

const DEFAULT_DPI_COLORS = [rgb(255, 0, 0), rgb(0, 0, 255), rgb(0, 255, 0), rgb(255, 255, 0), rgb(0, 255, 255), rgb(255, 0, 255)];

function makeSensor(sensor, max) {
  const t = buildDpiTable(max);
  return {
    sensor,
    defDPIInx: 1,
    dpicolor: DEFAULT_DPI_COLORS.slice(),
    dpi: [400, 800, 1600, 2400, 3200, 6400],
    dpiUI: t.ui,
    dpiHW: t.hw,
    min: t.ui[0],
    max: t.ui[t.ui.length - 1],
  };
}

/** 设备配置（对应原版 dvar / initgvarG23） */
export function createDevCfg() {
  const key = [
    new KeyInfo(fMouse, fmsCLICK),
    new KeyInfo(fMouse, fmsMENU),
    new KeyInfo(fMouse, fmsMIDDLE),
    new KeyInfo(fMouse, fmsFORWARD),
    new KeyInfo(fMouse, fmsBACK),
    new KeyInfo(fMouse, favDPI),
  ];
  // 硬件按键矩阵位置：注意前进/后退在硬件上是反的
  [0, 1, 2, 4, 3, 5].forEach((m, i) => (key[i].matrix = m));
  return {
    key,
    lodUI: [0.7, 1, 2],
    lodHW: [0, 1, 2],
    stDPI: [makeSensor(SENSOR_3395, 32000), makeSensor(SENSOR_3950, 45000)],
  };
}

export const dvar = createDevCfg();

export function getStDPI(sensor) {
  return dvar.stDPI.find((s) => s.sensor === sensor) || null;
}

export function getHwForDpi(dpi, sensor) {
  const s = getStDPI(sensor);
  if (!s) return -1;
  const i = s.dpiUI.indexOf(dpi);
  return i < 0 ? -1 : s.dpiHW[i];
}

export function closestDpi(sensor, value) {
  const s = getStDPI(sensor);
  if (!s) return value;
  let best = s.dpiUI[0];
  let diff = Math.abs(best - value);
  for (const v of s.dpiUI) {
    const d = Math.abs(v - value);
    if (d < diff) {
      diff = d;
      best = v;
    }
  }
  return best;
}

export function colorToCss(c) {
  const hex = (v) => (v & 255).toString(16).padStart(2, '0');
  return '#' + hex(c) + hex(c >> 8) + hex(c >> 16);
}

/** 根据设备型号返回可选 LOD 选项：value 为配置文件中保存的 lod 值 */
export function lodOptions(sensor) {
  if (sensor === SENSOR_3950) {
    return [
      { value: 0, label: '0.7 mm' },
      { value: 1, label: '1 mm' },
      { value: 2, label: '2 mm' },
    ];
  }
  return [
    { value: 1, label: '1 mm' },
    { value: 2, label: '2 mm' },
  ];
}
