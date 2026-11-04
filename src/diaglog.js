// 诊断用的运行日志：应用事件 + 控制台警告/错误 + 未捕获异常。
// 正式版没有开发者工具，这些只能靠「复制诊断信息」带出来。必须在其它模块之前加载。

const MAX_EVENTS = 150;
const MAX_CONSOLE = 60;
const t0 = Date.now();

export const events = [];
export const consoleLog = [];

const stamp = () => Date.now() - t0;

function push(list, max, entry) {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}

function fmtArg(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** 记录一条应用事件（连接、断开、写入、切换配置……） */
export function logEvent(msg) {
  push(events, MAX_EVENTS, { t: stamp(), msg });
}

export const startedAt = new Date(t0).toISOString();
export const uptime = stamp;

let installed = false;
export function installConsoleCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      push(consoleLog, MAX_CONSOLE, { t: stamp(), level, msg: args.map(fmtArg).join(' ').slice(0, 500) });
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    push(consoleLog, MAX_CONSOLE, { t: stamp(), level: 'uncaught', msg: `${e.message} @ ${e.filename}:${e.lineno}` });
  });
  window.addEventListener('unhandledrejection', (e) => {
    push(consoleLog, MAX_CONSOLE, { t: stamp(), level: 'rejection', msg: fmtArg(e.reason).slice(0, 500) });
  });
}

installConsoleCapture();
