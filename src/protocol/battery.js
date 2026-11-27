// 电量修正：补平固件换算里 46–56 % 的断档。
//
// 固件的换算（本地全部原相鼠标固件 1.3.8.3.6.2 – 1.4.0.4-ble 都一样；IDA：338.bin sub_1000C3D0，补偿在 0xC412）：
//   adc = 3 次 ADC 采样的平均值。2.4G / 有线的周期采样总是先扣一段"负载补偿"：adc ≥ 528 扣 10，否则扣 28
//   电量 = floor(100 × (adc − 补偿 − 422) / 168)，补偿后 ≥ 590 为 100 %，< 422 为 0 %
// 补偿本来写了 4 档（扣 28 / 22 / 16 / 10），但中间两档的比较常数是 220、249，adc ≥ 528 之后永远走不到，
// 实际只剩两档。于是 adc 528 → 57 %、527 → 45 %，46–56 % 永远不会出现，电量会从 57 % 直接掉到 45 %。
//
// 这里从固件的百分比反推 adc，再让补偿在 adc 510–546 之间从 28 线性减到 10（adc 每升 2 少扣 1），
// 用同一个公式重新算。35 % 及以下、67 % 及以上与固件完全相同；
// 固件的低电告警（补偿后 ≤ 483，即 adc ≤ 511）和自动关机（≤ 422，即 adc ≤ 450）对应的位置也不变。
// 46–56 % 只可能来自没补偿的读数（开机时的那几次采样，十几秒后固件自己会降下来），按不补偿反推。
// 只用于紧凑布局的状态包和 0x89（固件 1.3.8 起）；更早固件的换算没看过，旧布局不修正。

const ADC_EMPTY = 422; // 固件里的 0 %
const ADC_SPAN = 168; // 0 % → 100 %

/** 固件把补偿后的 adc 换成百分比 */
function percentOf(adc) {
  if (adc >= ADC_EMPTY + ADC_SPAN) return 100;
  if (adc < ADC_EMPTY) return 0;
  return Math.floor((100 * (adc - ADC_EMPTY)) / ADC_SPAN);
}

/** 固件实际的补偿：只有两档 */
const firmwareComp = (adc) => (adc >= 528 ? adc - 10 : adc - 28);

/** 连续的补偿：510 以下扣 28，546 起扣 10，中间线性过渡 */
const smoothComp = (adc) => (adc < 510 ? adc - 28 : adc >= 546 ? adc - 10 : adc - 28 + ((adc - 510) >> 1));

// 固件百分比 → 修正后的百分比。每个百分比对应 1–2 个 adc，取中间那个
const TABLE = (() => {
  const out = [];
  for (let p = 0; p <= 100; p++) {
    let adcs = [];
    for (let adc = 400; adc <= 620; adc++) if (percentOf(firmwareComp(adc)) === p) adcs.push(adc);
    if (!adcs.length) for (let adc = 400; adc <= 620; adc++) if (percentOf(adc) === p) adcs.push(adc); // 46–56：没补偿的读数
    out.push(percentOf(smoothComp(adcs[adcs.length >> 1])));
  }
  return out;
})();

/** 固件报的电量（0–100）→ 显示用的电量；不在 0–100 的值原样返回 */
export function correctPower(p) {
  return Number.isInteger(p) && p >= 0 && p <= 100 ? TABLE[p] : p;
}
