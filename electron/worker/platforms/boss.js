/**
 * BOSS直聘 Platform Adapter v6 — 完全重写
 *
 * ★★★ v6 核心变化 ★★★
 * 旧版(v5): bossSimulateHover → bossClickAfterHover（两步分离，中间页面易变）
 * 新版(v6): bossApplyCard(检查+hover+提取) → bossClickAndGreet(点击+打招呼)
 *           + bossGetRealCardCount(骨架屏过滤)
 *
 * Boss投递流程：
 * 1. 检查登录
 * 2. 首页 → 验证检测
 * 3. 搜索页 → 验证检测 → 等待真实内容加载
 * 4. 投递循环：bossApplyCard → 关键词检查 → bossClickAndGreet → 拦截检测
 * 5. 翻页
 */
const configLoader = require('../configLoader');
const locator = require('../locator');
const buttonHandler = require('../buttonHandler');
const auth = require('../auth');

const CITY_MAP = {
  '深圳': '100010000', '广州': '100020000', '北京': '100000000',
  '上海': '100030000', '杭州': '100080000', '成都': '100270000',
  '武汉': '100140000', '南京': '100070000', '西安': '100200000',
  '长沙': '100190000', '苏州': '100110000', '东莞': '100290000',
  '天津': '100050000', '重庆': '100240000', '厦门': '100170000',
  '合肥': '100150000', '郑州': '100180000', '青岛': '100090000'
};

const EXPERIENCE_MAP = { '': '0', '1-3': '102', '3-5': '103', '5-10': '104', '10+': '105' };
const EDUCATION_MAP = { '': '0', '大专': '202', '本科': '203', '硕士': '204', '博士': '205' };

function closestSalaryCode(minK) {
  if (!minK || minK <= 0) return '';
  if (minK <= 3) return '402'; if (minK <= 5) return '403'; if (minK <= 10) return '404';
  if (minK <= 15) return '405'; if (minK <= 20) return '406'; if (minK <= 25) return '407';
  if (minK <= 30) return '408'; if (minK <= 50) return '409';
  return '410';
}

function buildSearchUrl(filter, stripFilters = false) {
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');
  const cityCode = CITY_MAP[city] || '100010000';
  let url = 'https://www.zhipin.com/web/geek/jobs?city=' + cityCode + '&query=' + keyword;
  if (!stripFilters) {
    const exp = EXPERIENCE_MAP[filter.experience] || '0';
    if (exp !== '0') url += '&experience=' + exp;
    const edu = EDUCATION_MAP[filter.education] || '0';
    if (edu !== '0') url += '&degree=' + edu;
    const salaryCode = closestSalaryCode(filter.salary_min);
    if (salaryCode) url += '&salary=' + salaryCode;
  }
  return url;
}

// ═══════════════════════════════════════════════════════════════
// ★★★ v6 核心：run() — 简化的5步流程 ★★★
// ═══════════════════════════════════════════════════════════════

async function run(win, filter, resume, onProgress, helpers) {
  const { loadAndWait, sleep, execJS } = helpers;
  const results = { success: 0, failed: 0, skipped: 0, appliedJobs: [] };
  const limit = filter.daily_limit || 10;
  const MAX_PAGES = 3;
  const MAX_SKELETON_WAIT = 20; // 骨架屏最多等20秒

  // ━━━━━ Step 1: 登录检查 ━━━━━
  if (onProgress) onProgress({ type: 'phase', message: '[Boss] 1/5 检查登录...' });
  const isLoggedIn = await auth.verifyAuth('boss');
  if (!isLoggedIn) {
    if (onProgress) onProgress({ type: 'warning', message: '[Boss] 未登录，请扫码' });
    await auth.startLogin('boss');
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await auth.verifyAuth('boss')) { if (onProgress) onProgress({ type: 'info', message: '[Boss] 登录成功' }); break; }
      if (i === 59) { if (onProgress) onProgress({ type: 'error', message: '[Boss] 登录超时' }); return results; }
    }
  }

  // ━━━━━ Step 2: 首页 → 验证 ━━━━━
  if (onProgress) onProgress({ type: 'phase', message: '[Boss] 2/5 首页初始化...' });
  let homeOk = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await loadAndWait(win, 'https://www.zhipin.com/', 15000); } catch(e) {}
    // 检查是否真的加载成功了
    const homeCheck = await execJS(win, `JSON.stringify({url:window.location.href,bodyLen:document.body?document.body.innerText.length:0})`);
    if (homeCheck) {
      try {
        const hc = JSON.parse(homeCheck);
        if (hc.url && !hc.url.includes('chrome-error') && hc.bodyLen > 100) { homeOk = true; break; }
      } catch(_) {}
    }
    if (onProgress) onProgress({ type: 'warning', message: `[Boss] 首页重试${attempt}/3` });
    await sleep(3000 * attempt);
  }
  if (!homeOk) { if (onProgress) onProgress({ type: 'error', message: '[Boss] 首页加载失败(3次)' }); return results; }
  await sleep(1500 + Math.random() * 1000);

  if (!await handleVerify(win, onProgress, helpers)) {
    if (onProgress) onProgress({ type: 'error', message: '[Boss] 首页验证未通过' }); return results;
  }

  // ━━━━━ Step 3: 搜索 → 等内容就绪 ━━━━━
  const searchUrl = buildSearchUrl(filter);
  const keyword = decodeURIComponent(searchUrl.match(/query=([^&]+)/)?.[1] || '');
  if (onProgress) onProgress({ type: 'phase', message: `[Boss] 3/5 搜索: ${keyword} ← ${searchUrl}` });
  await loadAndWait(win, searchUrl, 20000);
  await sleep(3000);
  // 诊断：搜索完页面实际状态
  const searchDiag = await execJS(win, `JSON.stringify({url:window.location.href,title:document.title,bodyLen:document.body?document.body.innerText.length:0,bodySnippet:(document.body?document.body.innerText:'').substring(0,200)})`);
  if (onProgress) onProgress({ type: 'info', message: `[Boss] 搜索页状态: ${searchDiag || '(execJS失败)'}` });

  if (!await handleVerify(win, onProgress, helpers)) {
    const looseUrl = buildSearchUrl(filter, true);
    if (onProgress) onProgress({ type: 'warning', message: '[Boss] 搜索被拦截，宽松模式重试...' });
    await loadAndWait(win, looseUrl, 20000);
    await sleep(3000);
    if (!await handleVerify(win, onProgress, helpers)) {
      if (onProgress) onProgress({ type: 'error', message: '[Boss] 搜索验证未通过' }); return results;
    }
  }

  // ★ 等待真实内容加载（骨架屏→真实数据）
  await scrollAndWait(win, helpers, 8, 3000);
  let contentReady = await waitForRealContent(win, helpers, MAX_SKELETON_WAIT, onProgress);
  if (!contentReady) {
    if (onProgress) onProgress({ type: 'warning', message: '[Boss] 等待内容超时，可能被拦截或无结果' });
  }

  let currentUrl = win.webContents.getURL();

  // ━━━━━ Step 4+5: 投递循环 + 翻页 ━━━━━
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (results.success >= limit) {
      if (onProgress) onProgress({ type: 'info', message: `[Boss] 已达上限${limit}` }); break;
    }

    // 每页开始：获取真实卡片数
    const countInfo = await buttonHandler.bossGetRealCardCount(win, helpers);
    let cardCount = countInfo.realCount;

    // 骨架屏重试
    if (countInfo.isSkeleton && cardCount === 0) {
      for (let retry = 1; retry <= 3; retry++) {
        if (onProgress) onProgress({ type: 'warning', message: `[Boss] 第${page}页骨架屏重试${retry}/3` });
        await sleep(3000 * retry);
        await scrollAndWait(win, helpers, 4, 2000);
        const recheck = await buttonHandler.bossGetRealCardCount(win, helpers);
        cardCount = recheck.realCount;
        if (!recheck.isSkeleton && cardCount > 0) break;
      }
    }

    if (cardCount === 0) {
      const diag = countInfo.diagnostic || {};
      const tops = (diag.topContainers || []).map(function(c){return (c.tag||'')+'.'+(c.cls||'').substring(0,30);}).join(' | ');
      if (onProgress) onProgress({ type: 'error', message: `[Boss] 第${page}页0卡片 total=${countInfo.totalCount} skel=${countInfo.skeletonCount} body=${diag.bodyTextLen||0} links=${diag.jobLinks||0} tops=${tops||'none'}` }); break;
    }
    if (onProgress) onProgress({ type: 'info', message: `[Boss] 第${page}页${cardCount}个真实职位` });

    // 遍历卡片
    for (let cardIdx = 0; cardIdx < cardCount && results.success < limit; cardIdx++) {
      if (onProgress) onProgress({ type: 'info', message: `[Boss] ${cardIdx+1}/${cardCount} (${results.success}/${limit})` });

      // ★ bossApplyCard: 检查+hover+提取信息
      const cardResult = await buttonHandler.bossApplyCard(win, cardIdx, helpers);

      if (cardResult.error) {
        if (cardResult.error === 'skeleton_or_empty') {
          // 骨架屏 → 跳过这个卡片，不计入失败
          continue;
        }
        if (onProgress) onProgress({ type: 'warning', message: `[Boss] 卡片${cardIdx+1} 失败: ${cardResult.error}` });
        results.failed++;
        continue;
      }

      if (cardResult.alreadyApplied) {
        if (onProgress) onProgress({ type: 'info', message: `[Boss] 卡片${cardIdx+1} 已沟通，跳过` });
        results.skipped++;
        continue;
      }

      const cardInfo = cardResult.cardInfo;

      // ★ 关键词检查（在点击之前！）
      if (!buttonHandler.shouldApplyToCard(cardInfo, filter)) {
        if (onProgress) onProgress({ type: 'info', message: `[Boss] 卡片${cardIdx+1} 关键词不匹配: ${cardInfo.title || '(空)'}` });
        results.skipped++;
        continue;
      }

      // ★ bossClickAndGreet: 点击沟通+打招呼
      const applyResult = await buttonHandler.bossClickAndGreet(win, cardIdx, helpers);

      if (!applyResult.clicked) {
        if (onProgress) onProgress({ type: 'warning', message: `[Boss] 卡片${cardIdx+1} 点击失败: ${applyResult.error}` });
        results.failed++;
        continue;
      }

      // ★ 拦截检测
      await sleep(1500);
      const blockCheck = await buttonHandler.checkBlockIndicator(win, 'boss', helpers);
      if (blockCheck.blocked) {
        if (blockCheck.severity === 'hard') {
          if (onProgress) onProgress({ type: 'error', message: `[Boss] 严重拦截(${blockCheck.reason})，停止` }); break;
        } else if (blockCheck.severity === 'soft') {
          if (onProgress) onProgress({ type: 'warning', message: `[Boss] 轻度拦截(${blockCheck.reason})，等10秒` });
          await sleep(10000);
        }
      }

      // ★ 成功
      results.success++;
      results.appliedJobs.push({
        platform: 'boss',
        title: cardInfo.title || '',
        company: cardInfo.company || '',
        salary: cardInfo.salary || '',
        url: '',
        status: 'success'
      });

      if (onProgress) onProgress({
        type: 'result',
        message: `✅ Boss: ${cardInfo.company || '?'} - ${cardInfo.title || '?'}`,
        current: results.success,
        total: limit
      });

      // ★ 投递间隔
      const delay = (filter.interval_seconds || 5) * 1000 + Math.random() * 3000;
      await sleep(delay);
    }

    // ★ 翻页
    if (results.success < limit && page < MAX_PAGES) {
      const nextResult = await buttonHandler.clickNextPage(win, 'boss', currentUrl, page + 1, helpers);
      if (!nextResult.success) {
        if (onProgress) onProgress({ type: 'warning', message: `[Boss] 第${page+1}页翻页失败` }); break;
      }
      currentUrl = nextResult.newUrl || win.webContents.getURL();
      await handleVerify(win, onProgress, helpers);
      await scrollAndWait(win, helpers, 8, 3000);
      // 翻页后也要等真实内容
      await waitForRealContent(win, helpers, 15, null);
    }
  }

  if (onProgress) onProgress({ type: 'info', message: `[Boss] 完成: 成功${results.success} 失败${results.failed} 跳过${results.skipped}` });
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** 滚动页面促进懒加载 */
async function scrollAndWait(win, helpers, steps, waitMs) {
  const { execJS, sleep } = helpers;
  await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=${steps})clearInterval(t);},400);})();`);
  await sleep(waitMs);
}

/** 等待真实职位内容出现（骨架屏→真实数据） */
async function waitForRealContent(win, helpers, maxWaitSec, onProgress) {
  const { sleep } = helpers;
  for (let attempt = 1; attempt <= Math.ceil(maxWaitSec / 3); attempt++) {
    const countInfo = await buttonHandler.bossGetRealCardCount(win, helpers);
    if (countInfo.realCount > 0 && !countInfo.isSkeleton) return true;
    // 输出诊断信息到UI，方便定位问题
    const diag = countInfo.diagnostic || {};
    if (onProgress && attempt <= 3) {
      onProgress({ type: 'warning', message: `[Boss] 等内容(${attempt}) 卡片${countInfo.totalCount}个 真实${countInfo.realCount}个 URL=${(diag.url||'').substring(0,50)} bodyLen=${diag.bodyTextLen||0} jobLinks=${diag.jobLinks||0}` });
    }
    await sleep(3000);
  }
  return false;
}

/** 验证检测 */
async function handleVerify(win, onProgress, helpers, maxWaitSec) {
  if (!maxWaitSec) maxWaitSec = 90;
  const { sleep, execJS } = helpers;
  const indicators = configLoader.getVerifyIndicators('boss');
  const url = win.webContents.getURL();

  const urlNeedsVerify = indicators.urlPatterns.some(p => url.includes(p));
  const pageNeedsVerify = await execJS(win, `
    (function() {
      var text = document.body ? document.body.innerText : '';
      // 只有完全空白的页面才判为验证页（<50字），之前800字阈值误杀了正常首页
      var patterns = ${JSON.stringify(indicators.textPatterns)};
      for (var i = 0; i < patterns.length; i++) { if (text.includes(patterns[i])) return true; }
      var selectors = ${JSON.stringify(indicators.selectors)};
      for (var i = 0; i < selectors.length; i++) {
        try { var el = document.querySelector(selectors[i]); if (el && el.offsetHeight > 0) return true; } catch(_) {}
      }
      return false;
    })();
  `);

  if (!urlNeedsVerify && !pageNeedsVerify) return true;

  win.show();
  if (onProgress) onProgress({ type: 'warning', message: '[Boss] 需要验证！请操作' });
  await locator.captureScreenshot(win, 'boss_verify_detected');

  for (let i = 0; i < maxWaitSec / 2; i++) {
    await sleep(2000);
    if (!win || win.isDestroyed()) return false;
    const u = win.webContents.getURL();
    const urlOk = indicators.urlPatterns.every(p => !u.includes(p));
    const contentOk = await execJS(win, `
      (function() {
        var text = document.body ? document.body.innerText : '';
        if (text.length < 800) return false;
        var patterns = ${JSON.stringify(indicators.textPatterns)};
        for (var i = 0; i < patterns.length; i++) { if (text.includes(patterns[i])) return false; }
        return true;
      })();
    `);
    if (urlOk && contentOk) {
      if (onProgress) onProgress({ type: 'info', message: '[Boss] 验证通过' });
      return true;
    }
    if ((i + 1) % 8 === 0 && i > 2) {
      try { win.webContents.reload(); await sleep(3000); } catch(_) {}
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// 旧版 search + apply（保留作为fallback）
// ═══════════════════════════════════════════════════════════════

async function search(win, filter, onProgress, helpers) {
  const { loadAndWait, sleep, execJS } = helpers;
  const searchUrl = buildSearchUrl(filter);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) { try { win.webContents.session.clearStorageData(); } catch(_) {} await sleep(1000); }
    let homeOk = false;
    for (let h = 1; h <= 3; h++) { try { await loadAndWait(win, 'https://www.zhipin.com/', 12000); homeOk = true; break; } catch(e) { await sleep(2000 * h); } }
    if (!homeOk) continue;
    await sleep(1500 + Math.random() * 1000);
    const url = attempt >= 2 ? buildSearchUrl(filter, true) : searchUrl;
    await loadAndWait(win, url, 20000);
    await sleep(3000);
    if (!await handleVerify(win, onProgress, helpers)) { if (attempt < 3) continue; return []; }
    let allJobs = [];
    for (let page = 1; page <= 2; page++) {
      if (page > 1) { await loadAndWait(win, url + '&page=' + page, 15000); await sleep(2000); if (!await handleVerify(win, onProgress, helpers)) break; }
      for (let ex = 1; ex <= 3; ex++) {
        const pageResult = await locator.extractJobsFromPage(win, 'boss', helpers);
        if (pageResult.jobs && pageResult.jobs.length > 0) { allJobs = allJobs.concat(pageResult.jobs); break; }
        if (ex === 1) { await execJS(win, `(function(){var s=0;var t=setInterval(function(){window.scrollBy(0,500);if(++s>=10)clearInterval(t);},300);})();`); await sleep(4000); }
        else { await sleep(5000); }
      }
      if (allJobs.length === 0 && page === 1 && attempt < 3) break;
    }
    if (allJobs.length > 0) return allJobs;
  }
  return [];
}

async function apply(win, job, resume, helpers) {
  const { sleep, execJS } = helpers;
  await sleep(2000); // Let detail page fully render

  // Step 1: Click apply/chat button
  const result = await locator.clickElement(win, 'boss', 'apply', 'apply_btn', helpers);
  if (!result.success) throw new Error(result.error || '未找到投递/沟通按钮');

  await sleep(1500);

  // Step 2: Check if greeting dialog opened — fill and send
  const hasInput = await locator.locateElement(win, 'boss', 'apply', 'greeting_input', helpers);
  if (hasInput.found) {
    const skills = (resume.skills || []).slice(0, 5).join('、');
    const years = resume.work_history ? resume.work_history.length : 0;
    let msg = '您好';
    if (job.title) msg += '，我对贵司的「' + job.title + '」岗位很感兴趣';
    if (years > 0) msg += '，我有' + years + '年工作经验';
    if (skills) msg += '，擅长' + skills;
    msg += '，期待进一步沟通！';

    // Escape single quotes for JS string
    const safeMsg = msg.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    await execJS(win, `
      (function() {
        var inputs = document.querySelectorAll('.chat-input textarea, .chat-input, textarea[class*="input"], textarea[placeholder*="介绍"], .greeting-edit textarea, .dialog-msg textarea');
        for (var i = 0; i < inputs.length; i++) {
          var el = inputs[i];
          el.focus();
          try {
            var desc = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
            if (desc && desc.set) { desc.set.call(el, '${safeMsg}'); }
            else { el.value = '${safeMsg}'; }
          } catch(e) { el.value = '${safeMsg}'; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })();
    `);
    await sleep(800);
    await locator.clickElement(win, 'boss', 'apply', 'greeting_send', helpers);
    await sleep(1500);
  }

  // Step 3: Check for success or block indicators
  const successWords = configLoader.getSuccessIndicators('boss');
  const checkResult = await execJS(win, `
    (function() {
      var text = document.body ? document.body.innerText : '';
      var success = ${JSON.stringify(successWords)};
      for (var i = 0; i < success.length; i++) { if (text.includes(success[i])) return { ok: true, indicator: success[i] }; }
      var blocks = ['请先登录', '需要验证', '操作频繁', '今日投递已达上限'];
      for (var i = 0; i < blocks.length; i++) { if (text.includes(blocks[i])) return { blocked: true, reason: blocks[i] }; }
      return { ok: true };
    })();
  `);
  if (checkResult && checkResult.blocked) throw new Error('Boss拦截: ' + checkResult.reason);
  return true;
}

module.exports = { run, search, apply, CITY_MAP };
