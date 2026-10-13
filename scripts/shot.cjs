// 开发辅助：用模拟设备离屏渲染各页面并截图（electron scripts/shot.cjs <输出目录> [theme] [lang]）
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const out = path.resolve(process.argv[2] || 'shots');
const theme = process.argv[3] || 'dark';
const lang = process.argv[4] || 'zh';
const real = process.argv[5] === 'real'; // 连接真实设备（连接过程只读）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  ipcMain.handle('win:is-maximized', () => false);
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setDevicePermissionHandler((d) => d.deviceType === 'hid' && d.device.vendorId === 0x093a);
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.on('theme:set', () => {});
  ipcMain.on('tray:set', () => {});
  fs.mkdirSync(out, { recursive: true });
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    frame: false,
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), backgroundThrottling: false, offscreen: true },
  });
  await w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { search: real ? 'debug' : 'mock' });
  const run = (js) => w.webContents.executeJavaScript(js);
  await run(`localStorage.clear(); __app.settings.theme='${theme}'; __app.settings.lang='${lang}'; __app.settings.firstRunAck=true; __app.saveSettings();`);
  const shot = async (name) => {
    await sleep(700);
    console.log('capturing', name);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    console.log('saved', name);
  };
  if (!real) {
    await run(`__app.state.phase='welcome'`);
    await shot('0-welcome');
    await run(`document.querySelector('.status-card .btn.primary')?.click()`);
  }
  await sleep(real ? 4000 : 1500);
  console.log(await run(`JSON.stringify({ phase: __app.state.phase, cur: __app.state.curIndex, devCur: __app.state.device && __app.state.device.curDpi, levels: __app.state.device && __app.state.device.dpiLevels, pfCur: __app.state.profiles.list.map(p => p.curDpi), first: __app.state.firstRun, keys: __app.state.profiles.list[0].key.map(k => k.major + ":" + k.minor) })`));
  for (const p of ['buttons', 'performance', 'advanced', 'macros']) {
    await run(`__app.state.page='${p}'`);
    await shot(`1-${p}`);
  }
  if (!real) {
    await run(`(async () => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.list-actions .btn.primary').click(); await s(200);
      document.querySelector('.rec-btn').click(); await s(100);
      for (const [code, d] of [['ControlLeft', 40], ['KeyC', 60], ['KeyC', 30], ['ControlLeft', 120], ['KeyV', 50], ['KeyV', 10]]) {
        const down = !window.__down?.[code]; window.__down = { ...(window.__down || {}), [code]: down };
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true })); await s(d);
      }
      document.querySelector('.pad-head .btn.danger').click();
    })()`);
    await shot('3-macro-edit');
    await run(`__app.state.dialog = { title: '确认修改', message: '当前只剩这一个按键是"左键"，修改后可能无法正常点击。确定继续吗？', okText: '仍要修改', cancelText: '取消', danger: true, icon: 'warn', resolve: () => (__app.state.dialog = null) }; 0`);
    await shot('4-dialog');
    await run(`__app.state.dialog = null`);
  }
  await run(`__app.state.settingsOpen=true`);
  await shot('2-settings');
  app.quit();
});
