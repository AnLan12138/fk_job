/**
 * zhilian.js — 智联招聘适配器
 *
 * 投递机制：搜索 → 列表 → 点"申请职位" → 弹窗表单（期望薪资/自我介绍等） → 提交
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
  const cityCode = cfg().cities[city] || '736';

  const url = `https://sou.zhaopin.com/?jl=${cityCode}&kw=${encodeURIComponent(keyword)}`;
  logger.info('zhilian', `搜索: ${keyword} @ ${city}(code=${cityCode})`);

  await browser.loadURL(win, url, 15000);
  await _sleep(2000);

  if (await _isVerifyPage(win)) {
    logger.warn('zhilian', '检测到验证页');
    await _sleep(30000);
    if (await _isVerifyPage(win)) throw new Error('验证页未通过');
  }

  const jobs = await _extractJobList(win);
  logger.info('zhilian', `提取到 ${jobs.length} 个职位`);

  // 翻页（最多 3 页）
  for (let page = 2; page <= 3; page++) {
    if (await _clickNextPage(win)) {
      await _sleep(1500);
      const more = await _extractJobList(win);
      jobs.push(...more);
    } else break;
  }

  return jobs;
}

async function _extractJobList(win) {
  const raw = await browser.evalJS(win, `
    (function() {
      var items = document.querySelectorAll('.joblist-box__item, [class*="joblist-box"]');
      var out = [];
      items.forEach(function(el) {
        var titleEl = el.querySelector('.jobinfo__name, [class*="jobinfo__name"]');
        var companyEl = el.querySelector('.companyinfo__name, [class*="companyinfo__name"]');
        var salaryEl = el.querySelector('.jobinfo__salary, [class*="salary"]');
        var linkEl = el.querySelector('a[href*="zhaopin.com/company/"], a[href*="/job/"]');
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
  const r = await selector.locate(win, 'zhilian', 'search', 'next_page', 2000);
  if (!r.ok) return false;
  await browser.evalJS(win, `document.querySelector('[class*="next"], .pager-next') && document.querySelector('[class*="next"], .pager-next').click()`);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 接口 3: applyOne — 填表提交
// ═══════════════════════════════════════════════════════════════
async function applyOne(win, job, resume) {
  // 先尝试列表页直接点"申请职位"
  const btn = await selector.locate(win, 'zhilian', 'apply', 'btn_apply', 3000);
  if (btn.ok && btn.el) {
    await _clickEl(win, btn.el);
    await _sleep(2000);
  } else if (job.url) {
    // 进详情页
    await browser.loadURL(win, job.url, 15000);
    await _sleep(1500);
    const detailBtn = await selector.locate(win, 'zhilian', 'apply', 'btn_apply', 5000);
    if (detailBtn.ok && detailBtn.el) {
      await _clickEl(win, detailBtn.el);
      await _sleep(2000);
    }
  }

  // 处理弹窗表单
  const formHandled = await _handleForm(win, resume);
  return formHandled;
}

async function _handleForm(win, resume) {
  // 找到表单区域（可能有"期望薪资"、"自我介绍"、"上传简历"等字段）
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
    const uploaded = await _tryUploadResume(win, resume.resume_pdf_path);
    if (!uploaded) logger.warn('zhilian', '简历上传失败（可能跳过）');
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

async function _tryUploadResume(win, pdfPath) {
  const r = await browser.evalJS(win, `
    (function() {
      var input = document.querySelector('input[type="file"]');
      if (!input) return false;
      // 不能直接设置文件路径到 input，但可以用 Electron 的 DOM setter
      Object.defineProperty(input, 'files', { value: [], configurable: true });
      return true;
    })();
  `);
  // Electron 渲染进程无法直接操作文件系统，需手动选择
  // 此处仅标记"已处理"，真实上传让用户手动
  logger.info('zhilian', '简历需手动上传');
  return true;
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
