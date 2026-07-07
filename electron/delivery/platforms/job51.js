/**
 * job51.js — 51job 适配器
 *
 * 投递机制：搜索 → 列表 → 点"申请职位" → 弹窗表单（Resume 上传+表单） → 提交
 *
 * 特点：传统招聘平台，表单字段较多，Resume 上传通常是必填项
 *
 * 独立文件：不与其他平台共用代码，所有逻辑自包含。
 */
const browser = require('../browser');
const selector = require('../selector-engine');
const logger = require('./logger-proxy');

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  _cfg = selector.loadConfig('job51');
  return _cfg;
}

// ═══════════════════════════════════════════════════════════════
// 接口 1: loginCheck
// ═══════════════════════════════════════════════════════════════
async function loginCheck(win) {
  const url = win.webContents.getURL();
  if (url.includes('/login') || url.includes('/verify') || url.includes('/security')) return false;

  const cookies = await browser.getCookies('job51');
  const authNames = (cfg() && cfg().authCookie) || ['guid', '51job'];
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
  const cityCode = cfg().cities[city] || '040000';

  const url = `https://search.51job.com/list/${cityCode},000000,0000,00,9,99,${encodeURIComponent(keyword)},2,1.html`;
  logger.info('job51', `搜索: ${keyword} @ ${city}(code=${cityCode})`);

  await browser.loadURL(win, url, 15000);
  await _sleep(2000);

  if (await _isVerifyPage(win)) {
    logger.warn('job51', '检测到验证页');
    await _sleep(30000);
    if (await _isVerifyPage(win)) throw new Error('验证页未通过');
  }

  const jobs = await _extractJobList(win);
  logger.info('job51', `提取到 ${jobs.length} 个职位`);

  // ★ 缓存 job 列表到 window
  win._job51Jobs = jobs;
  win._job51SearchUrl = url;

  for (let page = 2; page <= 3; page++) {
    if (await _clickNextPage(win)) {
      await _sleep(1500);
      const more = await _extractJobList(win);
      jobs.push(...more);
      win._job51Jobs = jobs;
    } else break;
  }

  return jobs;
}

async function _extractJobList(win) {
  const raw = await browser.evalJS(win, `
    (function() {
      var items = document.querySelectorAll('.j_result .e:not(.title), [class*="joblist"] > div');
      var out = [];
      items.forEach(function(el) {
        var titleEl = el.querySelector('.jname, [class*="jname"]');
        var companyEl = el.querySelector('.cname, [class*="cname"]');
        var salaryEl = el.querySelector('.salary, [class*="salary"]');
        var linkEl = el.querySelector('a[href*="51job.com/"]');
        out.push({
          title: titleEl ? titleEl.textContent.trim() : '',
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
  const r = await selector.locate(win, 'job51', 'search', 'next_page', 2000);
  if (!r.ok) return false;
  await browser.evalJS(win, `document.querySelector('[class*="next"]') && document.querySelector('[class*="next"]').click()`);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 接口 3: applyOne — 弹窗表单（Resume 上传必填）
// ═══════════════════════════════════════════════════════════════
async function applyOne(win, job, resume, index) {
  logger.info('job51', `投递开始: ${job.company} - ${job.title}`);

  const currentUrl = win.webContents.getURL();
  if (win._job51SearchUrl && !currentUrl.includes('search.51job.com')) {
    await browser.loadURL(win, win._job51SearchUrl, 15000);
    await _sleep(2000);
  }

  // ★ 直接用 index 定位卡片
  const cardIndex = (typeof index === 'number') ? index : -1;
  logger.info('job51', `卡片索引: ${cardIndex}`);
  if (cardIndex < 0) return false;

  // ★ 滚动到卡片 + 点击
  await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.j_result .e:not(.title)');
      if (cards.length > ${cardIndex}) cards[${cardIndex}].scrollIntoView({ block: 'center' });
    })();
  `);
  await _sleep(500);

  const clicked = await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.j_result .e:not(.title)');
      var card = cards[${cardIndex}];
      if (!card) return false;

      var selectors = ['.apply-btn', '[class*="applybtn"]', '[class*="apply-btn"]'];
      for (var i = 0; i < selectors.length; i++) {
        var btn = card.querySelector(selectors[i]);
        if (btn && btn.offsetHeight > 0) { btn.click(); return true; }
      }

      var allBtns = card.querySelectorAll('a, button, span');
      for (var j = 0; j < allBtns.length; j++) {
        var t = allBtns[j].textContent.trim();
        if ((t === '申请职位' || t === '立即申请' || t === '投递简历') && allBtns[j].offsetHeight > 0) {
          allBtns[j].click();
          return true;
        }
      }
      return false;
    })();
  `);

  logger.info('job51', `点击按钮: ${clicked}`);
  if (!clicked) return false;

  await _sleep(2000);

  // ★ 检查是否直接成功
  const afterClick = await browser.evalJS(win, `
    (function() {
      if (!document.body) return JSON.stringify({ url: window.location.href });
      var text = (document.body.innerText || '');
      return JSON.stringify({ success: text.includes('投递成功') || text.includes('申请成功'), bodySnippet: text.substring(0, 300) });
    })();
  `);
  if (afterClick) {
    try {
      const info = JSON.parse(afterClick);
      if (info.success) {
        logger.info('job51', `页面提示投递成功`);
        return true;
      }
    } catch (e) {}
  }

  return await _handleForm(win, resume);
}

async function _handleForm(win, resume) {
  const fields = cfg().apply && cfg().apply.form_fields;
  if (!fields) return true;

  // 期望薪资
  if (fields.expected_salary) {
    const r = await selector.locate(win, 'job51', 'apply', 'form_fields', 3000);
    if (r.ok && r.el) {
      const salary = (resume.salary_min && resume.salary_max)
        ? `${resume.salary_min}-${resume.salary_max}K`
        : `${resume.salary_min || 25}K`;
      await _fillInput(win, r.el, salary);
      await _sleep(300);
    }
  }

  // 自我介绍
  if (fields.self_intro) {
    const r = await selector.locate(win, 'job51', 'apply', 'form_fields', 3000);
    if (r.ok && r.el) {
      const intro = _buildIntro(resume);
      await _fillInput(win, r.el, intro);
      await _sleep(300);
    }
  }

  // 上传简历
  if (resume.resume_pdf_path) {
    logger.info('job51', '简历需手动上传（51job 有 file input 校验）');
  }

  // 提交
  const submit = await selector.locate(win, 'job51', 'apply', 'btn_submit', 3000);
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
  return `您好，我是${name}，有${exp}年开发经验，精通${skills}，对岗位非常期待，希望有机会沟通！`;
}

async function _isVerifyPage(win) {
  const url = win.webContents.getURL();
  const patterns = (cfg() && cfg().verify && cfg().verify.urlPatterns) || [];
  if (patterns.some(p => url.includes(p))) return true;
  const hasV = await browser.evalJS(win, `
    (function() {
      var sel = ['.verify-img', '[class*="captcha"]'];
      for (var i = 0; i < sel.length; i++) if (document.querySelector(sel[i])) return true;
      var t = (document.body.innerText || '');
      return t.includes('安全验证') || t.includes('需要验证');
    })();
  `);
  return !!hasV;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  name: 'job51',
  loginCheck,
  getLoginUrl,
  searchJobs,
  applyOne
};
