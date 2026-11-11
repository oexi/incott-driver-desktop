// 桌面版（Tauri）的宿主接口：提供 window.desktop（窗口、文件、日志、Linux udev……），以及 navigator.hid 的替代实现。
// WebKit（Linux / macOS 的系统 webview）没有 WebHID，HID 收发交给 Rust（src-tauri/src/hid.rs）。
// 必须最先加载：diaglog.js、store.js 在模块加载时就读取 window.desktop。
// 不在 Tauri 里（浏览器 ?mock 预览、测试）时什么都不做。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

function toBytes(data) {
  if (data instanceof Uint8Array) return Array.from(data);
  if (ArrayBuffer.isView(data)) return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (data instanceof ArrayBuffer) return Array.from(new Uint8Array(data));
  return Array.from(data || []);
}

function hidError(err) {
  return err instanceof Error ? err : new DOMException(String(err), 'NetworkError');
}

/* ------------------------------------------------------------ navigator.hid */

class TauriHidDevice extends EventTarget {
  constructor(info) {
    super();
    this._id = info.id;
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName || '';
    this.collections = info.collections || [];
    this.opened = false;
  }

  async open() {
    if (this.opened) throw new DOMException('The device is already open.', 'InvalidStateError');
    await invoke('hid_open', { id: this._id }).catch((e) => {
      throw hidError(e);
    });
    this.opened = true;
  }

  async close() {
    if (!this.opened) return;
    this.opened = false;
    await invoke('hid_close', { id: this._id }).catch(() => {});
  }

  async forget() {
    await this.close();
  }

  _check() {
    if (!this.opened) throw new DOMException('The device must be opened first.', 'InvalidStateError');
  }

  async sendFeatureReport(reportId, data) {
    this._check();
    await invoke('hid_send_feature', { id: this._id, reportId, data: toBytes(data) }).catch((e) => {
      throw hidError(e);
    });
  }

  async sendReport(reportId, data) {
    this._check();
    await invoke('hid_send_output', { id: this._id, reportId, data: toBytes(data) }).catch((e) => {
      throw hidError(e);
    });
  }

  /** 与 WebHID 一致：第 0 字节是报告 ID */
  async receiveFeatureReport(reportId) {
    this._check();
    const bytes = await invoke('hid_receive_feature', { id: this._id, reportId }).catch((e) => {
      throw hidError(e);
    });
    return new DataView(new Uint8Array(bytes).buffer);
  }
}

function matchFilter(d, f) {
  if (f.vendorId != null && f.vendorId !== d.vendorId) return false;
  if (f.productId != null && f.productId !== d.productId) return false;
  if (f.usagePage == null && f.usage == null) return true;
  return d.collections.some((c) => (f.usagePage == null || c.usagePage === f.usagePage) && (f.usage == null || c.usage === f.usage));
}

class TauriHid extends EventTarget {
  constructor() {
    super();
    this._devices = new Map(); // 路径 → 设备对象：同一个设备始终是同一个对象（store / device.js 按对象比较）
    this.scanning = false;
  }

  _upsert(info) {
    let d = this._devices.get(info.id);
    if (!d) {
      d = new TauriHidDevice(info);
      this._devices.set(info.id, d);
    }
    return d;
  }

  async getDevices() {
    const list = await invoke('hid_list');
    const ids = new Set(list.map((i) => i.id));
    // 拔掉的设备轮询还没报告时，先从缓存里去掉没打开的那些
    for (const [id, d] of this._devices) if (!ids.has(id) && !d.opened) this._devices.delete(id);
    return list.map((i) => this._upsert(i));
  }

  /** INCOTT 设备自动授权（与 1.x 的 Electron 版一样），这里只是按过滤条件挑选；诊断扫描期间返回空列表 */
  async requestDevice({ filters = [] } = {}) {
    if (this.scanning) return [];
    const all = await this.getDevices();
    return filters.length ? all.filter((d) => filters.some((f) => matchFilter(d, f))) : all;
  }

  _onConnect(info) {
    const device = this._upsert(info);
    const ev = new Event('connect');
    ev.device = device;
    this.dispatchEvent(ev);
  }

  _onDisconnect(id) {
    const device = this._devices.get(id);
    if (!device) return;
    this._devices.delete(id);
    device.opened = false;
    const ev = new Event('disconnect');
    ev.device = device;
    this.dispatchEvent(ev);
  }

  _onInput({ id, reportId, data }) {
    const device = this._devices.get(id);
    if (!device || !device.opened) return;
    const ev = new Event('inputreport');
    ev.device = device;
    ev.reportId = reportId;
    ev.data = new DataView(new Uint8Array(data).buffer);
    device.dispatchEvent(ev);
  }
}

/* --------------------------------------------------- Linux 自绘窗口边框 */

// 窗口是透明的，四周 12px 阴影区由页面画（base.css 的 html.csd）。Tauri 自带的缩放热区只有窗口最外 5px，
// 这里让整个阴影区和边框内侧几像素都能拖动缩放，靠近四角时斜向缩放
function setupLinuxFrame() {
  const root = document.documentElement;
  root.classList.add('csd', 'focused');
  invoke('win_is_maximized').then((m) => root.classList.toggle('maximized', !!m));
  listen('win:state', (e) => root.classList.toggle('maximized', !!e.payload?.maximized));
  listen('win:focus', (e) => root.classList.toggle('focused', !!e.payload));

  const INSIDE = 4; // 边框内侧也算边缘的宽度
  const CORNER = 16; // 离角这么近时斜向缩放
  const CURSOR = { North: 'n-resize', South: 's-resize', East: 'e-resize', West: 'w-resize', NorthEast: 'ne-resize', NorthWest: 'nw-resize', SouthEast: 'se-resize', SouthWest: 'sw-resize' };
  const dirAt = (x, y) => {
    if (root.classList.contains('maximized')) return null;
    const r = document.querySelector('.app')?.getBoundingClientRect();
    if (!r) return null;
    const top = y < r.top + INSIDE;
    const bottom = y > r.bottom - INSIDE;
    const left = x < r.left + INSIDE;
    const right = x > r.right - INSIDE;
    if (!top && !bottom && !left && !right) return null;
    const v = top || ((left || right) && y < r.top + CORNER) ? 'North' : bottom || ((left || right) && y > r.bottom - CORNER) ? 'South' : '';
    const h = left || ((top || bottom) && x < r.left + CORNER) ? 'West' : right || ((top || bottom) && x > r.right - CORNER) ? 'East' : '';
    return v + h;
  };
  let shown = null;
  window.addEventListener(
    'mousemove',
    (e) => {
      const d = dirAt(e.clientX, e.clientY);
      if (d === shown) return;
      shown = d;
      document.body.style.cursor = d ? CURSOR[d] : '';
    },
    true
  );
  window.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      const d = dirAt(e.clientX, e.clientY);
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      getCurrentWindow().startResizeDragging(d).catch(() => {});
    },
    true
  );
}

/* ----------------------------------------------------------- window.desktop */

function install() {
  const platform = window.__INCOTT__?.platform || 'linux';
  const hid = new TauriHid();
  listen('hid:connect', (e) => hid._onConnect(e.payload));
  listen('hid:disconnect', (e) => hid._onDisconnect(e.payload.id));
  listen('hid:input', (e) => hid._onInput(e.payload));
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
  if (platform === 'linux') setupLinuxFrame();

  let theme = null;
  let tray = null;
  window.desktop = {
    isDesktop: true,
    shell: 'tauri',
    platform,
    info: () => invoke('app_info'),
    win: {
      minimize: () => invoke('win_minimize'),
      toggleMaximize: () => invoke('win_toggle_maximize'),
      close: () => invoke('win_close'),
      isMaximized: () => invoke('win_is_maximized'),
      onState: (cb) => {
        const un = listen('win:state', (e) => cb(e.payload));
        return () => un.then((f) => f());
      },
      startDrag: () => invoke('win_start_drag'),
      reveal: () => invoke('win_reveal').catch(() => {}),
    },
    setTheme: (source) => {
      if (source === theme) return;
      theme = source;
      invoke('set_theme', { source }).catch(() => {});
    },
    setTray: (enabled) => {
      if (!!enabled === tray) return;
      tray = !!enabled;
      invoke('set_tray', { enabled: tray }).catch(() => {});
    },
    openExternal: (url) => invoke('open_external', { url: String(url) }).catch(() => {}),
    saveText: (opts) => invoke('save_text', { opts }),
    openText: (opts) => invoke('open_text', { opts: opts || {} }),
    copyText: async (text) => {
      try {
        return await invoke('copy_text', { text: String(text ?? '') });
      } catch {
        await navigator.clipboard.writeText(String(text ?? ''));
        return true;
      }
    },
    log: {
      append: (line) => invoke('log_append', { line: String(line) }).catch(() => {}),
      previous: () => invoke('log_previous'),
      onMainEvent: (cb) => listen('diag:main-event', (e) => cb(e.payload)),
    },
    hidScan: async (on) => {
      if (on) {
        hid.scanning = true;
        return true;
      }
      hid.scanning = false;
      return invoke('hid_list_all');
    },
    linux: {
      hidrawStatus: () => invoke('linux_hidraw_status'),
      installUdev: () => invoke('linux_install_udev'),
    },
  };

  // WebKit 自带的右键菜单（后退 / 重新加载……）对应用没有意义，1.x 的 Electron 版也没有右键菜单。
  // 输入框里保留剪切 / 复制 / 粘贴
  document.addEventListener('contextmenu', (e) => {
    const el = e.target instanceof Element ? e.target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') : null;
    const editable = el && !(el instanceof HTMLInputElement && ['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type));
    if (!editable) e.preventDefault();
  });

  // 诊断用：webview 版本与它看到的深色模式（Linux 上由 Rust 按系统设置告诉 GTK，见 linux.rs）
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  const ua = /AppleWebKit\/[\d.]+|Edg\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] || navigator.userAgent;
  window.desktop.log.append(`[ui] webview ${ua} · prefers-color-scheme dark=${mq?.matches}`);
  mq?.addEventListener('change', (e) => window.desktop.log.append(`[ui] prefers-color-scheme dark=${e.matches}`));
}

if (isTauri) install();
