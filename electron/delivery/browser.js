/**
 * browser.js — BrowserWindow 工厂 + stealth 反检测注入
 *
 * 职责：
 * 1. 创建带 session partition 的 BrowserWindow（登录态隔离）
 * 2. 自动注入 stealth 脚本（每次页面加载后）
 * 3. 窗口生命周期管理（复用 / 销毁 / 崩溃恢复）
 */
const { BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

// ═══════ 窗口池（每个平台一个） ═══════
const _winPool = {};

function getWindow(platform, opts = {}) {
  const existing = _winPool[platform];
  if (existing && !existing.isDestroyed()) {
    try { if (opts.show !== false) existing.show(); } catch (_) {}
    return existing;
  }
  delete _winPool[platform];

  const partition = getPartition(platform);
  const win = new BrowserWindow({
    width: opts.width || 1280,
    height: opts.height || 800,
    show: opts.show !== false,
    title: opts.title || `求职助手 - ${platform}`,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false  // 允许跨域（Boss 等有 CDN 资源）
    }
  });
  win.setMenuBarVisibility(false);

  // 崩溃自动清理引用
  win.webContents.on('crashed', () => {
    console.error(`[browser] ${platform} 渲染进程崩溃`);
    delete _winPool[platform];
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  });
  win.webContents.on('render-process-gone', () => {
    console.error(`[browser] ${platform} render-process-gone`);
    delete _winPool[platform];
  });

  // Stealth 注入
  setupStealth(win);

  _winPool[platform] = win;
  return win;
}

function destroyWindow(platform) {
  const win = _winPool[platform];
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch (_) {}
  }
  delete _winPool[platform];
}

function getPartition(platform) {
  return `persist:fuckjob_${platform}`;
}

// ═══════ Session / Cookie 操作 ═══════
async function getCookies(platform) {
  const ses = session.fromPartition(getPartition(platform));
  return await ses.cookies.get({});
}

async function getCookiesForPlatform(platform, url) {
  const ses = session.fromPartition(getPartition(platform));
  const cookies = await ses.cookies.get({ url });
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ═══════ Stealth 反检测 ═══════
const STEALTH_SCRIPT = `
// 1. webdriver
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

// 2. plugins
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    return [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehah', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
  },
  configurable: true
});

// 3. languages
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });

// 4. chrome runtime
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
  window.chrome.runtime = { connect: function(){}, sendMessage: function(){} };
}

// 5. permissions API
var op = window.navigator.permissions.query;
window.navigator.permissions.query = function(p) {
  if (p && p.name === 'notifications') return Promise.resolve({ state: Notification.permission });
  return op.call(this, p);
};

// 6. WebGL fingerprint
var gp = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(param) {
  if (param === 37445) return 'Intel Inc.';
  if (param === 37446) return 'Intel Iris OpenGL Engine';
  return gp.call(this, param);
};

// 7. media devices
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  var oe = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = function() {
    return oe().then(function(devs) {
      if (!devs || devs.length === 0) {
        return [
          { kind: 'audioinput', deviceId: 'default', label: '', groupId: '' },
          { kind: 'videoinput', deviceId: 'default', label: '', groupId: '' }
        ];
      }
      return devs;
    });
  };
}
`;

async function injectStealth(win) {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(STEALTH_SCRIPT);
  } catch (_) {}
}

function setupStealth(win) {
  win.webContents.on('did-finish-load', () => { injectStealth(win).catch(()=>{}); });
  injectStealth(win).catch(()=>{});
}

// ═══════ 窗口加载辅助 ═══════
function loadURL(win, url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    win.webContents.once('did-finish-load', finish);
    win.webContents.once('did-fail-load', () => finish());
    setTimeout(finish, timeoutMs);
    win.loadURL(url);
  });
}

async function evalJS(win, code, timeoutMs = 8000) {
  if (!win || win.isDestroyed()) return null;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evalJS timeout')), timeoutMs))
    ]);
  } catch (_) { return null; }
}

module.exports = {
  getWindow, destroyWindow, getPartition,
  getCookies, getCookiesForPlatform,
  injectStealth, loadURL, evalJS,
  _pool: _winPool
};
