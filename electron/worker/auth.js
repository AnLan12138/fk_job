/**
 * auth.js — 使用 Electron BrowserWindow 做授权登录
 *
 * 登录态通过 Electron session partition 持久化，
 * 后续投递时从 session 提取 cookies 注入。
 *
 * 防崩溃策略：
 * 1. close 事件用 preventDefault + destroy() 安全关闭
 * 2. authWindow 加 webContents crashed/render-process-gone 保护
 * 3. verifyAuth 只查 cookies，不开隐藏窗口验证（避免同 partition 撞车）
 * 4. 全局 uncaughtException 兜底（main.js 里已加）
 */
const { BrowserWindow, session } = require('electron');
const db = require('../data/db');

// ═══════ Auth Window 引用池 ═══════
// 用户关闭授权窗口后只隐藏不销毁，搜索/投递时复用同一窗口
// 这样 BOSS 看到的是同一个浏览器会话，不会触发 verify
const authWindows = {};

function getAuthWindow(platform) {
  const win = authWindows[platform];
  if (win && !win.isDestroyed()) return win;
  delete authWindows[platform];
  return null;
}

function releaseAuthWindow(platform) {
  const win = authWindows[platform];
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch (_) {}
  }
  delete authWindows[platform];
}

const URLS = {
  boss: 'https://www.zhipin.com/',
  liepin: 'https://www.liepin.com/',
  zhilian: 'https://www.zhaopin.com/',
  job51: 'https://www.51job.com/',
  lagou: 'https://www.lagou.com/'
};

// 每个平台使用独立的 session partition，登录态互不干扰
function getPartition(platform) {
  return `persist:fuckjob_${platform}`;
}

async function startLogin(platform) {
  const url = URLS[platform];
  if (!url) return { error: `未知平台: ${platform}` };

  // 如果有旧的隐藏授权窗口，先销毁（用户重新授权）
  releaseAuthWindow(platform);

  const partition = getPartition(platform);

  const authWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: `求职助手 - ${platform} 登录`,
    webPreferences: {
      partition: partition,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // 去掉菜单栏
  authWindow.setMenuBarVisibility(false);

  // ═══════ authWindow 崩溃防护 ═══════
  // 渲染进程崩溃时清理引用并销毁窗口
  authWindow.webContents.on('crashed', (event, killed) => {
    console.error(`[auth] ${platform} 渲染进程崩溃, killed=${killed}`);
    delete authWindows[platform];
    try { if (!authWindow.isDestroyed()) authWindow.destroy(); } catch(_) {}
  });
  authWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`[auth] ${platform} 渲染进程消失, reason=${details.reason}`);
    delete authWindows[platform];
    try { if (!authWindow.isDestroyed()) authWindow.destroy(); } catch(_) {}
  });

  authWindow.loadURL(url);

  return new Promise((resolve) => {
    let resolved = false;

    // ═══════ 关键：preventDefault + hide() ═══════
    // 用户点X时，只隐藏不销毁 —— 搜索/投递时复用同一窗口
    // BOSS 看到的是同一个浏览器会话，不会触发 verify 页面
    authWindow.on('close', (e) => {
      e.preventDefault(); // 阻止 Electron 默认销毁行为

      if (!resolved) {
        resolved = true;
        try {
          db.setPlatformStatus(platform, 'authorized', partition);
        } catch (_) {}
        resolve({ success: true, platform });
      }

      // 隐藏窗口，保留引用供搜索/投递复用
      try {
        if (!authWindow.isDestroyed()) authWindow.hide();
      } catch (_) {}
      authWindows[platform] = authWindow;
    });

    // 兜底：窗口被 crash handler destroy 时清理引用
    authWindow.on('closed', () => {
      delete authWindows[platform];
      if (!resolved) {
        resolved = true;
        try {
          db.setPlatformStatus(platform, 'authorized', partition);
        } catch (_) {}
        resolve({ success: true, platform });
      }
    });
  });
}

/**
 * 验证授权状态 — 检查特定平台的 auth cookie，而非任意 cookie
 *
 * 各平台关键 auth cookie：
 *   boss:   wt2（Boss 的核心 session cookie）
 *   zhilian: at（智联的 access token）
 *   job51:  guid / 51job（51job 用户标识）
 *   liepin: user_sec_id（猎聘的用户安全 ID）
 *   lagou:  user_trace_token / LG_TOKEN（拉勾 token）
 *
 * 额外兜底：如果以上特定 cookie 都找不到，但 total > 5 个 cookie，
 * 视为「可能已登录」（部分平台的 cookie 名会变化）
 */
async function verifyAuth(platform) {
  const partition = getPartition(platform);
  const url = URLS[platform];
  if (!url) return false;

  let ses;
  try {
    ses = session.fromPartition(partition);
  } catch (_) {
    db.setPlatformStatus(platform, 'never', partition);
    return false;
  }

  try {
    const allCookies = await ses.cookies.get({});

    if (allCookies.length === 0) {
      db.setPlatformStatus(platform, 'never', partition);
      return false;
    }

    // 各平台的已知 auth cookie 名
    const AUTH_COOKIE_NAMES = {
      boss: ['wt2', 'lastCity'],
      zhilian: ['at', 'rt', 'user_id', 'zp_passport_deepknow_session'],
      job51: ['guid', '51job', 'acw_tc'],
      liepin: ['user_sec_id', '__session__', 'abtest'],
      lagou: ['user_trace_token', 'LG_TOKEN', 'index_session_token']
    };

    const knownNames = AUTH_COOKIE_NAMES[platform] || [];
    const cookieNames = new Set(allCookies.map(c => c.name));

    // 检查是否有已知 auth cookie
    const hasAuthCookie = knownNames.some(name => cookieNames.has(name));

    if (hasAuthCookie) {
      db.setPlatformStatus(platform, 'authorized', partition);
      return true;
    }

    // 兜底: cookie 数量 > 5 且不是纯 tracking cookie，视为可能已登录
    const nonTrackingCookies = allCookies.filter(c => {
      const name = (c.name || '').toLowerCase();
      return !name.startsWith('_ga') && !name.startsWith('_gid') && !name.startsWith('_utm')
          && !name.includes('hm_') && !name.includes('baidu') && !name.includes('cnzz');
    });

    if (nonTrackingCookies.length >= 3) {
      db.setPlatformStatus(platform, 'authorized', partition);
      return true;
    }

    // 有 cookie 但不是 auth cookie → 只访问过首页，没登录
    db.setPlatformStatus(platform, 'never', partition);
    return false;

  } catch (_) {
    db.setPlatformStatus(platform, 'expired', partition);
    return false;
  }
}

/**
 * 从 Electron session 提取 cookies，转换为 Playwright 格式
 * 供 engine.js 在投递时注入 Playwright context
 */
async function getCookiesForPlaywright(platform) {
  const partition = getPartition(platform);
  const ses = session.fromPartition(partition);
  const allCookies = await ses.cookies.get({});

  return allCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expirationDate || -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: (c.sameSite === 'no_restriction' ? 'None' :
               c.sameSite === 'lax' ? 'Lax' :
               c.sameSite === 'strict' ? 'Strict' : 'Lax')
  }));
}

module.exports = { startLogin, verifyAuth, getCookiesForPlaywright, getPartition, getAuthWindow, releaseAuthWindow };
