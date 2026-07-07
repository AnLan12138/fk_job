/**
 * stealth.js — BrowserWindow 反检测注入
 *
 * ★ 核心：在 BrowserWindow 创建后立即注入 stealth 脚本
 *   覆盖 navigator.webdriver 等自动化特征
 *   模拟真实浏览器的 plugins/languages/chrome 等属性
 *
 * ★ 与 Playwright stealth 的区别：
 *   Playwright 注入的是 CDP 层面的，可以被高级检测发现
 *   BrowserWindow 的 executeJavaScript 是在渲染进程内执行的，
 *   和用户手动在 Console 里敲代码一样，零协议痕迹
 */
const STEALTH_INIT_SCRIPT = `
// ═══════ Navigator 指纹覆盖 ═══════
// 1. webdriver 属性 — 最核心的检测点
Object.defineProperty(navigator, 'webdriver', {
  get: () => undefined,
  configurable: true
});

// 2. plugins — 真实浏览器有5+个插件
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    var arr = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehah', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
    arr.refresh = function() {};
    return arr;
  },
  configurable: true
});

// 3. languages — 真实中文用户
Object.defineProperty(navigator, 'languages', {
  get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  configurable: true
});

// ═══════ Chrome 运行时特征 ═══════
// 4. window.chrome — 真实 Chrome 有这个对象
if (!window.chrome) {
  window.chrome = {};
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: function() {},
    sendMessage: function() {}
  };
}

// ═══════ Permissions API 伪装 ═══════
// 5. navigator.permissions.query — 自动化浏览器对 notifications 返回 "denied"
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = function(parameters) {
  if (parameters.name === 'notifications') {
    return Promise.resolve({ state: Notification.permission });
  }
  return originalQuery(parameters);
};

// ═══════ WebGL 渲染器伪装 ═══════
// 6. getParameter — 避免返回 "SwiftShader" 等虚拟渲染器
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
  if (parameter === 37445) {
    return 'Intel Inc.';  // UNMASKED_VENDOR_WEBGL
  }
  if (parameter === 37446) {
    return 'Intel Iris OpenGL Engine';  // UNMASKED_RENDERER_WEBGL
  }
  return getParameter.call(this, parameter);
};

// ═══════ iframe contentWindow 修复 ═══════
// 7. 某些检测通过 iframe 测试 navigator.webdriver
// 在 iframe 中也覆盖
const originalAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function() {
  return originalAttachShadow.call(this);
};

// ═══════ 媒体设备 ═══════  
// 8. enumerateDevices — 真实浏览器有多个设备
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = function() {
    return origEnumerate().then(function(devices) {
      if (devices.length === 0) {
        return [
          { kind: 'audioinput', deviceId: 'default', label: '', groupId: '' },
          { kind: 'videoinput', deviceId: 'default', label: '', groupId: '' }
        ];
      }
      return devices;
    });
  };
}
`;

/**
 * 向 BrowserWindow 注入 stealth 脚本
 * @param {BrowserWindow} win
 */
async function injectStealth(win) {
  if (!win || win.isDestroyed()) return;
  try {
    // did-finish-load 后注入（确保DOM已存在）
    await win.webContents.executeJavaScript(STEALTH_INIT_SCRIPT);
  } catch (e) {
    console.error('[stealth] 注入失败:', e.message);
  }
}

/**
 * 在 webContents 的 did-finish-load 事件上自动注入 stealth
 * ★ 这样每次导航到新页面后都会重新注入（单页应用SPA会重新渲染）
 */
function setupAutoStealth(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on('did-finish-load', () => {
    injectStealth(win).catch(_ => {});
  });
  // 首次注入
  injectStealth(win).catch(_ => {});
}

module.exports = { injectStealth, setupAutoStealth, STEALTH_INIT_SCRIPT };
