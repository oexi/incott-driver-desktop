'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onState: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('win:state', fn);
      return () => ipcRenderer.removeListener('win:state', fn);
    },
  },
  setTheme: (source) => ipcRenderer.send('theme:set', source),
  setTray: (enabled) => ipcRenderer.send('tray:set', enabled),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  openClassic: () => ipcRenderer.send('classic:open'),
  onClassicClosed: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('classic:closed', fn);
    return () => ipcRenderer.removeListener('classic:closed', fn);
  },
  saveText: (opts) => ipcRenderer.invoke('file:save-text', opts),
  openText: (opts) => ipcRenderer.invoke('file:open-text', opts),
  linux: {
    hidrawStatus: () => ipcRenderer.invoke('linux:hidraw-status'),
    installUdev: () => ipcRenderer.invoke('linux:install-udev'),
  },
});
