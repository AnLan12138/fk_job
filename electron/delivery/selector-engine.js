/**
 * selector-engine.js — 多策略元素定位引擎
 *
 * 职责：读 config/xxx.json 的选择器链，逐个策略尝试，失败返回详细诊断。
 * 纯函数设计：不依赖外部状态，便于独立测试。
 *
 * 策略（按优先级）：css / xpath / text / role
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_DIR = path.join(__dirname, 'platforms');
const SCREENSHOT_DIR = path.join(app.getPath('userData'), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch (_) {}
}

// ═══════ 配置缓存 ═══════
const _cache = {};
function loadConfig(platform) {
  if (_cache[platform]) return _cache[platform];
  const filePath = path.join(CONFIG_DIR, `${platform}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    _cache[platform] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return _cache[platform];
  } catch (_) {
    return null;
  }
}

// ═══════ 核心：定位单个元素 ═══════
async function locate(win, platform, section, name, timeoutMs = 8000) {
  const config = loadConfig(platform);
  if (!config) return { ok: false, reason: `config 不存在: ${platform}` };

  const chain = _buildChain(config, section, name);
  if (chain.length === 0) {
    return { ok: false, reason: `选择器链为空: ${platform}.${section}.${name}` };
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const step of chain) {
      const found = await _tryStrategy(win, step);
      if (found) return { ok: true, el: found.el, strategy: step.strategy, text: found.text };
      lastError = `${step.strategy}=${step.value}`;
    }
    await _sleep(500);
  }

  return { ok: false, reason: `全策略失败: ${lastError}`, chain };
}

// ═══════ 核心：等待任意一个配置中的选择器出现 ═══════
async function waitAny(win, platform, section, names, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const name of names) {
      const r = await locate(win, platform, section, name, 500);
      if (r.ok) return { ok: true, name, ...r };
    }
    await _sleep(400);
  }
  return { ok: false, reason: `超时未出现: ${names.join(',')}` };
}

// ═══════ 核心：提取列表 ═══════
async function extractList(win, platform, listName, itemFields) {
  const config = loadConfig(platform);
  if (!config) return { ok: false, reason: 'config 不存在' };

  const listChain = _buildChain(config, 'search', listName);
  if (listChain.length === 0) return { ok: false, reason: `列表选择器未配置: ${listName}` };

  // 取第一个匹配的列表选择器
  let listSelector = null;
  for (const step of listChain) {
    if (step.strategy === 'css') { listSelector = step.value; break; }
  }
  if (!listSelector) listSelector = listChain[0].value;

  const result = await _execJS(win, `
    (function() {
      var items = document.querySelectorAll('${listSelector.replace(/'/g, "\\'")}');
      var out = [];
      items.forEach(function(el) {
        out.push({ _html: el.outerHTML.substring(0, 500), _text: (el.textContent || '').trim().substring(0, 300) });
      });
      return JSON.stringify(out);
    })();
  `);

  try {
    const list = JSON.parse(result || '[]');
    return { ok: true, count: list.length, items: list };
  } catch (e) {
    return { ok: false, reason: '列表解析失败' };
  }
}

// ═══════ 策略执行 ═══════
async function _tryStrategy(win, step) {
  if (!win || win.isDestroyed()) return null;

  switch (step.strategy) {
    case 'css': {
      const r = await _execJS(win, `
        (function() {
          var el = document.querySelector('${(step.value || '').replace(/'/g, "\\'")}');
          if (!el) return null;
          var rect = el.getBoundingClientRect();
          return { found: true, text: (el.textContent || '').trim().substring(0, 200),
                   x: rect.x + rect.width/2, y: rect.y + rect.height/2, href: el.href || '' };
        })();
      `);
      return r && r.found ? { el: r, text: r.text } : null;
    }
    case 'text': {
      const r = await _execJS(win, `
        (function() {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          var node;
          while (node = walker.nextNode()) {
            if ((node.textContent || '').trim().includes('${(step.value || '').replace(/'/g, "\\'")}')) {
              var el = node.parentElement;
              var rect = el.getBoundingClientRect();
              return { found: true, text: el.textContent.trim().substring(0, 200), x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            }
          }
          return null;
        })();
      `);
      return r && r.found ? { el: r, text: r.text } : null;
    }
    case 'xpath': {
      const r = await _execJS(win, `
        (function() {
          var result = document.evaluate('${(step.value || '').replace(/'/g, "\\'")}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          var el = result.singleNodeValue;
          if (!el) return null;
          var rect = el.getBoundingClientRect();
          return { found: true, text: (el.textContent || '').trim().substring(0, 200), x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
        })();
      `);
      return r && r.found ? { el: r, text: r.text } : null;
    }
    default:
      return null;
  }
}

// ═══════ 选择器链构建 ═══════
function _buildChain(config, section, name) {
  const sec = config[section];
  if (!sec) return {};
  const elements = sec.elements || {};
  const def = elements[name];
  if (!def) return [];

  // 数组格式：已经是链
  if (Array.isArray(def)) return def;

  // 字符串格式：单个 CSS
  if (typeof def === 'string') return [{ strategy: 'css', value: def }];

  // 对象格式：按优先级展开
  if (typeof def === 'object') {
    const chain = [];
    for (const p of ['css', 'xpath', 'text', 'role']) {
      if (def[p]) chain.push({ strategy: p, value: def[p] });
    }
    return chain;
  }
  return [];
}

// ═══════ 工具 ═══════
async function execJS(win, code, timeoutMs = 8000) {
  if (!win || win.isDestroyed()) return null;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error('execJS timeout')), timeoutMs))
    ]);
  } catch (e) {
    return null;
  }
}

function _execJS(win, code) { return execJS(win, code); }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(win, tag) {
  if (!win || win.isDestroyed()) return null;
  try {
    const img = await win.webContents.capturePage();
    const file = path.join(SCREENSHOT_DIR, `${tag}_${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch (_) { return null; }
}

module.exports = {
  locate, waitAny, extractList, execJS, screenshot, loadConfig,
  _clearCache: () => { for (const k in _cache) delete _cache[k]; }
};
