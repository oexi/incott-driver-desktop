'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog, Menu, Tray, nativeImage, session, clipboard, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { linuxHidrawStatus, installUdevRules } = require('./linux-udev.cjs');

const INCOTT_VENDOR_ID = 0x093a;
const IS_MAC = process.platform === 'darwin';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const ROOT = path.join(__dirname, '..');

let mainWindow = null;
let tray = null;
let quitting = false;
let closeToTray = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => showMain());

function resolveAsset(...p) {
  return path.join(app.isPackaged ? process.resourcesPath : path.join(ROOT, 'build'), ...p);
}

function showMain() {
  if (!mainWindow) return createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------ 诊断日志 */

// 应用事件与控制台错误同时写入本机文件（userData/logs），软件重启或崩溃后，
// 诊断信息里仍能看到上一次运行的记录。只保存在本机，不会上传。
const LOG_MAX = 1024 * 1024;
const PREV_TAIL = 150;
let logDir = null;
let logFile = null;
let logSize = 0;

function initLog() {
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'diag.log');
    if (fs.existsSync(logFile)) fs.renameSync(logFile, path.join(logDir, 'diag.prev.log'));
    appendLog(`=== session start v${app.getVersion()} ${process.platform}-${process.arch} ${osPrettyName()}`);
  } catch {
    logFile = null;
  }
}

/** force：超过大小上限后仍然写入（用于"正常退出"标记，否则写满的日志会被误判为异常退出） */
function appendLog(line, force = false) {
  if (!logFile || (logSize > LOG_MAX && !force)) return;
  const s = `${new Date().toISOString()} ${String(line).slice(0, 1000)}\n`;
  logSize += Buffer.byteLength(s);
  try {
    // 同步写：崩溃前的最后几行也能落盘；事件很少，不影响性能
    fs.appendFileSync(logFile, logSize > LOG_MAX ? `${s}=== log size limit reached, later lines dropped\n` : s);
  } catch {
    /* ignore */
  }
}

function readPrevLog() {
  if (!logDir) return null;
  const file = path.join(logDir, 'diag.prev.log');
  try {
    const st = fs.statSync(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const last = lines.at(-1) || '';
    return {
      modified: st.mtime.toISOString(),
      total: lines.length,
      cleanExit: /=== session end/.test(last),
      lines: lines.slice(-PREV_TAIL),
    };
  } catch {
    return null;
  }
}

/** 主进程事件（休眠 / 唤醒、渲染进程崩溃……）：写入日志，并转给页面记入事件列表 */
function mainEvent(msg) {
  appendLog(`[main] ${msg}`);
  mainWindow?.webContents.send('diag:main-event', msg);
}

/* ---------------------------------------------------------------- WebHID */

// 诊断用：列出系统里全部 HID 设备（不授权任何设备），用来判断"找不到设备"时接收器到底有没有被系统识别
let hidScan = null;

function summarizeHid(d) {
  return {
    vendorId: d.vendorId,
    productId: d.productId,
    // 其它厂商的设备名可能是用户自己起的（例如蓝牙设备），只保留 INCOTT（Pixart）的
    name: d.vendorId === INCOTT_VENDOR_ID ? d.name || '' : undefined,
    usages: Array.isArray(d.collections) ? d.collections.map((c) => [c.usagePage, c.usage]) : undefined,
  };
}

function setupHid(ses) {
  // 只加载本地页面，权限检查全部放行（其中包括 WebHID 所需的 'hid'）
  ses.setPermissionCheckHandler(() => true);
  // 对 INCOTT（Pixart 093A）设备自动授权：navigator.hid.getDevices() 直接可见，无需每次手动选择
  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'hid') return details.device.vendorId === INCOTT_VENDOR_ID;
    return false;
  });
  // navigator.hid.requestDevice() 的选择器：Electron 没有自带 UI，这里自动挑选匹配设备
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const list = details.deviceList || [];
    if (hidScan) {
      hidScan.devices = list.map(summarizeHid);
      callback('');
      return;
    }
    const pick = list.find((d) => d.vendorId === INCOTT_VENDOR_ID) || list[0];
    callback(pick ? pick.deviceId : '');
  });
}

/* --------------------------------------------------------------- windows */

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#0e0f13' : '#f4f5f8';
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    frame: IS_MAC,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: windowBackground(),
    icon: resolveAsset('icon.png'),
    title: 'Incott Driver',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('unresponsive', () => appendLog('[main] window unresponsive'));
  mainWindow.on('responsive', () => appendLog('[main] window responsive again'));
  mainWindow.webContents.on('render-process-gone', (_e, d) => appendLog(`[main] renderer gone: ${d.reason} (exit ${d.exitCode})`));
  mainWindow.on('maximize', () => mainWindow.webContents.send('win:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:state', { maximized: false }));
  mainWindow.on('close', (e) => {
    if (!quitting && closeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 应用只有一个页面，不会自己跳转：其它导航一律拦下。以前只拦 http(s)，把文件拖进窗口时会打开那个文件、替换整个界面
  // （无边框窗口连关闭按钮都没了），被打开的页面还能用 preload 暴露的全部接口
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(ROOT, 'dist', 'index.html'));
}

/* ------------------------------------------------------------------ tray */

function ensureTray(enabled) {
  closeToTray = enabled;
  if (!enabled) {
    if (tray) tray.destroy();
    tray = null;
    return;
  }
  if (tray) return;
  let img = nativeImage.createFromPath(resolveAsset(IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (img.isEmpty()) img = nativeImage.createFromPath(resolveAsset('icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Incott Driver');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口 / Show', click: () => showMain() },
      { type: 'separator' },
      {
        label: '退出 / Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => showMain());
}

/* ------------------------------------------------------------------- IPC */

function senderWindow(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

function osPrettyName() {
  if (process.platform !== 'linux') return `${os.type()} ${os.release()}`;
  try {
    const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
    return `${m ? m[1] : 'Linux'} (kernel ${os.release()})`;
  } catch {
    return `Linux ${os.release()}`;
  }
}

function installKind() {
  if (!app.isPackaged) return 'dev';
  if (process.env.APPIMAGE) return 'AppImage';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  if (process.platform === 'linux' && process.execPath.startsWith('/opt/')) return 'system package';
  return 'packaged';
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  // 以下仅用于诊断信息（不含用户名、路径等个人信息）
  os: osPrettyName(),
  locale: app.getLocale(),
  install: installKind(),
  session: process.env.XDG_SESSION_TYPE || '',
  desktop: process.env.XDG_CURRENT_DESKTOP || '',
}));

ipcMain.on('win:minimize', (e) => senderWindow(e)?.minimize());
ipcMain.on('win:toggle-maximize', (e) => {
  const w = senderWindow(e);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', (e) => senderWindow(e)?.close());
ipcMain.handle('win:is-maximized', (e) => !!senderWindow(e)?.isMaximized());

ipcMain.on('theme:set', (_e, source) => {
  if (['system', 'light', 'dark'].includes(source)) nativeTheme.themeSource = source;
});

ipcMain.on('tray:set', (_e, enabled) => ensureTray(!!enabled));

ipcMain.on('open:external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});

ipcMain.handle('file:save-text', async (e, { defaultName, content, filters }) => {
  const res = await dialog.showSaveDialog(senderWindow(e), {
    defaultPath: defaultName,
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(res.filePath, content, 'utf8');
  return { ok: true, path: res.filePath };
});

ipcMain.handle('file:open-text', async (e, { filters }) => {
  const res = await dialog.showOpenDialog(senderWindow(e), {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const p = res.filePaths[0];
  const content = await fs.promises.readFile(p, 'utf8');
  return { ok: true, path: p, name: path.basename(p), content };
});

ipcMain.handle('clipboard:write-text', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.on('log:append', (_e, line) => appendLog(line));
ipcMain.handle('log:previous', () => readPrevLog());

ipcMain.handle('diag:hid-scan', (_e, on) => {
  if (on) {
    const scan = { devices: null };
    hidScan = scan;
    // 万一页面没有收尾，过几秒自动恢复正常的设备选择
    setTimeout(() => hidScan === scan && (hidScan = null), 8000);
    return true;
  }
  const devices = hidScan?.devices ?? null;
  hidScan = null;
  return devices;
});

ipcMain.handle('linux:hidraw-status', () => linuxHidrawStatus(INCOTT_VENDOR_ID));
ipcMain.handle('linux:install-udev', () => installUdevRules());

/* ------------------------------------------------------------- lifecycle */

app.whenReady().then(() => {
  if (!gotLock) return;
  if (!IS_MAC) Menu.setApplicationMenu(null);
  initLog();
  setupHid(session.defaultSession);
  createMainWindow();
  powerMonitor.on('suspend', () => mainEvent('system suspend'));
  powerMonitor.on('resume', () => mainEvent('system resume'));
  app.on('child-process-gone', (_e, d) => appendLog(`[main] child process gone: ${d.type} ${d.reason}`));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMain();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => appendLog('=== session end', true));

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
