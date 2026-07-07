/**
 * runner.js — 投递调度器（替代 engine.js）
 *
 * 职责：
 * 1. 接收平台列表 + 筛选条件 + 简历
 * 2. 逐个平台调用对应适配器
 * 3. 汇总结果、写日志、推 UI
 *
 * 设计：每个平台独立 try/catch，一个平台失败不影响其他。
 */
const browser = require('./browser');
const logger = require('./logger');
const selector = require('./selector-engine');

let _isRunning = false;
let _shouldStop = false;

function isRunning() { return _isRunning; }
function requestStop() { _shouldStop = true; }
function forceReset() { _isRunning = false; _shouldStop = false; }

/**
 * 主入口
 * @param {string[]} platforms - ['boss', 'liepin', ...]
 * @param {object} filter - 筛选条件
 * @param {object} resume - 简历数据
 * @param {function} onProgress - 实时推送 UI
 */
async function start(platforms, filter, resume, onProgress) {
  if (_isRunning) return { error: '已有投递任务在运行' };
  _isRunning = true;
  _shouldStop = false;

  // ★ 进度通过 onProgress 直接发给 UI（不走 logger，避免格式混乱）
  logger.info(null, `投递任务启动: ${platforms.join(', ')}`);

  const results = { total: 0, success: 0, failed: 0, skipped: 0, byPlatform: {} };

  // ★ 发送初始进度给 UI
  onProgress({ type: 'info', message: `任务启动: ${platforms.join(', ')}`, platforms });

  for (const platform of platforms) {
    if (_shouldStop) {
      logger.warn(platform, '用户中止');
      break;
    }

    logger.info(platform, '===== 开始 =====');
    onProgress({ type: 'phase', platform, message: `${platform} 开始...` });

    const platformResult = await _runOnePlatform(platform, filter, resume, onProgress);
    results.byPlatform[platform] = platformResult;
    results.success += platformResult.success || 0;
    results.failed += platformResult.failed || 0;
    results.skipped += platformResult.skipped || 0;

    logger.info(platform, `===== 结束: 成功${platformResult.success} 失败${platformResult.failed} 跳过${platformResult.skipped} =====`);
    onProgress({ type: 'phase', platform, message: `${platform} 完成: 成功${platformResult.success} 失败${platformResult.failed}` });
  }

  results.total = results.success + results.failed + results.skipped;
  _isRunning = false;

  logger.info(null, `全部完成: 总${results.total} 成功${results.success} 失败${results.failed} 跳过${results.skipped}`);
  onProgress({ type: 'done', message: `全部完成: 总${results.total} 成功${results.success} 失败${results.failed} 跳过${results.skipped}` });
  return results;
}

async function _runOnePlatform(platform, filter, resume, onProgress) {
  const result = { success: 0, failed: 0, skipped: 0, appliedJobs: [] };

  let adapter;
  try {
    adapter = require(`./platforms/${platform}`);
  } catch (e) {
    logger.error(platform, '适配器加载失败', e.message);
    return result;
  }

  // 校验适配器接口
  if (typeof adapter.loginCheck !== 'function' ||
      typeof adapter.searchJobs !== 'function' ||
      typeof adapter.applyOne !== 'function') {
    logger.error(platform, '适配器接口不完整（需要 loginCheck/searchJobs/applyOne）');
    return result;
  }

  logger.info(platform, '创建 BrowserWindow...');
  const win = browser.getWindow(platform, { show: true });
  logger.info(platform, `BrowserWindow 创建完成. 当前URL: ${win.webContents.getURL()}`);

  try {
    // Step 1: 登录检查
    logger.info(platform, 'Step 1/4: 检查登录态...');
    let loggedIn = await adapter.loginCheck(win);
    logger.info(platform, `loginCheck 返回: ${loggedIn}`);
    if (!loggedIn) {
      logger.warn(platform, '未登录，请在弹出的窗口中登录');
      // 打开首页让用户登录
      const loginUrl = adapter.getLoginUrl ? adapter.getLoginUrl() : _getDefaultUrl(platform);
      logger.info(platform, `加载登录页: ${loginUrl}`);
      await browser.loadURL(win, loginUrl, 30000);
      logger.info(platform, `登录页加载完成. 当前URL: ${win.webContents.getURL()}`);
      // 等待用户登录（轮询 60 秒）
      for (let i = 0; i < 30; i++) {
        await _sleep(2000);
        loggedIn = await adapter.loginCheck(win);
        if (loggedIn) break;
      }
      if (!loggedIn) {
        logger.error(platform, '登录超时，跳过');
        return result;
      }
    }
    logger.info(platform, '已登录 ✓');

    // Step 2: 搜索职位
    logger.info(platform, 'Step 2/4: 搜索职位...');
    const jobs = await adapter.searchJobs(win, filter);
    logger.info(platform, `搜索到 ${jobs.length} 个职位`);
    if (jobs.length === 0) return result;

    // Step 3: 过滤
    const filtered = _applyFilters(jobs, filter, platform);
    logger.info(platform, `过滤后剩余 ${filtered.length} 个职位`);

    // Step 4: 逐个投递
    const limit = filter.daily_limit || 10;
    const targetCount = Math.min(filtered.length, limit);
    logger.info(platform, `Step 3-4/4: 开始投递 ${targetCount} 个职位...`);
    onProgress({ type: 'phase', platform, message: `开始投递 ${targetCount} 个职位...` });

    for (let i = 0; i < targetCount; i++) {
      if (_shouldStop) {
        logger.warn(platform, '用户中止投递');
        break;
      }
      const job = filtered[i];
      logger.info(platform, `[${i+1}/${targetCount}] ${job.company} - ${job.title}`);
      onProgress({ type: 'delivering', platform, message: `${job.company} - ${job.title}`, current: i + 1, total: targetCount, job });

      try {
        const ok = await adapter.applyOne(win, job, resume);
        if (ok) {
          result.success++;
          result.appliedJobs.push({ platform, ...job });
          logger.recordDelivery(platform, job.company, job.title, job.salary, job.url, 'success', '', job.raw || '');
          onProgress({ type: 'result', platform, message: `✅ ${job.company} - ${job.title}`, current: i + 1, total: targetCount });
        } else {
          result.failed++;
          logger.recordDelivery(platform, job.company, job.title, job.salary, job.url, 'failed', 'applyOne 返回 false', '');
          onProgress({ type: 'error', platform, message: `❌ ${job.company} - ${job.title}`, current: i + 1, total: targetCount });
        }
      } catch (e) {
        result.failed++;
        logger.error(platform, `投递异常: ${e.message}`);
        logger.recordDelivery(platform, job.company, job.title, job.salary, job.url, 'failed', e.message, '');
        onProgress({ type: 'error', platform, message: `❌ ${job.title}: ${e.message}`, current: i + 1, total: targetCount });
      }

      // 间隔
      const interval = (filter.interval_seconds || 5) * 1000 + Math.random() * 3000;
      await _sleep(interval);
    }

  } catch (e) {
    logger.error(platform, '平台运行异常', e.message);
  }

  return result;
}

// ═══════ 过滤逻辑 ═══════
function _applyFilters(jobs, filter, platform) {
  let list = jobs.slice();

  // 黑名单关键词
  const blackKeywords = filter.blacklist_keywords || [];
  if (blackKeywords.length > 0) {
    list = list.filter(j => {
      const text = `${j.title} ${j.company}`.toLowerCase();
      return !blackKeywords.some(kw => text.includes(kw.toLowerCase()));
    });
  }

  // 黑名单公司
  const blackCompanies = filter.blacklist_companies || [];
  if (blackCompanies.length > 0) {
    list = list.filter(j => !blackCompanies.some(c => (j.company || '').includes(c)));
  }

  // 薪资底线
  if (filter.salary_min > 0) {
    list = list.filter(j => {
      const s = _parseSalaryMax(j.salary);
      return s === null || s >= filter.salary_min;
    });
  }

  return list;
}

function _parseSalaryMax(salaryStr) {
  if (!salaryStr) return null;
  const m = String(salaryStr).match(/(\d+)[kK]?\s*[-~]\s*(\d+)/);
  if (m) return parseInt(m[2], 10);
  const m2 = String(salaryStr).match(/(\d+)[kK]/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function _getDefaultUrl(platform) {
  const map = {
    boss: 'https://www.zhipin.com/',
    liepin: 'https://www.liepin.com/',
    zhilian: 'https://www.zhaopin.com/',
    job51: 'https://www.51job.com/',
    lagou: 'https://www.lagou.com/'
  };
  return map[platform] || 'https://www.zhipin.com/';
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, isRunning, requestStop, forceReset };
