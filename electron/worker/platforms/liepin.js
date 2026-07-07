/**
 * 猎聘 Platform Adapter v5 — 模拟真人7步操作流程
 *
 * ★★★ v5 核心变化 ★★★
 * 猎聘搜索页的"投递简历"按钮直接可见，不需要hover
 * 投递后可能有确认弹窗 → buttonHandler.liepinHandleConfirmDialog()
 * 按钮可能变成"已投递" → 检查状态后跳过
 *
 * 猎聘是最稳定的平台，按钮直接可见，改造风险最低
 */
const configLoader = require('../configLoader');
const locator = require('../locator');
const buttonHandler = require('../buttonHandler');
const auth = require('../auth');

const CITY_CODES = {
  '深圳': '050090', '广州': '050020', '北京': '010010', '上海': '020010',
  '杭州': '070020', '成都': '280020', '武汉': '170020', '南京': '060020',
  '西安': '210020', '长沙': '180020', '苏州': '060030', '东莞': '050040',
  '天津': '030010', '重庆': '040010', '厦门': '090040',
  '合肥': '080020', '郑州': '150020', '青岛': '120020'
};

function liepinSalaryCode(minK) {
  if (!minK || minK <= 0) return '';
  if (minK <= 3) return '1'; if (minK <= 5) return '2'; if (minK <= 10) return '3';
  if (minK <= 15) return '4'; if (minK <= 20) return '5'; if (minK <= 30) return '7';
  if (minK <= 50) return '8'; return '9';
}
function liepinEduCode(edu) { var m = { '大专': '1', '本科': '2', '硕士': '3', '博士': '4' }; return m[edu] || ''; }
function liepinExpCode(exp) { var m = { '1-3': '020', '3-5': '030', '5-10': '040', '10+': '050' }; return m[exp] || ''; }

function buildSearchUrl(filter) {
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');
  const cityCode = CITY_CODES[city] || '';
  let url = 'https://www.liepin.com/zhaopin/?key=' + keyword;
  if (cityCode) url += '&dqs=' + cityCode;
  const expCode = liepinExpCode(filter.experience); if (expCode) url += '&expTag=' + expCode;
  const eduCode = liepinEduCode(filter.education); if (eduCode) url += '&edu=' + eduCode;
  const salaryCode = liepinSalaryCode(filter.salary_min); if (salaryCode) url += '&salary=' + salaryCode;
  return url;
}

async function handleVerify(win, onProgress, helpers, maxWaitSec) {
  if (!maxWaitSec) maxWaitSec = 120;
  const { sleep, execJS } = helpers;
  const indicators = configLoader.getVerifyIndicators('liepin');
  const url = win.webContents.getURL();

  const urlNeedsVerify = indicators.urlPatterns.some(p => url.includes(p));
  const pageNeedsVerify = await execJS(win, `
    (function() {
      var text = document.body ? document.body.innerText : '';
      var patterns = ${JSON.stringify(indicators.textPatterns)};
      for (var i = 0; i < patterns.length; i++) { if (text.includes(patterns[i])) return true; }
      var selectors = ${JSON.stringify(indicators.selectors)};
      for (var i = 0; i < selectors.length; i++) { try { var el = document.querySelector(selectors[i]); if (el && el.offsetHeight > 0) return true; } catch(_) {} }
      return false;
    })();
  `);

  if (!urlNeedsVerify && !pageNeedsVerify) return true;

  win.show();
  if (onProgress) onProgress({ type: 'warning', message: '[猎聘] ⚠️ 需要登录/验证！请在弹出窗口中操作' });
  await locator.captureScreenshot(win, 'liepin_verify_detected');

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
        return true;
      })();
    `);
    if (urlOk && contentOk) {
      if (onProgress) onProgress({ type: 'info', message: '[猎聘] ✅ 验证通过' });
      return true;
    }
  }
  if (onProgress) onProgress({ type: 'error', message: '[猎聘] ❌ 验证超时（120秒）' });
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
  if (onProgress) onProgress({ type: 'phase', message: '[猎聘] Step 1: 检查登录状态...' });

  const isLoggedIn = await auth.verifyAuth('liepin');
  if (!isLoggedIn) {
    if (onProgress) onProgress({ type: 'warning', message: '[猎聘] ⚠️ 未登录！弹出登录窗口' });
    await auth.startLogin('liepin');
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await auth.verifyAuth('liepin')) {
        if (onProgress) onProgress({ type: 'info', message: '[猎聘] ✅ 登录成功' });
        break;
      }
      if (i === 59) {
        if (onProgress) onProgress({ type: 'error', message: '[猎聘] ❌ 登录超时' });
        return results;
      }
    }
  }

  // ━━━━━ Step 2: 首页初始化 ━━━━━
  if (onProgress) onProgress({ type: 'phase', message: '[猎聘] Step 2: 访问首页...' });
  await loadAndWait(win, 'https://www.liepin.com/', 15000);
  await sleep(1500 + Math.random() * 1000);
  if (!await handleVerify(win, onProgress, helpers)) {
    if (onProgress) onProgress({ type: 'error', message: '[猎聘] 首页验证未通过' });
    return results;
  }

  // ━━━━━ Step 3+4: 搜索 ━━━━━
  const searchUrl = buildSearchUrl(filter);
  const keyword = decodeURIComponent(searchUrl.match(/key=([^&]+)/)?.[1] || '');
  if (onProgress) onProgress({ type: 'phase', message: `[猎聘] Step 3-4: 搜索: ${keyword}` });
  await loadAndWait(win, searchUrl, 15000);
  await sleep(2000);
  if (!await handleVerify(win, onProgress, helpers)) {
    if (onProgress) onProgress({ type: 'error', message: '[猎聘] 搜索验证失败' });
    return results;
  }

  // 滚动触发懒加载
  await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=8)clearInterval(t);},400);})();`);
  await sleep(3000);

  let currentUrl = win.webContents.getURL();

  // ━━━━━ Step 5-7: 投递循环 ━━━━━
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (results.success >= perPlatformLimit) {
      if (onProgress) onProgress({ type: 'info', message: `[猎聘] ✅ 已达上限 ${perPlatformLimit}` });
      break;
    }

    if (onProgress) onProgress({ type: 'phase', message: `[猎聘] 第${page}页投递循环...` });

    const _cardCountResult = await buttonHandler.getCardCount(win, 'liepin', helpers);
    const cardCount = (_cardCountResult && _cardCountResult.realCount !== undefined) ? _cardCountResult.realCount : (_cardCountResult || 0);
    if (cardCount === 0) {
      if (onProgress) onProgress({ type: 'warning', message: `[猎聘] 第${page}页0个卡片` });
      break;
    }
    if (onProgress) onProgress({ type: 'info', message: `[猎聘] 第${page}页发现 ${cardCount} 个职位卡片` });

    for (let cardIdx = 0; cardIdx < cardCount && results.success < perPlatformLimit; cardIdx++) {
      if (onProgress) onProgress({ type: 'info', message: `[猎聘] 卡片 ${cardIdx+1}/${cardCount}` });

      // ★ Bug#1修复：先提取信息（不点击）
      const infoResult = await buttonHandler.getCardInfoOnSearchPage(win, 'liepin', cardIdx, helpers);

      if (infoResult.error) {
        if (onProgress) onProgress({ type: 'warning', message: `[猎聘] 卡片${cardIdx+1} 信息提取失败: ${infoResult.error}` });
        results.failed++;
        continue;
      }

      if (infoResult.alreadyApplied) {
        if (onProgress) onProgress({ type: 'info', message: `[猎聘] 卡片${cardIdx+1} 已投递，跳过` });
        results.skipped++;
        continue;
      }

      const cardInfo = infoResult.cardInfo;

      // ★ 关键词实时匹配（在点击之前判断！）
      if (!buttonHandler.shouldApplyToCard(cardInfo, filter)) {
        if (onProgress) onProgress({ type: 'info', message: `[猎聘] 卡片${cardIdx+1} 关键词不匹配: ${cardInfo?.title || ''}` });
        results.skipped++;
        continue;
      }

      // ★ 关键词匹配成功 → 点击投递按钮
      const clickResult = await buttonHandler.clickApplyOnly(win, 'liepin', cardIdx, helpers);

      if (!clickResult.clicked) {
        if (onProgress) onProgress({ type: 'warning', message: `[猎聘] 卡片${cardIdx+1} 点击失败: ${clickResult.error}` });
        results.failed++;
        continue;
      }

      // ★ 处理确认弹窗
      await sleep(1500);
      await buttonHandler.liepinHandleConfirmDialog(win, helpers);

      // ★ 检查拦截
      const blockCheck = await buttonHandler.checkBlockIndicator(win, 'liepin', helpers);
      if (blockCheck.blocked) {
        if (blockCheck.severity === 'hard') {
          if (onProgress) onProgress({ type: 'error', message: `[猎聘] ❌ 拦截(${blockCheck.reason})，停止` });
          break;
        } else if (blockCheck.severity === 'soft') {
          if (onProgress) onProgress({ type: 'warning', message: `[猎聘] ⚠️ 拦截(${blockCheck.reason})，暂停10秒` });
          await sleep(10000);
        }
      }

      // ★ 投递成功
      results.success++;
      results.appliedJobs.push({
        platform: 'liepin',
        title: cardInfo?.title || '',
        company: cardInfo?.company || '',
        salary: cardInfo?.salary || '',
        url: '',
        status: 'success'
      });

      if (onProgress) onProgress({
        type: 'result',
        message: `✅ 猎聘: ${cardInfo?.company || '未知'} - ${cardInfo?.title || '未知'}`,
        current: results.success,
        total: perPlatformLimit
      });

      const delay = (filter.interval_seconds || 5) * 1000 + Math.random() * 3000;
      await sleep(delay);
    }

    // ★ 翻页
    if (results.success < perPlatformLimit && page < MAX_PAGES) {
      const nextResult = await buttonHandler.clickNextPage(win, 'liepin', currentUrl, page + 1, helpers);
      if (!nextResult.success) {
        if (onProgress) onProgress({ type: 'warning', message: `[猎聘] 翻页失败` });
        break;
      }
      currentUrl = nextResult.newUrl || win.webContents.getURL();
      await handleVerify(win, onProgress, helpers);
      await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=8)clearInterval(t);},400);})();`);
      await sleep(3000);
    }
  }

  if (onProgress) onProgress({ type: 'info', message: `[猎聘] 完成: 成功${results.success} 失败${results.failed} 跳过${results.skipped}` });
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 旧版 search + apply — 备选
// ═══════════════════════════════════════════════════════════════

async function search(win, filter, onProgress, helpers) {
  const { loadAndWait, sleep, execJS } = helpers;
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');
  const cityCode = CITY_CODES[city] || '';
  let searchUrl = 'https://www.liepin.com/zhaopin/?key=' + keyword;
  if (cityCode) searchUrl += '&dqs=' + cityCode;
  const expCode = liepinExpCode(filter.experience); if (expCode) searchUrl += '&expTag=' + expCode;
  const eduCode = liepinEduCode(filter.education); if (eduCode) searchUrl += '&edu=' + eduCode;
  const salaryCode = liepinSalaryCode(filter.salary_min); if (salaryCode) searchUrl += '&salary=' + salaryCode;

  if (onProgress) onProgress({ type: 'phase', message: '[猎聘] 访问首页...' });
  await loadAndWait(win, 'https://www.liepin.com/', 15000);
  await sleep(1500 + Math.random() * 1000);
  if (!await handleVerify(win, onProgress, helpers)) return [];

  if (onProgress) onProgress({ type: 'phase', message: '[猎聘] 搜索: ' + decodeURIComponent(keyword) });
  await loadAndWait(win, searchUrl, 15000);
  await sleep(2000);
  if (!await handleVerify(win, onProgress, helpers)) return [];

  let allJobs = [];
  for (let page = 0; page < 2; page++) {
    if (page > 0) {
      await loadAndWait(win, searchUrl + '&curPage=' + page, 20000);
      await sleep(2000);
      if (!await handleVerify(win, onProgress, helpers)) break;
    }
    const result = await locator.extractJobsFromPage(win, 'liepin', helpers);
    if (result.jobs && result.jobs.length > 0) {
      allJobs = allJobs.concat(result.jobs);
      onProgress({ type: 'info', message: '[猎聘] 第' + (page + 1) + '页→' + result.jobs.length + '个' });
    } else { break; }
  }
  return allJobs;
}

async function apply(win, job, resume, helpers) {
  const { sleep, execJS } = helpers;
  await sleep(1500 + Math.random() * 1000);
  const result = await locator.clickElement(win, 'liepin', 'apply', 'apply_btn', helpers);
  if (result.success) {
    await sleep(2000);
    await locator.clickElement(win, 'liepin', 'apply', 'confirm_btn', helpers);
    await sleep(1000);
    const successIndicators = configLoader.getSuccessIndicators('liepin');
    const checkResult = await execJS(win, `
      (function() {
        var text = document.body ? document.body.innerText : '';
        var words = ${JSON.stringify(successIndicators)};
        for (var i = 0; i < words.length; i++) { if (text.includes(words[i])) return { success: true, indicator: words[i] }; }
        var blocks = ['请先登录', '简历不完整', '操作频繁', '今日投递已达上限'];
        for (var i = 0; i < blocks.length; i++) { if (text.includes(blocks[i])) return { blocked: true, reason: blocks[i] }; }
        return { unknown: true };
      })();
    `);
    if (checkResult && checkResult.success) return true;
    if (checkResult && checkResult.blocked) throw new Error(`猎聘投递被拦截: ${checkResult.reason}`);
    return true;
  }
  const chatResult = await locator.clickElement(win, 'liepin', 'apply', 'chat_btn', helpers);
  if (chatResult.success) { await sleep(2000); return true; }
  throw new Error(`投递按钮和沟通按钮都找不到`);
}

module.exports = { run, search, apply };