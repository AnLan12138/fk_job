/**
 * configLoader.js — YAML配置加载器
 *
 * ★ 核心原则：所有选择器、URL模板、验证特征都从配置文件读取
 *   网站改版时只需改配置文件，不改源码
 *
 * 配置格式：JSON（不用YAML避免额外依赖）
 * 配置目录：electron/worker/config/
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, 'config');

// ═══════ 配置缓存 + 文件修改时间追踪 ═══════
const configCache = {};
const configMtime = {};

function loadConfig(platform) {
  const filePath = path.join(CONFIG_DIR, `${platform}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`[configLoader] 配置文件不存在: ${filePath}`);
    return null;
  }

  // ★ Bug#5修复：检测文件修改时间，缓存过期自动刷新
  try {
    const stat = fs.statSync(filePath);
    const currentMtime = stat.mtimeMs;
    if (configCache[platform] && configMtime[platform] === currentMtime) {
      return configCache[platform];
    }
    // 文件有变动或首次加载 → 重新读取
    const raw = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);
    configCache[platform] = config;
    configMtime[platform] = currentMtime;
    return config;
  } catch (e) {
    console.error(`[configLoader] 配置解析失败: ${filePath} — ${e.message}`);
    return null;
  }
}

/** 清除缓存（配置文件更新后调用） */
function clearCache() {
  for (const k in configCache) delete configCache[k];
  for (const k in configMtime) delete configMtime[k];
}

/**
 * 从配置中获取选择器链（多策略兜底）
 * 返回格式: [{ strategy: 'css', value: '.job-card-wrapper' }, { strategy: 'text', value: '立即沟通' }, ...]
 */
function getSelectorChain(platform, section, elementName) {
  const config = loadConfig(platform);
  if (!config) return [];

  const sectionConfig = config[section];
  if (!sectionConfig) return [];

  const elements = sectionConfig.elements || {};
  const elementDef = elements[elementName];

  if (!elementDef) return [];

  // 单字符串 → [{ strategy: 'css', value: str }]
  if (typeof elementDef === 'string') {
    return [{ strategy: 'css', value: elementDef }];
  }

  // 对象格式 → 按优先级排列
  // { css: '.job-card-wrapper', text: '立即沟通', xpath: '//div[@class="job"]' }
  if (typeof elementDef === 'object' && !Array.isArray(elementDef)) {
    const chain = [];
    const priority = ['css', 'xpath', 'text', 'role'];
    for (const p of priority) {
      if (elementDef[p]) {
        chain.push({ strategy: p, value: elementDef[p] });
      }
    }
    return chain;
  }

  // 数组格式 → 已经是选择器链
  if (Array.isArray(elementDef)) {
    return elementDef;
  }

  return [];
}

/**
 * 获取验证检测特征列表
 */
function getVerifyIndicators(platform) {
  const config = loadConfig(platform);
  if (!config) return { urlPatterns: [], selectors: [], textPatterns: [] };

  const verify = config.verify || {};
  return {
    urlPatterns: verify.urlPatterns || [],
    selectors: verify.selectors || [],
    textPatterns: verify.textPatterns || []
  };
}

/**
 * 获取搜索URL模板
 */
function getSearchUrlTemplate(platform) {
  const config = loadConfig(platform);
  if (!config) return null;
  return config.search?.urlTemplate || null;
}

/**
 * 获取投递成功判定特征
 */
function getSuccessIndicators(platform) {
  const config = loadConfig(platform);
  if (!config) return [];
  return config.apply?.successIndicators || [];
}

/**
 * 获取投递频率限制配置
 */
function getRateLimit(platform) {
  const config = loadConfig(platform);
  if (!config) return { maxPerDay: 50, delayMin: 3, delayMax: 6 };
  return config.rateLimit || { maxPerDay: 50, delayMin: 3, delayMax: 6 };
}

module.exports = { loadConfig, clearCache, getSelectorChain, getVerifyIndicators, getSearchUrlTemplate, getSuccessIndicators, getRateLimit };
