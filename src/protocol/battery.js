// 电量显示：从固件报的百分比还原 ADC 读数，按锂电池的放电曲线重新换算。
//
// 固件的换算（本地全部原相鼠标固件 1.3.8.3.6.2 – 1.4.0.4-ble 都一样；IDA：338.bin sub_1000C3D0，补偿在 0xC412）：
//   adc = 3 次 ADC 采样的平均值。2.4G / 有线的周期采样总是先扣一段"负载补偿"：adc ≥ 528 扣 10，否则扣 28
//   电量 = floor(100 × (adc − 补偿 − 422) / 168)，补偿后 ≥ 590 为 100 %，< 422 为 0 %
// 这样换算有三个问题：
// - 补偿本来写了 4 档（扣 28 / 22 / 16 / 10），但中间两档的比较常数是 220、249，adc ≥ 528 之后永远走不到，
//   实际只剩两档：adc 528 → 57 %、527 → 45 %，46–56 % 永远不会出现，电量从 57 % 直接掉到 45 %
// - 高电量段也扣 10，充满（约 590）只有 94 % 左右
// - 电压按直线换成电量，而锂电池在 3.7–3.9 V 很平、3.6 V 以下掉得快，低电量段明显虚高（3.6 V 显示 33 %）
//
// 这里：固件百分比 → adc（扔掉固件的补偿）→ 电压（以这只鼠标学到的满电 adc 为 4.2 V）→ 锂电池放电曲线插值。
// 固件百分比到 adc：≥ 57 % 按扣 10 那档、≤ 45 % 按扣 28 那档反推，每个百分比对应 1–2 个 adc，取中间那个；
// 46–56 % 只可能来自没补偿的读数（开机时的那几次采样，十几秒后固件自己会降下来），按不补偿反推。
// 只用于紧凑布局的状态包和 0x89（固件 1.3.8 起）；更早固件的换算没看过，旧布局不处理。

const ADC_EMPTY = 422; // 固件里的 0 %
const ADC_SPAN = 168; // 0 % → 100 %

/** 固件把补偿后的 adc 换成百分比 */
function firmwarePercent(adc) {
  if (adc >= ADC_EMPTY + ADC_SPAN) return 100;
  if (adc < ADC_EMPTY) return 0;
  return Math.floor((100 * (adc - ADC_EMPTY)) / ADC_SPAN);
}

/** 固件实际的补偿：只有两档 */
const firmwareComp = (adc) => (adc >= 528 ? adc - 10 : adc - 28);

// 固件百分比 → adc
const ADC_OF = (() => {
  const out = [];
  for (let p = 0; p <= 100; p++) {
    let adcs = [];
    for (let adc = 400; adc <= 620; adc++) if (firmwarePercent(firmwareComp(adc)) === p) adcs.push(adc);
    if (!adcs.length) for (let adc = 400; adc <= 620; adc++) if (firmwarePercent(adc) === p) adcs.push(adc); // 46–56：没补偿的读数
    out.push(adcs[adcs.length >> 1]);
  }
  return out;
})();

/** 固件报的电量（0–100）对应的 adc；不在 0–100 时为 null */
export function firmwareToAdc(p) {
  return Number.isInteger(p) && p >= 0 && p <= 100 ? ADC_OF[p] : null;
}

/** 还没学到满电值时用固件的满电点：590 ≈ 4.2 V（422 / 590 = 3.0 / 4.2，推算，没有实测） */
export const DEFAULT_FULL_ADC = 590;
const FULL_VOLT = 4.2;
/** 学到的满电 adc 只在这个范围内采用 */
export const FULL_ADC_MIN = 560;
export const FULL_ADC_MAX = 630;
/** 充电结束、读数回落后固件值至少这么高才算充满 */
export const FULL_MIN_FW = 85;

// 典型锂电池（充满 4.2 V）的电压 → 剩余电量，取几份公开资料的中间值。
// 是通用形状，没有对这块电池实测，误差估计在 5–10 个百分点
const CURVE = [
  [3.2, 0],
  [3.3, 1],
  [3.4, 3],
  [3.5, 6],
  [3.6, 12],
  [3.65, 19],
  [3.7, 29],
  [3.75, 40],
  [3.8, 50],
  [3.85, 58],
  [3.9, 67],
  [4.0, 79],
  [4.1, 90],
  [4.2, 100],
];

/** adc → 电量（0–100），fullAdc 是这只鼠标充满时的 adc */
export function adcToPercent(adc, fullAdc = DEFAULT_FULL_ADC) {
  const v = (FULL_VOLT * adc) / fullAdc;
  if (v <= CURVE[0][0]) return 0;
  for (let i = 1; i < CURVE.length; i++) {
    const [v1, p1] = CURVE[i];
    if (v <= v1) {
      const [v0, p0] = CURVE[i - 1];
      return Math.round(p0 + ((p1 - p0) * (v - v0)) / (v1 - v0));
    }
  }
  return 100;
}

/** 学到的满电 adc 是否可信 */
export function validFullAdc(adc) {
  return Number.isInteger(adc) && adc >= FULL_ADC_MIN && adc <= FULL_ADC_MAX;
}

/** 充电结束、读数回落后的固件值 → 满电 adc；不像充满（低于 85 %）时为 null */
export function fullAdcFrom(fw) {
  if (!Number.isInteger(fw) || fw < FULL_MIN_FW || fw > 100) return null;
  const adc = firmwareToAdc(fw);
  return validFullAdc(adc) ? adc : null;
}

/**
 * 固件报的电量 → 界面显示。
 * - 充电时电压被充电器抬高，最多显示 99 %
 * - 有线、没在充电、固件值 ≥ 85 %：插着线而充电芯片说不充了，就是充满了，显示 100 %
 * @returns {{ power: number, full: boolean }} 固件值不在 0–100 时 power 原样返回
 */
export function batteryView(fw, { fullAdc = DEFAULT_FULL_ADC, charging = false, wired = false } = {}) {
  const adc = firmwareToAdc(fw);
  if (adc == null) return { power: fw, full: false };
  if (wired && !charging && fw >= FULL_MIN_FW) return { power: 100, full: true };
  const p = adcToPercent(adc, validFullAdc(fullAdc) ? fullAdc : DEFAULT_FULL_ADC);
  return { power: charging ? Math.min(p, 99) : p, full: false };
}
