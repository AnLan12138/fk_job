/**
 * Deduplicate jobs across platforms — v3 (容错增强版)
 * 
 * ★★★ v3 核心改进：公司名提取失败时不过度去重 ★★★
 * 
 * 问题背景：
 * - Boss等平台可能所有职位公司名为空（EXTRACT_JS选择器失效）
 * - 此时旧版用精确标题匹配去重，会把"会计"和"会计助理"以外的相同标题消掉
 * - 但如果平台返回了重复的推广位（同一URL出现两次），应该被正确去重
 *
 * 新版逻辑：
 * 1. 有公司名 → 用原有的 company+title Jaccard 相似度去重（正常逻辑）
 * 2. 公司名为空但有URL → 用URL去重（天然唯一标识），不按标题消
 * 3. 公司名为空无URL → 只做完全相同的标题+info组合去重（极严格，避免误杀）
 */
function deduplicate(jobs, filter) {
  const seen = new Map();   // 有公司名的职位：key=normalizeKey, value=job
  const seenUrl = new Map(); // 无公司名的职位：key=URL, value=job（URL唯一，精确去重）
  const result = [];

  for (const job of jobs) {
    const hasCompany = job.company && clean(job.company).length > 1;
    
    if (hasCompany) {
      // ★ 有公司名 → 用原有的 company+title 模糊去重
      const key = normalizeKey(job.company, job.title);
      let isDuplicate = false;
      for (const [existingKey] of seen) {
        if (similarity(key, existingKey) > 0.75) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) {
        seen.set(key, job);
        result.push(job);
      }
    } else {
      // ★★★ 无公司名 → 只用URL去重（不过度按标题消）★★★
      // 原因：公司名为空通常是EXTRACT_JS选择器问题（临时性），不应该因此丢失大量职位
      // URL天然是每个职位的唯一标识符，不会误消
      
      const url = job.url || '';
      
      if (url && url.length > 20) {
        if (!seenUrl.has(url)) {
          seenUrl.set(url, job);
          result.push(job); // ★ 直接加入结果集，不做标题匹配去重
        }
        // URL已存在 → 同一职位被提取了两次（如推广位重复）→ 正确跳过
      } else {
        // 极端情况：无URL无公司名 → 用 title+salary 组合做精确匹配（最宽容）
        const fallbackKey = clean(job.title) + '|' + (job.salary || '');
        let dup = false;
        for (const [existingKey] of seenUrl) {
          // seenUrl的value是job对象，检查是否完全相同
          const existingJob = seenUrl.get(existingKey);
          if (existingJob && existingJob.title === job.title && existingJob.salary === job.salary) {
            dup = true;
            break;
          }
        }
        if (!dup) { seenUrl.set(fallbackKey || ('_' + result.length), job); result.push(job); }
      }
    }
  }

  return result;
}

function normalizeKey(company, title) {
  return `${clean(company)}|${clean(title)}`;
}

function clean(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/[（）\(\)【】\[\]（）]/g, '')
    .replace(/[\s\-_]+/g, '')
    .replace(/有限公司|股份有限|有限责任公司|集团/g, '')
    .trim();
}

function similarity(a, b) {
  if (a === b) return 1;
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

module.exports = { deduplicate };
