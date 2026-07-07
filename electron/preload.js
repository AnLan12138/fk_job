const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Resume ──
  saveResume: (data) => ipcRenderer.invoke('resume:save', data),
  loadResume: () => ipcRenderer.invoke('resume:load'),

  // ── Auth ──
  getAuthStatus: () => ipcRenderer.invoke('auth:status'),
  startLogin: (platform) => ipcRenderer.invoke('auth:login', platform),
  verifyAuth: (platform) => ipcRenderer.invoke('auth:verify', platform),

  // ── Filter ──
  saveFilter: (data) => ipcRenderer.invoke('filter:save', data),
  loadFilter: () => ipcRenderer.invoke('filter:load'),

  // ── Delivery ──
  startDelivery: (config) => ipcRenderer.invoke('delivery:start', config),
  stopDelivery: () => ipcRenderer.invoke('delivery:stop'),
  onDeliveryProgress: (callback) => {
    ipcRenderer.on('delivery:progress', (event, data) => callback(data));
  },

  // ── History ──
  getHistory: (limit) => ipcRenderer.invoke('history:list', limit),

  // ── Progress log ──
  getProgressLog: () => ipcRenderer.invoke('progress:list'),
  clearProgressLog: () => ipcRenderer.invoke('progress:clear'),

  // ── 诊断（临时） ──
  diagnose: (platform) => ipcRenderer.invoke('diagnose:start', platform)
});
