const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const initSqlJs = require('sql.js');

// ★ 防御：防止被 `node electron/main.js` 直接启动导致 app=undefined
if (!app || !app.whenReady) {
  console.error('[启动错误] 请使用 npm start 启动，不要用 node 直接运行 main.js');
  console.error('  正确命令:  cd D:\\VScode_project\\fuck_job && npm start');
  process.exit(1);
}

let db;
let mainWindow;

// 隐藏默认菜单栏，只保留标题和窗口控制按钮
Menu.setApplicationMenu(null);

// ═══════ 全局崩溃防护 ═══════
// 防止主进程 uncaught exception 直接干掉整个 app
process.on('uncaughtException', (err) => {
  console.error('[主进程异常]', err.message || err);
  // 不退出，让 app 继续运行
});

// 防止渲染进程崩溃连带主进程
app.on('render-process-gone', (event, webContents, details) => {
  console.error('[渲染进程崩溃]', details.reason, details.exitCode);
  // 不退出，只记录
});

app.on('child-process-gone', (event, details) => {
  console.error('[子进程崩溃]', details.type, details.reason, details.exitCode);
});

// ═══════ Init SQLite async before anything else ═══════
async function initDB() {
  const SQL = await initSqlJs();
  db = require('./data/db');
  await db.init(SQL);
  return db;
}

// ═══════ Window ═══════
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 960,
    minHeight: 680,
    title: '求职助手 - 一键全平台投递',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await initDB();
  createWindow();

  // ★★★ 临时自动触发（上线前删）★★★
  // DISABLED: 需要用户登录
  /*
  setTimeout(async () => {
    try {
      const runner = require('./delivery/runner');
      const db = require('./data/db');
      const filter = db.loadFilter() || { keywords: ['Java'], cities: ['深圳'], daily_limit: 2, interval_seconds: 5 };
      const resume = db.loadResume() || { name: '张三', skills: ['Java','Spring'], work_history: [{}] };
      const result = await runner.start(['liepin'], filter, resume, (p) => {
        console.log('[liepin progress]', JSON.stringify(p));
      });
      console.log('[liepin result]', JSON.stringify(result));
    } catch (e) {
      console.error('[liepin auto error]', e.message);
    }
  }, 6000);
  */

  // ★★★ 临时诊断钩子（上线前删）：启动 8 秒后自动诊断 boss ★★★
  // DISABLED: 需要先登录 boss
  /*
  setTimeout(async () => {
    try {
      const diag = require('./delivery/diagnose');
      const b = require('./delivery/browser');
      const win = b.getWindow('boss', { show: false });
      await b.loadURL(win, 'https://www.zhipin.com/web/geek/jobs?city=100010000&query=Java', 15000);
      await new Promise(r => setTimeout(r, 3000));
      await diag.diagnoseAll(win, 'boss');
      console.log('[自动诊断完成] 请查看 %APPDATA%\\fuck-job\\diagnose_latest.txt');
    } catch (e) {
      console.error('[自动诊断失败]', e.message);
    }
  }, 8000);
  */
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ═══════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════

// ── Resume ──
ipcMain.handle('resume:save', async (event, data) => {
  return db.saveResume(data);
});

ipcMain.handle('resume:load', async () => {
  return db.loadResume();
});

// ── Platform Auth ──
ipcMain.handle('auth:status', async () => {
  return db.getPlatformStatus();
});

ipcMain.handle('auth:login', async (event, platform) => {
  const auth = require('./worker/auth');
  return auth.startLogin(platform);
});

ipcMain.handle('auth:verify', async (event, platform) => {
  const auth = require('./worker/auth');
  return auth.verifyAuth(platform);
});

// ── Filter ──
ipcMain.handle('filter:save', async (event, data) => {
  return db.saveFilter(data);
});

ipcMain.handle('filter:load', async () => {
  return db.loadFilter();
});

// ── Delivery ──
ipcMain.handle('delivery:start', async (event, { platforms, filter, resume }) => {
  const runner = require('./delivery/runner');
  // 安全检查：如果引擎卡在 isRunning=true 但实际没在运行，自动重置
  if (runner.isRunning()) {
    console.error('[main] 引擎状态异常: isRunning=true 但用户再次触发，自动重置');
    runner.forceReset();
  }
  return runner.start(platforms, filter, resume, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('delivery:progress', progress);
    }
  });
});

ipcMain.handle('delivery:stop', async () => {
  const runner = require('./delivery/runner');
  return runner.requestStop();
});

ipcMain.handle('delivery:reset', async () => {
  const runner = require('./delivery/runner');
  return runner.forceReset();
});

ipcMain.handle('delivery:status', async () => {
  const runner = require('./delivery/runner');
  return { isRunning: runner.isRunning() };
});

// ── History ──
ipcMain.handle('history:list', async (event, limit) => {
  return db.getDeliveryLog(limit || 100);
});

// ── Progress log（兼容旧 UI 调用） ──
ipcMain.handle('progress:list', async () => {
  const engine = require('./delivery/runner');
  return engine.getProgressLog ? engine.getProgressLog() : [];
});
ipcMain.handle('progress:clear', async () => {
  const engine = require('./delivery/runner');
  return engine.clearProgressLog ? engine.clearProgressLog() : { ok: true };
});

// ── 诊断（临时，上线前删） ──
ipcMain.handle('diagnose:start', async (event, platform) => {
  const diag = require('./delivery/diagnose');
  const b = require('./delivery/browser');
  const win = b.getWindow(platform, { show: false });
  // 先加载 boss 搜索页让 cookie 生效
  await b.loadURL(win, 'https://www.zhipin.com/web/geek/jobs?city=100010000&query=Java', 15000);
  await new Promise(r => setTimeout(r, 4000));
  const result = await diag.diagnoseAll(win, platform);
  return result;
});
