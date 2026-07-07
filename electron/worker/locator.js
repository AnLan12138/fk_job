/**
 * locator.js — 多策略元素定位器 + 截图诊断
 *
 * ★ 核心思想：一个策略失败 → 自动试下一个 → 全失败才报错，且报错时输出具体原因
 * ★ 从配置文件读取选择器链，不再是硬编码
 * ★ 失败时自动截图 + DOM dump → 不当哑巴
 *
 * 策略优先级：css → xpath → text → 全局扫描兜底
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const configLoader = require('./configLoader');

// ═══════ 截图目录 ═══════
const SCREENSHOT_DIR = path.join(app.getPath('userData'), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch(_) {}
}

// ═══════ 多策略定位 ═══════

/**
 * 在页面上查找元素 — 多策略兜底
 * @param {BrowserWindow} win - Electron窗口
 * @param {string} platform - 平台名
 * @param {string} section - 配置区域 (search/apply)
 * @param {string} elementName - 元素名 (job_item/job_link等)
 * @param {object} helpers - { execJS, sleep }
 * @returns {Promise<{found: boolean, value: string|null, strategy: string|null, error: string|null}>}
 */
async function locateElement(win, platform, section, elementName, helpers) {
  const { execJS } = helpers;
  const chain = configLoader.getSelectorChain(platform, section, elementName);

  if (!chain || chain.length === 0) {
    return { found: false, value: null, strategy: null, error: `[locator] ${platform}.${section}.${elementName} 配置中没有选择器` };
  }

  // 逐个策略尝试
  for (const { strategy, value } of chain) {
    try {
      const result = await _tryStrategy(win, strategy, value, execJS);
      if (result.found) {
        return { found: true, value: result.value, strategy, error: null };
      }
    } catch (e) {
      // 这个策略失败，继续下一个
      continue;
    }
  }

  // 全部策略失败
  const triedStrategies = chain.map(c => `${c.strategy}=${c.value}`).join(', ');
  return { found: false, value: null, strategy: null, error: `[locator] ${platform}.${section}.${elementName} 全策略失败: ${triedStrategies}` };
}

/**
 * 尝试单个策略
 */
async function _tryStrategy(win, strategy, value, execJS) {
  switch (strategy) {
    case 'css': {
      const el = await execJS(win, `
        (function() {
          var el = document.querySelector('${value.replace(/'/g, "\\'")}');
          if (el) return { found: true, text: el.textContent.trim().substring(0, 100), href: el.href || '' };
          return { found: false };
        })();
      `);
      return el && el.found ? { found: true, value: el.text || el.href } : { found: false };
    }
    case 'xpath': {
      const el = await execJS(win, `
        (function() {
          var result = document.evaluate('${value.replace(/'/g, "\\'")}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          var node = result.singleNodeValue;
          if (node) return { found: true, text: node.textContent.trim().substring(0, 100) };
          return { found: false };
        })();
      `);
      return el && el.found ? { found: true, value: el.text } : { found: false };
    }
    case 'text': {
      const el = await execJS(win, `
        (function() {
          var btns = Array.from(document.querySelectorAll('a, button, span, div[role=button]'));
          var found = btns.find(function(el) {
            var t = el.textContent.trim();
            return t === '${value.replace(/'/g, "\\'")}' || t.includes('${value.replace(/'/g, "\\'")}');
          });
          if (found) return { found: true, text: found.textContent.trim() };
          return { found: false };
        })();
      `);
      return el && el.found ? { found: true, value: el.text } : { found: false };
    }
    default:
      return { found: false };
  }
}

/**
 * 点击元素 — 多策略兜底
 * @returns {Promise<{success: boolean, strategy: string|null, error: string|null}>}
 */
async function clickElement(win, platform, section, elementName, helpers) {
  const { execJS } = helpers;
  const chain = configLoader.getSelectorChain(platform, section, elementName);

  if (!chain || chain.length === 0) {
    return { success: false, strategy: null, error: `[locator] ${platform}.${section}.${elementName} 配置中没有选择器` };
  }

  for (const { strategy, value } of chain) {
    try {
      const clicked = await _clickStrategy(win, strategy, value, execJS);
      if (clicked) {
        return { success: true, strategy, error: null };
      }
    } catch (e) {
      continue;
    }
  }

  // 全失败 → 输出页面上所有可点击元素，不当哑巴
  const pageButtons = await execJS(win, `
    Array.from(document.querySelectorAll('a, button, span[class*=btn], div[role=button]'))
      .map(function(b) { return b.textContent.trim().substring(0, 30); })
      .filter(function(t) { return t.length > 0; })
      .slice(0, 20)
      .join(' | ');
  `);

  const triedStrategies = chain.map(c => `${c.strategy}=${c.value}`).join(', ');
  const errorDetail = `[locator] ${platform}.${section}.${elementName} 全策略失败: ${triedStrategies} | 页面按钮: ${pageButtons || '(空)'}`;

  // 自动截图
  await captureScreenshot(win, `${platform}_${elementName}_click_failed`);

  return { success: false, strategy: null, error: errorDetail };
}

/**
 * 尝试单个点击策略
 */
async function _clickStrategy(win, strategy, value, execJS) {
  switch (strategy) {
    case 'css': {
      const result = await execJS(win, `
        (function() {
          var el = document.querySelector('${value.replace(/'/g, "\\'")}');
          if (!el) return false;
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.click();
          return true;
        })();
      `);
      return result === true;
    }
    case 'xpath': {
      const result = await execJS(win, `
        (function() {
          var result = document.evaluate('${value.replace(/'/g, "\\'")}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          var node = result.singleNodeValue;
          if (!node) return false;
          node.scrollIntoView({ behavior: 'instant', block: 'center' });
          node.click();
          return true;
        })();
      `);
      return result === true;
    }
    case 'text': {
      const result = await execJS(win, `
        (function() {
          var btns = Array.from(document.querySelectorAll('a, button, span, div[role=button]'));
          var found = btns.find(function(el) {
            var t = el.textContent.trim();
            return t === '${value.replace(/'/g, "\\'")}' || t.includes('${value.replace(/'/g, "\\'")}');
          });
          if (!found) return false;
          found.scrollIntoView({ behavior: 'instant', block: 'center' });
          found.click();
          return true;
        })();
      `);
      return result === true;
    }
    default:
      return false;
  }
}

// ═══════ 批量提取 — 多策略兜底 ═══════

/**
 * 从搜索页提取职位列表 — 使用配置化的选择器链
 * ★ 与旧的硬编码 EXTRACT_JS 不同，这个从配置读取选择器
 * ★ 每个元素（job_item/job_link/job_title/company/salary）都有多策略兜底
 * ★ 全失败时返回诊断信息而不是空数组（不当哑巴）
 */
async function extractJobsFromPage(win, platform, helpers) {
  const { execJS, sleep } = helpers;
  const config = configLoader.loadConfig(platform);
  if (!config) {
    return { jobs: [], diagnostic: { error: `${platform} 配置文件不存在` } };
  }

  const searchConfig = config.search || {};
  const elements = searchConfig.elements || {};

  // 构建选择器JS代码 — 从配置动态生成
  const jobItemSelectors = _buildSelectorArray(elements.job_item || []);
  const jobLinkSelectors = _buildSelectorArray(elements.job_link || []);
  const titleSelectors = _buildSelectorArray(elements.job_title || []);
  const companySelectors = _buildSelectorArray(elements.company_name || []);
  const salarySelectors = _buildSelectorArray(elements.salary || []);

  // ★ 核心：动态生成的提取JS — 配置驱动 + 三层兜底 ★
  // 策略1: 配置化选择器提取（CSS/XPath）
  // 策略2: TreeWalker兜底（遍历DOM文本节点找职位）
  // 策略3: 链接暴力收集器（不依赖任何CSS类名！直接从URL模式识别职位链接）
  const extractJS = `
new Promise(function(resolve) {
  var timeout = setTimeout(function() { resolve({jobs:[], diagnostic:{error:'提取超时20秒'}}); }, 20000);

  // 先滚动触发懒加载
  var scrollCount = 0;
  var scrollTimer = setInterval(function() {
    window.scrollBy(0, 600); scrollCount++;
    if (scrollCount >= 6) {
      clearInterval(scrollTimer);
      setTimeout(function() {
        clearTimeout(timeout);
        var jobs = [];
        var seen = {};
        var salaryRE = /\\d{1,3}[Kk][-~]\\d{1,3}[Kk]|\\d{4,6}[-~]\\d{4,6}|\\d+-\\d+[Kk万千]|\\d+元\\/|\\*{2,4}-\\*{2,4}/;

        // ═══════ 通用工具函数 ═══════
        var jobUrlPatterns = [
          /\\/job\\//i, /\\/job_detail\\//i, /\\/zhaopin\\//i,
          /\\/geek\\/job/i, /\\/position\\//i, /\\/Jobs\\//i,
          /\\/wn\\//i, /\\/search\\/jobdetail/i,
          /ka=(?:list|search)/i, /jobid=/i, /__key=/i
        ];

        function isJobUrl(href) {
          if (!href || href.includes('/login') || href.includes('/passport') || href.includes('/search') || href.includes('javascript')) return false;
          for (var i = 0; i < jobUrlPatterns.length; i++) {
            if (jobUrlPatterns[i].test(href)) return true;
          }
          return false;
        }

        function trySelectors(selectors, root) {
          for (var i = 0; i < selectors.length; i++) {
            var s = selectors[i];
            try {
              if (s.strategy === 'css') {
                var els = (root || document).querySelectorAll(s.value);
                if (els.length > 0) return els;
              } else if (s.strategy === 'xpath') {
                var iter = document.evaluate(s.value, root || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                if (iter.snapshotLength > 0) {
                  var arr = []; for (var j = 0; j < iter.snapshotLength; j++) arr.push(iter.snapshotItem(j));
                  return arr;
                }
              }
            } catch(_) {}
          }
          return null;
        }

        function trySingleSelector(selectors, root) {
          for (var i = 0; i < selectors.length; i++) {
            var s = selectors[i];
            try {
              if (s.strategy === 'css') {
                var el = (root || document).querySelector(s.value);
                if (el && el.textContent.trim().length > 0) return el.textContent.trim();
              } else if (s.strategy === 'xpath') {
                var node = document.evaluate(s.value, root || document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (node && node.textContent.trim().length > 0) return node.textContent.trim();
              }
            } catch(_) {}
          }
          return '';
        }

        function cleanJobTitle(text) {
          if (!text) return '';
          // 去除常见的非标题后缀
          return text.replace(/[\\s·•|\\n\\r]+/g, ' ').trim().substring(0, 60);
        }

        // ═══════ 策略1: 配置化选择器提取 ═══════
        var jobItemSelectors = ${JSON.stringify(jobItemSelectors)};
        var jobLinkSelectors = ${JSON.stringify(jobLinkSelectors)};
        var titleSelectors = ${JSON.stringify(titleSelectors)};
        var companySelectors = ${JSON.stringify(companySelectors)};
        var salarySelectors = ${JSON.stringify(salarySelectors)};

        var items = trySelectors(jobItemSelectors);
        if (items && items.length > 0) {
          for (var k = 0; k < items.length; k++) {
            var item = items[k];
            var linkEls = item.querySelectorAll('a[href]');
            var url = '';
            for (var li = 0; li < linkEls.length; li++) {
              var href = linkEls[li].href;
              if (href && !href.includes('/search') && !href.includes('/sou/') && !href.includes('login') && !seen[href]) {
                url = href; break;
              }
            }
            if (!url) {
              var linkItems = trySelectors(jobLinkSelectors, item);
              if (linkItems) {
                for (var lj = 0; lj < linkItems.length; lj++) {
                  var href2 = linkItems[lj].href || '';
                  if (href2 && !seen[href2]) { url = href2; break; }
                }
              }
            }
            if (!url || seen[url]) continue;
            seen[url] = true;

            var title = trySingleSelector(titleSelectors, item) || '';
            if (title.length < 3) { var linkEl = item.querySelector('a[href]'); if (linkEl) title = linkEl.textContent.trim().substring(0, 60); }
            if (title.length < 3) continue;

            var company = trySingleSelector(companySelectors, item) || '';
            var salary = trySingleSelector(salarySelectors, item) || '';
            if (!salary) { var cardText = item.textContent || ''; var salMatch = cardText.match(salaryRE); if (salMatch) salary = salMatch[0]; }
            if (!company || company.length < 2) { company = _extractCompanyFromCardText(item, cardText); }

            jobs.push({ title: cleanJobTitle(title), company: company, salary: salary, url: url, info: item.textContent.trim().substring(0, 200) });
          }
        }

        // ═══════ 策略2: 增强版TreeWalker（不再依赖薪资正则！）═══════
        // ★★★ v4.2改进：旧版只找salaryRE匹配的节点，但Boss等平台搜索列表不显示薪资 ★★★
        // 新版：找包含职位链接的DOM区域，无论是否有薪资文字
        if (jobs.length === 0) {
          try {
            // 先用链接方式快速定位所有可能的职位区域
            var allLinks = document.querySelectorAll('a[href]');
            var candidateContainers = [];

            for (var ai = 0; ai < allLinks.length; ai++) {
              var aHref = allLinks[ai].href || '';
              if (isJobUrl(aHref) && !seen[aHref]) {
                // 向上找到合适的容器（卡片/列表项/行）
                var container = allLinks[ai].closest('li, [class*="card"], [class*="item"], [class*="row"], [class*="job"], tr, [class*="list"] > *, section > *')
                            || allLinks[ai].parentElement
                            || allLinks[ai];
                if (container && container !== document && container !== document.body) {
                  candidateContainers.push({ el: container, url: aHref, linkEl: allLinks[ai] });
                  seen[aHref] = true;
                }
              }
            }

            // 从容器中提取职位信息
            for (var ci = 0; ci < candidateContainers.length; ci++) {
              var c = candidateContainers[ci];
              var cText = c.el.textContent || '';
              var cLinkText = c.linkEl ? c.linkEl.textContent.trim().substring(0, 60) : '';

              // 标题优先取链接文本（通常是职位名），其次取容器的第一个大号字体元素
              var s2title = cLinkText;
              if (s2title.length < 3) {
                // 尝试从容器内找 h1-h4, strong, b, 或第一个有意义的子元素
                var heading = c.el.querySelector('h1, h2, h3, h4, h5, [class*="title"], [class*="name"], strong, b');
                s2title = heading ? heading.textContent.trim().substring(0, 60) : c.el.querySelector('*') ? '' : '';
                if (s2title.length < 3) s2title = cText.split(/\\n/)[0].trim().substring(0, 60);
              }
              if (s2title.length < 3) continue;

              // 薪资
              var s2salMatch = cText.match(salaryRE);
              var s2salary = s2salMatch ? s2salMatch[0] : '';

              // 公司名
              var s2company = _extractCompanyFromCardText(c.el, cText);

              jobs.push({
                title: cleanJobTitle(s2title),
                company: s2company,
                salary: s2salary,
                url: c.url,
                info: cText.substring(0, 200)
              });
            }
          } catch(e2) { console.error('[TreeWalker]', e2.message); }
        }

        // ═══════ 策略3: 链接暴力收集器（终极兜底——完全不依赖DOM结构）═══════
        // 如果策略1和策略2都失败了，暴力扫描页面所有<a>标签
        // 只要href看起来像职位详情页，就当作一个职位来收集
        if (jobs.length === 0) {
          try {
            var allA = document.querySelectorAll('a[href]');
            for (var bi = 0; bi < allA.length; bi++) {
              var bHref = allA[bi].href || '';
              if (!isJobUrl(bHref) || seen[bHref]) continue;
              seen[bHref] = true;

              var bText = allA[bi].textContent.trim();

              // 过滤掉导航、footer、header等非职位链接
              if (bText.length < 2 || bText.length > 100) continue;
              if (/^首页$|^登录$|^注册$|^搜索$|^更多$|^返回$/.test(bText)) continue;

              // 尝试从周围上下文提取更多信息
              var parent = allA[bi].parentElement || allA[bi];
              var parentText = parent.textContent ? parent.textContent.trim().substring(0, 300) : '';

              jobs.push({
                title: cleanJobTitle(bText),
                company: _extractCompanyFromCardText(parent, parentText),
                salary: '',
                url: bHref,
                info: parentText
              });

              // 安全阀：最多收集50个
              if (jobs.length >= 50) break;
            }
          } catch(e3) { console.error('[BruteForce]', e3.message); }
        }

        // ═══════ 不当哑巴：返回诊断信息而不是空数组 ═══════
        if (jobs.length === 0) {
          resolve({
            jobs: [],
            diagnostic: {
              url: window.location.href,
              title: document.title,
              bodyLen: document.body ? document.body.innerText.length : 0,
              bodySnippet: document.body ? document.body.innerText.substring(0, 500) : '',
              allLinks: document.querySelectorAll('a[href]').length,
              jobLikeLinks: Array.from(document.querySelectorAll('a[href]')).filter(function(a){return isJobUrl(a.href)}).length,
              allButtons: document.querySelectorAll('a, button').length,
              mainClasses: Array.from(document.querySelectorAll('main, [class*="job"], [class*="search"], [class*="list"], [class*="result"], [class*="elist"], [class*="joblist"], [class*="card"]'))
                .map(function(el) { return el.tagName + '.' + (el.className || '').toString().substring(0, 80); })
                .filter(Boolean).join(' | '),
              sampleLinks: Array.from(document.querySelectorAll('a[href]')).slice(0, 15)
                .map(function(a) { return a.textContent.trim().substring(0,30) + ' => ' + a.href.substring(0, 80); })
                .join(' | '),
              sampleJobLinks: Array.from(document.querySelectorAll('a[href]')).filter(function(a){return isJobUrl(a.href)}).slice(0, 10)
                .map(function(a) { return a.textContent.trim().substring(0,40) + ' => ' + a.href.substring(0, 80); })
                .join(' | ')
            }
          });
        } else {
          resolve({ jobs: jobs, diagnostic: null });
        }
      }, 3000);
    }
  }, 800);
});
`;

  const result = await execJS(win, extractJS);

  if (!result) {
    return { jobs: [], diagnostic: { error: 'execJS返回null（窗口可能崩溃）' } };
  }

  // 返回格式可能是 { jobs: [...], diagnostic: {...} } 或直接数组（旧格式兼容）
  if (Array.isArray(result)) {
    return { jobs: result, diagnostic: null };
  }

  if (result.jobs) {
    return { jobs: result.jobs, diagnostic: result.diagnostic };
  }

  // 兜底：可能是 _empty 对象（旧格式）
  if (result._empty) {
    return {
      jobs: [],
      diagnostic: {
        url: result.url || '',
        title: result.title || '',
        bodyLen: result.bodyLen || 0,
        snippet: result.snippet || '',
        error: '旧格式_empty对象'
      }
    };
  }

  return { jobs: [], diagnostic: { error: `未知返回格式: ${typeof result}` } };
}

// ═══════ 截图诊断 ═══════

async function captureScreenshot(win, label) {
  try {
    if (!win || win.isDestroyed()) return null;
    const img = await win.webContents.capturePage();
    if (!img || img.isEmpty()) return null;
    const filename = `${label}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(filepath, img.toPNG());
    return filepath;
  } catch (_) {
    return null;
  }
}

/**
 * 完整的页面诊断 — 失败时输出具体问题
 */
async function diagnosePage(win, platform, helpers, context) {
  const { execJS } = helpers;
  const screenshotPath = await captureScreenshot(win, `${platform}_${context}_diag`);

  const diag = await execJS(win, `
    (function() {
      return JSON.stringify({
        url: window.location.href,
        title: document.title,
        bodyLen: document.body ? document.body.innerText.length : 0,
        bodySnippet: document.body ? document.body.innerText.substring(0, 500) : '',
        allLinks: document.querySelectorAll('a[href]').length,
        allButtons: document.querySelectorAll('a, button').length,
        verifyDetected: ${JSON.stringify(configLoader.getVerifyIndicators(platform).textPatterns)}
          .some(function(p) { return document.body && document.body.innerText.includes(p); }),
        captchaDetected: document.querySelector('.geetest, [class*="captcha"], [class*="verify"], .slider-captcha, .nc_wrapper') !== null,
        mainDOM: Array.from(document.querySelectorAll('main, [class*="job"], [class*="search"], [class*="list"], [class*="result"], [class*="elist"], [class*="joblist"], [class*="position"]'))
          .map(function(el) { return el.tagName + '.' + (el.className || '').toString().substring(0, 100); })
          .filter(Boolean).slice(0, 15).join(' | ')
      });
    })();
  `);

  let diagData = {};
  try { diagData = JSON.parse(diag || '{}'); } catch(_) {}

  return {
    screenshot: screenshotPath,
    ...diagData,
    platform,
    context
  };
}

// ═══════ 辅助函数 ═══════

function _buildSelectorArray(def) {
  if (!def) return [];
  if (typeof def === 'string') return [{ strategy: 'css', value: def }];
  if (Array.isArray(def)) return def;
  if (typeof def === 'object') {
    const result = [];
    const priority = ['css', 'xpath', 'text'];
    for (const p of priority) {
      if (def[p]) result.push({ strategy: p, value: def[p] });
    }
    return result;
  }
  return [];
}

/**
 * ★★★ 智能公司名提取（选择器全失败时的终极兜底）★★★★★
 * 
 * 从职位卡片的文字内容中启发式提取公司名。
 * BOSS等平台的卡片结构通常是：[职位标题] [薪资] [地点] [经验/学历] [公司名]
 * 
 * 策略：
 * 1. 检查卡片内所有<a>标签的href是否包含 /gongsi/ 或 /company/ → 取其文本
 * 2. 从卡片子元素中找包含"有限公司"、"集团"等关键词的元素
 * 3. 用正则从完整卡片文字中匹配公司特征词
 */
function _extractCompanyFromCardText(item, cardText) {
  // Strategy 1: 卡片内链接中找公司相关 href
  const links = item.querySelectorAll('a[href]');
  for (let i = 0; i < links.length; i++) {
    const href = links[i].getAttribute('href') || '';
    const text = links[i].textContent.trim();
    if ((href.includes('/gongsi/') || href.includes('/company/') || href.includes('/com/')) && text.length >= 2 && text.length <= 50) {
      return text;
    }
  }

  // Strategy 2: 找包含公司特征关键词的子元素
  const companyKeywords = ['有限公司', '股份有限', '集团', '科技', '网络', '信息', '教育', '咨询', '金融', '投资', '贸易', '实业', '发展'];
  const children = item.querySelectorAll('*');
  let bestCandidate = '';
  let bestScore = 0;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const text = el.textContent.trim();
    if (text.length < 2 || text.length > 60) continue;
    // 跳过明显的非公司名字段
    const tag = el.tagName.toLowerCase();
    if (tag === 'span' && (el.className.includes('salary') || el.className.includes('money'))) continue;

    // 计算匹配度
    let score = 0;
    for (const kw of companyKeywords) {
      if (text.includes(kw)) { score += 3; break; }
    }
    // 额外：短文本（2-10字符）更可能是公司名
    if (text.length >= 2 && text.length <= 15) score += 1;
    // 不包含薪资格式的加分
    if (!salaryRE.test(text)) score += 1;

    if (score > bestScore) { bestScore = score; bestCandidate = text; }
  }
  if (bestScore >= 2) return bestCandidate;

  // Strategy 3: 正则匹配 — 在完整卡片文字中找 "xxx有限公司" 模式
  if (cardText) {
    // 匹配 "xxx有限公司" 或 "xxx集团" 等模式
    const companyRE = /([^\s\n\r·•|，,]{2,20}(?:有限(?:责任)?公司|股份(?:有限)?公司|集团|合伙企业|事务所))/g;
    const matches = cardText.match(companyRE);
    if (matches && matches.length > 0) return matches[0];
  }

  return ''; // 全部失败，返回空字符串
}

module.exports = {
  locateElement,
  clickElement,
  extractJobsFromPage,
  captureScreenshot,
  diagnosePage,
  SCREENSHOT_DIR
};
