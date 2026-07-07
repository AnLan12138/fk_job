/**
 * engine.js — 投递引擎 v5 — 模拟真人7步操作流程
 *
 * ★★★ v5 核心架构变化 ★★★
 * 旧架构(v4): PHASE 1搜索 → 提取列表 → PHASE 2逐个进详情页投递
 * 新架构(v5): 每个平台直接调用 run() → 在搜索页直接操作 → 不进详情页
 *
 * 流程简化：
 * 1. 各平台并行启动 run()
 * 2. run() 内部实现7步：登录检查→首页→搜索→搜索页投递→翻页循环
 * 3. 关键词匹配和黑名单过滤在搜索页实时进行（buttonHandler.shouldApplyToCard）
 * 4. 不再需要 deduper.js / matcher.js 的后处理
 *
 * 旧版 search+apply 流程保留作为 fallback，但默认使用新版 run()
 */
const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('../data/db');

let isRunning = false;
let shouldStop = false;

// Progress log persistence
const PROGRESS_LOG_PATH = path.join(app.getPath('userData'), 'progress_log.json');
function saveProgressEntry(entry) {
  try {
    let log = [];
    if (fs.existsSync(PROGRESS_LOG_PATH)) log = JSON.parse(fs.readFileSync(PROGRESS_LOG_PATH, 'utf-8'));
    log.push({ ...entry, time: new Date().toISOString() });
    if (log.length > 200) log = log.slice(-200);
    fs.writeFileSync(PROGRESS_LOG_PATH, JSON.stringify(log));
  } catch(_) {}
}
function getProgressLog() {
  try { if (fs.existsSync(PROGRESS_LOG_PATH)) return JSON.parse(fs.readFileSync(PROGRESS_LOG_PATH, 'utf-8')); } catch(_) {}
  return [];
}
function clearProgressLog() { try { fs.unlinkSync(PROGRESS_LOG_PATH); } catch(_) {} }

// ═══════ Helpers ═══════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadAndWait(win, url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    win.webContents.once('did-finish-load', finish);
    win.webContents.once('did-fail-load', () => finish());
    setTimeout(finish, timeoutMs);
    win.loadURL(url);
  });
}

async function execJS(win, code, timeoutMs = 60000) {
  if (!win || win.isDestroyed()) return null;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code),
      new Promise((_, reject) => setTimeout(() => reject(new Error('execJS timeout')), timeoutMs))
    ]);
  } catch(e) { console.error('[execJS]', e.message); return null; }
}

// ═══════ Window cache ═══════
const engineWindows = {};

function getPlatformWindow(platform) {
  // 1. Check engine's own cache
  if (engineWindows[platform] && !engineWindows[platform].isDestroyed()) {
    try { engineWindows[platform].show(); } catch(_) {}
    return { win: engineWindows[platform], isNew: false };
  }
  delete engineWindows[platform];

  // 2. Always create fresh window — release old auth window first
  //    Auth window holds partition cache lock; destroy it before creating new one
  const authModule = require('./auth');
  const old = authModule.getAuthWindow(platform);
  if (old) { try { old.destroy(); } catch(_) {} }
  const partition = authModule.getPartition(platform);
  const win = new BrowserWindow({
    width: 1280, height: 800, show: true,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('crashed', () => { delete engineWindows[platform]; try { if (!win.isDestroyed()) win.destroy(); } catch(_) {} });
  win.webContents.on('render-process-gone', () => { delete engineWindows[platform]; try { if (!win.isDestroyed()) win.destroy(); } catch(_) {} });

  // Stealth反检测
  const stealth = require('./stealth');
  stealth.setupAutoStealth(win);

  // ★★★ 拦截新窗口/新标签页请求（智联等平台的window.open）★★★
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.error("[engine] 新窗口请求(" + platform + "): " + url);
    if (platform === "zhilian") {
      win.loadURL(url);
      return { action: "deny" };
    }
    const isJobNav =
      (url.includes("zhipin.com") && (url.includes("/web/") || url.includes("/job_detail/"))) ||
      (url.includes("51job.com") && (url.includes("/pc/search") || url.includes("/job/"))) ||
      (url.includes("liepin.com") && (url.includes("/zhaopin/") || url.includes("/job/")));
    if (isJobNav) {
      win.loadURL(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  engineWindows[platform] = win;
  return { win, isNew: true };
}

// ═══════════════════════════════════════════════════════════════
// ★★★ v5 核心：start() — 调用各平台的 run() ★★★
// ═══════════════════════════════════════════════════════════════

async function start(platforms, filter, resume, onProgress) {
  if (isRunning) return { error: "Engine already running" };
  isRunning = true;
  shouldStop = false;
  clearProgressLog();

  const results = { total: 0, success: 0, failed: 0, skipped: 0, appliedJobs: [] };

  const progress = (data) => {
    saveProgressEntry(data);
    onProgress(data);
  };

  const helpers = { loadAndWait, sleep, execJS, onProgress: progress };

  try {
    progress({ type: 'phase', message: `★ v5架构启动: ${platforms.length}个平台并行投递...` });

    // ══ v5: 各平台并行调用 run() ══
    const platformResults = await Promise.all(
      platforms.map(platform => {
        let finished = false;
        const timer = new Promise((resolve) => {
          setTimeout(() => {
            if (!finished) {
              progress({ type: 'warning', platform, message: platform + ' 运行超时(5分钟)' });
            }
            resolve({ success: 0, failed: 0, skipped: 0, appliedJobs: [], _timedOut: true, platform });
          }, 300000); // 5分钟超时
        });

        const runTask = _runOnePlatform(platform, filter, resume, progress, helpers)
          .then(r => { finished = true; return r; })
          .catch(err => {
            finished = true;
            progress({ type: 'error', platform, message: platform + ' 运行异常: ' + (err.message || err) });
            return { success: 0, failed: 0, skipped: 0, appliedJobs: [], platform, _error: err.message };
          });

        return Promise.race([runTask, timer]);
      })
    );

    // ══ 收集结果 ══
    for (const pr of platformResults) {
      if (!pr._timedOut && !pr._error) {
        results.success += pr.success || 0;
        results.failed += pr.failed || 0;
        results.skipped += pr.skipped || 0;
        results.appliedJobs = results.appliedJobs.concat(pr.appliedJobs || []);
      }
    }

    results.total = results.success + results.failed + results.skipped;

    // ══ 写入投递日志 ══
    for (const job of results.appliedJobs) {
      db.addDeliveryLog(job.platform, job.company, job.title, job.salary || '', job.url || '', 'success', '', '');
    }

    // ══ 运行诊断 ══
    const diagnosticCollector = require('./diagnostic').createStatsCollector();
    for (const pr of platformResults) {
      if (!pr._timedOut) {
        diagnosticCollector.recordSearch(pr.platform, [], []);
        diagnosticCollector.recordApply(pr.platform, pr.success || 0, pr.failed || 0, pr.skipped || 0, [], []);
      }
    }

    const diagnostic = require('./diagnostic');
    const diagReport = diagnostic.run(diagnosticCollector.stats);
    const diagText = diagnostic.formatReport(diagReport);
    progress({ type: 'diagnostic', message: diagText, findings: diagReport.findings, healthy: diagReport.healthy });

    // ══ 清理 ══
    for (const platform of platforms) {
      try {
        const pw = engineWindows[platform];
        if (pw && !pw.isDestroyed()) pw.hide();
      } catch(_) {}
    }

  } finally {
    isRunning = false;
    progress({ type: 'done', message: `★ v5完成: 成功${results.success} 失败${results.failed} 跳过${results.skipped}` });
  }

  return results;
}

/**
 * 运行单个平台的完整流程
 * ★ v5核心：直接调用 platformModule.run()，不再分搜索+投递两阶段
 */
async function _runOnePlatform(platform, filter, resume, progress, helpers) {
  if (shouldStop) return { success: 0, failed: 0, skipped: 0, appliedJobs: [], platform };

  progress({ type: 'phase', platform, message: `★ ${platform} v5流程启动...` });

  const { win } = getPlatformWindow(platform);
  if (!win || win.isDestroyed()) {
    progress({ type: 'error', platform, message: platform + ' 窗口创建失败' });
    return { success: 0, failed: 0, skipped: 0, appliedJobs: [], platform };
  }

  const platformModule = require('./platforms/' + platform);

  // ★★★ 优先使用新版 run()，如果不存在则 fallback 到旧版 search+apply ★★★
  if (platformModule.run) {
    progress({ type: 'phase', platform, message: `★ ${platform} 使用v5新架构(搜索页直接投递)` });
    return await platformModule.run(win, filter, resume, progress, helpers);
  }

  // ★★★ Fallback: 旧版 search + apply 流程 ★★★
  progress({ type: 'phase', platform, message: `${platform} 使用v4旧架构(搜索+详情页投递)` });
  const perPlatformLimit = filter.daily_limit || 10;
  const results = { success: 0, failed: 0, skipped: 0, appliedJobs: [], platform };

  // Phase 1: 搜索
  let jobs = [];
  try {
    jobs = await platformModule.search(win, filter, progress, helpers);
    progress({ type: 'info', platform, message: `${platform} 搜索→${jobs.length}个职位` });
  } catch(e) {
    progress({ type: 'error', platform, message: `${platform} 搜索失败: ${e.message}` });
    return results;
  }

  // Phase 2: 投递
  const totalTarget = Math.min(jobs.length, perPlatformLimit);
  for (let idx = 0; idx < totalTarget && !shouldStop; idx++) {
    const job = jobs[idx];
    progress({ type: 'delivering', platform, message: `[${idx+1}/${totalTarget}] ${job.company || job.title}`, current: idx + 1, total: totalTarget, job });

    try {
      await loadAndWait(win, job.url, 20000);
      await sleep(1500 + Math.random() * 1000);

      // 验证检测
      const currentUrl = win.webContents.getURL();
      const isVerifyPage = currentUrl.includes("/passport/") || currentUrl.includes("/verify") || currentUrl.includes("/safe/") || currentUrl.includes("/login");
      if (isVerifyPage) {
        win.show();
        progress({ type: 'warning', platform, message: `验证拦截: ${job.company}` });
        await sleep(30000);
        results.skipped++;
        continue;
      }

      const ok = await platformModule.apply(win, job, resume, helpers);
      if (ok) {
        db.addDeliveryLog(platform, job.company, job.title, job.salary || '', job.url || '', 'success', '', '');
        results.success++;
        results.appliedJobs.push({ platform, ...job, status: 'success' });
        progress({ type: 'result', platform, message: `✅ ${job.company} - ${job.title}`, current: idx + 1, total: totalTarget });
      }
    } catch(e) {
      db.addDeliveryLog(platform, job.company, job.title, job.salary || '', job.url || '', 'failed', e.message, '');
      results.failed++;
      progress({ type: 'error', platform, message: `❌ ${job.title}: ${e.message}` });
    }

    await sleep((filter.interval_seconds || 5) * 1000 + Math.random() * 3000);
  }

  return results;
}

function stop() { shouldStop = true; return { success: true }; }
function getStatus() { return { isRunning }; }

function forceReset() {
  isRunning = false; shouldStop = false;
  return { success: true };
}

module.exports = { start, stop, getStatus, forceReset, getProgressLog, clearProgressLog };