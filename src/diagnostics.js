// 「复制诊断信息」：正式版没有开发者工具，这是用户把原始数据交给我们的唯一途径。
// 内容：自动判断（用户也能看懂的结论）、环境、识别结果与连接时的原始回包、状态包统计与解码（两种候选布局）、
// 全部读命令的原始回包与解码、鼠标实际值与本地配置的对照、HID 错误、应用事件、控制台错误、
// HID 设备结构（含系统里全部 HID 设备）、板载配置、宏的结构摘要、最近的原始收发、上次连接失败的现场，
// 以及上一次运行的日志（桌面版写在本机文件里）。
// 只发送 0x80–0x8F 的读命令，不会改动鼠标里的任何设置；鼠标正在写入或连接卡住时连读命令也不发，只导出现有记录。

import * as C from './protocol/constants.js';
import { IncottDevice, toHex, sleep, modelFromCode, keyToHw, hwToKey, withTimeout, statusLayoutOf } from './protocol/device.js';
import { MAX_ACTION, lpCycle, lpUntilAnyKey, lpUntilKeyRelease, macroToHw } from './protocol/macro.js';
import { state, settings, curProfile, effectiveRate, diag, toast, isMock, macroUsage } from './store.js';
import { events, consoleLog, startedAt, uptime } from './diaglog.js';
import { keyLabel } from './functions.js';
import { t } from './i18n.js';

const desktop = typeof window !== 'undefined' ? window.desktop : undefined;

const Q = (label, ...cmd) => ({ label, cmd, star: label.endsWith('*') });
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

/**
 * 诊断时依次发送的读命令。带 * 的只在官方桌面驱动（GamingMouse.exe）里见过，网页驱动不用，
 * 不同固件未必支持——正是需要实机数据确认的部分。
 */
export const DIAG_QUERIES = [
  Q('device: psd / model / receiver / sensor / color', 0x8f),
  ...range(5, (i) => Q(`pairing ${i + 1}${i ? ' *' : ''}`, 0x8e, i + 1)),
  Q('info', 0x89),
  Q('dpi stages / current', 0x83),
  Q('firmware version *', 0x80),
  Q('polling rate *', 0x81),
  ...range(6, (i) => Q(`dpi value #${i + 1} *`, 0x82, i)),
  ...['LOD', 'ripple', 'angle snap', 'motion sync', 'sensor mode'].map((n, i) => Q(`${n} *`, 0x84, i + 1)),
  ...['debounce *', 'fire key *', 'sleep time'].map((n, i) => Q(n, 0x85, i + 1)),
  // 官方新版桌面驱动（incott-app 1.4.0.3）：当前硬件槽位；1.4.x 固件回显 7
  Q('onboard slot *', 0x85, 6),
  Q('firmware 1.4 check (echoes 7) *', 0x85, 7),
  ...range(6, (i) => Q(`key @ matrix ${i}`, 0x86, i)),
  Q('onboard profile (key 9)', 0x86, 9),
  // 已知型号只有 6 个按键槽位；多出按键的型号（例如 G23 Pro 的回报率键，issue #10）可能在这些槽位里
  ...[6, 7, 8, 10, 11, 12, 13, 14, 15].map((i) => Q(`key @ matrix ${i} (beyond the known 6)`, 0x86, i)),
  Q('receiver LED *', 0x88),
];

/* ------------------------------------------------------------- 格式化 */

const hex2 = (v) => (v ?? 0).toString(16).padStart(2, '0').toUpperCase();
const hex4 = (v) => (v ?? 0).toString(16).padStart(4, '0');
const fmtT = (ms) => `+${String(ms).padStart(7)}ms`;
const fence = (lines) => ['```text', ...lines, '```'];
const keyOf = (cmd) => cmd.slice(0, 2).join(',');
const fromHex = (s) => (s ? s.split(' ').map((h) => parseInt(h, 16)) : null);
const ago = (ts) => (ts ? `${((Date.now() - ts) / 1000).toFixed(1)} s ago` : 'never');
const secsSince = (ts) => (ts ? Math.round((Date.now() - ts) / 1000) : 0);
const rateOf = (code) => (code >= 0 && code <= 6 ? `${C.RATE_HW[code]}Hz` : `?(${code})`);
const LOD_FW = { 0: '1 mm', 1: '2 mm', 2: '0.7 mm' };
const LOD_PROFILE = { 0: '0.7 mm', 1: '1 mm', 2: '2 mm' };
const SENSOR_MODE = ['LP/节能', 'HP/标准', 'Corded/电竞'];
const u16 = (d, i) => d[i] | (d[i + 1] << 8);
const u32 = (d, i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;
const EXTRA_SLOTS = [6, 7, 8, 10, 11, 12, 13, 14, 15];

function pidKind(pid) {
  if (pid === C.PID_WIRED) return 'wired';
  if (pid === C.PID_WIRELESS) return '2.4G receiver';
  return 'unknown PID';
}

function sensorOf(b) {
  if (b === 240) return 'PAW3395';
  if ([241, 0xe1, 0xe2].includes(b)) return C.sensorName(C.sensorFromByte(b));
  return `unknown → treated as PAW3395`;
}

function reportBytes(r) {
  return Math.ceil((r.items || []).reduce((s, i) => s + (i.reportSize || 0) * (i.reportCount || 0), 0) / 8);
}

function describeHid(d) {
  const rep = (list) => (list || []).map((r) => `${r.reportId}:${reportBytes(r)}B`).join(',');
  const cols = (d.collections || []).map(
    (c) =>
      `${hex4(c.usagePage)}:${hex4(c.usage)} type=${c.type ?? '?'} in[${rep(c.inputReports)}] out[${rep(c.outputReports)}] feat[${rep(c.featureReports)}]${
        c.children?.length ? ` children=${c.children.length}` : ''
      }`
  );
  return [`${hex4(d.vendorId)}:${hex4(d.productId)} "${d.productName || ''}" ${d.opened ? 'opened' : 'closed'}`, ...cols.map((c) => `    ${c}`)];
}

function isIncott(d) {
  return d.vendorId === C.VENDOR_ID && (d.collections || []).some((c) => c.usagePage === C.USAGE_PAGE && c.usage === C.USAGE);
}

function fmtLog(list) {
  return list?.length ? list.map((e) => `${fmtT(e.t)} ${e.dir.padEnd(5)} ${e.hex}`) : ['(empty)'];
}

/* --------------------------------------------------------------- 解码 */

/** 按键码 → 文字（宏 / 火力键等无法用 hwToKey 还原的也给出说明） */
function describeCode(code) {
  code >>>= 0;
  const k = hwToKey(code);
  if (k) return keyLabel(k, t.value, state.macros) || k.toText();
  if ((code & 0xff) === 9) return `macro buffer ${code >>> 16}`;
  if (code === keyToHw(new C.KeyInfo(C.fMouse, C.favFIRE), 0) >>> 0) return 'fire key';
  // 未知功能：按字节列出，低字节是功能类别（01 鼠标键 / 03 多媒体 / 07 DPI 类 / 09 宏 / 0A 连发 …）
  return `unknown: type=${hex2(code & 255)} b1=${hex2((code >>> 8) & 255)} b2=${hex2((code >>> 16) & 255)} b3=${hex2(code >>> 24)}`;
}

/** 状态包（Report ID 9）的两种候选布局（见 device.js statusLayoutOf），标出按内容判断的那种 */
function decodeStatus(hex) {
  const d = fromHex(hex);
  if (!d || d.length < 4) return '';
  const e = d.concat([0, 0, 0, 0, 0, 0, 0, 0]).slice(0, 8);
  const pick = statusLayoutOf(e);
  const mark = (l) => (pick.layout === l ? (pick.sure ? '*' : '?') : '');
  const x = e[4] | ((e[3] & 15) << 8);
  const y = e[5] | ((e[3] >> 4) << 8);
  const web = `${mark('packed')}packed: pwr=${e[0] & 127}% chg=${e[0] >> 7} rate=${rateOf(e[1] & 15)} dpi#=${e[1] >> 4} profile=${(e[2] & 192) >> 6} deb=${e[2] & 63} x/y=${x}/${y} lod=${e[6] >> 4} motion=${e[6] & 15}`;
  const dsk = `${mark('old')}old: chg=${d[0]} bat=${d[1]}% dpi#=${d[2]} rate=${rateOf(d[3])}`;
  return `${web} | ${dsk}`;
}

/** 读命令回包解码；d 为去掉 Report ID 的数据（d[0] 为回显） */
function decodeReply(cmd, d, pid) {
  const [c, sub] = cmd;
  if (!d || d[0] !== c) return '';
  // [0x85,6] 有线时不回显子序号：r[1] 就是槽位；经接收器是 [0x85,6,槽位]
  if (c === 0x85 && sub === 6 && d[1] !== 6) return pid === C.PID_WIRED && d[1] <= 3 ? `slot ${d[1] + 1}` : `not supported (${d[1]})`;
  if (sub != null && d[1] !== sub) return `sub-index mismatch (${d[1]})`;
  switch (c) {
    case 0x8f: {
      const si = pid === C.PID_WIRELESS ? 5 : 4;
      return `psd=${d[1]} model=${d[2]}→${modelFromCode(d[2]) || 'UNSUPPORTED'} r3=${hex2(d[3])}${d[3] === 2 ? '(8K)' : ''} r4=${hex2(d[4])} r5=${hex2(d[5])} r6=${hex2(d[6])} sensor@r${si}=${sensorOf(d[si])}`;
    }
    case 0x8e:
      return `id=${[2, 3, 4, 5].map((i) => hex2(d[i])).join('')}${sub === 1 ? ` online=${d[6]}` : ''}`;
    case 0x89: {
      // 固件 1.4.0.3（IDA）：有线时鼠标实时回答；接收器用最近一个状态包回答，收到过才有 0x5A。r[2] 是连接方式，
      // 1K 接收器的 r[4] 是状态包第 3 字节（消抖 | 槽位 << 6），其它情况是 DPI 档
      const link = { 2: 'wired', 1: '1K receiver', 0: '8K receiver' }[d[2]] ?? `?${d[2]}`;
      const r4 = d[2] === 1 ? `status-d2=${hex2(d[4])}` : `dpi#=${d[4]}`;
      return `battery=${d[1]} link=${link} rate=${rateOf(d[3] & 15)} ${r4} r5=${d[5]} r6=${d[6]} magic=${d[7] === 0x5a ? 'OK' : 'missing (no status report cached yet)'}`;
    }
    case 0x83:
      return `stages=${d[1]} current=${d[2]} extra=${d[3]},${d[4]},${d[5]}`;
    case 0x80:
      return `version=${d[1] * 10 + d[2]}`;
    case 0x81:
      return `rate=${rateOf(d[1])}`;
    case 0x82: {
      const x = u16(d, 2);
      return `x=${(x + 1) * 50} (hw ${x}) y-raw=${hex2(d[4])} ${hex2(d[5])} ${hex2(d[6])}`;
    }
    case 0x84:
      if (sub === 1) return `${LOD_FW[d[2]] ?? '?'} (fw ${d[2]})`;
      if (sub === 5) return `${SENSOR_MODE[d[2]] ?? '?'} (${d[2]})`;
      return d[2] ? 'on' : 'off';
    case 0x85:
      if (sub === 1) return `${d[2]} ms`;
      if (sub === 2) return `count=${d[2]} interval=${u16(d, 3)} ms`;
      if (sub === 6) return d[2] <= 3 ? `slot ${d[2] + 1} (via receiver; may be leftover on old firmware)` : `not supported (${d[2]})`;
      if (sub === 7) return `firmware 1.4.x: ${hex2(d[2])} ${hex2(d[3])} color=${d[4]}`;
      return `${u16(d, 2)} s`;
    case 0x86: {
      const code = u32(d, 2);
      return sub === 9 ? `profile index ${code}` : `0x${code.toString(16).padStart(8, '0')} ${describeCode(code)}`;
    }
    case 0x88:
      return `mode ${d[1]}`;
    default:
      return '';
  }
}

/** 142（8E 01）回包里的鼠标在线标志；hex 含 Report ID：[9, 0x8E, 01, id×4, online, …] */
function linkOnlineOf(hex) {
  const r = fromHex(hex);
  return r && r[1] === 0x8e && r[2] === 1 ? r[7] : null;
}

/* ----------------------------------------------------------- 读命令 */

const QUERY_TIMEOUT = 3000; // 单条读命令的超时；探测时收集状态包的时长必须比它短
const PROBE_LISTEN = 2500;

/**
 * 依次发送全部读命令：返回逐行文本、原始回包（key = "cmd,sub"），
 * 以及带 * 命令的回包是否全为 0（全为 0 多半是固件不支持这些命令，对照表里相关项不可信）
 */
async function runQueries(dev, pid) {
  const lines = [];
  const raw = {};
  const star = { total: 0, zero: 0 };
  for (const q of DIAG_QUERIES) {
    let r;
    try {
      r = await withTimeout(dev.rawQuery(q.cmd), QUERY_TIMEOUT, 'query');
    } catch (err) {
      // 超时说明读写已经卡住，后面的命令也不会有结果
      lines.push(`${q.cmd.map(hex2).join(' ')} → ${err.message}, aborted`);
      break;
    }
    const head = `${toHex(r.sent)} → `;
    if (!r.recv) {
      lines.push(`${head}(no data${r.error ? `: ${r.error}` : ''})  ${q.label}`);
      continue;
    }
    raw[keyOf(q.cmd)] = r.recv;
    const d = Array.from(r.recv.slice(1));
    const echo = r.recv[1] === q.cmd[0];
    // 其它配对槽位本来就可能是空的，不算
    if (q.star && echo && q.cmd[0] !== 0x8e) {
      star.total++;
      if (d.slice(q.cmd.length > 1 ? 2 : 1).every((b) => b === 0)) star.zero++;
    }
    const dec = echo ? decodeReply(q.cmd, d, pid) : 'NO ECHO';
    lines.push(`${head}${toHex(r.recv)}  ${String(r.ms).padStart(4)}ms  ${q.label}${dec ? ` = ${dec}` : ''}`);
  }
  return { lines, raw, starUnsupported: star.total > 0 && star.zero === star.total };
}

/** 鼠标里的实际值（读回）与当前本地配置的对照 */
function compareWithProfile(raw, pf, dev, { starUnsupported, firstRun }) {
  const data = (k) => {
    const r = raw[k];
    if (!r || r[1] !== Number(k.split(',')[0])) return null;
    const d = Array.from(r.slice(1));
    const sub = k.split(',')[1];
    return sub != null && d[1] !== Number(sub) ? null : d;
  };
  const rows = [];
  const mismatches = [];
  const extra = [];
  if (firstRun) rows.push('note: first run — apart from keys and the number of DPI stages, the profile holds defaults never written to the mouse');
  if (starUnsupported) rows.push('note: every * command replied all zeros (probably unsupported) — rows marked * are shown as ?');
  // star：该项来自带 * 的命令；固件不支持这些命令时，不一致标为 ? 而不是 ≠
  // pv 为 null：配置里没有可比的值（只列出鼠标里的值）
  const row = (name, dv, pv, star = false) => {
    // 固件不支持 * 命令时回包全 0，"一致"也只是巧合，同样标为 ?
    let mark = dv == null || (starUnsupported && star) ? '?' : pv == null ? '·' : String(dv) === String(pv) ? '✓' : '≠';
    if (mark === '≠') mismatches.push(name);
    rows.push(`${mark} ${`${name}${star ? ' *' : ''}`.padEnd(16)} device ${String(dv ?? '(no data)').padEnd(22)} profile ${pv ?? '-'}`);
  };
  let d;
  d = data('131');
  row('dpi stages', d && d[1], pf.dpi.length);
  row('dpi current', d && d[2], pf.curDpi);
  for (let i = 0; i < 6; i++) {
    d = data(`130,${i}`);
    if (!d && i >= pf.dpi.length) continue;
    row(`dpi #${i + 1} x`, d && (u16(d, 2) + 1) * 50, pf.dpi[i] ?? '-', true);
  }
  d = data('129');
  row('rate', d && rateOf(d[1]), rateOf(C.RATE_HW.indexOf(effectiveRate.value)), true);
  d = data('132,1');
  row('LOD', d && (LOD_FW[d[2]] ?? `fw ${d[2]}`), LOD_PROFILE[pf.lod] ?? pf.lod, true);
  d = data('132,2');
  row('ripple', d && !!d[2], pf.ripple, true);
  d = data('132,3');
  row('angle snap', d && !!d[2], pf.fixline, true);
  d = data('132,4');
  row('motion sync', d && !!d[2], pf.motion, true);
  d = data('132,5');
  row('sensor mode', d && (SENSOR_MODE[d[2]] ?? d[2]), SENSOR_MODE[pf.sensormode] ?? pf.sensormode, true);
  d = data('133,1');
  row('debounce', d && d[2], pf.debounce, true);
  d = data('133,3');
  row('sleep', d && u16(d, 2), pf.sleeptime);
  // 火力键参数在固件里是全局的，只有配置里有火力键时才可比
  const fire = pf.key.find((k) => k.major === C.fMouse && k.minor === C.favFIRE);
  d = data('133,2');
  row(
    'fire (global)',
    d && `${d[2]}x/${u16(d, 3)}ms`,
    fire ? `${Math.min(3, fire.itemdata & 65535)}x/${Math.min(255, (fire.itemdata >> 16) & 65535)}ms` : null,
    true
  );
  if (dev.is8KReceiver) {
    d = data('136');
    row('receiver LED', d && d[1], pf.receiverLED, true);
  }
  C.dvar.key.forEach((dk, i) => {
    d = data(`134,${dk.matrix}`);
    const want = keyToHw(pf.key[i], i);
    row(`key ${i + 1} (m${dk.matrix})`, d && `0x${u32(d, 2).toString(16)}`, want === -1 ? '(not writable)' : `0x${(want >>> 0).toString(16)}`);
  });
  d = data('134,9');
  row('onboard profile', d && u32(d, 2), state.curIndex);
  // 超出已知 6 个按键的槽位：本软件不会写入，有非零码说明鼠标可能有额外按键
  for (const m of EXTRA_SLOTS) {
    d = data(`134,${m}`);
    const code = d && u32(d, 2);
    if (!code) continue;
    extra.push(`m${m}=0x${code.toString(16)}`);
    rows.push(`• extra slot m${String(m).padEnd(10)} device 0x${code.toString(16).padEnd(20)} ${describeCode(code)} (not managed by this app)`);
  }
  return { rows, mismatches, extra };
}

/* --------------------------------------------------------------- 汇总 */

function inputStats(src) {
  const log = src.inputLog || [];
  const byId = Object.entries(src.inputById || {})
    .map(([id, n]) => `id${id}:${n}`)
    .join(' ');
  let interval = '';
  if (log.length >= 2) interval = ` · avg interval ${Math.round((log.at(-1).t - log[0].t) / (log.length - 1))}ms (last ${log.length})`;
  return `${src.inputCount ?? 0} total${byId ? ` (${byId})` : ''}${interval}`;
}

/** 关键信息：型号码、PID、鼠标在线标志、连接时 143 / 142 / 137 / 131 / 134,9 回包原文、状态包数量与最近几包 */
function summary({ pid, modelCode, replies, inputSrc, extra = [] }) {
  const L = [];
  const r143 = fromHex(replies[143]?.hex);
  if (modelCode == null && r143 && r143[1] === 0x8f) modelCode = r143[3];
  const name = modelCode == null ? '(no reply)' : `${modelCode} → ${modelFromCode(modelCode) || 'UNSUPPORTED'}`;
  L.push(`model code     ${name}`);
  L.push(`vid:pid        ${hex4(C.VENDOR_ID)}:${hex4(pid)} (${pidKind(pid)})`);
  if (r143) {
    // r143 含 Report ID：[9, 0x8F, psd, model, r3, r4, r5, r6, ...]
    const si = pid === C.PID_WIRELESS ? 6 : 5;
    L.push(`receiver       r3=${hex2(r143[4])} r4=${hex2(r143[5])} → ${r143[4] === 2 ? '8K receiver' : 'not 8K'}`);
    L.push(`sensor byte    ${hex2(r143[si])} → ${sensorOf(r143[si])}`);
  }
  const online = linkOnlineOf(replies[142]?.hex);
  if (online != null) L.push(`mouse online   8E01 r6=${online} → ${online === 1 ? 'online' : online === 0 ? 'NOT ONLINE?' : '?'} (meaning unconfirmed)`);
  L.push(...extra);
  for (const [cmd, label] of [
    [143, '8F'],
    [142, '8E 01'],
    [137, '89'],
    [131, '83'],
    [134, '86 09'],
  ]) {
    const r = replies[cmd];
    L.push(`${`${cmd} (${label})`.padEnd(15)}${r ? `${fmtT(r.t)}  ${r.hex}` : '(no reply)'}`);
  }
  L.push(`input reports  ${inputStats(inputSrc)}`);
  const last = (inputSrc.inputLog || []).slice(-5);
  if (last.length) {
    L.push('last input reports:');
    for (const e of last) L.push(`  ${fmtT(e.t)} ${e.dir.padEnd(5)} ${e.hex}`);
  }
  return L;
}

function decodedInputs(inputLog) {
  const last10 = (inputLog || []).filter((e) => e.dir === `in#${C.REPORT_ID}`).slice(-10);
  return fence(last10.length ? last10.map((e) => `${fmtT(e.t)} ${e.hex.slice(0, 23)}  ${decodeStatus(e.hex)}`) : ['(none received)']);
}

/** 宏只给结构摘要：录制的按键序列可能包含用户输入过的文字（甚至密码），不放进诊断信息 */
function macroLines() {
  const LOOP = { [lpUntilKeyRelease]: 'hold', [lpUntilAnyKey]: 'until-any-key', [lpCycle]: 'cycle' };
  const lines = state.macros.list.slice(0, 40).map((m, i) => {
    const held = {};
    for (const it of m.item) held[it.key] = (held[it.key] || 0) + (it.press ? 1 : -1);
    const unbalanced = Object.values(held).filter((n) => n !== 0).length;
    const delay = m.item.reduce((s, it) => s + (Number(it.delay) || 0), 0);
    const used = macroUsage(m.uid).map((u) => `P${u.profile + 1}-B${u.button + 1}`).join(',') || '-';
    const loop = `${LOOP[m.looptype] ?? m.looptype}${m.looptype === lpCycle ? `×${m.cycle}` : ''}`;
    return `#${i + 1} uid=${m.uid} actions=${m.item.length}/${MAX_ACTION} unbalanced=${unbalanced} total-delay=${delay}ms loop=${loop} bound=${used} hw=${macroToHw(m, 0) ? 'ok' : 'FAIL'}`;
  });
  if (state.macros.list.length > 40) lines.push(`…(${state.macros.list.length - 40} more)`);
  return lines;
}

/** 配置里绑定了宏库中已不存在的宏（写入时会按默认功能处理） */
function missingMacros() {
  const out = [];
  state.profiles.list.forEach((pf, p) =>
    pf.key.forEach((k, b) => {
      if (k.major === C.fJuji && !state.macros.find(k.itemdata)) out.push(`P${p + 1}-B${b + 1} uid=${k.itemdata}`);
    })
  );
  return out;
}

/* ----------------------------------------------------------- 自动判断 */

/**
 * 根据收集到的数据给出结论（界面语言），放在报告最前面：用户能据此自己排查，开发者也能一眼看到重点。
 * ⚠ 表示可能的问题，· 表示参考信息。
 */
export function buildFindings(c, tr = t.value) {
  const W = (s) => `⚠ ${s}`;
  const I = (s) => `· ${s}`;
  const out = [];
  if (c.busy) out.push(W(tr.fBusy(c.busy)));
  if (c.noIncott) out.push(W(tr.fNoDevice));
  if (c.sysHid?.devices) {
    const pix = c.sysHid.devices.filter((d) => d.vendorId === C.VENDOR_ID);
    const odd = pix.filter((d) => d.productId !== C.PID_WIRED && d.productId !== C.PID_WIRELESS);
    if (!pix.length) out.push(W(tr.fSysNoPixart(c.sysHid.devices.length)));
    else if (odd.length) out.push(W(tr.fSysOtherPid(odd.map((d) => `093a:${hex4(d.productId)}${d.name ? ` "${d.name}"` : ''}`).join(', '))));
  } else if (c.sysHid?.error) out.push(I(tr.fSysScanFailed(c.sysHid.error)));
  if (c.linuxDenied?.length) out.push(W(tr.fLinuxPerm(c.linuxDenied.join(', '))));
  if (c.lastFailure) {
    const e = c.lastFailure.error;
    if (e === 'NO_RESPONSE') out.push(W(tr.fNoResponse));
    else if (e === 'UNSUPPORTED_DEVICE') out.push(W(tr.fUnsupported(c.lastFailure.modelCode ?? '?')));
    else if (e === 'READ_FAILED') out.push(W(tr.fReadFailed));
    else out.push(W(tr.fConnectFailed(e)));
  }
  if (c.probeUnsupported != null) out.push(W(tr.fUnsupported(c.probeUnsupported)));
  if (c.wireless && c.linkOnline === 0) out.push(W(tr.fOffline));
  if (c.connected) {
    if (!c.statusCount && c.sinceConnect >= 10) out.push(W(tr.fNoStatus(c.sinceConnect)));
    else out.push(I(tr.fStatus(c.statusCount || 0, c.sinceConnect)));
  }
  if (c.firmware != null) out.push(I(tr.fFirmware(c.firmware)));
  if (c.starUnsupported) out.push(I(tr.fStarZero));
  if (c.firstRun) out.push(I(tr.fFirstRun));
  else if (c.mismatches?.length) out.push(W(tr.fMismatch(c.mismatches.join(', '))));
  if (c.extraSlots?.length) out.push(I(tr.fExtraSlots(c.extraSlots.join(', '))));
  if (c.missingMacros?.length) out.push(W(tr.fMissingMacro(c.missingMacros.join(', '))));
  if (c.applyFails?.length) out.push(W(tr.fApplyFailed(c.applyFails.length, c.applyFails.at(-1))));
  if (c.hidErrors?.length) out.push(W(tr.fHidErrors(c.hidErrors.length, c.hidErrors.at(-1))));
  if (c.consoleErrors) out.push(I(tr.fConsole(c.consoleErrors)));
  if (c.prevLog && !c.prevLog.cleanExit) out.push(I(tr.fPrevUnclean));
  if (!out.some((s) => s.startsWith('⚠'))) out.push(I(tr.fNone));
  return out;
}

/* --------------------------------------------------------------- 探测 */

/** 未连接时：临时打开设备，发读命令，顺便收集一会儿状态包，然后关闭 */
async function probe(hid) {
  const dev = new IncottDevice(hid);
  let openedHere = false;
  try {
    if (!hid.opened) {
      await withTimeout(hid.open(), 5000, 'open');
      openedHere = true;
    }
  } catch (err) {
    return { error: `open failed: ${err?.message || err}` };
  }
  hid.addEventListener('inputreport', dev._onInput);
  const t0 = Date.now();
  try {
    const q = await runQueries(dev, hid.productId);
    const rest = PROBE_LISTEN - (Date.now() - t0);
    if (rest > 0) await sleep(rest);
    return { ...q, dev };
  } finally {
    hid.removeEventListener('inputreport', dev._onInput);
    if (openedHere) await hid.close().catch(() => {});
  }
}

/**
 * 列出系统里全部 HID 设备（桌面版）：requestDevice 触发主进程的选择事件，主进程只记录列表、不选择任何设备。
 * 必须在点击按钮后立刻调用（requestDevice 需要用户手势）。
 */
async function scanSystemHid() {
  if (!desktop?.hidScan || isMock || typeof navigator === 'undefined' || !navigator.hid?.requestDevice) return null;
  let error = null;
  try {
    await desktop.hidScan(true);
    await withTimeout(navigator.hid.requestDevice({ filters: [] }), 4000, 'requestDevice').catch((err) => (error = err));
  } catch (err) {
    error = err;
  }
  const devices = await desktop.hidScan(false).catch(() => null);
  if (devices) return { devices };
  return { error: String(error?.message || error || 'no device list') };
}

/* --------------------------------------------------------------- 主体 */

const MAX_TEXT = 60000; // GitHub Issue 正文上限 65536

/**
 * 体积大、可截断的部分放在最后，按优先级分配剩余篇幅，超出时从最早的记录开始截掉。
 * 保证整份报告不超过 MAX_TEXT。
 */
function renderTail(head, sections) {
  let budget = MAX_TEXT - head.length;
  const blocks = new Map();
  for (const s of [...sections].sort((a, b) => a.prio - b.prio)) {
    const allow = Math.max(0, Math.min(budget, s.max) - s.title.length - 80);
    let lines = s.lines;
    let size = lines.reduce((n, l) => n + l.length + 1, 0);
    let cut = 0;
    while (size > allow && cut < lines.length) size -= lines[cut++].length + 1;
    if (cut) lines = [`…(${cut} older lines omitted)`, ...lines.slice(cut)];
    const block = `\n\n### ${s.title}\n${fence(lines).join('\n')}`;
    budget -= block.length;
    blocks.set(s, block);
  }
  return head + sections.map((s) => blocks.get(s)).join('');
}

/**
 * @param busy    非空时表示鼠标正在写入 / 连接卡住：不发送任何命令，只导出现有记录
 * @param sysHid  scanSystemHid 的结果
 */
export async function collectDiagnostics({ busy = null, sysHid = null } = {}) {
  const L = [];
  const tail = [];
  const info = desktop ? await desktop.info().catch(() => null) : null;
  const dev = state.device;
  const ctx = { busy, sysHid, firstRun: false, hidErrors: [] };

  L.push('## INCOTT Driver diagnostics', '');
  L.push(`- time: ${new Date().toISOString()} (app started ${startedAt}, uptime ${Math.round(uptime() / 1000)} s)`);
  if (info) {
    L.push(`- app: v${info.version} (${info.install || '?'}) · Electron ${info.electron} · Chromium ${info.chrome}`);
    L.push(`- os: ${info.os || info.platform} · ${info.platform}-${info.arch}${info.session ? ` · ${info.session}` : ''}${info.desktop ? ` · ${info.desktop}` : ''} · locale ${info.locale || '?'}`);
  } else {
    L.push(`- browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : '?'}`);
  }
  L.push(`- ui: lang=${settings.lang} theme=${settings.theme} closeToTray=${settings.closeToTray} phase=${state.phase}${isMock ? ' · MOCK' : ''}`);
  if (state.error) L.push(`- error: ${state.error.title} — ${state.error.message}`);
  if (busy) L.push(`- busy: ${busy} — no commands sent, existing records only`);
  L.push('- `*` = command only seen in the official desktop driver; replies may be meaningless on some firmware');
  L.push('- device log times (+ms) are relative to opening the device; event / console times to app start');
  const findingsAt = L.length;

  let granted = [];
  try {
    granted = isMock ? (dev ? [dev.hid] : []) : navigator.hid ? await navigator.hid.getDevices() : [];
  } catch (err) {
    L.push(`- navigator.hid.getDevices failed: ${err?.message || err}`);
  }

  const errSources = [];
  if (dev) {
    // 先快照记录，避免混进下面诊断查询本身的收发
    const xfer = dev.xferLog.slice();
    const input = dev.inputLog.slice();
    const src = { inputLog: input, inputCount: dev.inputCount, inputById: { ...dev.inputById } };
    const pid = dev.hid.productId;
    Object.assign(ctx, {
      connected: true,
      wireless: dev.iswireless,
      linkOnline: dev.linkOnline,
      statusCount: src.inputById[C.REPORT_ID] || 0,
      sinceConnect: secsSince(dev.connectedAt),
      firstRun: state.firstRun,
    });
    L.push('', `### Summary (connected${busy ? ', busy' : ''})`);
    L.push(
      ...fence(
        summary({
          pid,
          modelCode: dev.modelCode,
          replies: dev.replies,
          inputSrc: src,
          extra: [
            `connected      ${ago(dev.connectedAt)} · last input ${ago(dev.lastInputAt)}`,
            `parsed         ${dev.devname} sensor=0x${dev.sensor.toString(16)} wireless=${dev.iswireless} 8K=${dev.is8KReceiver} pink=${dev.isPink}`,
            `at connect     rate=${dev.curUSBRate} dpi=${dev.curDpi}/${dev.dpiLevels} power=${dev.power} onboard=${dev.curOnBoard}`,
            `ui now         power=${state.info.power} charging=${state.info.charging} rate=${state.info.rate} profile=${state.curIndex + 1} slot=${state.slot == null ? '?' : state.slot + 1} firstRun=${state.firstRun} pending=${state.pending} applying=${state.applying}`,
            ...(dev.applyError ? [`last apply err ${dev.applyError}`] : []),
          ],
        })
      )
    );

    L.push('', '### Input reports decoded (last 10, both candidate layouts)');
    L.push(...decodedInputs(input));

    if (!busy) {
      const q = await runQueries(dev, pid);
      ctx.starUnsupported = q.starUnsupported;
      const fw = q.raw['128'];
      if (fw && fw[1] === 0x80 && fw[2] * 10 + fw[3] > 0) ctx.firmware = fw[2] * 10 + fw[3];
      const pf = curProfile.value;
      if (pf) {
        const cmp = compareWithProfile(q.raw, pf, dev, { starUnsupported: q.starUnsupported, firstRun: state.firstRun });
        ctx.mismatches = cmp.mismatches;
        ctx.extraSlots = cmp.extra;
        L.push('', `### Device vs profile ${state.curIndex + 1} (read back now)`);
        L.push(...fence(cmp.rows));
      }
      L.push('', '### Raw queries (sent → reply incl. report ID, round trip)');
      L.push(...fence(q.lines));
    }
    errSources.push(['connected device', dev.errLog]);

    tail.push({ title: 'Recent input reports (raw)', lines: fmtLog(input), prio: 5, max: 5000 });
    tail.push({ title: 'Recent transfers (raw)', lines: fmtLog(xfer), prio: 4, max: 12000 });
  } else if (diag.connecting) {
    // 连接还没完成（多半卡住了）：不另外打开设备，只导出这次连接到目前为止的现场
    const { dev: cd, since } = diag.connecting;
    const hid = cd.hid;
    ctx.wireless = hid.productId === C.PID_WIRELESS;
    ctx.linkOnline = cd.linkOnline;
    L.push('', `### Connecting ${hex4(hid.vendorId)}:${hex4(hid.productId)} "${hid.productName || ''}" (in progress for ${secsSince(since)} s)`);
    L.push(...fence(summary({ pid: hid.productId, modelCode: cd.modelCode, replies: cd.replies, inputSrc: cd })));
    errSources.push(['connecting device', cd.errLog]);
    tail.push({ title: 'Connecting: transfers so far', lines: fmtLog(cd.xferLog), prio: 3, max: 10000 });
  } else if (busy) {
    L.push('', '(busy — devices not probed)');
  } else {
    const targets = granted.filter(isIncott);
    if (!targets.length) {
      ctx.noIncott = true;
      L.push('', '(no INCOTT vendor collection granted — nothing to probe)');
    }
    for (const hid of targets) {
      const r = await probe(hid);
      L.push('', `### Probe ${hex4(hid.vendorId)}:${hex4(hid.productId)} "${hid.productName || ''}" (not connected)`);
      if (r.error) {
        L.push(r.error);
        continue;
      }
      // 探测时没有经过 _readData，按查询结果拼出同样格式的回包表
      const replies = {};
      for (const [k, cmd] of [
        ['143', 143],
        ['142,1', 142],
        ['137', 137],
        ['131', 131],
        ['134,9', 134],
      ])
        if (r.raw[k]) replies[cmd] = { t: 0, hex: toHex(r.raw[k]) };
      const m = r.raw['143'];
      const code = m && m[1] === 0x8f ? m[3] : null;
      if (code != null && !modelFromCode(code)) ctx.probeUnsupported = code;
      if (hid.productId === C.PID_WIRELESS) {
        ctx.wireless = true;
        ctx.linkOnline = linkOnlineOf(replies[142]?.hex);
      }
      L.push(...fence(summary({ pid: hid.productId, modelCode: code, replies, inputSrc: r.dev })));
      L.push(`Input reports decoded (listened ${PROBE_LISTEN / 1000} s):`);
      L.push(...decodedInputs(r.dev.inputLog));
      L.push('Raw queries:');
      L.push(...fence(r.lines));
      errSources.push([`probe ${hex4(hid.productId)}`, r.dev.errLog]);
    }
  }

  const f = diag.lastFailure;
  if (f) {
    ctx.lastFailure = f;
    if (ctx.linkOnline == null && f.productId === C.PID_WIRELESS) {
      ctx.wireless = true;
      ctx.linkOnline = f.linkOnline ?? linkOnlineOf(f.replies?.[142]?.hex);
    }
    L.push('', `### Last connect failure (${f.time})`);
    L.push(...fence([`error ${f.error} · "${f.productName}"`, ...summary({ pid: f.productId, modelCode: f.modelCode, replies: f.replies || {}, inputSrc: f })]));
    errSources.push(['last connect failure', f.errLog]);
    tail.push({ title: 'Last connect failure: transfers', lines: fmtLog(f.xferLog), prio: 3, max: 8000 });
  }

  // HID 错误 / 超时单独列出：收发记录有长度上限，错误可能早已被挤掉
  const errLines = [];
  for (const [name, list] of errSources) {
    if (!list?.length) continue;
    errLines.push(`[${name}]`, ...fmtLog(list));
    ctx.hidErrors.push(...list.map((e) => e.hex));
  }
  if (errLines.length) {
    L.push('', '### HID errors / timeouts');
    L.push(...fence(errLines));
  }

  ctx.applyFails = events.filter((e) => /→ FAILED/.test(e.msg)).map((e) => e.msg.replace(/^.*→ FAILED at /, ''));
  ctx.consoleErrors = consoleLog.filter((e) => e.level !== 'warn').length;
  ctx.missingMacros = missingMacros();

  L.push('', '### HID devices (granted)');
  L.push(...fence(granted.length ? granted.flatMap(describeHid) : ['(none)']));
  if (sysHid) {
    L.push('', '### All HID devices seen by the system (names only for 093a)');
    L.push(
      ...fence(
        sysHid.devices
          ? sysHid.devices.length
            ? sysHid.devices.map(
                (d) => `${hex4(d.vendorId)}:${hex4(d.productId)}${d.name != null ? ` "${d.name}"` : ''}${d.usages ? ` ${d.usages.map(([p, u]) => `${hex4(p)}:${hex4(u)}`).join(',')}` : ''}`
              )
            : ['(none)']
          : [`scan failed: ${sysHid.error}`]
      )
    );
  }
  if (desktop?.platform === 'linux' && desktop.linux) {
    const st = await desktop.linux.hidrawStatus().catch(() => null);
    if (st) {
      ctx.linuxDenied = st.devices.filter((d) => !d.access).map((d) => d.node);
      L.push('', '### Linux hidraw');
      L.push(
        ...fence([
          `udev rules: /etc=${st.rulesInstalled} /usr/lib=${st.rulesSystem} · needsFix=${st.needsFix}`,
          ...st.devices.map((d) => `${d.node} pid=${hex4(d.productId)} access=${d.access} "${d.name || ''}"`),
        ])
      );
    }
  }

  if (state.profiles.list.length) {
    L.push('', `### Local profiles (current = ${state.curIndex + 1}, xySplit=${state.xySplit})`);
    L.push(...fence(state.profiles.list.map((p, i) => `[${i + 1}] ${p.toText()}`)));
  }
  L.push('', `### Macros (${state.macros.list.length}, structure only — key content omitted for privacy)`);
  L.push(...fence(state.macros.list.length ? macroLines() : ['(none)']));
  if (ctx.missingMacros.length) L.push(`missing from library: ${ctx.missingMacros.join(', ')}`);

  tail.push({ title: 'App events', lines: events.length ? events.map((e) => `${fmtT(e.t)} ${e.msg}`) : ['(none)'], prio: 1, max: 16000 });
  tail.push({
    title: 'Console warnings / errors',
    lines: consoleLog.length ? consoleLog.map((e) => `${fmtT(e.t)} ${e.level.padEnd(9)} ${e.msg}`) : ['(none)'],
    prio: 2,
    max: 10000,
  });
  const prev = desktop?.log?.previous ? await desktop.log.previous().catch(() => null) : null;
  if (prev) {
    ctx.prevLog = prev;
    tail.push({
      title: `Previous session log (last ${prev.lines.length} of ${prev.total} lines, ended cleanly: ${prev.cleanExit ? 'yes' : 'NO'})`,
      lines: prev.lines,
      prio: 6,
      max: 8000,
    });
  }

  L.splice(findingsAt, 0, '', `### ${t.value.diagFindings}`, ...buildFindings(ctx).map((s) => `- ${s}`));

  // 展示顺序：事件、控制台、状态包、收发、失败现场、上次运行
  const order = ['App events', 'Console', 'Recent input', 'Recent transfers', 'Connecting', 'Last connect failure', 'Previous session'];
  tail.sort((a, b) => order.findIndex((o) => a.title.startsWith(o)) - order.findIndex((o) => b.title.startsWith(o)));
  return `${renderTail(L.join('\n'), tail)}\n`;
}

/* ------------------------------------------------------------- 导出 */

const BUSY_WAIT = 6000;
const isBusy = () => state.applying || state.pending > 0 || state.phase === 'connecting';

function busyDesc() {
  if (state.phase === 'connecting') {
    const since = diag.connecting?.since;
    return `connecting${since ? ` for ${secsSince(since)} s` : ''}`;
  }
  return `writing to the mouse (applying=${state.applying}, pending=${state.pending})`;
}

async function writeClipboard(text) {
  if (desktop?.copyText) return desktop.copyText(text);
  await navigator.clipboard.writeText(text);
  return true;
}

async function saveFile(text) {
  const defaultName = `incott-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
  if (desktop) {
    const r = await desktop.saveText({ defaultName, content: text, filters: [{ name: 'Text', extensions: ['txt'] }] });
    return !!r.ok;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

/**
 * @param action 'copy' 复制到剪贴板 | 'save' 保存为文件
 * 鼠标正在写入或正在连接时先等一会儿；仍然忙（多半卡住了）就不发命令，只导出现有记录——这种时候最需要诊断信息。
 */
export async function runDiagnostics(action = 'copy') {
  if (state.diagRunning) return;
  state.diagRunning = true;
  diag.running = true;
  let text;
  let busy = null;
  try {
    // 先于任何等待：requestDevice 需要点击按钮带来的用户手势
    const sysHid = state.phase !== 'ready' ? await scanSystemHid() : null;
    const t0 = Date.now();
    while (isBusy() && Date.now() - t0 < BUSY_WAIT) await sleep(200);
    busy = isBusy() ? busyDesc() : null;
    text = await collectDiagnostics({ busy, sysHid });
  } catch (err) {
    console.error('[diag]', err);
    text = `## INCOTT Driver diagnostics\n\ncollect failed: ${err?.stack || err}\n`;
  } finally {
    diag.running = false;
    state.diagRunning = false;
  }
  if (action === 'save') {
    try {
      if (await saveFile(text)) toast(busy ? t.value.diagSavedBusy : t.value.diagSavedFile, busy ? 'warn' : 'success', 4500);
    } catch (err) {
      console.warn('[diag] save', err);
      toast(t.value.diagFailed, 'error');
    }
    return;
  }
  try {
    await writeClipboard(text);
    toast(busy ? t.value.diagCopiedBusy : t.value.diagCopied, busy ? 'warn' : 'success', 4500);
  } catch (err) {
    console.warn('[diag] clipboard', err);
    if (!desktop) return toast(t.value.diagFailed, 'error');
    if (await saveFile(text).catch(() => false)) toast(t.value.diagSaved, 'success');
  }
}

export const copyDiagnostics = () => runDiagnostics('copy');
export const saveDiagnostics = () => runDiagnostics('save');
