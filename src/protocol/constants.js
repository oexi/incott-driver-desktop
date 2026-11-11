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

/**
 * 传感器模式字节（[4,5,x] / 0x84 子序号 5）的最高位：官方新版桌面驱动的「高帧率」，只在 PAW3950 的电竞模式下提供。
 * 固件 1.4.0.3 的 PAW3950 驱动（IDA：G23 镜像 sub_1000F54C）在电竞模式下，DPI ≥ 7000 或这一位为 1 时用原相「高 DPI」那套参数：
 * 寄存器 0x0653 = 0x02（约 20000 fps）、慢速降档 DPI 7500；否则 0x0653 = 0x03（约 12000 fps）、降档 DPI 4000。
 * 帧率数值来自第三方实测（xbabtech-site.pages.dev/blog/downshift），固件和公开资料里没有。
 * 支持的鼠标（store.hiFpsSupported）按配置写；不支持时比较只看低 7 位，写入时保留鼠标里原来的最高位，
 * 免得把在官方驱动里打开的「高帧率」关掉
 */
export const SENSOR_MODE_HIFPS = 0x80;
export const sensorModeOf = (b) => (b == null ? null : b & 0x7f);

export const DEBOUNCE_MIN = 0;
export const DEBOUNCE_MAX = 30;

export const SENSOR_3395 = 0x3395; // 13205
export const SENSOR_3950 = 0x3950; // 14672
// 官方新版桌面驱动 incott-app 1.4.0.3（IDA）认的另外两种传感器（143 回包里的传感器字节 0xE1 / 0xE2），
// 网页驱动和旧版桌面驱动都不认。只有 3395 / 3950 能分开设 X / Y（官方只给这两种开 Y 轴滑块）
export const SENSOR_E1 = 0xe1; // 200 – 16000，步进 100：dpi = 100 × (hw + 2)
export const SENSOR_E2 = 0xe2; // 50 – 12000：10000 以内步进 50（50 × (hw + 1)），以上步进 100（100 × (hw − 99)）

/** 143 回包里的传感器字节 → 传感器（其它值按 PAW3395 处理，与以前一致） */
export function sensorFromByte(b) {
  if (b === 241) return SENSOR_3950;
  if (b === 0xe1) return SENSOR_E1;
  if (b === 0xe2) return SENSOR_E2;
  return SENSOR_3395; // 240 或未知
}

/** 传感器显示名 */
export function sensorName(sensor) {
  if (sensor === SENSOR_3950) return 'PAW3950';
  if (sensor === SENSOR_3395) return 'PAW3395';
  if (sensor === SENSOR_E1) return '16K sensor (0xE1)';
  if (sensor === SENSOR_E2) return '12K sensor (0xE2)';
  return `0x${(sensor >>> 0).toString(16)}`;
}

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

/** 按官方新版桌面驱动的换算建表：hw 从 0 开始，dpiOf(hw) 超过 max 为止 */
function buildDpiTableBy(dpiOf, max) {
  const ui = [];
  const hw = [];
  for (let h = 0; dpiOf(h) <= max; h++) {
    ui.push(dpiOf(h));
    hw.push(h);
  }
  return { ui, hw };
}

const DEFAULT_DPI_COLORS = [rgb(255, 0, 0), rgb(0, 0, 255), rgb(0, 255, 0), rgb(255, 255, 0), rgb(0, 255, 255), rgb(255, 0, 255)];

function makeSensor(sensor, max, { table = buildDpiTable(max), step = 50, xy = true } = {}) {
  const t = table;
  return {
    sensor,
    step, // 界面上的步进（E2 在 10000 以上实际是 100，取值时按表就近）
    xy, // 能否分开设 X / Y
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
    stDPI: [
      makeSensor(SENSOR_3395, 32000),
      makeSensor(SENSOR_3950, 45000),
      makeSensor(SENSOR_E1, 16000, { table: buildDpiTableBy((h) => 100 * (h + 2), 16000), step: 100, xy: false }),
      makeSensor(SENSOR_E2, 12000, { table: buildDpiTableBy((h) => (h <= 199 ? 50 * (h + 1) : 100 * (h - 99)), 12000), xy: false }),
    ],
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

/**
 * LOD：配置文件中的 lod（0 = 0.7 mm，1 = 1 mm，2 = 2 mm）→ 写入鼠标的固件值。
 *
 * 固件编码为 0 = 1 mm、1 = 2 mm、2 = 0.7 mm（仅 PAW3950），两种传感器相同，
 * 以官方 Windows 桌面驱动（Gaming Mouse Driver：1mm→0，2mm→1）为准。
 * 原版网页驱动在 PAW3395 上直接发送 lod（1 mm→1、2 mm→2），整体错一位，
 * 导致 G23 等机型调整 LOD 不生效（issue #7）；PAW3950 分支本来就是正确的。
 */
const LOD_HW = [2, 0, 1];

export function lodToHw(lod, sensor) {
  // PAW3395 不提供 0.7 mm（例如导入了 3950 的配置），按 1 mm 处理
  if (sensor !== SENSOR_3950 && lod === 0) lod = 1;
  return LOD_HW[lod] ?? LOD_HW[1];
}
