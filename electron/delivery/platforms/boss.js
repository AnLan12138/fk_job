/**
 * boss.js — BOSS 直聘适配器
 *
 * 独立文件：不与其他平台共用代码，所有逻辑自包含。
 * 职责：loginCheck / searchJobs / applyOne
 *
 * 投递机制：Boss 是"立即沟通"→ 打招呼 → 完成。
 *  和猎头/智联的"填表-提交"完全不同，所以独立实现。
 */
const browser = require('../browser');
const selector = require('../selector-engine');
const logger = require('./logger-proxy'); // 轻量代理，避免循环依赖

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  _cfg = selector.loadConfig('boss');
  return _cfg;
}

// ═══════════════════════════════════════════════════════════════
// 接口 1: loginCheck — 检查是否已登录
// ═══════════════════════════════════════════════════════════════
async function loginCheck(win) {
  // 方法 1: URL 是否在登录页
  const url = win.webContents.getURL();
  if (url.includes('/passport/') || url.includes('/login') || url.includes('/verify')) {
    return false;
  }

  // 方法 2: cookie 检查
  const cookies = await browser.getCookies('boss');
  const authNames = (cfg() && cfg().authCookie) || ['wt2', 'lastCity'];
  const cookieNames = cookies.map(c => c.name);
  const hasAuth = authNames.some(n => cookieNames.includes(n));
  if (hasAuth) return true;

  // 方法 3: 访问首页看是否被重定向到登录页
  await browser.loadURL(win, cfg().loginUrl, 15000);
  await _sleep(1500);
  const finalUrl = win.webContents.getURL();
  if (finalUrl.includes('/passport/') || finalUrl.includes('/login')) return false;

  // 方法 4: 首页内容有用户标识
  const hasUserName = await browser.evalJS(win, `
    !!document.querySelector('[class*="user-name"], [class*="header-login"], .nav-avatar, .btn-nav-avatar')
  `);
  return !!hasUserName;
}

function getLoginUrl() { return cfg().loginUrl; }

// ═══════════════════════════════════════════════════════════════
// 接口 2: searchJobs — 搜索职位
// ═══════════════════════════════════════════════════════════════
async function searchJobs(win, filter) {
  const keyword = (filter.keywords && filter.keywords[0]) || 'Java';
  const city = (filter.cities && filter.cities[0]) || '深圳';

  // 构建搜索 URL
  const cityCode = cfg().cities[city] || '100010000';
  let url = `https://www.zhipin.com/web/geek/jobs?city=${cityCode}&query=${encodeURIComponent(keyword)}`;

  if (filter.experience && cfg().experience[filter.experience]) {
    url += `&experience=${cfg().experience[filter.experience]}`;
  }
  if (filter.education && cfg().education[filter.education]) {
    url += `&degree=${cfg().education[filter.education]}`;
  }

  logger.info('boss', `搜索: ${keyword} @ ${city}`);

  // ★ 缓存搜索页 URL，applyOne 返回搜索页时用
  win._bossSearchUrl = url;

  await browser.loadURL(win, url, 15000);
  await _sleep(2000);

  // 验证页面检查
  if (await _isVerifyPage(win)) {
    logger.warn('boss', '检测到验证页，需人工处理');
    // 等 30 秒让用户处理
    await _sleep(30000);
    if (await _isVerifyPage(win)) throw new Error('验证页未通过');
  }

  // 提取列表
  const jobs = await _extractJobList(win);
  logger.info('boss', `提取到 ${jobs.length} 个职位`);

  // ★ 提取到 0 个时自动诊断（帮助调试选择器）
  if (jobs.length === 0) {
    const fs = require('fs');
    const path = require('path');
    const { app } = require('electron');
    const snapFile = path.join(app.getPath('userData'), 'boss_search_debug.json');
    const snap = await browser.evalJS(win, `
      (function() {
        var all = document.querySelectorAll('*');
        var classes = {};
        for (var i = 0; i < all.length; i++) {
          var c = all[i].className || '';
          if (typeof c === 'string' && c.length > 3 && c.length < 80 && /job|card|list|item/i.test(c)) {
            classes[c] = (classes[c] || 0) + 1;
          }
        }
        return JSON.stringify({
          url: window.location.href,
          bodyLen: document.body.innerHTML.length,
          bodyText: (document.body.innerText || '').substring(0, 800),
         MatchedClasses: classes,
          sampleLinks: Array.from(document.querySelectorAll('a[href*="/job_detail/"], a[href*="/web/geek/job"]')).slice(0, 5).map(a => ({text: a.textContent.trim().substring(0, 50), href: a.href}))
        });
      })();
    `);
    try {
      fs.writeFileSync(snapFile, snap);
      logger.warn('boss', `搜索页DOM快照已写入: ${snapFile}`);
    } catch (e) {}
  }

  // ★ 缓存 job 列表到 window，applyOne 用索引直接定位卡片（不依赖标题匹配）
  win._bossJobs = jobs;
  win._bossSearchUrl = url;
  win._bossSearchTime = Date.now();

  // 最多翻 3 页
  if (jobs.length > 0) {
    for (let page = 2; page <= 3; page++) {
      const hasNext = await _clickNextPage(win);
      if (!hasNext) break;
      await _sleep(1500);
      const more = await _extractJobList(win);
      jobs.push(...more);
      // ★ 每翻一页更新缓存
      win._bossJobs = jobs;
    }
  }

  logger.info('boss', `共 ${jobs.length} 个职位（含翻页）`);
  return jobs;
}

async function _extractJobList(win) {
  // ★ 从 config 读选择器，不再硬编码
  const listConfig = cfg() && cfg().search && cfg().search.job_list || [];
  let selector = '.job-card-wrap'; // fallback
  for (const item of listConfig) {
    if (item.strategy === 'css') { selector = item.value; break; }
  }

  const raw = await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('${selector}');
      var out = [];
      cards.forEach(function(el) {
        var titleEl = el.querySelector('.job-name, .job-title, [class*="job-name"]');
        var salaryEl = el.querySelector('.job-salary, [class*="salary"]');
        var linkEl = el.querySelector('a[href*="/job_detail/"], a[href*="/web/geek/job"]');
        // 公司名：取第一个非空文本节点（排除职位名和薪资）
        var companyEl = el.querySelector('.company-text, [class*="company"]');
        var company = companyEl ? companyEl.textContent.trim() : '';
        if (!company) {
          // fallback: 取卡片内第2个文本节点
          var texts = Array.from(el.querySelectorAll('span,div,a')).map(e => e.textContent.trim()).filter(t => t.length > 1 && t.length < 40);
          company = texts.length > 1 ? texts[1] : '';
        }
        out.push({
          title: titleEl ? titleEl.textContent.trim() : '',
          company: company,
          salary: salaryEl ? salaryEl.textContent.trim() : '',
          url: linkEl ? linkEl.href : '',
          raw: el.outerHTML.substring(0, 300)
        });
      });
      return JSON.stringify(out);
    })();
  `);

  try {
    const list = JSON.parse(raw || '[]');
    return list.filter(j => j.title && j.title.length > 1);
  } catch (e) {
    return [];
  }
}

async function _clickNextPage(win) {
  const r = await selector.locate(win, 'boss', 'search', 'next_page', 2000);
  if (r.ok && r.el) {
    await browser.evalJS(win, `
      var btn = document.querySelector('[class*="next"], a:has-text("下一页")');
      if (btn) { btn.click(); "ok"; } else { "no-btn"; }
    `);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// 接口 3: applyOne — 投递单个职位
// ═══════════════════════════════════════════════════════════════
async function applyOne(win, job, resume) {
  logger.info('boss', `投递开始: ${job.company} - ${job.title}`);

  // ★ Boss 最佳投递路径：搜索页 hover → "立即沟通"（不进详情页，避开登录弹窗）
  const okA = await _tryQuickApply(win, job);
  if (okA) {
    logger.info('boss', `投递成功 ✓: ${job.company} - ${job.title}`);
    return true;
  }

  logger.warn('boss', `搜索页 hover 失败: ${job.company} - ${job.title}`);
  return false;
}

async function _tryQuickApply(win, job) {
  // ★ 确保窗口在搜索页
  const currentUrl = win.webContents.getURL();
  if (win._bossSearchUrl && !currentUrl.includes('/web/geek/jobs')) {
    logger.info('boss', `返回搜索页`);
    await browser.loadURL(win, win._bossSearchUrl, 15000);
    await _sleep(2000);
  }

  // ★ 直接通过缓存的 job 索引定位卡片（不依赖标题匹配）
  const cardIndex = await _getCardIndex(win, job);
  logger.info('boss', `卡片索引: ${cardIndex}`);
  if (cardIndex < 0) {
    logger.warn('boss', `找不到卡片: ${job.title}`);
    return false;
  }

  // ★ 滚动到卡片可见区域
  await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.job-card-wrap');
      if (cards.length > ${cardIndex}) {
        cards[${cardIndex}].scrollIntoView({ block: 'center' });
      }
    })();
  `);
  await _sleep(500);

  // ★ 真实鼠标 hover（用 sendInputEvent，不只是 dispatchEvent）
  const pos = await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.job-card-wrap');
      var real = [];
      cards.forEach(function(c) {
        if (c.textContent.trim().length > 10) real.push(c);
      });
      if (real.length <= ${cardIndex}) return null;
      var r = real[${cardIndex}].getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    })();
  `);
  if (!pos) {
    logger.warn('boss', `卡片坐标为空: index=${cardIndex}`);
    return false;
  }
  const p = JSON.parse(pos);
  logger.info('boss', `hover 坐标: (${p.x}, ${p.y})`);

  // ★ 关键：两次移动 + 等待，让 React 渲染 hover 效果
  try {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y - 20) });
    await _sleep(400 + Math.random() * 200);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) });
    await _sleep(800 + Math.random() * 400);
  } catch (_) {}

  // ★ 多级 fallback 搜索"立即沟通"按钮（移植旧代码 v7 逻辑）
  const clickResult = await browser.evalJS(win, `
    (function() {
      // 找真实卡片
      var allCards = document.querySelectorAll('.job-card-wrap');
      var real = [];
      allCards.forEach(function(c) {
        if (c.textContent.trim().length > 10) real.push(c);
      });
      if (real.length <= ${cardIndex}) return { error: 'card_not_found' };
      var card = real[${cardIndex}];

      // Level 1: 卡片内 CSS 选择器
      var btnSelectors = ['.btn-start-chat', '.btn-greeting', '.op-btn-chat', '[class*="btn-start-chat"]', '[class*="op-btn"]', '[class*="greeting-btn"]', 'a[class*="start-chat"]'];
      for (var bi = 0; bi < btnSelectors.length; bi++) {
        try {
          var btn = card.querySelector(btnSelectors[bi]);
          if (btn && btn.offsetHeight > 0) { btn.scrollIntoView({block:'center'}); btn.click(); return { clicked: true, strategy: 'card_css:' + btnSelectors[bi] }; }
        } catch(_) {}
      }

      // Level 2: 卡片内文字匹配
      var cardBtns = card.querySelectorAll('a, button, span, div[role=button]');
      for (var ti = 0; ti < cardBtns.length; ti++) {
        var t = cardBtns[ti].textContent.trim();
        if ((t === '立即沟通' || t === '继续沟通') && cardBtns[ti].offsetHeight > 0) {
          cardBtns[ti].scrollIntoView({block:'center'});
          cardBtns[ti].click();
          return { clicked: true, strategy: 'card_text:' + t };
        }
      }

      // Level 3: 全局文字搜索"立即沟通"
      var allGlobalBtns = document.querySelectorAll('a, button, span, div[role=button], div[class*="btn"]');
      for (var gi = 0; gi < allGlobalBtns.length; gi++) {
        var gt = allGlobalBtns[gi].textContent.trim();
        if ((gt === '立即沟通' || gt === '继续沟通') && allGlobalBtns[gi].offsetHeight > 0) {
          allGlobalBtns[gi].scrollIntoView({block:'center'});
          allGlobalBtns[gi].click();
          return { clicked: true, strategy: 'global_text:' + gt };
        }
      }

      // Level 4: hover overlay/floating panel 内搜索
      var overlays = document.querySelectorAll('[class*="hover-card"], [class*="job-hover"], [class*="card-hover"], [class*="hover-detail"], [class*="popup"], [class*="float"]');
      for (var oi = 0; oi < overlays.length; oi++) {
        if (overlays[oi].offsetHeight > 0) {
          var oBtns = overlays[oi].querySelectorAll('a, button, span, div[role=button]');
          for (var ob = 0; ob < oBtns.length; ob++) {
            var ot = oBtns[ob].textContent.trim();
            if ((ot === '立即沟通' || ot === '继续沟通') && oBtns[ob].offsetHeight > 0) {
              oBtns[ob].click();
              return { clicked: true, strategy: 'overlay_text:' + ot };
            }
          }
        }
      }

      // Level 5: 全局 CSS 兜底
      var globalBtns = document.querySelectorAll('a.btn-start-chat, a[class*="start-chat"], .btn-start-chat, [class*="btn-start-chat"]');
      for (var gci = 0; gci < globalBtns.length; gci++) {
        if (globalBtns[gci].offsetHeight > 0) {
          globalBtns[gci].scrollIntoView({block:'center'});
          globalBtns[gci].click();
          return { clicked: true, strategy: 'global_css' };
        }
      }

      // Level 6: 最终兜底
      var allVisibleBtns = document.querySelectorAll('a, button');
      for (var vi = 0; vi < allVisibleBtns.length; vi++) {
        var vt = allVisibleBtns[vi].textContent.trim();
        if (vt.indexOf('沟通') !== -1 && vt.length <= 6 && allVisibleBtns[vi].offsetHeight > 0 && allVisibleBtns[vi].offsetWidth > 0) {
          allVisibleBtns[vi].scrollIntoView({block:'center'});
          allVisibleBtns[vi].click();
          return { clicked: true, strategy: 'fallback_text:' + vt };
        }
      }

      return { error: 'no_chat_button_found' };
    })();
  `);

  logger.info('boss', `点击结果: ${JSON.stringify(clickResult)}`);

  if (clickResult && clickResult.clicked) {
    logger.info('boss', `✓ 按钮点击成功, 策略: ${clickResult.strategy}`);
    await _sleep(1500);
    return true;
  }

  logger.warn('boss', `按钮点击失败: ${clickResult && clickResult.error || 'unknown'}`);
  return false;
}

async function _tryDetailPageApply(win, resume) {
  const btn = await selector.locate(win, 'boss', 'apply', 'btn_apply', 5000);
  if (!btn.ok) return false;

  // 点击按钮
  if (btn.el && btn.el.x !== undefined) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(btn.el.x), y: Math.round(btn.el.y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(btn.el.x), y: Math.round(btn.el.y), button: 'left', clickCount: 1 });
  }
  await _sleep(2000);

  // 可能出现弹框（期望薪资 / 打招呼内容）
  const hasPopup = await selector.locate(win, 'boss', 'apply', 'greeting_input', 3000);
  if (hasPopup.ok && resume) {
    // 填写打招呼内容
    const intro = _buildGreeting(resume, '');
    await _fillInput(win, hasPopup.el, intro);
    await _sleep(500);
    // 发送
    const send = await selector.locate(win, 'boss', 'apply', 'greeting_send', 2000);
    if (send.ok && send.el && send.el.x !== undefined) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(send.el.x), y: Math.round(send.el.y), button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(send.el.x), y: Math.round(send.el.y), button: 'left', clickCount: 1 });
    }
    await _sleep(1500);
  }

  return true;
}

// ═══════ 工具 ═══════
async function _getCardIndex(win, job) {
  // ★ 策略 1：直接从缓存的 job 列表找索引（最快、最准）
  if (win._bossJobs && Array.isArray(win._bossJobs)) {
    for (let i = 0; i < win._bossJobs.length; i++) {
      const j = win._bossJobs[i];
      if (j.url === job.url || (j.title === job.title && j.company === job.company)) {
        return i;
      }
    }
  }

  // ★ 策略 2：DOM 匹配（fallback）
  const r = await browser.evalJS(win, `
    (function() {
      var cards = document.querySelectorAll('.job-card-wrap');
      for (var i = 0; i < cards.length; i++) {
        var t = (cards[i].querySelector('.job-name') || {}).textContent || '';
        // 模糊匹配：只要卡片标题包含 job 标题的前 4 个字符
        if (t.includes('${(job.title || "").replace(/['\\]/g, "").substring(0, 4)}')) {
          return i;
        }
      }
      return -1;
    })();
  `);
  return r === null ? -1 : parseInt(r, 10);
}

async function _fillInput(win, el, text) {
  if (!el || el.x === undefined) return;
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(el.x), y: Math.round(el.y), button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(el.x), y: Math.round(el.y), button: 'left', clickCount: 1 });
  await _sleep(200);
  // 逐字输入
  for (const ch of String(text)) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await _sleep(30 + Math.random() * 70);
  }
}

function _buildGreeting(resume, jd) {
  const name = resume.name || '面试者';
  const exp = (resume.work_history && resume.work_history.length) || 0;
  const topSkills = (resume.skills || []).slice(0, 5).join('/');
  return `您好，我是${name}，有${exp}年工作经验，擅长${topSkills}，对这个岗位非常感兴趣，期待沟通！`;
}

async function _isVerifyPage(win) {
  const url = win.webContents.getURL();
  const patterns = (cfg() && cfg().verify && cfg().verify.urlPatterns) || [];
  if (patterns.some(p => url.includes(p))) return true;

  const hasVerify = await browser.evalJS(win, `
    (function() {
      var sel = ['.geetest', '[class*="captcha"]', '[class*="verify"]', '.slider-captcha'];
      for (var i = 0; i < sel.length; i++) {
        if (document.querySelector(sel[i])) return true;
      }
      var txt = document.body.innerText;
      return txt.includes('安全验证') || txt.includes('滑动验证') || txt.includes('扫码登录');
    })();
  `);
  return !!hasVerify;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  name: 'boss',
  loginCheck,
  getLoginUrl,
  searchJobs,
  applyOne
};
