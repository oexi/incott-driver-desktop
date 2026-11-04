// 「复制诊断信息」：正式版没有开发者工具，这是用户把原始数据交给我们的唯一途径。
// 内容：环境、识别结果与连接时的原始回包、状态包统计与解码（两种候选布局）、
// 全部读命令的原始回包与解码、鼠标实际值与本地配置的对照、应用事件、控制台错误、
// HID 设备结构、全部板载配置与宏、最近的原始收发，以及上次连接失败的现场。
// 只发送 0x80–0x8F 的读命令，不会改动鼠标里的任何设置。

import * as C from './protocol/constants.js';
import { IncottDevice, toHex, sleep, modelFromCode, keyToHw, hwToKey } from './protocol/device.js';
import { state, settings, curProfile, effectiveRate, diag, toast, isMock } from './store.js';
import { events, consoleLog, startedAt, uptime } from './diaglog.js';
import { keyLabel } from './functions.js';
import { t } from './i18n.js';

const desktop = typeof window !== 'undefined' ? window.desktop : undefined;

const Q = (label, ...cmd) => ({ label, cmd });
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
const rateOf = (code) => (code >= 0 && code <= 6 ? `${C.RATE_HW[code]}Hz` : `?(${code})`);
const LOD_FW = { 0: '1 mm', 1: '2 mm', 2: '0.7 mm' };
const LOD_PROFILE = { 0: '0.7 mm', 1: '1 mm', 2: '2 mm' };
const SENSOR_MODE = ['LP/节能', 'HP/标准', 'Corded/电竞'];
const u16 = (d, i) => d[i] | (d[i + 1] << 8);
const u32 = (d, i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

function pidKind(pid) {
  if (pid === C.PID_WIRED) return 'wired';
  if (pid === C.PID_WIRELESS) return '2.4G receiver';
  return 'unknown PID';
}

function sensorOf(b) {
  if (b === 240) return 'PAW3395';
  if (b === 241) return 'PAW3950';
  return `unknown → treated as PAW3395`;
}

function withTimeout(p, ms) {
  let timer;
  const limit = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)));
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
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
  return list.length ? list.map((e) => `${fmtT(e.t)} ${e.dir.padEnd(5)} ${e.hex}`) : ['(empty)'];
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

/** 状态包（Report ID 9）的两种候选布局：网页驱动 / 官方桌面驱动 */
function decodeStatus(hex) {
  const d = fromHex(hex);
  if (!d || d.length < 4) return '';
  const web = `web: pwr=${d[0] & 127}% chg=${d[0] >> 7} rate=${rateOf(d[1] & 15)} dpi#=${d[1] >> 4} profile=${(d[2] & 192) >> 6}`;
  const dsk = `desktop: state=${d[0]} bat=${d[1]}% dpi#=${d[2]} rate=${rateOf(d[3])}`;
  return `${web} | ${dsk}`;
}

/** 读命令回包解码；d 为去掉 Report ID 的数据（d[0] 为回显） */
function decodeReply(cmd, d, pid) {
  const [c, sub] = cmd;
  if (!d || d[0] !== c) return '';
  if (sub != null && d[1] !== sub) return `sub-index mismatch (${d[1]})`;
  switch (c) {
    case 0x8f: {
      const si = pid === C.PID_WIRELESS ? 5 : 4;
      return `psd=${d[1]} model=${d[2]}→${modelFromCode(d[2]) || 'UNSUPPORTED'} r3=${hex2(d[3])}${d[3] === 2 ? '(8K)' : ''} r4=${hex2(d[4])} r5=${hex2(d[5])} r6=${hex2(d[6])} sensor@r${si}=${sensorOf(d[si])}`;
    }
    case 0x8e:
      return `id=${[2, 3, 4, 5].map((i) => hex2(d[i])).join('')}${sub === 1 ? ` online=${d[6]}` : ''}`;
    case 0x89:
      return `battery=${d[1]} charge=${d[2]} rate=${rateOf(d[3] & 15)} dpi#=${d[4]} r5=${d[5]} r6=${d[6]} magic=${d[7] === 0x5a ? 'OK' : 'missing'}`;
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

/* ----------------------------------------------------------- 读命令 */

const QUERY_TIMEOUT = 3000; // 单条读命令的超时；探测时收集状态包的时长必须比它短
const PROBE_LISTEN = 2500;

/** 依次发送全部读命令：返回逐行文本 + 原始回包（key = "cmd,sub"） */
async function runQueries(dev, pid) {
  const lines = [];
  const raw = {};
  for (const q of DIAG_QUERIES) {
    let r;
    try {
      r = await withTimeout(dev.rawQuery(q.cmd), QUERY_TIMEOUT);
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
    const dec = echo ? decodeReply(q.cmd, d, pid) : 'NO ECHO';
    lines.push(`${head}${toHex(r.recv)}  ${String(r.ms).padStart(4)}ms  ${q.label}${dec ? ` = ${dec}` : ''}`);
  }
  return { lines, raw };
}

/** 鼠标里的实际值（读回）与当前本地配置的对照 */
function compareWithProfile(raw, pf, dev) {
  const data = (k) => {
    const r = raw[k];
    if (!r || r[1] !== Number(k.split(',')[0])) return null;
    const d = Array.from(r.slice(1));
    const sub = k.split(',')[1];
    return sub != null && d[1] !== Number(sub) ? null : d;
  };
  const rows = [];
  const row = (name, dv, pv) => {
    const mark = dv == null ? '?' : String(dv) === String(pv) ? '✓' : '≠';
    rows.push(`${mark} ${name.padEnd(16)} device ${String(dv ?? '(no data)').padEnd(22)} profile ${pv}`);
  };
  let d;
  d = data('131');
  row('dpi stages', d && d[1], pf.dpi.length);
  row('dpi current', d && d[2], pf.curDpi);
  for (let i = 0; i < 6; i++) {
    d = data(`130,${i}`);
    if (!d && i >= pf.dpi.length) continue;
    row(`dpi #${i + 1} x`, d && (u16(d, 2) + 1) * 50, pf.dpi[i] ?? '-');
  }
  d = data('129');
  row('rate', d && rateOf(d[1]), rateOf(C.RATE_HW.indexOf(effectiveRate.value)));
  d = data('132,1');
  row('LOD', d && (LOD_FW[d[2]] ?? `fw ${d[2]}`), LOD_PROFILE[pf.lod] ?? pf.lod);
  d = data('132,2');
  row('ripple', d && !!d[2], pf.ripple);
  d = data('132,3');
  row('angle snap', d && !!d[2], pf.fixline);
  d = data('132,4');
  row('motion sync', d && !!d[2], pf.motion);
  d = data('132,5');
  row('sensor mode', d && (SENSOR_MODE[d[2]] ?? d[2]), SENSOR_MODE[pf.sensormode] ?? pf.sensormode);
  d = data('133,1');
  row('debounce', d && d[2], pf.debounce);
  d = data('133,3');
  row('sleep', d && u16(d, 2), pf.sleeptime);
  // 火力键参数在固件里是全局的，只有配置里有火力键时才可比
  const fire = pf.key.find((k) => k.major === C.fMouse && k.minor === C.favFIRE);
  d = data('133,2');
  row('fire (global)', d && `${d[2]}x/${u16(d, 3)}ms`, fire ? `${Math.min(3, fire.itemdata & 65535)}x/${Math.min(255, (fire.itemdata >> 16) & 65535)}ms` : '(no fire key)');
  if (dev.is8KReceiver) {
    d = data('136');
    row('receiver LED', d && d[1], pf.receiverLED);
  }
  C.dvar.key.forEach((dk, i) => {
    d = data(`134,${dk.matrix}`);
    const want = keyToHw(pf.key[i], i);
    row(`key ${i + 1} (m${dk.matrix})`, d && `0x${u32(d, 2).toString(16)}`, want === -1 ? '(not writable)' : `0x${(want >>> 0).toString(16)}`);
  });
  d = data('134,9');
  row('onboard profile', d && u32(d, 2), state.curIndex);
  // 超出已知 6 个按键的槽位：本软件不会写入，有非零码说明鼠标可能有额外按键
  for (const m of [6, 7, 8, 10, 11, 12, 13, 14, 15]) {
    d = data(`134,${m}`);
    const code = d && u32(d, 2);
    if (code) rows.push(`• extra slot m${String(m).padEnd(10)} device 0x${code.toString(16).padEnd(20)} ${describeCode(code)} (not managed by this app)`);
  }
  return rows;
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

/** 关键信息：型号码、PID、连接时 143 / 142 / 137 / 131 / 134,9 回包原文、状态包数量与最近几包 */
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

/* --------------------------------------------------------------- 探测 */

/** 未连接时：临时打开设备，发读命令，顺便收集一会儿状态包，然后关闭 */
async function probe(hid) {
  const dev = new IncottDevice(hid);
  let openedHere = false;
  try {
    if (!hid.opened) {
      await hid.open();
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

/* --------------------------------------------------------------- 主体 */

const MAX_TEXT = 60000; // GitHub Issue 正文上限 65536

export async function collectDiagnostics() {
  const L = [];
  const tail = []; // 体积最大、可截断的部分放最后
  const info = desktop ? await desktop.info().catch(() => null) : null;
  const dev = state.device;

  L.push('## INCOTT Driver diagnostics', '');
  L.push(`- time: ${new Date().toISOString()} (app started ${startedAt}, uptime ${Math.round(uptime() / 1000)} s)`);
  if (info) {
    L.push(`- app: v${info.version} (${info.install || '?'}) · Electron ${info.electron} · Chromium ${info.chrome}`);
    L.push(`- os: ${info.os || info.platform} · ${info.platform}-${info.arch}${info.session ? ` · ${info.session}` : ''}${info.desktop ? ` · ${info.desktop}` : ''} · locale ${info.locale || '?'}`);
  } else {
    L.push(`- browser: ${navigator.userAgent}`);
  }
  L.push(`- ui: lang=${settings.lang} theme=${settings.theme} closeToTray=${settings.closeToTray} phase=${state.phase}${isMock ? ' · MOCK' : ''}`);
  if (state.error) L.push(`- error: ${state.error.title} — ${state.error.message}`);
  L.push('- `*` = command only seen in the official desktop driver; replies may be meaningless on some firmware');
  L.push('- device log times (+ms) are relative to opening the device; event / console times to app start');

  let granted = [];
  try {
    granted = isMock ? (dev ? [dev.hid] : []) : navigator.hid ? await navigator.hid.getDevices() : [];
  } catch (err) {
    L.push(`- navigator.hid.getDevices failed: ${err?.message || err}`);
  }

  if (dev) {
    // 先快照记录，避免混进下面诊断查询本身的收发
    const xfer = dev.xferLog.slice();
    const input = dev.inputLog.slice();
    const src = { inputLog: input, inputCount: dev.inputCount, inputById: { ...dev.inputById } };
    const pid = dev.hid.productId;
    L.push('', '### Summary (connected)');
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
            `ui now         power=${state.info.power} charging=${state.info.charging} rate=${state.info.rate} profile=${state.curIndex + 1} firstRun=${state.firstRun} pending=${state.pending}`,
          ],
        })
      )
    );

    L.push('', '### Input reports decoded (last 10, both candidate layouts)');
    const last10 = input.filter((e) => e.dir === 'in#9').slice(-10);
    L.push(...fence(last10.length ? last10.map((e) => `${fmtT(e.t)} ${e.hex.slice(0, 23)}  ${decodeStatus(e.hex)}`) : ['(none received)']));

    const q = await runQueries(dev, pid);
    const pf = curProfile.value;
    if (pf) {
      L.push('', `### Device vs profile ${state.curIndex + 1} (read back now)`);
      L.push(...fence(compareWithProfile(q.raw, pf, dev)));
    }
    L.push('', '### Raw queries (sent → reply incl. report ID, round trip)');
    L.push(...fence(q.lines));

    tail.push({ title: 'Recent input reports (raw)', lines: fmtLog(input) });
    tail.push({ title: 'Recent transfers (raw)', lines: fmtLog(xfer), trim: true });
  } else {
    const targets = granted.filter(isIncott);
    if (!targets.length) L.push('', '(no INCOTT vendor collection granted — nothing to probe)');
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
      L.push(
        ...fence(
          summary({
            pid: hid.productId,
            modelCode: m && m[1] === 0x8f ? m[3] : null,
            replies,
            inputSrc: r.dev,
          })
        )
      );
      L.push('Input reports decoded:');
      const ins = r.dev.inputLog.filter((e) => e.dir === 'in#9').slice(-10);
      L.push(...fence(ins.length ? ins.map((e) => `${fmtT(e.t)} ${e.hex.slice(0, 23)}  ${decodeStatus(e.hex)}`) : ['(none received)']));
      L.push('Raw queries:');
      L.push(...fence(r.lines));
    }
  }

  const f = diag.lastFailure;
  if (f) {
    L.push('', `### Last connect failure (${f.time})`);
    L.push(...fence([`error ${f.error} · "${f.productName}"`, ...summary({ pid: f.productId, modelCode: f.modelCode, replies: f.replies || {}, inputSrc: f })]));
    tail.push({ title: 'Last connect failure: transfers', lines: fmtLog(f.xferLog) });
  }

  L.push('', '### App events');
  L.push(...fence(events.length ? events.map((e) => `${fmtT(e.t)} ${e.msg}`) : ['(none)']));
  L.push('', '### Console warnings / errors');
  L.push(...fence(consoleLog.length ? consoleLog.map((e) => `${fmtT(e.t)} ${e.level.padEnd(9)} ${e.msg}`) : ['(none)']));

  L.push('', '### HID devices (granted)');
  L.push(...fence(granted.length ? granted.flatMap(describeHid) : ['(none)']));
  if (desktop?.platform === 'linux' && desktop.linux) {
    const st = await desktop.linux.hidrawStatus().catch(() => null);
    if (st) {
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
  L.push('', `### Macros (${state.macros.list.length})`);
  const macroText = state.macros.list.map((m) => m.toText()).join('\n');
  L.push(...fence(macroText ? [macroText.length > 8000 ? `${macroText.slice(0, 8000)} …(truncated)` : macroText] : ['(none)']));

  // 原始收发记录最长，超出上限时从最早的记录开始截掉
  let text = L.join('\n');
  for (const s of tail) {
    let lines = s.lines;
    const budget = MAX_TEXT - text.length - s.title.length - 40;
    if (s.trim) {
      let size = lines.reduce((n, l) => n + l.length + 1, 0);
      let cut = 0;
      while (size > budget && cut < lines.length) size -= lines[cut++].length + 1;
      if (cut) lines = [`…(${cut} older lines omitted)`, ...lines.slice(cut)];
    }
    text += `\n\n### ${s.title}\n${fence(lines).join('\n')}`;
  }
  return text + '\n';
}

async function writeClipboard(text) {
  if (desktop?.copyText) return desktop.copyText(text);
  await navigator.clipboard.writeText(text);
  return true;
}

export async function copyDiagnostics() {
  if (state.diagRunning) return;
  if (state.applying || state.pending || state.phase === 'connecting') return toast(t.value.diagBusy, 'warn');
  state.diagRunning = true;
  diag.running = true;
  let text;
  try {
    text = await collectDiagnostics();
  } catch (err) {
    console.error('[diag]', err);
    text = `## INCOTT Driver diagnostics\n\ncollect failed: ${err?.stack || err}\n`;
  } finally {
    diag.running = false;
    state.diagRunning = false;
  }
  try {
    await writeClipboard(text);
    toast(t.value.diagCopied, 'success', 4500);
  } catch (err) {
    console.warn('[diag] clipboard', err);
    if (!desktop) return toast(t.value.diagFailed, 'error');
    const r = await desktop.saveText({
      defaultName: `incott-diagnostics-${Date.now()}.txt`,
      content: text,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (r.ok) toast(t.value.diagSaved, 'success');
  }
}
