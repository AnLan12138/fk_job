/**
 * 智联招聘 Platform Adapter v5 — 模拟真人7步操作流程
 *
 * ★★★ v5 核心变化 ★★★
 * 智联的APP下载弹窗是最大障碍 → buttonHandler.zhilianDismissAppPopup() 主动关闭
 * "申请职位"按钮经常被APP弹窗遮挡 → 先关弹窗再投递
 * 如果申请按钮仍弹APP → 切换到沟通按钮
 *
 * v4配置文件有乱码问题 → v5已修复所有中文值
 */
const configLoader = require('../configLoader');
const locator = require('../locator');
const buttonHandler = require('../buttonHandler');
const auth = require('../auth');

const CITY_CODES = {
  '深圳': '765', '广州': '763', '北京': '530', '上海': '538',
  '杭州': '653', '成都': '801', '武汉': '736', '南京': '635',
  '西安': '854', '长沙': '749', '苏州': '641', '东莞': '773',
  '天津': '533', '重庆': '551', '厦门': '682', '合肥': '603',
  '郑州': '593', '青岛': '624'
};
const EXP_MAP = { '': '', '1-3': '0301', '3-5': '0302', '5-10': '0303', '10+': '0304' };
const EDU_MAP = { '': '', '大专': '3', '本科': '4', '硕士': '5', '博士': '6' };

function buildSearchUrl(filter) {
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');
  const cityCode = CITY_CODES[city] || '765';
  let url = 'https://www.zhaopin.com/sou/jl' + cityCode + '/kw' + keyword;
  const exp = EXP_MAP[filter.experience]; if (exp) url += '?we=' + exp;
  const edu = EDU_MAP[filter.education];
  if (edu) url += (exp ? '&' : '?') + 'el=' + edu;
  return url;
}

async function handleVerify(win, onProgress, helpers, maxWaitSec) {
  if (!maxWaitSec) maxWaitSec = 120;
  const { sleep, execJS } = helpers;
  const indicators = configLoader.getVerifyIndicators('zhilian');
  const url = win.webContents.getURL();

  const urlNeedsVerify = indicators.urlPatterns.some(p => url.includes(p));
  const pageNeedsVerify = await execJS(win, `
    (function() {
      var text = document.body ? document.body.innerText : '';
      var patterns = ${JSON.stringify(indicators.textPatterns)};
      for (var i = 0; i < patterns.length; i++) { if (text.includes(patterns[i])) return true; }
      var selectors = ${JSON.stringify(indicators.selectors)};
      for (var i = 0; i < selectors.length; i++) { try { var el = document.querySelector(selectors[i]); if (el && el.offsetHeight > 0) return true; } catch(_) {} }
      if (text.length < 500) return true;
      return false;
    })();
  `);

  if (!urlNeedsVerify && !pageNeedsVerify) return true;

  win.show();
  if (onProgress) onProgress({ type: 'warning', message: '[智联] ⚠️ 需要登录/验证！请在弹出窗口中操作' });
  await locator.captureScreenshot(win, 'zhilian_verify_detected');

  for (let i = 0; i < maxWaitSec / 2; i++) {
    await sleep(2000);
    if (!win || win.isDestroyed()) return false;
    const u = win.webContents.getURL();
    const urlOk = indicators.urlPatterns.every(p => !u.includes(p));
    const contentOk = await execJS(win, `
      (function() {
        var text = document.body ? document.body.innerText : '';
        var patterns = ${JSON.stringify(indicators.textPatterns)};
        for (var i = 0; i < patterns.length; i++) { if (text.includes(patterns[i])) return false; }
        if (text.length < 500) return false;
        return true;
      })();
    `);
    if (urlOk && contentOk) {
      if (onProgress) onProgress({ type: 'info', message: '[智联] ✅ 验证通过' });
      return true;
    }
  }
  if (onProgress) onProgress({ type: 'error', message: '[智联] ❌ 验证超时' });
  return false;
}

// ═══════════════════════════════════════════════════════════════
// ★★★ v5 核心流程：run() ★★★
// ═══════════════════════════════════════════════════════════════

async function run(win, filter, resume, onProgress, helpers) {
  const { loadAndWait, sleep, execJS } = helpers;
  const results = { success: 0, failed: 0, skipped: 0, appliedJobs: [] };
  const perPlatformLimit = filter.daily_limit || 10;
  const MAX_PAGES = 3;

  // ━━━━━ Step 1: 检查登录 ━━━━━
  if (onProgress) onProgress({ type: 'phase', message: '[智联] Step 1: 检查登录状态...' });

  const isLoggedIn = await auth.verifyAuth('zhilian');
  if (!isLoggedIn) {
    if (onProgress) onProgress({ type: 'warning', message: '[智联] ⚠️ 未登录！弹出登录窗口' });
    await auth.startLogin('zhilian');
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await auth.verifyAuth('zhilian')) {
        if (onProgress) onProgress({ type: 'info', message: '[智联] ✅ 登录成功' });
        break;
      }
      if (i === 59) {
        if (onProgress) onProgress({ type: 'error', message: '[智联] ❌ 登录超时' });
        return results;
      }
    }
  }

  // ━━━━━ Step 2: 首页初始化 ━━━━━
  if (onProgress) onProgress({ type: 'phase', message: '[智联] Step 2: 访问首页...' });
  await loadAndWait(win, 'https://www.zhaopin.com/', 15000);
  await sleep(2000 + Math.random() * 1000);
  if (!await handleVerify(win, onProgress, helpers)) {
    if (onProgress) onProgress({ type: 'error', message: '[智联] 首页验证未通过' });
    return results;
  }

  // ━━━━━ Step 3+4: 搜索 ━━━━━
  const searchUrl = buildSearchUrl(filter);
  const keyword = decodeURIComponent(searchUrl.match(/kw([^?&]+)/)?.[1] || '');
  if (onProgress) onProgress({ type: 'phase', message: `[智联] Step 3-4: 搜索: ${keyword}` });

  // ★ 智联搜索按钮可能触发window.open → 已在engine.js setWindowOpenHandler拦截
  await loadAndWait(win, searchUrl, 20000);
  await sleep(3000);
  if (!await handleVerify(win, onProgress, helpers)) {
    if (onProgress) onProgress({ type: 'error', message: '[智联] 搜索验证失败' });
    return results;
  }

  // ★ 搜索页加载后，主动关闭APP下载弹窗
  await buttonHandler.zhilianDismissAppPopup(win, helpers);

  // 滚动触发懒加载
  await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=8)clearInterval(t);},400);})();`);
  await sleep(3000);

  let currentUrl = win.webContents.getURL();

  // ━━━━━ Step 5-7: 投递循环 ━━━━━
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (results.success >= perPlatformLimit) {
      if (onProgress) onProgress({ type: 'info', message: `[智联] ✅ 已达上限 ${perPlatformLimit}` });
      break;
    }

    if (onProgress) onProgress({ type: 'phase', message: `[智联] 第${page}页投递循环...` });

    // ★ 每页操作前先关闭APP弹窗
    await buttonHandler.zhilianDismissAppPopup(win, helpers);

    const _cardCountResult = await buttonHandler.getCardCount(win, 'zhilian', helpers);
    const cardCount = (_cardCountResult && _cardCountResult.realCount !== undefined) ? _cardCountResult.realCount : (_cardCountResult || 0);
    if (cardCount === 0) {
      if (onProgress) onProgress({ type: 'warning', message: `[智联] 第${page}页0个卡片` });
      break;
    }
    if (onProgress) onProgress({ type: 'info', message: `[智联] 第${page}页发现 ${cardCount} 个职位卡片` });

    for (let cardIdx = 0; cardIdx < cardCount && results.success < perPlatformLimit; cardIdx++) {
      if (onProgress) onProgress({ type: 'info', message: `[智联] 卡片 ${cardIdx+1}/${cardCount}` });

      // ★ 每次操作前先关闭可能新出现的APP弹窗
      await buttonHandler.zhilianDismissAppPopup(win, helpers);

      // ★ Bug#1修复：先提取信息（不点击）
      const infoResult = await buttonHandler.getCardInfoOnSearchPage(win, 'zhilian', cardIdx, helpers);

      if (infoResult.error) {
        if (onProgress) onProgress({ type: 'warning', message: `[智联] 卡片${cardIdx+1} 信息提取失败: ${infoResult.error}` });
        results.failed++;
        continue;
      }

      if (infoResult.alreadyApplied) {
        if (onProgress) onProgress({ type: 'info', message: `[智联] 卡片${cardIdx+1} 已申请，跳过` });
        results.skipped++;
        continue;
      }

      const cardInfo = infoResult.cardInfo;

      // ★ 关键词实时匹配（在点击之前判断！）
      if (!buttonHandler.shouldApplyToCard(cardInfo, filter)) {
        if (onProgress) onProgress({ type: 'info', message: `[智联] 卡片${cardIdx+1} 关键词不匹配: ${cardInfo?.title || ''}` });
        results.skipped++;
        continue;
      }

      // ★ 关键词匹配成功 → 点击投递按钮
      const clickResult = await buttonHandler.clickApplyOnly(win, 'zhilian', cardIdx, helpers);

      if (!clickResult.clicked) {
        if (onProgress) onProgress({ type: 'warning', message: `[智联] 卡片${cardIdx+1} 按钮找不到: ${clickResult.error}` });
        results.failed++;
        continue;
      }

      await sleep(2000);

      // ★ 检查是否又弹出APP弹窗（点击申请按钮可能触发新弹窗）
      const hasAppPopupAgain = await execJS(win, `
        (function() {
          var text = document.body ? document.body.innerText : '';
          return text.includes('下载APP') || text.includes('打开智联') || 
                 document.querySelector('[class*="download-app"]') !== null ||
                 document.querySelector('[class*="open-app"]') !== null;
        })();
      `);

      if (hasAppPopupAgain) {
        // ★ 尝试关闭APP弹窗
        const dismissed = await buttonHandler.zhilianDismissAppPopup(win, helpers);
        if (!dismissed) {
          if (onProgress) onProgress({ type: 'warning', message: `[智联] 卡片${cardIdx+1} APP弹窗无法关闭，跳过` });
          results.skipped++;
          continue;
        }
      }

      // ★ 检查拦截
      const blockCheck = await buttonHandler.checkBlockIndicator(win, 'zhilian', helpers);
      if (blockCheck.blocked) {
        if (blockCheck.severity === 'hard') {
          if (onProgress) onProgress({ type: 'error', message: `[智联] ❌ 拦截(${blockCheck.reason})，停止` });
          break;
        } else if (blockCheck.severity === 'soft') {
          if (onProgress) onProgress({ type: 'warning', message: `[智联] ⚠️ 拦截(${blockCheck.reason})，暂停10秒` });
          await sleep(10000);
        }
      }

      // ★ 投递成功
      results.success++;
      results.appliedJobs.push({
        platform: 'zhilian',
        title: cardInfo?.title || '',
        company: cardInfo?.company || '',
        salary: cardInfo?.salary || '',
        url: '',
        status: 'success'
      });

      if (onProgress) onProgress({
        type: 'result',
        message: `✅ 智联: ${cardInfo?.company || '未知'} - ${cardInfo?.title || '未知'}`,
        current: results.success,
        total: perPlatformLimit
      });

      const delay = (filter.interval_seconds || 5) * 1000 + Math.random() * 3000;
      await sleep(delay);
    }

    // ★ 翻页
    if (results.success < perPlatformLimit && page < MAX_PAGES) {
      const nextResult = await buttonHandler.clickNextPage(win, 'zhilian', currentUrl, page + 1, helpers);
      if (!nextResult.success) {
        if (onProgress) onProgress({ type: 'warning', message: `[智联] 翻页失败` });
        break;
      }
      currentUrl = nextResult.newUrl || win.webContents.getURL();
      await handleVerify(win, onProgress, helpers);
      await buttonHandler.zhilianDismissAppPopup(win, helpers);
      await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=8)clearInterval(t);},400);})();`);
      await sleep(3000);
    }
  }

  if (onProgress) onProgress({ type: 'info', message: `[智联] 完成: 成功${results.success} 失败${results.failed} 跳过${results.skipped}` });
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 旧版 search + apply — 备选
// ═══════════════════════════════════════════════════════════════

async function search(win, filter, onProgress, helpers) {
  const { loadAndWait, sleep, execJS } = helpers;
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');
  const cityCode = CITY_CODES[city] || '765';
  let searchUrl = 'https://www.zhaopin.com/sou/jl' + cityCode + '/kw' + keyword;
  const exp = EXP_MAP[filter.experience]; if (exp) searchUrl += '?we=' + exp;
  const edu = EDU_MAP[filter.education]; if (edu) searchUrl += (exp ? '&' : '?') + 'el=' + edu;

  if (onProgress) onProgress({ type: 'phase', message: '[智联] 访问首页...' });
  await loadAndWait(win, 'https://www.zhaopin.com/', 15000);
  await sleep(2000 + Math.random() * 1000);

  if (onProgress) onProgress({ type: 'phase', message: '[智联] 搜索: ' + decodeURIComponent(keyword) });
  await loadAndWait(win, searchUrl, 20000);
  await sleep(3000);
  if (!await handleVerify(win, onProgress, helpers)) return [];

  let allJobs = [];
  let baseUrl = win.webContents.getURL().replace(/\/p\d+/, '').replace(/\?.*$/, '');
  let queryParams = searchUrl.match(/\?([^#]*)/);
  let queryStr = queryParams ? '?' + queryParams[1] : '';

  for (let page = 1; page <= 2; page++) {
    if (page > 1) {
      const pageUrl = baseUrl + '/p' + page + queryStr;
      await loadAndWait(win, pageUrl, 20000);
      await sleep(3000);
      if (!await handleVerify(win, onProgress, helpers)) break;
    }
    const result = await locator.extractJobsFromPage(win, 'zhilian', helpers);
    if (result.jobs && result.jobs.length > 0) {
      allJobs = allJobs.concat(result.jobs);
      onProgress({ type: 'info', message: '智联 第' + page + '页→' + result.jobs.length + '个' });
    } else { break; }
  }
  return allJobs;
}

async function apply(win, job, resume, helpers) {
  const { sleep, execJS } = helpers;
  await sleep(1500 + Math.random() * 1000);
  const result = await locator.clickElement(win, 'zhilian', 'apply', 'apply_btn', helpers);
  if (result.success) {
    await sleep(2000);
    const hasAppPrompt = await execJS(win, `
      document.body.innerText.includes('下载APP') ||
      document.body.innerText.includes('打开智联') ||
      document.querySelector('[class*="download-app"]') !== null
    `);
    if (hasAppPrompt) {
      await buttonHandler.zhilianDismissAppPopup(win, helpers);
      const chatResult = await locator.clickElement(win, 'zhilian', 'apply', 'chat_btn', helpers);
      if (chatResult.success) { await sleep(2000); return true; }
      throw new Error('投递弹出APP下载提示，沟通按钮也不可用');
    }
    return true;
  }
  const chatResult = await locator.clickElement(win, 'zhilian', 'apply', 'chat_btn', helpers);
  if (chatResult.success) { await sleep(2000); return true; }
  throw new Error(`投递按钮和沟通按钮都找不到`);
}

module.exports = { run, search, apply };