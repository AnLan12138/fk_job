/**
 * 拉勾 Platform Adapter（BrowserWindow 版 v2 — 增加WAF验证检测 + 翻页）
 *
 * 搜索: https://www.lagou.com/wn/jobs?kd={keyword}&city={city}&pn={page}
 * 城市直接用中文名
 * ⚠️ 拉勾有CF_APP_WAF防火墙，需要先完成滑动验证才能访问搜索页
 */
const EXTRACT_JOBS_JS = `
new Promise(resolve => {
  // ★ 加超时：最多 15 秒必须返回
  const safetyTimer = setTimeout(() => {
    console.error('[LAGOU] 提取超时，强制返回');
    resolve([]);
  }, 15000);

  let scrollCount = 0;
  const timer = setInterval(() => {
    window.scrollBy(0, 600);
    scrollCount++;
    if (scrollCount >= 5) {
      clearInterval(timer);
      setTimeout(() => {
        clearTimeout(safetyTimer);
        var jobs = [];

        // ═══════ 先检查WAF/验证拦截 ═══════
        var bodyText = document.body ? document.body.innerText : '';
        if (bodyText.includes('请进行验证') || bodyText.includes('滑动验证') ||
            bodyText.includes('别离开') || bodyText.includes('CF_APP_WAF')) {
          console.error('[LAGOU] 页面被WAF拦截');
          resolve([]);
          return;
        }

        // 策略1: 新版职位卡片
        var cards = document.querySelectorAll('.job-list-box .job-card, .s_position_list .item, .position-list .item, [class*="job-card"], [class*="position"] > li, .rec-job-list > li');
        if (cards.length === 0) {
          cards = document.querySelectorAll('a[href*="/jobs/"], a[href*="lagou.com/job"], a[href*="/zpb/"]');
        }

        jobs = Array.from(cards).map(function(el) {
          var linkEl = el.tagName === 'A' ? el : el.querySelector('a[href]');
          var titleEl = el.querySelector('.p_top .p_name, .job-name, .position-name, .job-title, [class*="job-name"], [class*="position"], h3, .title');
          var companyEl = el.querySelector('.company_name, .company-name, .company, .c_name, [class*="company"]');
          var salaryEl = el.querySelector('.money, .salary, .job-salary, .p_bot .money, [class*="salary"], [class*="money"]');
          var infoEl = el.querySelector('.industry, .job-info, .p_bot .li_b_l, [class*="info"]');

          if (!titleEl && linkEl) titleEl = linkEl.querySelector('[class*="name"], [class*="title"]');
          if (!linkEl) linkEl = el.closest('a');

          return {
            title: titleEl ? titleEl.textContent.trim().substring(0, 80) : (linkEl ? linkEl.textContent.trim().substring(0, 80) : ''),
            company: companyEl ? companyEl.textContent.trim() : '',
            salary: salaryEl ? salaryEl.textContent.trim() : '',
            url: linkEl ? linkEl.href : '',
            info: infoEl ? infoEl.textContent.trim() : ''
          };
        }).filter(function(j) { return j.title && j.title.length > 2; });

        if (jobs.length === 0) {
          console.error('[LAGOU-DIAG] url=' + window.location.href + ' title=' + document.title + ' bodyLen=' + (document.body?document.body.innerText.length:0) + ' bodySnippet=' + (document.body?document.body.innerText.substring(0,300):''));
        }

        resolve(jobs);
      }, 2000);
    }
  }, 800);
});
`;

async function handleVerify(win, onProgress, helpers, maxWaitSec = 120) {
  const { sleep, execJS } = helpers;
  const url = win.webContents.getURL();

  // ═══════ 拉勾的WAF验证检测 ═══════
  // 拉勾被CF_APP_WAF拦截时不会重定向，而是直接在当前URL显示滑动验证页面

  // 1. URL层面的检测
  const urlNeedsVerify = url.includes('/login') || url.includes('/passport') || url.includes('/verify') || url.includes('/safe');

  // 2. 内容层面的检测（拉勾WAF特征）
  const pageNeedsVerify = await execJS(win, `
    (function() {
      var text = document.body ? document.body.innerText : '';
      // WAF验证页特征文字
      if (text.includes('请进行验证') || text.includes('滑动验证') || text.includes('别离开') || text.includes('CF_APP_WAF')) return true;
      // 检查是否有滑动验证码元素
      var slider = document.querySelector('.slider-captcha, .geetest, [class*="captcha"], [class*="verify"]');
      if (slider && slider.offsetHeight > 0) return true;
      return false;
    })();
  `);

  if (!urlNeedsVerify && !pageNeedsVerify) return true;

  // 需要验证 — 弹出窗口让用户操作
  win.show();
  if (onProgress) onProgress({ type: 'warning', message: '[拉勾] ⚠️ 需要完成滑动验证！请在弹出窗口中操作验证' });

  for (let i = 0; i < maxWaitSec / 2; i++) {
    await sleep(2000);
    if (!win || win.isDestroyed()) return false;

    const u = win.webContents.getURL();
    const urlOk = !u.includes('/login') && !u.includes('/passport') && !u.includes('/verify') && !u.includes('/safe');

    // 内容层面检查
    const contentOk = await execJS(win, `
      (function() {
        var text = document.body ? document.body.innerText : '';
        if (text.includes('请进行验证') || text.includes('滑动验证') || text.includes('别离开')) return false;
        return true;
      })();
    `);

    if (urlOk && contentOk) {
      if (onProgress) onProgress({ type: 'info', message: '[拉勾] ✅ 验证通过' });
      return true;
    }
  }

  if (onProgress) onProgress({ type: 'error', message: '[拉勾] ❌ 验证超时' });
  return false;
}

async function search(win, filter, onProgress, helpers) {
  const { loadAndWait, sleep, execJS } = helpers;
  const keyword = encodeURIComponent((filter.keywords || ['Java'])[0]);
  const city = (filter.cities && filter.cities.length > 0 ? filter.cities[0] : '深圳');

  // ═══════ 先访问首页建立cookie会话 ═══════
  if (onProgress) onProgress({ type: 'phase', message: '[拉勾] 访问首页...' });
  await loadAndWait(win, 'https://www.lagou.com/', 15000);
  await sleep(1500 + Math.random() * 1000);

  // 首页也可能触发WAF验证
  if (!await handleVerify(win, onProgress, helpers)) return [];

  // ═══════ 搜索 + 翻页 ═══════
  let allJobs = [];
  for (let page = 1; page <= 2; page++) {
    let searchUrl = 'https://www.lagou.com/wn/jobs?kd=' + keyword + '&city=' + encodeURIComponent(city) + '&pn=' + page;

    if (page === 1) {
      if (onProgress) onProgress({ type: 'phase', message: '[拉勾] 搜索: ' + decodeURIComponent(keyword) });
    }

    await loadAndWait(win, searchUrl, 25000);
    await sleep(3000 + Math.random() * 1500);

    // 搜索页可能触发WAF验证
    if (!await handleVerify(win, onProgress, helpers)) break;

    const url = win.webContents.getURL();
    if (page === 1) {
      console.error('[拉勾] 搜索页URL: ' + url);
      if (onProgress) onProgress({ type: 'info', message: '[拉勾] 搜索页 → ' + url });
    }

    const jobs = await execJS(win, EXTRACT_JOBS_JS);
    if (jobs && jobs.length > 0) { allJobs = allJobs.concat(jobs); } else { break; }
  }

  console.error('[拉勾] 提取到 ' + allJobs.length + ' 个职位');

  // 0结果诊断
  if (allJobs.length === 0 && onProgress) {
    const diag = await execJS(win, `
      JSON.stringify({
        url: window.location.href,
        title: document.title,
        bodyLen: document.body ? document.body.innerText.length : 0,
        bodySnippet: document.body ? document.body.innerText.substring(0, 300) : ''
      });
    `);
    console.error('[拉勾] 空结果诊断: ' + diag);
    try {
      const d = JSON.parse(diag || '{}');
      const snippet = d.bodySnippet || '';
      if (snippet.includes('验证') || snippet.includes('CF_APP_WAF')) {
        onProgress({ type: 'error', message: '[拉勾] 搜索0结果 — 可能被WAF拦截，请在拉勾窗口完成验证' });
      } else {
        onProgress({ type: 'warning', message: '[拉勾] 0结果 | URL: ' + (d.url||'') + ' | bodyLen: ' + (d.bodyLen||0) });
      }
    } catch(_) {
      onProgress({ type: 'warning', message: '[拉勾] 搜索0结果' });
    }
  }

  if (onProgress) onProgress({ type: 'info', message: '[拉勾] 提取 ' + allJobs.length + ' 个' });
  return allJobs;
}

async function apply(win, job, resume, helpers) {
  const { sleep, execJS } = helpers;
  await sleep(1500 + Math.random() * 1000);

  const result = await execJS(win, `
    new Promise(resolve => {
      var btns = Array.from(document.querySelectorAll('a, button'));
      var applyBtn = btns.find(function(el) {
        var t = el.textContent.trim();
        return t.includes('投递') || t.includes('立即投递') || t.includes('沟通') || t.includes('申请');
      });
      if (applyBtn) { applyBtn.click(); setTimeout(function() { resolve(true); }, 2000); }
      else {
          var _btns = Array.from(document.querySelectorAll("a, button")).map(function(b){return b.textContent.trim().substring(0,25)}).filter(Boolean).slice(0,15).join(", ");
          resolve({found:false, btns:_btns});
        }
    });
  `);

  if (!result || result.found === false) throw new Error("未找到投递按钮 | 可用按钮: " + ((result && result.btns) || "空"));
  await sleep(1000);
  return true;
}

module.exports = { search, apply };
