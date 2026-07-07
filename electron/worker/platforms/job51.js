/**
 * 51job前程无忧 Platform Adapter v5 — 模拟真人7步操作流程
 *
 * ★★★ v5 核心变化 ★★★
 * v4配置文件有乱码 → v5已修复所有中文值
 * v4只有1个apply_btn选择器 → v5扩充到5个（text+css多策略）
 * 新增搜索页专用按钮配置 searchPageButtons
 */
const configLoader = require('../configLoader');
const locator = require('../locator');
const buttonHandler = require('../buttonHandler');
const auth = require('../auth');

const CITY_CODES = {
  '深圳': '040000', '广州': '030200', '北京': '010000', '上海': '020000',
  '杭州': '080200', '成都': '090200', '武汉': '180200', '南京': '070200',
  '西安': '200200', '长沙': '190200', '苏州': '070300', '东莞': '190400',
  '天津': '050000', '重庆': '060000', '厦门': '110300', '合肥': '150200',
  '郑州': '170200', '青岛': '120300'
};

function closestSalaryCode51(minK) {
  if (!minK || minK <= 0) return '';
  if (minK <= 3) return '04'; if (minK <= 5) return '05'; if (minK <= 6) return '06';
  if (minK <= 8) return '07'; if (minK <= 10) return '08'; if (minK <= 15) return '09';
  if (minK <= 20) return '10'; if (minK <= 30) return '11'; if (minK <= 50) return '12';
  return '13';
}

function buildSearchUrl(filter) {
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');
  const cityCode = CITY_CODES[city] || '040000';
  let url = 'https://we.51job.com/pc/search?keyword=' + keyword + '&jobArea=' + cityCode;
  const eduMap = { '本科': '04', '硕士': '05', '大专': '03', '博士': '06' };
  if (filter.education && eduMap[filter.education]) url += '&degree=' + eduMap[filter.education];
  const expMap = { '1-3': '0102', '3-5': '0103', '5-10': '0104', '10+': '0105' };
  if (filter.experience && expMap[filter.experience]) url += '&workYear=' + expMap[filter.experience];
  if (filter.salary_min) {
    const salaryEncode = closestSalaryCode51(filter.salary_min);
    if (salaryEncode) url += '&salary=' + salaryEncode;
  }
  return url;
}

async function handleVerify(win, onProgress, helpers, maxWaitSec) {
  if (!maxWaitSec) maxWaitSec = 120;
  const { sleep, execJS } = helpers;
  const indicators = configLoader.getVerifyIndicators('job51');
  const url = win.webContents.getURL();

  const urlNeedsVerify = indicators.urlPatterns.some(p => url.includes(p));
  const pageNeedsVerify = await execJS(win, `
    (function() {
      var text = document.body ? document.body.innerText : '';
      var textPatterns = ${JSON.stringify(indicators.textPatterns)};
      for (var i = 0; i < textPatterns.length; i++) { if (text.includes(textPatterns[i])) return true; }
      var selectorPatterns = ${JSON.stringify(indicators.selectors)};
      for (var i = 0; i < selectorPatterns.length; i++) { try { var el = document.querySelector(selectorPatterns[i]); if (el && el.offsetHeight > 0) return true; } catch(_) {} }
      if (text.length < 500) return true;
      return false;
    })();
  `);

  if (!urlNeedsVerify && !pageNeedsVerify) return true;

  win.show();
  if (onProgress) onProgress({ type: 'warning', message: '[51job] ⚠️ 需要登录/验证！请在弹出窗口中操作' });
  await locator.captureScreenshot(win, '51job_verify_detected');

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
      if (onProgress) onProgress({ type: 'info', message: '[51job] ✅ 验证通过' });
      return true;
    }
  }
  if (onProgress) onProgress({ type: 'error', message: '[51job] ❌ 验证超时' });
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
  if (onProgress) onProgress({ type: 'phase', message: '[51job] Step 1: 检查登录状态...' });

  const isLoggedIn = await auth.verifyAuth('job51');
  if (!isLoggedIn) {
    if (onProgress) onProgress({ type: 'warning', message: '[51job] ⚠️ 未登录！弹出登录窗口' });
    await auth.startLogin('job51');
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await auth.verifyAuth('job51')) {
        if (onProgress) onProgress({ type: 'info', message: '[51job] ✅ 登录成功' });
        break;
      }
      if (i === 59) {
        if (onProgress) onProgress({ type: 'error', message: '[51job] ❌ 登录超时' });
        return results;
      }
    }
  }

  // ━━━━━ Step 2: 首页初始化 ━━━━━
  if (onProgress) onProgress({ type: 'phase', message: '[51job] Step 2: 访问首页...' });
  await loadAndWait(win, 'https://we.51job.com/', 10000);
  await sleep(1500 + Math.random() * 1000);
  if (!await handleVerify(win, onProgress, helpers)) {
    if (onProgress) onProgress({ type: 'error', message: '[51job] 首页验证未通过' });
    return results;
  }

  // ━━━━━ Step 3+4: 搜索 ━━━━━
  const searchUrl = buildSearchUrl(filter);
  const keyword = decodeURIComponent(searchUrl.match(/keyword=([^&]+)/)?.[1] || '');
  if (onProgress) onProgress({ type: 'phase', message: `[51job] Step 3-4: 搜索: ${keyword}` });
  await loadAndWait(win, searchUrl, 15000);
  await sleep(2000);
  if (!await handleVerify(win, onProgress, helpers)) {
    if (onProgress) onProgress({ type: 'error', message: '[51job] 搜索验证失败' });
    return results;
  }

  // 滚动触发懒加载
  await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=8)clearInterval(t);},400);})();`);
  await sleep(3000);

  let currentUrl = win.webContents.getURL();

  // ━━━━━ Step 5-7: 投递循环 ━━━━━
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (results.success >= perPlatformLimit) {
      if (onProgress) onProgress({ type: 'info', message: `[51job] ✅ 已达上限 ${perPlatformLimit}` });
      break;
    }

    if (onProgress) onProgress({ type: 'phase', message: `[51job] 第${page}页投递循环...` });

    const _cardCountResult = await buttonHandler.getCardCount(win, 'job51', helpers);
    const cardCount = (_cardCountResult && _cardCountResult.realCount !== undefined) ? _cardCountResult.realCount : (_cardCountResult || 0);
    if (cardCount === 0) {
      if (onProgress) onProgress({ type: 'warning', message: `[51job] 第${page}页0个卡片` });
      break;
    }
    if (onProgress) onProgress({ type: 'info', message: `[51job] 第${page}页发现 ${cardCount} 个职位卡片` });

    for (let cardIdx = 0; cardIdx < cardCount && results.success < perPlatformLimit; cardIdx++) {
      if (onProgress) onProgress({ type: 'info', message: `[51job] 卡片 ${cardIdx+1}/${cardCount}` });

      // ★ Bug#1修复：先提取信息（不点击）
      const infoResult = await buttonHandler.getCardInfoOnSearchPage(win, 'job51', cardIdx, helpers);

      if (infoResult.error) {
        if (onProgress) onProgress({ type: 'warning', message: `[51job] 卡片${cardIdx+1} 信息提取失败: ${infoResult.error}` });
        results.failed++;
        continue;
      }

      if (infoResult.alreadyApplied) {
        if (onProgress) onProgress({ type: 'info', message: `[51job] 卡片${cardIdx+1} 已申请，跳过` });
        results.skipped++;
        continue;
      }

      const cardInfo = infoResult.cardInfo;

      // ★ 关键词实时匹配（在点击之前判断！）
      if (!buttonHandler.shouldApplyToCard(cardInfo, filter)) {
        if (onProgress) onProgress({ type: 'info', message: `[51job] 卡片${cardIdx+1} 关键词不匹配: ${cardInfo?.title || ''}` });
        results.skipped++;
        continue;
      }

      // ★ 关键词匹配成功 → 点击申请按钮
      const clickResult = await buttonHandler.clickApplyOnly(win, 'job51', cardIdx, helpers);

      if (!clickResult.clicked) {
        if (onProgress) onProgress({ type: 'warning', message: `[51job] 卡片${cardIdx+1} 按钮找不到: ${clickResult.error}` });
        results.failed++;
        continue;
      }

      await sleep(2000);

      // ★ 检查拦截
      const blockCheck = await buttonHandler.checkBlockIndicator(win, 'job51', helpers);
      if (blockCheck.blocked) {
        if (blockCheck.severity === 'hard') {
          if (onProgress) onProgress({ type: 'error', message: `[51job] ❌ 拦截(${blockCheck.reason})，停止` });
          break;
        } else if (blockCheck.severity === 'soft') {
          if (onProgress) onProgress({ type: 'warning', message: `[51job] ⚠️ 拦截(${blockCheck.reason})，暂停10秒` });
          await sleep(10000);
        }
      }

      // ★ 投递成功
      results.success++;
      results.appliedJobs.push({
        platform: 'job51',
        title: cardInfo?.title || '',
        company: cardInfo?.company || '',
        salary: cardInfo?.salary || '',
        url: '',
        status: 'success'
      });

      if (onProgress) onProgress({
        type: 'result',
        message: `✅ 51job: ${cardInfo?.company || '未知'} - ${cardInfo?.title || '未知'}`,
        current: results.success,
        total: perPlatformLimit
      });

      const delay = (filter.interval_seconds || 5) * 1000 + Math.random() * 3000;
      await sleep(delay);
    }

    // ★ 翻页
    if (results.success < perPlatformLimit && page < MAX_PAGES) {
      const nextResult = await buttonHandler.clickNextPage(win, 'job51', currentUrl, page + 1, helpers);
      if (!nextResult.success) {
        if (onProgress) onProgress({ type: 'warning', message: `[51job] 翻页失败` });
        break;
      }
      currentUrl = nextResult.newUrl || win.webContents.getURL();
      await handleVerify(win, onProgress, helpers);
      await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=8)clearInterval(t);},400);})();`);
      await sleep(3000);
    }
  }

  if (onProgress) onProgress({ type: 'info', message: `[51job] 完成: 成功${results.success} 失败${results.failed} 跳过${results.skipped}` });
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 旧版 search + apply — 备选
// ═══════════════════════════════════════════════════════════════

async function search(win, filter, onProgress, helpers) {
  const { loadAndWait, sleep, execJS } = helpers;
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');
  const cityCode = CITY_CODES[city] || '040000';
  let searchUrl = 'https://we.51job.com/pc/search?keyword=' + keyword + '&jobArea=' + cityCode;
  const eduMap = { '本科': '04', '硕士': '05', '大专': '03', '博士': '06' };
  if (filter.education && eduMap[filter.education]) searchUrl += '&degree=' + eduMap[filter.education];
  const expMap = { '1-3': '0102', '3-5': '0103', '5-10': '0104', '10+': '0105' };
  if (filter.experience && expMap[filter.experience]) searchUrl += '&workYear=' + expMap[filter.experience];
  if (filter.salary_min) { const sc = closestSalaryCode51(filter.salary_min); if (sc) searchUrl += '&salary=' + sc; }

  if (onProgress) onProgress({ type: 'phase', message: '[51job] 访问首页...' });
  await loadAndWait(win, 'https://we.51job.com/', 10000);
  await sleep(1500 + Math.random() * 1000);

  if (onProgress) onProgress({ type: 'phase', message: '[51job] 搜索: ' + decodeURIComponent(keyword) });
  await loadAndWait(win, searchUrl, 15000);
  await sleep(2000);
  if (!await handleVerify(win, onProgress, helpers)) return [];

  let allJobs = [];
  for (let page = 1; page <= 2; page++) {
    if (page > 1) {
      await loadAndWait(win, searchUrl + '&pageno=' + page, 15000);
      await sleep(2000);
      if (!await handleVerify(win, onProgress, helpers)) break;
    }
    const result = await locator.extractJobsFromPage(win, 'job51', helpers);
    if (result.jobs && result.jobs.length > 0) {
      allJobs = allJobs.concat(result.jobs);
      onProgress({ type: 'info', message: '51job 第' + page + '页→' + result.jobs.length + '个' });
    } else { break; }
  }
  return allJobs;
}

async function apply(win, job, resume, helpers) {
  const { sleep, execJS } = helpers;
  await sleep(1500 + Math.random() * 1000);
  const result = await locator.clickElement(win, 'job51', 'apply', 'apply_btn', helpers);
  if (result.success) {
    await sleep(2000);
    const successIndicators = configLoader.getSuccessIndicators('job51');
    const checkResult = await execJS(win, `
      (function() {
        var text = document.body ? document.body.innerText : '';
        var successWords = ${JSON.stringify(successIndicators)};
        for (var i = 0; i < successWords.length; i++) { if (text.includes(successWords[i])) return { success: true, indicator: successWords[i] }; }
        var blockWords = ['请先登录', '简历不完整', '操作频繁'];
        for (var i = 0; i < blockWords.length; i++) { if (text.includes(blockWords[i])) return { blocked: true, reason: blockWords[i] }; }
        return { unknown: true };
      })();
    `);
    if (checkResult && checkResult.success) return true;
    if (checkResult && checkResult.blocked) throw new Error(`投递被拦截: ${checkResult.reason}`);
    return true;
  }
  throw new Error(result.error || '未找到投递按钮');
}

module.exports = { run, search, apply };