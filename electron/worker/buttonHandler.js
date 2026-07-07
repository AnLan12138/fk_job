/**
 * buttonHandler.js — 平台特性按钮处理工具集 (v7)
 *
 * ★ v7修复（核心：无法投递→"立即沟通"按钮点不到）
 *   问题根因：dispatchEvent模拟hover → React合成事件不响应 → hover没触发 → "立即沟通"按钮没出现
 *   修复方案：
 *   1. bossApplyCard: 用 Electron sendInputEvent 做真实鼠标移动触发React hover
 *   2. bossClickAndGreet: sendInputEvent 重新hover + 全局搜索"立即沟通"按钮（不只卡片内）
 *   3. 多级fallback：卡片内CSS→卡片内text→全局text→hover overlay→全局CSS
 *
 * ★ v6架构保留：Boss专用函数单步注入，减少execJS调用次数
 * ★ 其他平台保持不变
 */

const configLoader = require('./configLoader');

// ═══════════════════════════════════════════════════════════════
// ★★★ v7新增：Electron真实鼠标移动（替代dispatchEvent）★★★
// ═══════════════════════════════════════════════════════════════

/**
 * 用Electron的sendInputEvent做真实鼠标移动，能正确触发React/Vue的hover事件
 * dispatchEvent只触发原生DOM事件，React的合成事件系统不会响应
 * @param {BrowserWindow} win
 * @param {number} x - 页面坐标x
 * @param {number} y - 页面坐标y
 */
function realMouseMove(win, x, y) {
  try {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  } catch(e) {
    console.error('[realMouseMove] sendInputEvent failed:', e.message);
  }
}

/**
 * 获取卡片在页面上的坐标位置（用于sendInputEvent）
 * @param {BrowserWindow} win
 * @param {number} cardIndex - 真实卡片index
 * @param {object} helpers
 * @returns {Promise<{x, y, width, height, centerX, centerY}|null>}
 */
async function getCardPosition(win, cardIndex, helpers) {
  const { execJS } = helpers;
  const config = configLoader.loadConfig('boss');
  if (!config) return null;

  const rect = await execJS(win, `
    (function() {
      var allCards = [];
      var selectors = ${JSON.stringify(config.search.elements.job_item.map(s => s.value))};
      for (var i = 0; i < selectors.length; i++) {
        try { var f = document.querySelectorAll(selectors[i]); if (f.length > 0) { allCards = Array.from(f); break; } } catch(_) {}
      }
      if (allCards.length === 0) {
        var links = document.querySelectorAll('a[href*="/web/geek/job"], a[href*="/job_detail/"]');
        for (var j = 0; j < links.length; j++) {
          var box = links[j].closest('li, [ka="search-job-item"], [class*="job-card"]');
          if (box && !allCards.includes(box)) allCards.push(box);
        }
      }
      var realCards = [];
      for (var c = 0; c < allCards.length; c++) {
        var text = (allCards[c].textContent || '').trim();
        var hasJobName = allCards[c].querySelector('.job-name, [class*="job-name"]');
        if ((hasJobName && hasJobName.textContent.trim().length > 2) || (text.length > 15 && /[\u4e00-\u9fa5]{2,}/.test(text))) {
          realCards.push(allCards[c]);
        }
      }
      if (realCards.length <= ${cardIndex}) return null;
      var card = realCards[${cardIndex}];
      var r = card.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, centerX: r.x + r.width/2, centerY: r.y + r.height/2 };
    })();
  `);
  return rect;
}

// ═══════════════════════════════════════════════════════════════
// ★★★ Boss专用 v6：一步提取卡片信息 + hover ★★★
// ═══════════════════════════════════════════════════════════════

/**
 * Boss搜索页：找真实卡片 → hover → 提取信息，全在一个execJS里完成
 * 
 * 关键改进：
 * - 骨架屏过滤：只操作有真实文本的卡片，跳过灰色占位符
 * - 已沟通检测：发现"已沟通"/"继续沟通"直接标记，不hover不点
 * - 单步注入：找卡片+hover+提取一次完成，避免中间页面变化
 * 
 * @param {BrowserWindow} win
 * @param {number} cardIndex - 第几个真实卡片（0-based，只算有内容的卡片）
 * @param {object} helpers - { execJS, sleep }
 * @returns {Promise<{cardInfo: object|null, alreadyApplied: boolean, status: string|null, hovered: boolean, error: string|null}>}
 */
async function bossApplyCard(win, cardIndex, helpers) {
  const { execJS, sleep } = helpers;
  const config = configLoader.loadConfig('boss');
  if (!config) return { cardInfo: null, alreadyApplied: false, hovered: false, error: 'boss配置加载失败' };

  // ★★★ v7新增：先用sendInputEvent做真实鼠标移动到卡片位置 ★★★
  // 这一步必须在execJS之前，因为dispatchEvent无法触发React合成事件
  const cardPos = await getCardPosition(win, cardIndex, helpers);
  if (cardPos) {
    realMouseMove(win, cardPos.centerX, cardPos.centerY);
    await sleep(300 + Math.random() * 200); // 让React有时间处理hover事件
  }

  const result = await execJS(win, `
    (function() {
      // ═══════ 找真实卡片（v8: 多级fallback，和bossGetRealCardCount一致） ═══════
      var allCards = [];
      var selectors = ${JSON.stringify(config.search.elements.job_item.map(s => s.value))};
      
      // Level1: 配置选择器
      for (var i = 0; i < selectors.length; i++) {
        try { var found = document.querySelectorAll(selectors[i]); if (found.length > 0) { allCards = Array.from(found); break; } } catch(_) {}
      }

      // Level2: v8通用Boss选择器
      if (allCards.length === 0) {
        var bossSelectors = [
          '.job-list-box li', '.search-job-result li',
          '[class*="job-list"] li', '[class*="search-result"] li',
          '.job-card-wrapper', '.job-card-left',
          '[class*="JobCard"]', '[class*="jobcard"]',
          '[class*="job-card"]', '[class*="job_item"]',
          '[data-job-id]', '[ka="search-job-item"]',
          '.recommend-card', '.job-list-ul li'
        ];
        for (var bsi = 0; bsi < bossSelectors.length; bsi++) {
          try { var bsf = document.querySelectorAll(bossSelectors[bsi]); if (bsf.length > 0) { allCards = Array.from(bsf); break; } } catch(_) {}
        }
      }
      
      // Level3: 职位链接兜底
      if (allCards.length === 0) {
        var links = document.querySelectorAll('a[href*="/web/geek/job"], a[href*="/job_detail/"], a[href*="/gongsi/"]');
        for (var j = 0; j < links.length; j++) {
          var box = links[j].closest('li, div, section, article, [ka="search-job-item"], [class*="job-card"], [class*="JobCard"], [class*="card"]');
          if (box && !allCards.includes(box)) allCards.push(box);
        }
      }

      // Level4: v8终极兜底 — 按内容特征找
      if (allCards.length === 0) {
        var salaryPattern = /[\\d]+[\\-~][\\d]+[Kk万]/;
        var allContainers = document.querySelectorAll('li, div[class*="card"], div[class*="item"], section');
        for (var ci = 0; ci < allContainers.length; ci++) {
          var containerText = (allContainers[ci].textContent || '');
          if (salaryPattern.test(containerText) && /[\\u4e00-\\u9fa5]{2,8}/.test(containerText) && allContainers[ci].querySelector('a')) {
            allCards.push(allContainers[ci]);
          }
        }
      }

      // 过滤骨架屏（v8.1 大幅放宽 — Boss频繁改版，不能依赖固定选择器）
      var realCards = [];
      for (var c = 0; c < allCards.length; c++) {
        var card = allCards[c];
        var text = (card.textContent || '').trim();

        // 骨架屏：有shimmer动画 + 文字<20 才是骨架
        var hasSkeletonClass = card.querySelector('[class*="skeleton"], [class*="shimmer"], [class*="loading"], [class*="placeholder"]');
        if (hasSkeletonClass && text.length < 20) continue;
        if (text.length < 5 && !hasSkeletonClass) continue;

        // 有中文内容就认
        if (text.length > 8 && /[\\u4e00-\\u9fa5]{2,}/.test(text)) {
          realCards.push(card);
        }
      }

      if (realCards.length === 0) {
        // v8: 返回诊断信息，不再只说"skeleton_or_empty"
        return {
          error: 'skeleton_or_empty',
          total: allCards.length,
          skeleton: allCards.length,
          debug_pageUrl: window.location.href,
          debug_pageTextLen: (document.body ? document.body.innerText : '').length,
          debug_jobLinks: document.querySelectorAll('a[href*="/web/geek/job"], a[href*="/job_detail/"]').length
        };
      }
      if (realCards.length <= ${cardIndex}) {
        return { error: 'real_card_out_of_range', totalReal: realCards.length, total: allCards.length };
      }

      var card = realCards[${cardIndex}];

      // ═══════ 检查是否已沟通 ═══════
      var statusWords = ${JSON.stringify(config.apply.searchPageButtons.applied_status || [])};
      var allBtns = card.querySelectorAll('a, button, span, div[role=button]');
      for (var b = 0; b < allBtns.length; b++) {
        var t = allBtns[b].textContent.trim();
        for (var s = 0; s < statusWords.length; s++) {
          if (t === statusWords[s] || t.includes(statusWords[s])) {
            var info = _extractBossCardInfo(card);
            return { alreadyApplied: true, status: t, cardInfo: info, hovered: false };
          }
        }
      }

      // ═══════ 提取信息（sendInputEvent已经在前面做了hover） ═══════
      var info = _extractBossCardInfo(card);
      return { hovered: true, cardInfo: info, alreadyApplied: false };

      // ═══════ 内部：提取Boss卡片信息 ═══════
      function _extractBossCardInfo(card) {
        var title = '', company = '', salary = '';
        
        // 标题
        var titleEls = card.querySelectorAll('.job-name, [class*="job-name"], h3[class*="name"], h3, h4, a[href*="/web/geek/job"], a[href*="/job_detail/"]');
        for (var ti = 0; ti < titleEls.length; ti++) {
          var txt = titleEls[ti].textContent.trim();
          if (txt.length > 2 && txt.length < 80) { title = txt.substring(0, 60); break; }
        }
        if (!title) { var link = card.querySelector('a[href*="/web/geek/job"], a[href*="/job_detail/"]'); if (link) title = link.textContent.trim().substring(0, 60); }

        // 公司
        var companyEls = card.querySelectorAll('.company-name a, [class*="company-name"] a, a[href*="/gongsi/"]');
        for (var ci = 0; ci < companyEls.length; ci++) {
          var ctxt = companyEls[ci].textContent.trim();
          if (ctxt.length > 1) { company = ctxt.substring(0, 40); break; }
        }
        if (!company) {
          var cardText = card.textContent || '';
          var coMatch = cardText.match(/([\u4e00-\u9fa5]{2,10}(?:有限公司|集团|股份|科技|咨询|服务))/);
          if (coMatch) company = coMatch[1];
        }

        // 薪资
        var salaryEls = card.querySelectorAll('.salary, [class*="salary"], .job-limit .red, [class*="red"], [class*="money"]');
        for (var si = 0; si < salaryEls.length; si++) {
          var stxt = salaryEls[si].textContent.trim();
          if (stxt.length > 1) { salary = stxt; break; }
        }
        // v8: 如果没找到薪资元素，直接从文本提取薪资格式
        if (!salary) {
          var salaryMatch = (card.textContent || '').match(/[\\d]+[\\-~][\\d]+[Kk万]/);
          if (salaryMatch) salary = salaryMatch[0];
        }

        return { title: title, company: company, salary: salary };
      }
    })();
  `);

  if (!result) return { cardInfo: null, alreadyApplied: false, hovered: false, error: 'execJS返回null' };

  // v7: sendInputEvent hover已经在execJS前完成，这里再等一下让hover动画完全渲染
  if (result.hovered) await sleep(800 + Math.random() * 400);

  return result;
}

/**
 * Boss专用 v6：hover后点击"立即沟通" + 填打招呼 + 发送，全在一个execJS里完成
 * 
 * 设计思路：
 * - 先重新hover确保按钮可见
 * - 在卡片内找"立即沟通"按钮 → 点击
 * - 等弹窗出现后 → 填打招呼消息 → 点击发送
 * - 全在一次注入中完成，减少页面状态不一致的风险
 * 
 * @param {BrowserWindow} win
 * @param {number} cardIndex - 真实卡片index（与bossApplyCard对应）
 * @param {object} helpers
 * @returns {Promise<{clicked: boolean, greetingSent: boolean, strategy: string|null, error: string|null}>}
 */
async function bossClickAndGreet(win, cardIndex, helpers) {
  const { execJS, sleep } = helpers;
  const config = configLoader.loadConfig('boss');
  if (!config) return { clicked: false, greetingSent: false, error: 'boss配置加载失败' };

  // ★★★ v7核心修复：用sendInputEvent做真实鼠标hover ★★★
  // dispatchEvent无法触发React合成事件 → "立即沟通"按钮没出现 → 找不到按钮
  // 改用Electron的sendInputEvent，它走浏览器原生事件管道，React能正确响应
  const cardPos = await getCardPosition(win, cardIndex, helpers);
  if (cardPos) {
    // 先把鼠标移到卡片上方的"职位名"区域，确保hover生效
    realMouseMove(win, cardPos.centerX, cardPos.centerY - 20); // 稍偏上，命中职位名区域
    await sleep(500 + Math.random() * 300);
    // 再移到卡片中心
    realMouseMove(win, cardPos.centerX, cardPos.centerY);
    await sleep(800 + Math.random() * 400); // 给React足够时间渲染hover效果
  }

  // ★ Phase 1: 找到并点击沟通按钮（v7：多级fallback + 全局搜索）
  const clickPhase = await execJS(win, `
    (function() {
      // 找真实卡片（同bossApplyCard的过滤逻辑）
      var allCards = [];
      var selectors = ${JSON.stringify(config.search.elements.job_item.map(s => s.value))};
      for (var i = 0; i < selectors.length; i++) {
        try { var f = document.querySelectorAll(selectors[i]); if (f.length > 0) { allCards = Array.from(f); break; } } catch(_) {}
      }
      if (allCards.length === 0) {
        var links = document.querySelectorAll('a[href*="/web/geek/job"], a[href*="/job_detail/"]');
        for (var j = 0; j < links.length; j++) {
          var box = links[j].closest('li, [ka="search-job-item"], [class*="job-card"]');
          if (box && !allCards.includes(box)) allCards.push(box);
        }
      }

      var realCards = [];
      for (var c = 0; c < allCards.length; c++) {
        var text = (allCards[c].textContent || '').trim();
        var hasJobName = allCards[c].querySelector('.job-name, [class*="job-name"]');
        if ((hasJobName && hasJobName.textContent.trim().length > 2) || (text.length > 15 && /[\u4e00-\u9fa5]{2,}/.test(text))) {
          realCards.push(allCards[c]);
        }
      }

      if (realCards.length <= ${cardIndex}) return { error: 'real_card_not_found' };
      var card = realCards[${cardIndex}];

      // ═══════ v7多级fallback搜索"立即沟通"按钮 ═══════

      // ★ Level 1: 卡片内CSS选择器
      var btnSelectors = ${JSON.stringify((config.apply.searchPageButtons.apply_btn_after_hover || []).filter(s => s.strategy === 'css').map(s => s.value))};
      // v7新增更多当前Boss DOM选择器
      var extraSelectors = ['.btn-start-chat', '.btn-greeting', '.op-btn-chat', '.job-card-left .btn-start-chat',
        '[class*="btn-start-chat"]', '[class*="op-btn"]', '[class*="greeting-btn"]',
        'a[class*="start-chat"]', 'a[class*="btn-chat"]'];
      btnSelectors = btnSelectors.concat(extraSelectors);
      for (var bi = 0; bi < btnSelectors.length; bi++) {
        try {
          var btn = card.querySelector(btnSelectors[bi]);
          if (btn && btn.offsetHeight > 0) { btn.scrollIntoView({block:'center'}); btn.click(); return { clicked: true, strategy: 'card_css:' + btnSelectors[bi] }; }
        } catch(_) {}
      }

      // ★ Level 2: 卡片内文字匹配
      var btnTexts = ${JSON.stringify((config.apply.searchPageButtons.apply_btn_after_hover || []).filter(s => s.strategy === 'text').map(s => s.value))};
      var cardBtns = card.querySelectorAll('a, button, span, div[role=button]');
      for (var ti = 0; ti < cardBtns.length; ti++) {
        var t = cardBtns[ti].textContent.trim();
        for (var tv = 0; tv < btnTexts.length; tv++) {
          if (t === btnTexts[tv] && cardBtns[ti].offsetHeight > 0) {
            cardBtns[ti].scrollIntoView({block:'center'});
            cardBtns[ti].click();
            return { clicked: true, strategy: 'card_text:' + btnTexts[tv] };
          }
        }
      }

      // ★★★ Level 3: v7新增 — 全局文字搜索"立即沟通" ★★★
      // Boss的hover overlay可能把按钮渲染在卡片DOM外部
      var allGlobalBtns = document.querySelectorAll('a, button, span, div[role=button], div[class*="btn"]');
      for (var gi = 0; gi < allGlobalBtns.length; gi++) {
        var gt = allGlobalBtns[gi].textContent.trim();
        if ((gt === '立即沟通' || gt === '继续沟通') && allGlobalBtns[gi].offsetHeight > 0) {
          allGlobalBtns[gi].scrollIntoView({block:'center'});
          allGlobalBtns[gi].click();
          return { clicked: true, strategy: 'global_text:' + gt };
        }
      }

      // ★★★ Level 4: v7新增 — hover overlay/floating panel内搜索 ★★★
      // Boss搜索页hover后可能弹出浮层，按钮在浮层内
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

      // ★ Level 5: 全局CSS兜底（旧版逻辑）
      var globalBtns = document.querySelectorAll('a.btn-start-chat, a[class*="start-chat"], a[class*="greeting"], .btn-start-chat, [class*="btn-start-chat"]');
      for (var gci = 0; gci < globalBtns.length; gci++) {
        if (globalBtns[gci].offsetHeight > 0) {
          globalBtns[gci].scrollIntoView({block:'center'});
          globalBtns[gci].click();
          return { clicked: true, strategy: 'global_css' };
        }
      }

      // ★★★ Level 6: v7新增 — 最终兜底：搜索所有可见的疑似沟通按钮 ★★★
      // 如果以上都找不到，扫描页面上所有包含"沟通"文字的可点击元素
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

  if (!clickPhase || !clickPhase.clicked) {
    return { clicked: false, greetingSent: false, error: clickPhase ? clickPhase.error : 'click执行失败' };
  }

  // ★ Phase 2: 等打招呼弹窗 → 填消息 → 发送
  await sleep(1500 + Math.random() * 500);

  const greetPhase = await execJS(win, `
    (function() {
      var msg = '您好，我对贵司职位很感兴趣，期待进一步沟通！';

      // ★ 找输入框
      var inputSelectors = ${JSON.stringify((config.apply.searchPageButtons.greeting_input || []).map(s => s.value))};
      var input = null;
      for (var i = 0; i < inputSelectors.length; i++) {
        try { var el = document.querySelector(inputSelectors[i]); if (el && el.offsetHeight > 0) { input = el; break; } } catch(_) {}
      }
      // 兜底找输入框
      if (!input) {
        var areas = document.querySelectorAll('textarea[class*="input"], textarea[class*="chat"], textarea[class*="greeting"]');
        for (var j = 0; j < areas.length; j++) {
          if (areas[j].offsetHeight > 0) { input = areas[j]; break; }
        }
      }

      if (!input) return { greetingSent: false, reason: 'no_input_found' };

      // ★ 填消息（用native setter触发React/Vue的onChange）
      try {
        var ns = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        ns.call(input, msg);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch(_) {
        input.value = msg;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // ★ 点击发送按钮
      var sendSelectors = ${JSON.stringify((config.apply.searchPageButtons.greeting_send || []).map(s => s.value))};
      for (var si = 0; si < sendSelectors.length; si++) {
        try { var sb = document.querySelector(sendSelectors[si]); if (sb && sb.offsetHeight > 0) { sb.click(); return { greetingSent: true }; } } catch(_) {}
      }
      // 兜底：找"发送"文字按钮
      var allBtns = document.querySelectorAll('a, button');
      for (var bi = 0; bi < allBtns.length; bi++) {
        if (allBtns[bi].textContent.trim() === '发送' && allBtns[bi].offsetHeight > 0) {
          allBtns[bi].click();
          return { greetingSent: true };
        }
      }
      return { greetingSent: false, reason: 'no_send_btn' };
    })();
  `);

  return {
    clicked: true,
    greetingSent: greetPhase ? greetPhase.greetingSent === true : false,
    strategy: clickPhase.strategy,
    error: null
  };
}

/**
 * Boss专用 v6：获取真实卡片数量（过滤骨架屏）
 * 
 * @param {BrowserWindow} win
 * @param {object} helpers
 * @returns {Promise<{realCount: number, totalCount: number, isSkeleton: boolean}>}
 */
async function bossGetRealCardCount(win, helpers) {
  const { execJS } = helpers;
  const config = configLoader.loadConfig('boss');
  if (!config) return { realCount: 0, totalCount: 0, isSkeleton: true };

  // ★★★ v8: 多级fallback卡片检测 + 诊断dump ★★★
  // Boss直聘频繁更新DOM结构，旧选择器失效导致所有卡片被误判为骨架屏
  const result = await execJS(win, `
    (function() {
      var allCards = [];

      // ═══════ Level 1: 配置选择器 ═══════
      var selectors = ${JSON.stringify(config.search.elements.job_item.map(s => s.value))};
      for (var i = 0; i < selectors.length; i++) {
        try { var f = document.querySelectorAll(selectors[i]); if (f.length > 0) { allCards = Array.from(f); break; } } catch(_) {}
      }

      // ═══════ Level 2: v8新增 — 更多通用Boss选择器 ═══════
      if (allCards.length === 0) {
        var bossSelectors = [
          '.job-list-box li', '.search-job-result li',
          '[class*="job-list"] li', '[class*="search-result"] li',
          '.job-card-wrapper', '.job-card-left',
          '[class*="JobCard"]', '[class*="jobcard"]',
          '[class*="job-card"]', '[class*="job_item"]',
          '[data-job-id]', '[ka="search-job-item"]',
          '.recommend-card', '.job-list-ul li'
        ];
        for (var bsi = 0; bsi < bossSelectors.length; bsi++) {
          try {
            var bsf = document.querySelectorAll(bossSelectors[bsi]);
            if (bsf.length > 0) { allCards = Array.from(bsf); break; }
          } catch(_) {}
        }
      }

      // ═══════ Level 3: 职位链接兜底（最可靠） ═══════
      if (allCards.length === 0) {
        var links = document.querySelectorAll('a[href*="/web/geek/job"], a[href*="/job_detail/"], a[href*="/gongsi/"]');
        for (var j = 0; j < links.length; j++) {
          // v8: 扩展closest范围，覆盖更多可能的父元素
          var box = links[j].closest('li, div, section, article, [ka="search-job-item"], [class*="job-card"], [class*="JobCard"], [class*="card"]');
          if (box && !allCards.includes(box)) allCards.push(box);
        }
      }

      // ═══════ Level 4: v8终极兜底 — 按内容特征找卡片 ═══════
      // Boss搜索页的卡片一定包含薪资信息（如"8-15K"）
      if (allCards.length === 0) {
        // 找所有包含薪资格式文字的容器元素
        var salaryPattern = /[\\d]+[\\-~][\\d]+[Kk万]/;
        var allContainers = document.querySelectorAll('li, div[class*="card"], div[class*="item"], section');
        for (var ci = 0; ci < allContainers.length; ci++) {
          var containerText = (allContainers[ci].textContent || '');
          // 卡片特征：有薪资 + 有中文职位名 + 有链接
          if (salaryPattern.test(containerText) && /[\\u4e00-\\u9fa5]{2,8}/.test(containerText) && allContainers[ci].querySelector('a')) {
            allCards.push(allContainers[ci]);
          }
        }
      }

      // ═══════ 过滤骨架屏（放宽标准） ═══════
      // v8: 骨架屏特征是动画shimmer或没有真实文字内容，不能仅靠"没有.job-name"来判断
      var realCount = 0;
      var skeletonCount = 0;
      for (var c = 0; c < allCards.length; c++) {
        var text = (allCards[c].textContent || '').trim();
        var hasJobName = allCards[c].querySelector('.job-name, [class*="job-name"], [class*="job-name"], h3, h4');
        var jobNameText = hasJobName ? hasJobName.textContent.trim() : '';

        // ★ 骨架屏特征检测（比之前更精准）
        var isSkeletonCard = false;
        // 1. shimmer动画元素
        if (allCards[c].querySelector('[class*="skeleton"], [class*="shimmer"], [class*="loading"], [class*="placeholder"]')) {
          isSkeletonCard = true;
        }
        // 2. 文本内容全是空白/占位符
        if (text.length < 5 || /^[\\s\\u00a0]+$/.test(text)) {
          isSkeletonCard = true;
        }

        // ★ v8.1: 大幅放宽骨架屏判定 — 只要有内容就认
      // BOSS频繁改版CSS类名，不能依赖固定选择器
      var isProbablySkeleton =
        (text.length < 5) ||
        (allCards[c].querySelector('[class*="skeleton"], [class*="shimmer"], [class*="loading"], [class*="placeholder"]') && text.length < 20);

      if (isProbablySkeleton) {
        skeletonCount++;
        continue;
      }

      // ★ 真实卡片：有文字内容就认（Boss频繁改版，不能用固定选择器）
      if (text.length > 8 && /[\\u4e00-\\u9fa5]{2,}/.test(text)) {
        realCount++;
      }
      }

      // ═══════ 诊断dump：记录页面结构信息 ═══════
      var diagnostic = {
        url: window.location.href,
        bodyTextLen: (document.body ? document.body.innerText : '').length,
        // 记录页面上主要的容器元素，方便排查
        topContainers: [],
        // 记录找到的链接类型
        jobLinks: document.querySelectorAll('a[href*="/web/geek/job"], a[href*="/job_detail/"]').length,
        salaryMatches: (document.body ? (document.body.innerText.match(/[\\d]+[\\-~][\\d]+[Kk万]/g) || []) : []).length
      };
      // dump前5个顶层有意义容器的tag+class
      var mainDivs = document.querySelectorAll('.job-list-box, .search-job-result, [class*="job-list"], [class*="search-result"], [class*="job-card"], .job-list-ul, [class*="recommend"]');
      for (var mi = 0; mi < mainDivs.length && mi < 10; mi++) {
        diagnostic.topContainers.push({ tag: mainDivs[mi].tagName, cls: mainDivs[mi].className.substring(0, 80), childCount: mainDivs[mi].children.length });
      }
      // 如果没找到任何容器，dump body的直系子元素
      if (diagnostic.topContainers.length === 0) {
        var bodyChildren = document.body ? document.body.children : [];
        for (var bc = 0; bc < bodyChildren.length && bc < 8; bc++) {
          diagnostic.topContainers.push({ tag: bodyChildren[bc].tagName, cls: (bodyChildren[bc].className || '').substring(0, 60), childCount: bodyChildren[bc].children ? bodyChildren[bc].children.length : 0 });
        }
      }

      return {
        realCount: realCount,
        totalCount: allCards.length,
        skeletonCount: skeletonCount,
        isSkeleton: allCards.length > 0 && realCount === 0,
        diagnostic: diagnostic
      };
    })();
  `);

  // v8: 打印诊断信息
  if (result && result.diagnostic) {
    console.log('[bossGetRealCardCount] 诊断dump:', JSON.stringify(result.diagnostic, null, 2));
  }

  return result || { realCount: 0, totalCount: 0, isSkeleton: true };
}

// ═══════════════════════════════════════════════════════════════
// 智联专用：主动关闭APP下载弹窗
// ═══════════════════════════════════════════════════════════════

/**
 * 主动关闭智联的APP下载弹窗（不是检测到就放弃，而是主动关掉继续投递）
 * @param {BrowserWindow} win
 * @param {object} helpers
 * @returns {Promise<boolean>} 是否成功关闭弹窗
 */
async function zhilianDismissAppPopup(win, helpers) {
  const { execJS, sleep } = helpers;
  const config = configLoader.loadConfig('zhilian');
  if (!config) return false;
  const closeSelectors = config.apply.searchPageButtons.app_popup_close || [];

  const closed = await execJS(win, `
    (function() {
      // ★ 策略1：用配置的关闭选择器
      var closeSelectors = ${JSON.stringify(closeSelectors.map(s => s.value))};
      for (var i = 0; i < closeSelectors.length; i++) {
        try {
          var btn = document.querySelector(closeSelectors[i]);
          if (btn) { btn.click(); return true; }
        } catch(_) {}
      }

      // ★ 策略2：暴力扫描所有关闭按钮
      var allClose = document.querySelectorAll(
        '[class*="close"], [class*="Close"], .close-btn, .close-btn, ' +
        'button.close, span.close, a.close, ' +
        '[class*="cancel"], [class*="Cancel"]'
      );
      for (var j = 0; j < allClose.length; j++) {
        var t = allClose[j].textContent.trim();
        if (t === '关闭' || t === '取消' || t === '不再提示' || t === '下次再说' || t === '×' || t === 'X') {
          allClose[j].click();
          return true;
        }
      }

      // ★ 策略3：找所有弹窗/模态框的关闭按钮
      var modals = document.querySelectorAll(
        '[class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"], ' +
        '[class*="dialog"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"]'
      );
      for (var k = 0; k < modals.length; k++) {
        var closeBtn = modals[k].querySelector('[class*="close"], button');
        if (closeBtn) {
          var ct = closeBtn.textContent.trim();
          if (ct === '×' || ct === 'X' || ct === '关闭' || ct === '取消' || ct.length < 3) {
            closeBtn.click();
            return true;
          }
        }
      }

      // ★ 策略4：直接移除弹窗DOM（强制关闭）
      var popups = document.querySelectorAll(
        '[class*="download-app"], [class*="open-app"], [class*="DownloadApp"], [class*="OpenApp"]'
      );
      for (var m = 0; m < popups.length; m++) {
        // 如果弹窗有固定定位且遮挡了页面，直接隐藏
        if (popups[m].style.position === 'fixed' || popups[m].style.position === 'absolute') {
          popups[m].style.display = 'none';
          return true;
        }
        // 找弹窗的overlay
        var overlay = popups[m].closest('[class*="overlay"], [class*="mask"]');
        if (overlay) { overlay.style.display = 'none'; return true; }
      }

      return false;
    })();
  `);

  if (closed) {
    await sleep(500);
  }
  return closed === true;
}

// ═══════════════════════════════════════════════════════════════
// 猎聘专用：处理确认弹窗
// ═══════════════════════════════════════════════════════════════

/**
 * 猎聘投递后可能弹出确认框，主动点击"确定"
 * @param {BrowserWindow} win
 * @param {object} helpers
 * @returns {Promise<boolean>}
 */
async function liepinHandleConfirmDialog(win, helpers) {
  const { execJS, sleep } = helpers;
  const config = configLoader.loadConfig('liepin');
  if (!config) return false;
  const confirmSelectors = config.apply.searchPageButtons.confirm_btn || [];

  const result = await execJS(win, `
    (function() {
      // ★ 策略1：配置的确认按钮选择器
      var confirmItems = ${JSON.stringify(confirmSelectors)};
      for (var i = 0; i < confirmItems.length; i++) {
        try {
          if (confirmItems[i].strategy === 'css') {
            var el = document.querySelector(confirmItems[i].value);
            if (el && el.offsetHeight > 0) { el.click(); return true; }
          } else if (confirmItems[i].strategy === 'text') {
            var btns = document.querySelectorAll('a, button, span, div[role=button]');
            for (var j = 0; j < btns.length; j++) {
              if (btns[j].textContent.trim() === confirmItems[i].value && btns[j].offsetHeight > 0) {
                btns[j].click(); return true;
              }
            }
          }
        } catch(_) {}
      }

      // ★ 策略2：找弹窗里的"确定"/"确认"按钮
      var modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="confirm"]');
      for (var k = 0; k < modals.length; k++) {
        var btn = modals[k].querySelector('button, a, span');
        if (btn) {
          var t = btn.textContent.trim();
          if (t === '确定' || t === '确认' || t === '是的' || t === 'OK') {
            btn.click(); return true;
          }
        }
      }

      // ★ 策略3：全局搜索
      var allBtns = document.querySelectorAll('a, button, span, div[role=button]');
      for (var m = 0; m < allBtns.length; m++) {
        var t2 = allBtns[m].textContent.trim();
        if ((t2 === '确定' || t2 === '确认') && allBtns[m].offsetHeight > 0) {
          allBtns[m].click(); return true;
        }
      }

      return false;
    })();
  `);

  if (result) await sleep(500);
  return result === true;
}

// ═══════════════════════════════════════════════════════════════
// 全平台通用：在搜索页提取卡片信息（不点击按钮）
// ═══════════════════════════════════════════════════════════════

/**
 * ★★★ Bug#1修复：先提取卡片信息，再判断关键词，再决定是否点击 ★★★
 * 只提取标题/公司/薪资/按钮状态，不做任何点击操作
 * @param {BrowserWindow} win
 * @param {string} platform - 'liepin'/'zhilian'/'job51'/'boss'
 * @param {number} cardIndex - 0-based
 * @param {object} helpers
 * @returns {Promise<{cardInfo: object|null, alreadyApplied: boolean, status: string|null, totalCards: number, error: string|null}>}
 */
async function getCardInfoOnSearchPage(win, platform, cardIndex, helpers) {
  const { execJS } = helpers;
  const config = configLoader.loadConfig(platform);
  if (!config) return { cardInfo: null, alreadyApplied: false, status: null, totalCards: 0, error: '配置加载失败' };

  const appliedStatus = (config.apply.searchPageButtons || {}).applied_status || [];

  const result = await execJS(win, `
    (function() {
      // ═══════ 找卡片 ═══════
      var cardSelectors = ${JSON.stringify(config.search.elements.job_item.map(s => s.value))};
      var cards = [];
      for (var i = 0; i < cardSelectors.length; i++) {
        try { var found = document.querySelectorAll(cardSelectors[i]); if (found && found.length > 0) cards = Array.from(found); } catch(_) {}
        if (cards.length > 0) break;
      }
      // 兜底：找包含职位链接的容器
      if (cards.length === 0) {
        var allLinks = document.querySelectorAll('a[href]');
        var jobPatterns = [/\\/job\\//i, /\\/zhaopin\\//i, /\\/jobs\\//i, /\\/geek\\/job/i];
        for (var j = 0; j < allLinks.length; j++) {
          for (var pi = 0; pi < jobPatterns.length; pi++) {
            if (jobPatterns[pi].test(allLinks[j].href)) {
              var container = allLinks[j].closest('li, [class*="card"], [class*="item"], [class*="row"]');
              if (container && !cards.includes(container)) cards.push(container);
            }
          }
        }
      }

      if (!cards || cards.length <= ${cardIndex}) return { error: '卡片不存在(共' + (cards?cards.length:0) + '个)', totalCards: cards ? cards.length : 0 };

      var card = cards[${cardIndex}];

      // ═══════ 提取信息（只读，不点击） ═══════
      var title = '', company = '', salary = '';
      var titleSelectors = ${JSON.stringify(config.search.elements.job_title.map(s => s.value))};
      for (var ti = 0; ti < titleSelectors.length; ti++) {
        try { var te = card.querySelector(titleSelectors[ti]); if (te && te.textContent.trim().length > 2) { title = te.textContent.trim().substring(0, 60); break; } } catch(_) {}
      }
      if (!title) { var link = card.querySelector('a[href]'); if (link) title = link.textContent.trim().substring(0, 60); }

      var companySelectors = ${JSON.stringify(config.search.elements.company_name.map(s => s.value))};
      for (var ci = 0; ci < companySelectors.length; ci++) {
        try { var ce = card.querySelector(companySelectors[ci]); if (ce && ce.textContent.trim().length > 1) { company = ce.textContent.trim().substring(0, 40); break; } } catch(_) {}
      }
      if (!company) {
        var cardText = card.textContent || '';
        var coMatch = cardText.match(/([\u4e00-\u9fa5]{2,10}(?:有限公司|集团|股份|科技|咨询|服务))/);
        if (coMatch) company = coMatch[1];
      }

      var salarySelectors = ${JSON.stringify(config.search.elements.salary.map(s => s.value))};
      for (var si = 0; si < salarySelectors.length; si++) {
        try { var se = card.querySelector(salarySelectors[si]); if (se && se.textContent.trim().length > 1) { salary = se.textContent.trim(); break; } } catch(_) {}
      }

      // ═══════ 检查按钮状态（只读，不点击） ═══════
      var allBtns = card.querySelectorAll('a, button, span, div[role=button]');
      var statusWords = ${JSON.stringify(appliedStatus)};
      for (var bi = 0; bi < allBtns.length; bi++) {
        var t = allBtns[bi].textContent.trim();
        for (var si2 = 0; si2 < statusWords.length; si2++) {
          if (t === statusWords[si2] || t.includes(statusWords[si2])) return { alreadyApplied: true, status: t, cardInfo: {title:title,company:company,salary:salary}, totalCards: cards.length };
        }
      }

      return { alreadyApplied: false, status: null, cardInfo: {title:title,company:company,salary:salary}, totalCards: cards.length };
    })();
  `);

  return result || { cardInfo: null, alreadyApplied: false, status: null, totalCards: 0, error: '执行失败' };
}

// ═══════════════════════════════════════════════════════════════
// 全平台通用：在搜索页卡片上点击投递按钮（只点击，不提取信息）
// ═══════════════════════════════════════════════════════════════

/**
 * ★★★ Bug#1修复：配合getCardInfoOnSearchPage，先提取→关键词判断→再调用此函数点击 ★★★
 * 只负责找到按钮并点击，不提取卡片信息
 * @param {BrowserWindow} win
 * @param {string} platform - 'liepin'/'zhilian'/'job51'
 * @param {number} cardIndex - 0-based
 * @param {object} helpers
 * @returns {Promise<{clicked: boolean, strategy: string|null, error: string|null}>}
 */
async function clickApplyOnly(win, platform, cardIndex, helpers) {
  const { execJS } = helpers;
  const config = configLoader.loadConfig(platform);
  if (!config) return { clicked: false, strategy: null, error: '配置加载失败' };

  const searchBtns = config.apply.searchPageButtons || {};
  const applyBtnSelectors = searchBtns.apply_btn || config.apply.elements.apply_btn || [];
  const chatBtnSelectors = searchBtns.chat_btn || config.apply.elements.chat_btn || [];

  const result = await execJS(win, `
    (function() {
      // ═══════ 找卡片 ═══════
      var cardSelectors = ${JSON.stringify(config.search.elements.job_item.map(s => s.value))};
      var cards = [];
      for (var i = 0; i < cardSelectors.length; i++) {
        try { var found = document.querySelectorAll(cardSelectors[i]); if (found && found.length > 0) cards = Array.from(found); } catch(_) {}
        if (cards.length > 0) break;
      }
      if (cards.length === 0) {
        var allLinks = document.querySelectorAll('a[href]');
        var jobPatterns = [/\\/job\\//i, /\\/zhaopin\\//i, /\\/jobs\\//i, /\\/geek\\/job/i];
        for (var j = 0; j < allLinks.length; j++) {
          for (var pi = 0; pi < jobPatterns.length; pi++) {
            if (jobPatterns[pi].test(allLinks[j].href)) {
              var container = allLinks[j].closest('li, [class*="card"], [class*="item"], [class*="row"]');
              if (container && !cards.includes(container)) cards.push(container);
            }
          }
        }
      }

      if (!cards || cards.length <= ${cardIndex}) return { error: '卡片不存在' };

      var card = cards[${cardIndex}];
      var allBtns = card.querySelectorAll('a, button, span, div[role=button]');

      // ═══════ 点击投递按钮 ═══════
      var applySelectors = ${JSON.stringify(applyBtnSelectors)};
      for (var ai = 0; ai < applySelectors.length; ai++) {
        try {
          if (applySelectors[ai].strategy === 'css') {
            var el = card.querySelector(applySelectors[ai].value);
            if (el && el.offsetHeight > 0) { el.scrollIntoView({block:'center'}); el.click(); return { clicked: true, strategy: 'apply_css:' + applySelectors[ai].value }; }
          } else if (applySelectors[ai].strategy === 'text') {
            for (var bj = 0; bj < allBtns.length; bj++) {
              if (allBtns[bj].textContent.trim() === applySelectors[ai].value && allBtns[bj].offsetHeight > 0) {
                allBtns[bj].scrollIntoView({block:'center'});
                allBtns[bj].click();
                return { clicked: true, strategy: 'apply_text:' + applySelectors[ai].value };
              }
            }
          }
        } catch(_) {}
      }

      // ═══════ 备选：点击沟通按钮 ═══════
      var chatSelectors = ${JSON.stringify(chatBtnSelectors)};
      for (var chi = 0; chi < chatSelectors.length; chi++) {
        try {
          if (chatSelectors[chi].strategy === 'css') {
            var ce2 = card.querySelector(chatSelectors[chi].value);
            if (ce2 && ce2.offsetHeight > 0) { ce2.scrollIntoView({block:'center'}); ce2.click(); return { clicked: true, strategy: 'chat_css:' + chatSelectors[chi].value }; }
          } else if (chatSelectors[chi].strategy === 'text') {
            for (var bk = 0; bk < allBtns.length; bk++) {
              if (allBtns[bk].textContent.trim() === chatSelectors[chi].value && allBtns[bk].offsetHeight > 0) {
                allBtns[bk].scrollIntoView({block:'center'});
                allBtns[bk].click();
                return { clicked: true, strategy: 'chat_text:' + chatSelectors[chi].value };
              }
            }
          }
        } catch(_) {}
      }

      return { error: '卡片内找不到投递/沟通按钮' };
    })();
  `);

  return result || { clicked: false, strategy: null, error: '执行失败' };
}

// ═══════════════════════════════════════════════════════════════
// 全平台通用：提取信息+点击的组合调用（保留向后兼容）
// ═══════════════════════════════════════════════════════════════

/**
 * 组合调用：先提取信息 → 再点击按钮
 * 保留此函数供旧版调用，但内部改为调用 getCardInfo + clickApplyOnly
 * @param {BrowserWindow} win
 * @param {string} platform
 * @param {number} cardIndex
 * @param {object} helpers
 * @returns {Promise<{clicked: boolean, cardInfo: object|null, strategy: string|null, alreadyApplied: boolean, error: string|null}>}
 */
async function clickApplyOnSearchCard(win, platform, cardIndex, helpers) {
  // ★ Step 1: 先提取信息（不点击）
  const infoResult = await getCardInfoOnSearchPage(win, platform, cardIndex, helpers);

  if (infoResult.error) {
    return { clicked: false, cardInfo: infoResult.cardInfo, strategy: null, alreadyApplied: false, error: infoResult.error, totalCards: infoResult.totalCards };
  }

  if (infoResult.alreadyApplied) {
    return { clicked: false, cardInfo: infoResult.cardInfo, strategy: null, alreadyApplied: true, status: infoResult.status };
  }

  // ★ Step 2: 点击按钮（不提取信息）
  const clickResult = await clickApplyOnly(win, platform, cardIndex, helpers);

  return {
    clicked: clickResult.clicked,
    cardInfo: infoResult.cardInfo,
    strategy: clickResult.strategy,
    alreadyApplied: false,
    error: clickResult.error
  };
}

// ═══════════════════════════════════════════════════════════════
// 全平台通用：检测拦截特征
// ═══════════════════════════════════════════════════════════════

/**
 * 检测页面是否出现投递拦截特征（操作频繁/今日上限/请先登录等）
 * @param {BrowserWindow} win
 * @param {string} platform
 * @param {object} helpers
 * @returns {Promise<{blocked: boolean, reason: string|null, severity: string|null}>}
 *   severity: 'hard' = 必须停止整个投递 (今日上限/请先登录)
 *             'soft' = 暂停一会儿继续 (操作频繁)
 *             'info' = 不影响 (已沟通等)
 */
async function checkBlockIndicator(win, platform, helpers) {
  const { execJS } = helpers;
  const config = configLoader.loadConfig(platform);
  if (!config) return { blocked: false };
  const blockIndicators = config.apply.blockIndicators || [];

  const result = await execJS(win, `
    (function() {
      var text = document.body ? document.body.innerText : '';
      var blocks = ${JSON.stringify(blockIndicators)};
      var hardBlocks = ['请先登录', '今日投递已达上限', '需要验证', '简历不完整'];
      var softBlocks = ['操作频繁', 'Boss限制', '休息一下'];
      for (var i = 0; i < blocks.length; i++) {
        if (text.includes(blocks[i])) {
          for (var h = 0; h < hardBlocks.length; h++) {
            if (blocks[i].includes(hardBlocks[h])) return { blocked: true, reason: blocks[i], severity: 'hard' };
          }
          for (var s = 0; s < softBlocks.length; s++) {
            if (blocks[i].includes(softBlocks[s])) return { blocked: true, reason: blocks[i], severity: 'soft' };
          }
          return { blocked: true, reason: blocks[i], severity: 'info' };
        }
      }
      return { blocked: false };
    })();
  `);

  return result || { blocked: false };
}

// ═══════════════════════════════════════════════════════════════
// 全平台通用：获取搜索页的职位卡片总数
// ═══════════════════════════════════════════════════════════════

/**
 * ★★★ Boss修复：智能卡片计数，自动过滤骨架屏 ★★★
 * 
 * 问题：Boss搜索页使用skeleton loading，骨架屏DOM节点会匹配job_item选择器，
 *       导致把placeholder当成真实卡片，返回错误的卡片数。
 *       
 * 修复策略：
 * 1. 用选择器找到候选卡片后，检查每个卡片是否有实质内容（标题>2字）
 * 2. 统计"真实卡片数" vs "骨架屏数"
 * 3. 如果全部是骨架屏，返回0 + isSkeleton=true 标记
 * 4. 兜底：用职位链接数量作为备选计数
 */
async function getCardCount(win, platform, helpers) {
  const { execJS } = helpers;
  const config = configLoader.loadConfig(platform);
  if (!config) return { count: 0, isSkeleton: false };

  const result = await execJS(win, `
    (function() {
      var cardSelectors = ${JSON.stringify(config.search.elements.job_item.map(s => s.value))};
      
      // ═══════ Step 1: 用配置的选择器找卡片 ═══════
      var allCandidates = [];
      for (var i = 0; i < cardSelectors.length; i++) {
        try {
          var found = document.querySelectorAll(cardSelectors[i]);
          if (found && found.length > 0) {
            allCandidates = Array.from(found);
            break;
          }
        } catch(_) {}
      }

      // ═══════ Step 2: 区分真实卡片 vs 骨架屏 ═══════
      // 骨架屏特征: textContent很短(<10字符) 或只有空白/skeleton类名
      var realCards = [];
      var skeletonCards = 0;
      for (var c = 0; c < allCandidates.length; c++) {
        var card = allCandidates[c];
        var text = (card.textContent || '').trim();
        var hasRealContent = false;

        // 检查方法1: 文本长度 > 20字符（真实卡片通常有标题+公司名）
        if (text.length > 20) hasRealContent = true;
        
        // 检查方法2: 包含中文职位相关词
        else if (/[\u4e00-\u9fa5]{2,}/.test(text)) {
          // 有中文字符但较短 → 再检查是否包含常见骨架屏特征
          var className = (card.className || '') + '';
          var isLikelySkeleton = /skeleton|loading|shimmer|placeholder|ghost/i.test(className);
          // 检查子元素是否有实际链接
          var hasJobLink = !!card.querySelector('a[href*="job"], a[href*="zhaopin"], a[href*="geek"]');
          if (!isLikelySkeleton && hasJobLink) hasRealContent = true;
          else if (!isLikelySkeleton && text.length > 8) hasRealContent = true; // 短但有内容
        }
        
        // 检查方法3: 子元素中有可见的标题级元素
        if (!hasRealContent) {
          var headings = card.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="name"],[class*="job-name"]');
          for (var h = 0; h < headings.length; h++) {
            if ((headings[h].textContent || '').trim().length > 2) { hasRealContent = true; break; }
          }
        }

        if (hasRealContent) realCards.push(card);
        else skeletonCards++;
      }

      // ═══════ Step 3: 如果选择器没找到或全被判定为骨架屏，用兜底方式 ═══════
      var realCount = realCards.length;
      if (realCount === 0) {
        // 兜底：统计页面上的职位链接数量
        var allLinks = document.querySelectorAll('a[href]');
        var jobLinkCount = 0;
        for (var j = 0; j < allLinks.length; j++) {
          var href = allLinks[j].href || '';
          if (/\\/job\\/|\\/zhaopin\\/|\\/jobs\\/|\\/geek\\/job/i.test(href)) {
            // 排除导航栏等非列表项的链接
            var parentTag = allLinks[j].parentElement ? allLinks[j].parentElement.tagName : '';
            if (parentTag !== 'NAV' && parentTag !== 'HEADER' && parentTag !== 'FOOTER') jobLinkCount++;
          }
        }
        return {
          total: allCandidates.length,
          realCount: jobLinkCount,
          isSkeleton: skeletonCards > 0 || (allCandidates.length > 0 && realCount === 0),
          skeletonCount: skeletonCards,
          fallbackUsed: true
        };
      }

      return {
        total: allCandidates.length,
        realCount: realCount,
        isSkeleton: skeletonCards > 0 && realCount === 0,
        skeletonCount: skeletonCards,
        fallbackUsed: false
      };
    })();
  `);

  // 向后兼容：旧调用方期望直接拿到数字
  // 新调用方可以检查 isSkeleton 字段
  if (!result) return { count: 0, isSkeleton: true };
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 全平台通用：翻页
// ═══════════════════════════════════════════════════════════════

/**
 * 点击"下一页"按钮或通过URL翻页
 * @param {BrowserWindow} win
 * @param {string} platform
 * @param {string} currentUrl
 * @param {number} nextPageNum
 * @param {object} helpers
 * @returns {Promise<{success: boolean, newUrl: string|null}>}
 */
async function clickNextPage(win, platform, currentUrl, nextPageNum, helpers) {
  const { execJS, sleep, loadAndWait } = helpers;
  const config = configLoader.loadConfig(platform);
  if (!config) return { success: false, newUrl: null };
  const nextSelectors = config.search.elements.next_page || [];

  // ★ 策略1：尝试点击"下一页"按钮
  for (const { strategy, value } of nextSelectors) {
    try {
      if (strategy === 'css') {
        const clicked = await execJS(win, `
          (function() {
            var el = document.querySelector('${value.replace(/'/g, "\\'")}');
            if (el && el.offsetHeight > 0) { el.click(); return true; }
            return false;
          })();
        `);
        if (clicked) {
          await sleep(3000);
          const newUrl = win.webContents.getURL();
          if (newUrl !== currentUrl) return { success: true, newUrl };
        }
      } else if (strategy === 'text') {
        const clicked = await execJS(win, `
          (function() {
            var btns = document.querySelectorAll('a, button');
            for (var i = 0; i < btns.length; i++) {
              if (btns[i].textContent.trim() === '${value.replace(/'/g, "\\'")}' && btns[i].offsetHeight > 0) {
                btns[i].click(); return true;
              }
            }
            return false;
          })();
        `);
        if (clicked) {
          await sleep(3000);
          const newUrl = win.webContents.getURL();
          if (newUrl !== currentUrl) return { success: true, newUrl };
        }
      }
    } catch(_) {}
  }

  // ★ 策略2：URL翻页（各平台不同）
  let pageUrl = null;
  if (platform === 'boss') {
    pageUrl = currentUrl.includes('&page=') ? currentUrl.replace(/&page=\d+/, '&page=' + nextPageNum) : currentUrl + '&page=' + nextPageNum;
  } else if (platform === 'liepin') {
    pageUrl = currentUrl.includes('curPage=') ? currentUrl.replace(/curPage=\d+/, 'curPage=' + nextPageNum) : currentUrl + '&curPage=' + nextPageNum;
  } else if (platform === 'zhilian') {
    pageUrl = currentUrl.replace(/\/p\d+/, '/p' + nextPageNum);
  } else if (platform === 'job51') {
    pageUrl = currentUrl.includes('pageno=') ? currentUrl.replace(/pageno=\d+/, 'pageno=' + nextPageNum) : currentUrl + '&pageno=' + nextPageNum;
  }

  if (pageUrl) {
    try {
      await loadAndWait(win, pageUrl, 15000);
      await sleep(2000);
      return { success: true, newUrl: pageUrl };
    } catch(_) {
      return { success: false, newUrl: null };
    }
  }

  return { success: false, newUrl: null };
}

// ═══════════════════════════════════════════════════════════════
// 关键词匹配（搜索页实时过滤）
// ═══════════════════════════════════════════════════════════════

/**
 * 检查一个职位的标题/公司是否匹配关键词（实时判断，不进详情页）
 * @param {object} cardInfo - { title, company, salary }
 * @param {object} filter - { keywords, blacklist_keywords, blacklist_companies }
 * @returns {boolean}
 */
function shouldApplyToCard(cardInfo, filter) {
  if (!cardInfo) return false;
  const keywords = (filter.keywords || []).map(k => k.toLowerCase());
  const blacklist_kw = (filter.blacklist_keywords || []).map(k => k.toLowerCase());
  const blacklist_co = (filter.blacklist_companies || []).map(c => c.toLowerCase());

  const title = (cardInfo.title || '').toLowerCase();
  const company = (cardInfo.company || '').toLowerCase();

  // ★ 黑名单检查 — 公司名在黑名单就跳过
  if (blacklist_co.some(c => company.includes(c))) return false;
  if (blacklist_kw.some(k => title.includes(k) || company.includes(k))) return false;

  // ★ 关键词匹配 — 近义词也算
  if (!keywords.length) return true; // 无关键词就全投

  const RELATED_WORDS = {
    '会计': ['财务', '出纳', '审计', '账务', '核算', '税务', '成本', '预算'],
    'java': ['后端', '服务端', 'spring', '微服务', '开发工程师'],
    '前端': ['web开发', 'vue', 'react', 'angular', 'h5', '页面'],
    'python': ['后端', '数据', '算法', '爬虫', 'django', 'flask'],
    '销售': ['商务', '客户', '市场', '渠道', '业务', '拓展'],
    '运营': ['产品运营', '内容', '推广', '营销', '用户', '社群'],
    '设计': ['ui', '视觉', '交互', '平面', '美工', '创意'],
    '产品': ['产品经理', 'pm', '需求', '规划'],
  };

  for (const kw of keywords) {
    if (title.includes(kw) || company.includes(kw)) return true;
    const related = RELATED_WORDS[kw] || [];
    for (const rw of related) {
      if (title.includes(rw) || company.includes(rw)) return true;
    }
  }

  // ★ 30%相似度阈值兜底
  const threshold = 0.3;
  for (const kw of keywords) {
    const kwChars = new Set(kw.split(''));
    const titleChars = new Set(title.split(''));
    const intersection = new Set([...kwChars].filter(x => titleChars.has(x)));
    const union = new Set([...kwChars, ...titleChars]);
    if (union.size > 0 && intersection.size / union.size >= threshold) return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
// module.exports
// ═══════════════════════════════════════════════════════════════

module.exports = {
  bossApplyCard,
  bossClickAndGreet,
  bossGetRealCardCount,
  zhilianDismissAppPopup,
  liepinHandleConfirmDialog,
  getCardInfoOnSearchPage,
  clickApplyOnly,
  clickApplyOnSearchCard,
  checkBlockIndicator,
  getCardCount,
  clickNextPage,
  shouldApplyToCard,
  realMouseMove,
  getCardPosition
};