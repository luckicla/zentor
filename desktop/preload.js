'use strict';
// Lo que la página de MixUp puede pedirle a la app de escritorio
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('MixUpShell', {
  info: () => ipcRenderer.invoke('shell', 'info'),
  setIcon: name => ipcRenderer.invoke('shell', 'icon', name),
  check: () => ipcRenderer.invoke('shell', 'check'),
  install: () => ipcRenderer.invoke('shell', 'install'),
  download: () => ipcRenderer.invoke('shell', 'download'),
  state: () => ipcRenderer.invoke('shell', 'state'),
  // window: 'min' | 'max' (toggle) | 'close' | '' (just the state) → { max, full }
  win: what => ipcRenderer.invoke('shell', 'win', what || ''),
  onWin: cb => { const f = (_e, s) => cb(s); ipcRenderer.on('shell-win', f); return () => ipcRenderer.removeListener('shell-win', f); },
  onUpdate: cb => { const f = (_e, s) => cb(s); ipcRenderer.on('shell-update', f); return () => ipcRenderer.removeListener('shell-update', f); },
});
