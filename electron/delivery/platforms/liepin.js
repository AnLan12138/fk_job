/**
 * liepin.js — 猎聘适配器
 *
 * 投递机制：搜索 → 列表 → 点"应聘" → 弹窗表单（求职信必填） → 提交
 *
 * 特点：中高端岗位，常有"求职信"必填字段
 *
 * 独立文件：不与其他平台共用代码，所有逻辑自包含。
 */
const browser = require('../browser');
const selector = require('../selector-engine');
const logger = require('./logger-proxy');

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  _cfg = selector.loadConfig('liepin');
  return _cfg;
}

// ═══════════════════════════════════════════════════════════════
// 接口 1: loginCheck
// ═══════════════════════════════════════════════════════════════
async function loginCheck(win) {
  const url = win.webContents.getURL();
  if (url.includes('/login') || url.includes('/verify') || url.includes('/check')) return false;
  const cookies = await browser.getCookies('liepin');
  const authNames = (cfg() && cfg().authCookie) || ['user_sec_id', '__session__'];
  const cookieNames = cookies.map(c => c.name);
  return authNames.some(n => cookieNames.includes(n));
}

function getLoginUrl() { return cfg().loginUrl; }

// ═══════════════════════════════════════════════════════════════
// 接口 2: searchJobs
// ═══════════════════════════════════════════════════════════════
async function searchJobs(win, filter) {
  const keyword = (filter.keywords && filter.keywords[0]) || 'Java';
  const city = (filter.cities && filter.cities[0]) || '深圳';
  const cityCode = cfg().cities[city] || '050020';

  const url = `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&dqs=${cityCode}`;
  logger.info('liepin', `搜索: ${keyword} @ ${city}(code=${cityCode})`);

  // ★ 缓存搜索页 URL
  win._liepinSearchUrl = url;

  await browser.loadURL(win, url, 15000);
  await _sleep(2000);

  if (await _isVerifyPage(win)) {
    logger.warn('liepin', '检测到验证页');
    await _sleep(30000);
    if (await _isVerifyPage(win)) throw new Error('验证页未通过');
  }

  const jobs = await _extractJobList(win);
  logger.info('liepin', `提取到 ${jobs.length} 个职位`);

  // ★ 缓存 job 列表
  win._liepinJobs = jobs;
  win._liepinSearchTime = Date.now();

  // 最多翻 3 页
  for (let page = 2; page <= 3; page++) {
    if (await _clickNextPage(win)) {
      await _sleep(1500);
      const more = await _extractJobList(win);
      jobs.push(...more);
      win._liepinJobs = jobs;
    } else break;
  }

  return jobs;
}

async function _extractJobList(win) {
  const raw = await browser.evalJS(win, `
    (function() {
      var items = document.querySelectorAll('.job-list-box .job-list-item, .sojob-item-main');
      var out = [];
      items.forEach(function(el) {
        var titleEl = el.querySelector('.job-info .job-title, [class*="job-title"]');
        if (!titleEl || titleEl.textContent.trim().length < 2) return;
        var companyEl = el.querySelector('.company-name a, [class*="company-name"]');
        var salaryEl = el.querySelector('.job-salary, [class*="salary"]');
        var linkEl = el.querySelector('a[href*="/job/"], a[href*="/company/"]');
        out.push({
          title: titleEl.textContent.trim(),
          company: companyEl ? companyEl.textContent.trim() : '',
          salary: salaryEl ? salaryEl.textContent.trim() : '',
          url: linkEl ? linkEl.href : '',
          _raw: el.outerHTML.substring(0, 200)
        });
      });
      return JSON.stringify(out);
    })();
  `);
  try {
    const list = JSON.parse(raw || '[]');
    return list.filter(j => j.title && j.title.length > 1);
  } catch (e) { return []; }
}

async function _clickNextPage(win) {
  const r = await selector.locate(win, 'liepin', 'search', 'next_page', 2000);
  if (!r.ok) return false;
  await browser.evalJS(win, `document.querySelector('[class*="next"]') && document.querySelector('[class*="next"]').click()`);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 接口 3: applyOne — 弹窗表单（求职信必填）
// ═══════════════════════════════════════════════════════════════
async function applyOne(win, job, resume, index) {
  logger.info('liepin', `投递开始: ${job.company} - ${job.title}`);

  // ★ 确保窗口在搜索页
  const currentUrl = win.webContents.getURL();
  if (win._liepinSearchUrl && !currentUrl.includes('/zhaopin/')) {
    await browser.loadURL(win, win._liepinSearchUrl, 15000);
    await _sleep(2000);
  }

  // ★ 直接用 index 定位卡片
  const cardIndex = (typeof index === 'number') ? index : -1;
  logger.info('liepin', `卡片索引: ${cardIndex}`);
  if (cardIndex < 0) return false;

  // ★ 滚动到卡片
  await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.job-list-box .job-list-item, .sojob-item-main');
      var real = [];
      cards.forEach(function(c) { if (c.querySelector('[class*="job-title"]')) real.push(c); });
      if (real.length > ${cardIndex}) real[${cardIndex}].scrollIntoView({ block: 'center' });
    })();
  `);
  await _sleep(500);

  // ★ 点击"应聘"按钮（多级 fallback）
  const clicked = await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.job-list-box .job-list-item, .sojob-item-main');
      var real = [];
      cards.forEach(function(c) { if (c.querySelector('[class*="job-title"]')) real.push(c); });
      var card = real[${cardIndex}];
      if (!card) return false;

      // CSS 选择器
      var selectors = ['.apply-btn', '[class*="apply-btn"]', '.job-apply-btn', 'a.apply-btn'];
      for (var i = 0; i < selectors.length; i++) {
        var btn = card.querySelector(selectors[i]);
        if (btn && btn.offsetHeight > 0) { btn.click(); return true; }
      }

      // 文字匹配
      var allBtns = card.querySelectorAll('a, button, span, div[role="button"]');
      for (var j = 0; j < allBtns.length; j++) {
        var t = allBtns[j].textContent.trim();
        if ((t === '应聘' || t === '立即应聘' || t === '投递简历') && allBtns[j].offsetHeight > 0) {
          allBtns[j].click();
          return true;
        }
      }

      // 全局搜索
      var globalBtns = document.querySelectorAll('a, button, span');
      for (var k = 0; k < globalBtns.length; k++) {
        var gt = globalBtns[k].textContent.trim();
        if (gt === '应聘' && globalBtns[k].offsetHeight > 0) {
          globalBtns[k].click();
          return true;
        }
      }

      return false;
    })();
  `);

  logger.info('liepin', `点击"应聘": ${clicked}`);
  if (!clicked) {
    logger.warn('liepin', `未找到应聘按钮`);
    return false;
  }

  await _sleep(2000);

  // ★ 检查是否直接成功
  const afterClick = await browser.evalJS(win, `
    (function() {
      if (!document.body) return JSON.stringify({ url: window.location.href, note: 'navigating' });
      var text = (document.body.innerText || '');
      var success = text.includes('投递成功') || text.includes('应聘成功') || text.includes('已投递');
      return JSON.stringify({ url: window.location.href, success: success, bodySnippet: text.substring(0, 300) });
    })();
  `);
  logger.info('liepin', `点击后状态: ${afterClick}`);

  if (afterClick) {
    try {
      const info = JSON.parse(afterClick);
      if (info.success) {
        logger.info('liepin', `页面提示投递成功`);
        return true;
      }
    } catch (e) {}
  }

  // ★ 处理弹窗表单
  return await _handleForm(win, resume);
}

async function _handleForm(win, resume) {
  const fields = cfg().apply && cfg().apply.form_fields;
  if (!fields) return true;

  // 求职信（必填）
  if (fields.self_intro) {
    const r = await selector.locate(win, 'liepin', 'apply', 'form_fields', 3000);
    if (r.ok && r.el) {
      const intro = _buildIntro(resume);
      await _fillInput(win, r.el, intro);
      await _sleep(300);
    }
  }

  // 期望薪资
  if (fields.expected_salary) {
    const r = await selector.locate(win, 'liepin', 'apply', 'form_fields', 3000);
    if (r.ok && r.el) {
      const salary = (resume.salary_min && resume.salary_max)
        ? `${resume.salary_min}-${resume.salary_max}K`
        : `${resume.salary_min || 25}K`;
      await _fillInput(win, r.el, salary);
      await _sleep(300);
    }
  }

  // 提交
  const submit = await selector.locate(win, 'liepin', 'apply', 'btn_submit', 3000);
  if (submit.ok && submit.el) {
    await _clickEl(win, submit.el);
    await _sleep(2000);
    return true;
  }

  return false;
}

async function _clickEl(win, el) {
  if (!el || el.x === undefined) return;
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(el.x), y: Math.round(el.y) });
  await _sleep(150);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(el.x), y: Math.round(el.y), button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(el.x), y: Math.round(el.y), button: 'left', clickCount: 1 });
}

async function _fillInput(win, el, text) {
  if (!el || el.x === undefined) return;
  await _clickEl(win, el);
  await _sleep(200);
  for (const ch of String(text)) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await _sleep(30 + Math.random() * 70);
  }
}

function _buildIntro(resume) {
  const name = resume.name || '资深技术人';
  const exp = (resume.work_history && resume.work_history.length) || 0;
  const skills = (resume.skills || []).slice(0, 5).join('/');
  return `您好，我是${name}，${exp}年一线研发经验，精通${skills}，主导过多个千万级用户系统，对贵司岗位十分期待，希望进一步沟通！`;
}

async function _isVerifyPage(win) {
  const url = win.webContents.getURL();
  const patterns = (cfg() && cfg().verify && cfg().verify.urlPatterns) || [];
  if (patterns.some(p => url.includes(p))) return true;
  const hasV = await browser.evalJS(win, `
    (function() {
      var sel = ['.verify-pop', '[class*="captcha"]'];
      for (var i = 0; i < sel.length; i++) if (document.querySelector(sel[i])) return true;
      var t = (document.body.innerText || '');
      return t.includes('安全验证') || t.includes('需要验证');
    })();
  `);
  return !!hasV;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  name: 'liepin',
  loginCheck,
  getLoginUrl,
  searchJobs,
  applyOne
};
