'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog, Menu, Tray, nativeImage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { linuxHidrawStatus, installUdevRules } = require('./linux-udev.cjs');

const INCOTT_VENDOR_ID = 0x093a;
const IS_MAC = process.platform === 'darwin';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const ROOT = path.join(__dirname, '..');

let mainWindow = null;
let classicWindow = null;
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

/* ---------------------------------------------------------------- WebHID */

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
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    if (/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(ROOT, 'dist', 'index.html'));
}

function classicIndexPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'classic', 'index.html')
    : path.join(ROOT, 'classic', 'index.html');
}

function openClassicWindow() {
  if (classicWindow) {
    classicWindow.focus();
    return;
  }
  classicWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    title: 'Incott Driver — 经典界面',
    icon: resolveAsset('icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#ede9e6',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  classicWindow.setMenuBarVisibility(false);
  classicWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  classicWindow.on('closed', () => {
    classicWindow = null;
    if (mainWindow) mainWindow.webContents.send('classic:closed');
  });
  classicWindow.loadFile(classicIndexPath());
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

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
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

ipcMain.on('classic:open', () => openClassicWindow());

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

ipcMain.handle('linux:hidraw-status', () => linuxHidrawStatus(INCOTT_VENDOR_ID));
ipcMain.handle('linux:install-udev', () => installUdevRules());

/* ------------------------------------------------------------- lifecycle */

app.whenReady().then(() => {
  if (!gotLock) return;
  if (!IS_MAC) Menu.setApplicationMenu(null);
  setupHid(session.defaultSession);
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMain();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
