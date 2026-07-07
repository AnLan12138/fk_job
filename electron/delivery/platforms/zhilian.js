/**
 * zhilian.js — 智联招聘适配器
 *
 * 投递机制：搜索 → 列表 → 点"立即投递" → 弹窗表单（期望薪资/自我介绍等） → 提交
 *
 * 独立文件：不与其他平台共用代码，所有逻辑自包含。
 */
const browser = require('../browser');
const selector = require('../selector-engine');
const logger = require('./logger-proxy');

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  _cfg = selector.loadConfig('zhilian');
  return _cfg;
}

// ═══════════════════════════════════════════════════════════════
// 接口 1: loginCheck
// ═══════════════════════════════════════════════════════════════
async function loginCheck(win) {
  const url = win.webContents.getURL();
  if (url.includes('/login') || url.includes('/verify') || url.includes('/passport')) {
    return false;
  }
  const cookies = await browser.getCookies('zhilian');
  const authNames = (cfg() && cfg().authCookie) || ['at', 'rt'];
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
  const cityCode = cfg().cities[city] || '765';

  const url = `https://sou.zhaopin.com/?jl=${cityCode}&kw=${encodeURIComponent(keyword)}`;
  logger.info('zhilian', `搜索: ${keyword} @ ${city}(code=${cityCode})`);

  // ★ 缓存搜索页 URL，applyOne 用来返回
  win._zhilianSearchUrl = url;

  await browser.loadURL(win, url, 15000);
  await _sleep(2000);

  if (await _isVerifyPage(win)) {
    logger.warn('zhilian', '检测到验证页');
    await _sleep(30000);
    if (await _isVerifyPage(win)) throw new Error('验证页未通过');
  }

  const jobs = await _extractJobList(win);
  logger.info('zhilian', `提取到 ${jobs.length} 个职位`);

  // ★ 缓存 job 列表，applyOne 用索引直接定位卡片
  win._zhilianJobs = jobs;
  win._zhilianSearchTime = Date.now();

  // 最多翻 3 页
  for (let page = 2; page <= 3; page++) {
    if (await _clickNextPage(win)) {
      await _sleep(1500);
      const more = await _extractJobList(win);
      jobs.push(...more);
      win._zhilianJobs = jobs;
    } else break;
  }

  return jobs;
}

async function _extractJobList(win) {
  const raw = await browser.evalJS(win, `
    (function() {
      var items = document.querySelectorAll('.joblist-box__item');
      var out = [];
      items.forEach(function(el) {
        // ★ 只取有职位名的卡片（过滤广告/空卡片）
        var titleEl = el.querySelector('.jobinfo__name');
        if (!titleEl || titleEl.textContent.trim().length < 2) return;

        var companyEl = el.querySelector('.companyinfo__name, [class*="companyinfo__name"]');
        var salaryEl = el.querySelector('.jobinfo__salary, [class*="salary"]');
        var linkEl = el.querySelector('a[href*="zhaopin.com/company/"], a[href*="/job/"], a[href*="jobs.zhaopin.com"]');
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
  const r = await selector.locate(win, 'zhilian', 'search', 'next_page', 2000);
  if (!r.ok) return false;
  await browser.evalJS(win, `document.querySelector('[class*="next"], .pager-next') && document.querySelector('[class*="next"], .pager-next').click()`);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 接口 3: applyOne — 填表提交
// ═══════════════════════════════════════════════════════════════
async function applyOne(win, job, resume, index) {
  logger.info('zhilian', `投递开始: ${job.company} - ${job.title}`);

  // ★ 确保窗口在搜索页
  const currentUrl = win.webContents.getURL();
  if (win._zhilianSearchUrl && !currentUrl.includes('/sou/')) {
    await browser.loadURL(win, win._zhilianSearchUrl, 15000);
    await _sleep(2000);
  }

  // ★ 直接用 index 定位卡片（job 列表顺序 = DOM 卡片顺序）
  const cardIndex = (typeof index === 'number') ? index : -1;
  logger.info('zhilian', `卡片索引: ${cardIndex}`);
  if (cardIndex < 0) {
    logger.warn('zhilian', `无效索引: ${job.title}`);
    return false;
  }

  // ★ 滚动到卡片可见区域
  await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.joblist-box__item');
      var realCards = [];
      cards.forEach(function(c) {
        if (c.querySelector('.jobinfo__name')) realCards.push(c);
      });
      if (realCards.length > ${cardIndex}) {
        realCards[${cardIndex}].scrollIntoView({ block: 'center' });
      }
    })();
  `);
  await _sleep(500);

  // ★ 点击"立即投递"按钮（多级 fallback）
  const clicked = await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.joblist-box__item');
      var realCards = [];
      cards.forEach(function(c) {
        if (c.querySelector('.jobinfo__name')) realCards.push(c);
      });
      var card = realCards[${cardIndex}];
      if (!card) return false;

      // 多级 CSS 选择器
      var selectors = ['.apply-btn', '[class*="applybtn"]', '[class*="apply-btn"]', '[class*="job-apply"]', '[class*="jobapply"]', 'a.button', 'span.button'];
      for (var i = 0; i < selectors.length; i++) {
        var btn = card.querySelector(selectors[i]);
        if (btn && btn.offsetHeight > 0) { btn.click(); return true; }
      }

      // 文字匹配（卡片内）
      var allBtns = card.querySelectorAll('a, button, span, div[role="button"]');
      for (var j = 0; j < allBtns.length; j++) {
        var t = allBtns[j].textContent.trim();
        if ((t === '立即投递' || t === '投递简历' || t === '申请职位') && allBtns[j].offsetHeight > 0) {
          allBtns[j].click();
          return true;
        }
      }

      // 全局搜索
      var globalBtns = document.querySelectorAll('a, button, span');
      for (var k = 0; k < globalBtns.length; k++) {
        var gt = globalBtns[k].textContent.trim();
        if (gt === '立即投递' && globalBtns[k].offsetHeight > 0) {
          globalBtns[k].click();
          return true;
        }
      }

      return false;
    })();
  `);

  logger.info('zhilian', `点击"立即投递": ${clicked}`);
  if (!clicked) {
    logger.warn('zhilian', `未找到立即投递按钮`);
    return false;
  }

  await _sleep(2000);

  // ★ 智联"立即投递"点击后可能直接跳转/显示成功提示
  const afterClick = await browser.evalJS(win, `
    (function() {
      if (!document.body) return JSON.stringify({ url: window.location.href, note: 'navigating' });
      var text = (document.body.innerText || '');
      var success = text.includes('投递成功') || text.includes('申请成功') || text.includes('已投递');
      var loginRequired = text.includes('请登录') || text.includes('登录后');
      return JSON.stringify({
        url: window.location.href,
        success: success,
        loginRequired: loginRequired,
        bodySnippet: text.substring(0, 300)
      });
    })();
  `);
  logger.info('zhilian', `点击后状态: ${afterClick}`);

  // ★ 如果直接提示成功，返回 true
  if (afterClick) {
    try {
      const info = JSON.parse(afterClick);
      if (info.success) {
        logger.info('zhilian', `页面提示投递成功`);
        return true;
      }
    } catch (e) {}
  }

  // ★ 处理弹窗表单
  const formHandled = await _handleForm(win, resume);
  return formHandled;
}

async function _handleForm(win, resume) {
  const fields = cfg().apply && cfg().apply.form_fields;
  if (!fields) return true;

  // 填期望薪资
  if (fields.expected_salary) {
    const r = await selector.locate(win, 'zhilian', 'apply', 'form_fields', 3000);
    if (r.ok && r.el) {
      const salary = (resume.salary_min && resume.salary_max)
        ? `${resume.salary_min}-${resume.salary_max}K`
        : `${resume.salary_min || 25}K`;
      await _fillInput(win, r.el, salary);
      await _sleep(300);
    }
  }

  // 填自我介绍
  if (fields.self_intro) {
    const r = await selector.locate(win, 'zhilian', 'apply', 'form_fields', 3000);
    if (r.ok && r.el) {
      const intro = _buildIntro(resume);
      await _fillInput(win, r.el, intro);
      await _sleep(300);
    }
  }

  // 上传简历（如果有 PDF）
  if (resume.resume_pdf_path) {
    logger.info('zhilian', '简历需手动上传');
  }

  // 点提交
  const submit = await selector.locate(win, 'zhilian', 'apply', 'btn_submit', 3000);
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
  const name = resume.name || '面试者';
  const exp = (resume.work_history && resume.work_history.length) || 0;
  const skills = (resume.skills || []).slice(0, 5).join('/');
  return `您好，我是${name}，有${exp}年相关经验，精通${skills}，对岗位非常期待，希望有机会沟通！`;
}

async function _isVerifyPage(win) {
  const url = win.webContents.getURL();
  const patterns = (cfg() && cfg().verify && cfg().verify.urlPatterns) || [];
  if (patterns.some(p => url.includes(p))) return true;
  const hasV = await browser.evalJS(win, `
    (function() {
      var sel = ['.verify-box', '[class*="captcha"]', '.geetest'];
      for (var i = 0; i < sel.length; i++) if (document.querySelector(sel[i])) return true;
      var t = (document.body.innerText || '');
      return t.includes('安全验证') || t.includes('滑动验证');
    })();
  `);
  return !!hasV;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  name: 'zhilian',
  loginCheck,
  getLoginUrl,
  searchJobs,
  applyOne
};
