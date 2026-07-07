/**
 * diagnostic.js — 自动诊断引擎
 *
 * ★★★ 核心原则：问题出现一次就建检测，再出现就自动定位，不用用户反复测试 ★★★
 *
 * 每次投递完成后，自动检查管道各阶段的健康指标，
 * 发现已知问题模式就自动标记根因和建议修复方案。
 *
 * 管道阶段：search → enrich → dedup → keyword_match → blacklist → apply
 * 每个阶段都有 before/after 计数，任一阶段出现异常衰减就自动报告。
 */

// ═══════ 已知问题模式库 ═══════
// 每个模式：症状 → 根因 → 建议修复
// 当诊断引擎检测到症状时，自动匹配模式并给出根因说明
const KNOWN_PROBLEMS = [
  {
    id: 'DEDUPER_KILLING_ALL',
    name: '去重器把职位全消掉',
    symptoms: (stats) => {
      // 症状：某平台 dedup 后 0 个，但 search 有职位
      const hits = [];
      for (const p of Object.keys(stats.searchCount)) {
        const before = stats.dedupBefore[p] || 0;
        const after = stats.dedupAfter[p] || 0;
        if (before > 0 && after === 0) {
          hits.push({ platform: p, before, after });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: '公司名为空时，normalizeKey变成"|会计"，Jaccard相似度让少量职位标题共享字符被互相消掉',
    suggestion: 'deduper.js已修复：公司名为空→用URL去重+精确标题匹配，不再用Jaccard模糊匹配。如果再次出现，检查是否有新平台也出现空公司名问题',
    severity: 'CRITICAL'
  },
  {
    id: 'DEDUPER_KILLING_MOST',
    name: '去重器消掉大量职位（>80%衰减）',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.dedupBefore)) {
        const before = stats.dedupBefore[p] || 0;
        const after = stats.dedupAfter[p] || 0;
        if (before > 5 && after > 0 && (after / before) < 0.2) {
          hits.push({ platform: p, before, after, ratio: (after / before).toFixed(2) });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: '去重阈值0.75太宽松，或同一公司大量相似岗位被误判为重复',
    suggestion: '检查该平台的职位数据——同一公司是否发了大量相同岗位？如果不是，可能需要提高去重阈值或改进normalizeKey逻辑',
    severity: 'WARNING'
  },
  {
    id: 'SEARCH_RETURNING_ZERO',
    name: '某平台搜索返回0个职位',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.searchCount)) {
        if (stats.searchCount[p] === 0) {
          hits.push({ platform: p });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: '平台登录过期/被拦截/搜索页结构变化/搜索URL参数错误',
    suggestion: '1)检查该平台是否需要重新登录 2)检查搜索URL是否正确 3)检查EXTRACT_JS是否还能提取职位卡片',
    severity: 'CRITICAL'
  },
  {
    id: 'KEYWORD_MATCH_TOO_STRICT',
    name: '关键词匹配过滤掉所有职位',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.keywordBefore)) {
        const before = stats.keywordBefore[p] || 0;
        const after = stats.keywordAfter[p] || 0;
        if (before > 0 && after === 0) {
          hits.push({ platform: p, before, after });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: '关键词匹配阈值太高，或关键词与平台实际职位标题不匹配',
    suggestion: '1)降低match_threshold（当前默认60%） 2)检查关键词是否拼写正确 3)查看被过滤掉的职位标题是否真的不相关',
    severity: 'CRITICAL'
  },
  {
    id: 'EMPTY_COMPANY_HIGH_RATIO',
    name: '某平台大量职位公司名为空',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.emptyCompanyRatio)) {
        const ratio = stats.emptyCompanyRatio[p];
        if (ratio > 0.5) { // 超过50%的职位公司名为空
          hits.push({ platform: p, ratio: ratio.toFixed(2), total: stats.searchCount[p] });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: 'EXTRACT_JS没有正确提取公司名，或该平台搜索结果卡片没有公司名字段',
    suggestion: '检查该平台的EXTRACT_JS——是否正确提取了公司名DOM节点？可能需要更新选择器',
    severity: 'WARNING'
  },
  {
    id: 'EMPTY_URL_HIGH_RATIO',
    name: '某平台大量职位URL为空',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.emptyUrlRatio)) {
        const ratio = stats.emptyUrlRatio[p];
        if (ratio > 0.3) { // 超过30%的职位URL为空
          hits.push({ platform: p, ratio: ratio.toFixed(2), total: stats.searchCount[p] });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: 'EXTRACT_JS没有正确提取职位详情链接',
    suggestion: '检查该平台的EXTRACT_JS——是否正确提取了职位URL？注意URL可能是相对路径需要拼接',
    severity: 'CRITICAL'
  },
  {
    id: 'EMPTY_SALARY_HIGH_RATIO',
    name: '某平台大量职位薪资为空',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.emptySalaryRatio)) {
        const ratio = stats.emptySalaryRatio[p];
        if (ratio > 0.8) { // 超过80%的职位薪资为空
          hits.push({ platform: p, ratio: ratio.toFixed(2), total: stats.searchCount[p] });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: 'EXTRACT_JS没有正确提取薪资信息，或该平台搜索页不显示薪资',
    suggestion: '检查该平台的EXTRACT_JS——薪资选择器是否正确？部分平台需要在详情页才能看到薪资',
    severity: 'INFO'
  },
  {
    id: 'APPLY_ALL_FAILED',
    name: '某平台所有投递都失败',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.applyStats)) {
        const s = stats.applyStats[p];
        if (s.total > 0 && s.success === 0 && s.failed > 0) {
          const topReason = s.topFailReason || 'unknown';
          hits.push({ platform: p, total: s.total, failed: s.failed, topReason });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: '投递按钮选择器失效/弹窗拦截/登录过期/需要重新授权',
    suggestion: '1)检查该平台apply函数的按钮选择器 2)查看fail_reason——如果全是verify_timeout说明需要重新登录 3)如果是captcha说明被反爬拦截',
    severity: 'CRITICAL'
  },
  {
    id: 'APPLY_MOST_SKIPPED',
    name: '某平台大量投递被跳过',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.applyStats)) {
        const s = stats.applyStats[p];
        if (s.total > 3 && s.skipped > s.total * 0.5) {
          const topReason = s.topSkipReason || 'unknown';
          hits.push({ platform: p, total: s.total, skipped: s.skipped, topReason });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: '验证码/验证页拦截频繁出现',
    suggestion: '1)如果是verify_timeout：需要重新登录该平台 2)如果是captcha_not_solved：该平台反爬加强，需要降低投递频率',
    severity: 'WARNING'
  },
  {
    id: 'TITLE_TOO_LONG_MANY',
    name: '某平台大量职位标题超长（全卡片文字误抓）',
    symptoms: (stats) => {
      const hits = [];
      for (const p of Object.keys(stats.longTitleRatio)) {
        const ratio = stats.longTitleRatio[p];
        if (ratio > 0.3) {
          hits.push({ platform: p, ratio: ratio.toFixed(2), total: stats.searchCount[p] });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: 'EXTRACT_JS的职位标题选择器抓到了整个卡片文字而非标题节点',
    suggestion: '检查该平台EXTRACT_JS的title选择器——可能选了太宽的容器，应该选更精确的标题节点',
    severity: 'WARNING'
  },
  {
    id: 'PIPELINE_TOTAL_COLLAPSE',
    name: '管道总衰减>95%（搜索了很多但最终0个可投）',
    symptoms: (stats) => {
      const totalSearch = Object.values(stats.searchCount).reduce((a, b) => a + b, 0);
      const totalFinal = Object.values(stats.keywordAfter).reduce((a, b) => a + b, 0);
      if (totalSearch > 10 && totalFinal === 0) {
        return { totalSearch, totalFinal };
      }
      return null;
    },
    rootCause: '多个过滤环节叠加导致职位全被消掉——通常是deduper + keyword_match双重杀伤',
    suggestion: '逐层回查：哪一层把职位消得最多？先修杀伤最大的那一层',
    severity: 'CRITICAL'
  },
  {
    id: 'PLATFORM_OVERCHECK_LOGIN',
    name: '某平台主动触发登录检测破坏session',
    symptoms: (stats) => {
      // 症状：某平台搜索返回0，且 diagnostic log 中该平台之前有过 "need_login" 记录
      // 或者：某平台搜索0结果，但其他使用类似策略的平台（如猎聘）搜索正常
      // 这是一个启发式检测——如果某平台搜索0结果且猎聘正常，可能就是过度检测问题
      const hits = [];
      const liepinCount = stats.searchCount['liepin'] || 0;
      for (const p of Object.keys(stats.searchCount)) {
        if (p === 'liepin') continue; // 猎聘不比较自己
        const pCount = stats.searchCount[p];
        // 如果某平台搜索0但猎聘有很多结果 → 该平台可能被过度检测/拦截破坏了
        if (pCount === 0 && liepinCount > 10) {
          hits.push({ platform: p, liepinCount, platformCount: pCount });
        }
        // 如果某平台搜索结果远少于猎聘（<猎聘的10%） → 也可能是过度检测
        if (pCount > 0 && liepinCount > 10 && pCount < liepinCount * 0.1) {
          hits.push({ platform: p, liepinCount, platformCount: pCount, ratio: (pCount / liepinCount).toFixed(2) });
        }
      }
      return hits.length > 0 ? hits : null;
    },
    rootCause: '平台search函数可能做了过度激进的登录检测（如主动访问用户中心验证登录），反而破坏了本来正常的session，导致搜索返回0或很少结果',
    suggestion: '检查该平台的search函数——是否做了多余的导航（如访问i.zhaopin.com验证登录）？改成简洁策略：首页→直接搜索→遇到登录墙才被动处理，不做主动检测',
    severity: 'CRITICAL'
  }
];

// ═══════ 运行诊断 ═══════

/**
 * 运行诊断检查
 * @param {Object} stats - 管道各阶段的统计数据
 * @returns {Object} diagnosticReport - 诊断报告
 */
function run(stats) {
  const findings = [];
  const timestamp = new Date().toISOString();

  for (const pattern of KNOWN_PROBLEMS) {
    const symptomData = pattern.symptoms(stats);
    if (symptomData) {
      findings.push({
        id: pattern.id,
        name: pattern.name,
        severity: pattern.severity,
        rootCause: pattern.rootCause,
        suggestion: pattern.suggestion,
        details: symptomData,
        timestamp
      });
    }
  }

  // 生成管道衰减摘要
  const pipelineSummary = generatePipelineSummary(stats);

  return {
    findings,
    pipelineSummary,
    timestamp,
    healthy: findings.filter(f => f.severity === 'CRITICAL').length === 0
  };
}

/**
 * 生成管道衰减摘要——每个平台的完整管道流程
 * 格式: BOSS: 84 → enrich(80) → dedup(37) → keyword(30) → blacklist(28) → apply(25✅/2❌/1⏭)
 */
function generatePipelineSummary(stats) {
  const lines = [];
  for (const p of Object.keys(stats.searchCount)) {
    const search = stats.searchCount[p] || 0;
    const dedupBefore = stats.dedupBefore[p] || 0;
    const dedupAfter = stats.dedupAfter[p] || 0;
    const kwBefore = stats.keywordBefore[p] || 0;
    const kwAfter = stats.keywordAfter[p] || 0;
    const blBefore = stats.blacklistBefore[p] || 0;
    const blAfter = stats.blacklistAfter[p] || 0;

    // 找到衰减最大的阶段
    const stages = [
      { name: 'search', count: search },
      { name: 'dedup', count: dedupAfter, prev: dedupBefore, loss: dedupBefore - dedupAfter },
      { name: 'keyword', count: kwAfter, prev: kwBefore, loss: kwBefore - kwAfter },
      { name: 'blacklist', count: blAfter, prev: blBefore, loss: blBefore - blAfter }
    ];

    // 找最大衰减
    let maxLossStage = '';
    let maxLossPct = 0;
    for (const s of stages) {
      if (s.prev && s.prev > 0 && s.loss > 0) {
        const pct = (s.loss / s.prev * 100);
        if (pct > maxLossPct) {
          maxLossPct = pct;
          maxLossStage = s.name;
        }
      }
    }

    // apply 统计
    const apply = stats.applyStats[p] || { success: 0, failed: 0, skipped: 0, total: 0 };

    let pipelineStr = `${p}: ${search}`;
    if (dedupBefore !== search) pipelineStr += ` → enrich(${dedupBefore})`;
    pipelineStr += ` → dedup(${dedupAfter})`;
    if (dedupBefore > 0 && dedupAfter < dedupBefore) {
      const pct = ((dedupBefore - dedupAfter) / dedupBefore * 100).toFixed(0);
      pipelineStr += ` ⚠-${pct}%`;
    }
    pipelineStr += ` → keyword(${kwAfter})`;
    if (kwBefore > 0 && kwAfter < kwBefore) {
      const pct = ((kwBefore - kwAfter) / kwBefore * 100).toFixed(0);
      pipelineStr += ` ⚠-${pct}%`;
    }
    pipelineStr += ` → blacklist(${blAfter})`;
    pipelineStr += ` → apply(${apply.success}✅/${apply.failed}❌/${apply.skipped}⏭)`;

    if (maxLossStage) {
      pipelineStr += ` | 最大衰减: ${maxLossStage} -${maxLossPct.toFixed(0)}%`;
    }

    lines.push(pipelineStr);
  }
  return lines;
}

/**
 * 生成人类可读的诊断报告
 */
function formatReport(report) {
  if (report.healthy && report.findings.length === 0) {
    return '✅ 管道健康，无异常';
  }

  let text = '\n════════ 自动诊断报告 ═══════\n';
  text += `时间: ${report.timestamp}\n`;
  text += `健康状态: ${report.healthy ? '✅ 健康' : '❌ 有问题'}\n\n`;

  // 管道衰减摘要
  text += '── 管道衰减摘要 ──\n';
  for (const line of report.pipelineSummary) {
    text += line + '\n';
  }
  text += '\n';

  // 问题列表
  if (report.findings.length > 0) {
    text += '── 发现的问题 ──\n';
    // 按严重程度排序：CRITICAL > WARNING > INFO
    const sorted = [...report.findings].sort((a, b) => {
      const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
      return (order[a.severity] || 2) - (order[b.severity] || 2);
    });

    for (const f of sorted) {
      const icon = f.severity === 'CRITICAL' ? '🔴' : f.severity === 'WARNING' ? '🟡' : '🟢';
      text += `${icon} [${f.severity}] ${f.name}\n`;
      text += `   根因: ${f.rootCause}\n`;
      text += `   建议: ${f.suggestion}\n`;
      text += `   详情: ${JSON.stringify(f.details)}\n\n`;
    }
  }

  text += '════════════════════════════\n';
  return text;
}

// ═══════ 管道数据采集器 ═══════
// 在 engine.js 的各阶段调用，逐步采集数据

function createStatsCollector() {
  const stats = {
    searchCount: {},       // 各平台搜索到的职位数
    enrichStats: {},       // enrich后的统计（空公司名/空URL/空薪资比例）
    dedupBefore: {},       // 去重前数量
    dedupAfter: {},        // 去重后数量
    keywordBefore: {},     // 关键词匹配前
    keywordAfter: {},      // 关键词匹配后
    blacklistBefore: {},   // 黑名单过滤前
    blacklistAfter: {},    // 黑名单过滤后
    emptyCompanyRatio: {}, // 各平台空公司名比例
    emptyUrlRatio: {},     // 各平台空URL比例
    emptySalaryRatio: {},  // 各平台空薪资比例
    longTitleRatio: {},    // 各平台标题>80字符的比例
    applyStats: {},        // 各平台投递统计
    totalSearchTime: 0,    // 搜索总耗时
  };

  return {
    stats,

    /** 搜索阶段：记录各平台搜索到的职位数和enrich后的空字段比例 */
    recordSearch(platform, rawJobs, enrichedJobs) {
      stats.searchCount[platform] = enrichedJobs.length;

      // 计算空字段比例
      let emptyCompany = 0, emptyUrl = 0, emptySalary = 0, longTitle = 0;
      for (const j of enrichedJobs) {
        if (!j.company || j.company.length < 2) emptyCompany++;
        if (!j.url || j.url.length < 20) emptyUrl++;
        if (!j.salary || j.salary.length < 2) emptySalary++;
        if (j.title && j.title.length > 80) longTitle++;
      }
      const total = enrichedJobs.length || 1;
      stats.emptyCompanyRatio[platform] = emptyCompany / total;
      stats.emptyUrlRatio[platform] = emptyUrl / total;
      stats.emptySalaryRatio[platform] = emptySalary / total;
      stats.longTitleRatio[platform] = longTitle / total;
    },

    /** 去重阶段 */
    recordDedup(platform, beforeCount, afterCount) {
      stats.dedupBefore[platform] = beforeCount;
      stats.dedupAfter[platform] = afterCount;
    },

    /** 关键词匹配阶段 */
    recordKeyword(platform, beforeCount, afterCount) {
      stats.keywordBefore[platform] = beforeCount;
      stats.keywordAfter[platform] = afterCount;
    },

    /** 黑名单阶段 */
    recordBlacklist(platform, beforeCount, afterCount) {
      stats.blacklistBefore[platform] = beforeCount;
      stats.blacklistAfter[platform] = afterCount;
    },

    /** 投递阶段 */
    recordApply(platform, success, failed, skipped, failReasons, skipReasons) {
      // 找最频繁的失败/跳过原因
      const failCounts = {};
      for (const r of (failReasons || [])) failCounts[r] = (failCounts[r] || 0) + 1;
      const skipCounts = {};
      for (const r of (skipReasons || [])) skipCounts[r] = (skipCounts[r] || 0) + 1;

      const topFail = Object.entries(failCounts).sort((a, b) => b[1] - a[1])[0];
      const topSkip = Object.entries(skipCounts).sort((a, b) => b[1] - a[1])[0];

      stats.applyStats[platform] = {
        success, failed, skipped,
        total: success + failed + skipped,
        topFailReason: topFail ? topFail[0] : '',
        topSkipReason: topSkip ? topSkip[0] : '',
        failReasons: failCounts,
        skipReasons: skipCounts
      };
    }
  };
}

module.exports = {
  run,
  formatReport,
  createStatsCollector,
  KNOWN_PROBLEMS
};
