// ═══════════════════════════════════════════════════════════════════
// 求职助手 — 前端逻辑（左侧导航版 + 黑白双主题）
// ═══════════════════════════════════════════════════════════════════

// ── State ──
let resumeData = {
  name: '', phone: '', email: '', city: '',
  salary_min: 0, salary_max: 0,
  education: [], work_history: [], skills: []
};
let filterData = {
  keywords: [], cities: [], salary_min: 0, salary_max: 0,
  experience: '', education: '', job_type: '', company_size: '',
  date_range: '', company_types: [], funding_stage: [],
  blacklist_keywords: [], blacklist_companies: [],
  daily_limit: 10, interval_seconds: 5, match_threshold: 60
};
let deliveryRunning = false;
let deliveryStartTime = null;
let progressCounts = { total: 0, success: 0, failed: 0, skipped: 0 };
let platformStats = {};  // { boss: {total:0, success:0, failed:0}, ... }
const PLATFORM_NAMES = { boss: 'BOSS直聘', liepin: '猎聘', zhilian: '智联招聘', job51: '51job', lagou: '拉勾' };

// ═══════════════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════════════
function toast(msg, type = 'info', duration = 3000) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('fadeout');
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════════
// 左侧导航切换
// ═══════════════════════════════════════════════════════════════════
function switchNav(navId) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-nav="${navId}"]`).classList.add('active');
  document.getElementById(`page-${navId}`).classList.add('active');
}

// ═══════════════════════════════════════════════════════════════════
// 主题切换
// ═══════════════════════════════════════════════════════════════════
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);

  // 更新图标和文字
  document.getElementById('icon-sun').style.display = next === 'dark' ? '' : 'none';
  document.getElementById('icon-moon').style.display = next === 'light' ? '' : 'none';
  document.getElementById('theme-label').textContent = next === 'dark' ? '深色' : '浅色';

  localStorage.setItem('theme', next);
}

function loadTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('icon-sun').style.display = saved === 'dark' ? '' : 'none';
  document.getElementById('icon-moon').style.display = saved === 'light' ? '' : 'none';
  document.getElementById('theme-label').textContent = saved === 'dark' ? '深色' : '浅色';
}

// ═══════════════════════════════════════════════════════════════════
// 可折叠 Section
// ═══════════════════════════════════════════════════════════════════
function toggleSection(toggle) {
  const section = toggle.closest('.section.collapsible');
  section.classList.toggle('open');
}

// ═══════════════════════════════════════════════════════════════════
// RESUME
// ═══════════════════════════════════════════════════════════════════

// 教育经历
function addEducationRow(data = null) {
  const list = document.getElementById('education-list');
  const idx = resumeData.education.length;
  const d = data || { school: '', degree: '本科', major: '', graduation: '' };
  resumeData.education.push(d);

  const row = document.createElement('div');
  row.className = 'entry-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="field"><label>学校</label><input type="text" value="${d.school}" placeholder="XX大学" onchange="updateEducation(${idx},'school',this.value)"></div>
    <div class="field"><label>学历</label><select onchange="updateEducation(${idx},'degree',this.value)">
      <option value="大专" ${d.degree==='大专'?'selected':''}>大专</option>
      <option value="本科" ${d.degree==='本科'?'selected':''}>本科</option>
      <option value="硕士" ${d.degree==='硕士'?'selected':''}>硕士</option>
      <option value="博士" ${d.degree==='博士'?'selected':''}>博士</option>
    </select></div>
    <div class="field"><label>专业</label><input type="text" value="${d.major}" placeholder="计算机科学" onchange="updateEducation(${idx},'major',this.value)"></div>
    <div class="field"><label>毕业时间</label><input type="text" value="${d.graduation}" placeholder="2020.06" onchange="updateEducation(${idx},'graduation',this.value)"></div>
    <button class="entry-remove" onclick="removeEducation(${idx})">✕</button>
  `;
  list.appendChild(row);
}

function updateEducation(idx, field, value) { resumeData.education[idx][field] = value; }
function removeEducation(idx) { resumeData.education.splice(idx, 1); rebuildEducationList(); }
function rebuildEducationList() {
  const list = document.getElementById('education-list');
  list.innerHTML = '';
  resumeData.education.forEach(d => addEducationRow(d));
}

// 工作经历
function addWorkRow(data = null) {
  const list = document.getElementById('work-list');
  const idx = resumeData.work_history.length;
  const d = data || { company: '', title: '', start: '', end: '至今' };
  resumeData.work_history.push(d);

  const row = document.createElement('div');
  row.className = 'entry-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <div class="field"><label>公司</label><input type="text" value="${d.company}" placeholder="XX科技" onchange="updateWork(${idx},'company',this.value)"></div>
    <div class="field"><label>职位</label><input type="text" value="${d.title}" placeholder="Java后端开发" onchange="updateWork(${idx},'title',this.value)"></div>
    <div class="field"><label>起始</label><input type="text" value="${d.start}" placeholder="2022.03" onchange="updateWork(${idx},'start',this.value)"></div>
    <div class="field"><label>结束</label><input type="text" value="${d.end}" placeholder="至今" onchange="updateWork(${idx},'end',this.value)"></div>
    <button class="entry-remove" onclick="removeWork(${idx})">✕</button>
  `;
  list.appendChild(row);
}

function updateWork(idx, field, value) { resumeData.work_history[idx][field] = value; }
function removeWork(idx) { resumeData.work_history.splice(idx, 1); rebuildWorkList(); }
function rebuildWorkList() {
  const list = document.getElementById('work-list');
  list.innerHTML = '';
  resumeData.work_history.forEach(d => addWorkRow(d));
}

// 技能标签
function addSkill(skill = null) {
  const input = document.getElementById('r-skill-input');
  const val = skill || input.value.trim();
  if (val && !resumeData.skills.includes(val)) {
    resumeData.skills.push(val);
    renderSkillTags();
    input.value = '';
  }
}

function quickAddSkill(skill) { addSkill(skill); }

function removeSkill(idx) { resumeData.skills.splice(idx, 1); renderSkillTags(); }

function renderSkillTags() {
  document.getElementById('skill-tags').innerHTML = resumeData.skills.map((s, i) =>
    `<span class="tag">${s} <span class="remove" onclick="removeSkill(${i})">✕</span></span>`
  ).join('');
  updateCompletion();
}

// 完善度
function updateCompletion() {
  const fields = [
    resumeData.name, resumeData.phone, resumeData.email,
    resumeData.education.length > 0,
    resumeData.work_history.length > 0,
    resumeData.skills.length > 0,
    resumeData.city
  ];
  const filled = fields.filter(f => f && f !== '' && f !== 0).length;
  const pct = Math.round((filled / fields.length) * 100);
  document.getElementById('resume-completion').style.width = pct + '%';
  document.getElementById('resume-completion-text').textContent = pct + '%';
}

async function saveResume() {
  resumeData.name = document.getElementById('r-name').value.trim();
  resumeData.phone = document.getElementById('r-phone').value.trim();
  resumeData.email = document.getElementById('r-email').value.trim();
  resumeData.city = document.getElementById('r-city').value.trim();
  resumeData.salary_min = parseInt(document.getElementById('r-salary-min').value) || 0;
  resumeData.salary_max = parseInt(document.getElementById('r-salary-max').value) || 0;

  if (!resumeData.name) { toast('请填写姓名', 'error'); return; }
  if (!resumeData.phone) { toast('请填写手机号', 'error'); return; }
  if (!resumeData.email) { toast('请填写邮箱', 'error'); return; }

  await window.api.saveResume(resumeData);
  updateCompletion();
  toast('简历已保存', 'success');
}

async function loadResume() {
  const data = await window.api.loadResume();
  if (!data) { renderSkillTags(); updateCompletion(); return; }
  resumeData = { ...resumeData, ...data };

  document.getElementById('r-name').value = data.name || '';
  document.getElementById('r-phone').value = data.phone || '';
  document.getElementById('r-email').value = data.email || '';
  document.getElementById('r-city').value = data.city || '';
  document.getElementById('r-salary-min').value = data.salary_min || '';
  document.getElementById('r-salary-max').value = data.salary_max || '';

  if (data.education && data.education.length > 0) {
    resumeData.education = data.education;
    rebuildEducationList();
  }
  if (data.work_history && data.work_history.length > 0) {
    resumeData.work_history = data.work_history;
    rebuildWorkList();
  }
  if (data.skills) {
    resumeData.skills = data.skills;
    renderSkillTags();
  }
  updateCompletion();
}

// ═══════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════

async function loadAuth() {
  const statuses = await window.api.getAuthStatus();
  renderAuthUI(statuses);

  for (const s of statuses) {
    if (s.status === 'authorized') {
      updateAuthCard(s.platform, s.name, 'checking', '检测中...');
      const stillValid = await window.api.verifyAuth(s.platform);
      if (!stillValid) updateAuthCard(s.platform, s.name, 'expired', '已过期');
    }
  }

  const verified = await window.api.getAuthStatus();
  renderAuthUI(verified);
  renderDeliverPlatformSelect(verified);
  updateStats();
}

async function refreshAuth() {
  toast('正在刷新...', 'info');
  await loadAuth();
  toast('已刷新', 'success');
}

function renderAuthUI(statuses) {
  document.getElementById('platform-list').innerHTML = statuses.map(s => {
    let badgeText, badgeClass;
    if (s.status === 'authorized') { badgeText = '已授权'; badgeClass = 'authorized'; }
    else if (s.status === 'expired') { badgeText = '已过期'; badgeClass = 'expired'; }
    else if (s.status === 'checking') { badgeText = '检测中...'; badgeClass = 'checking'; }
    else { badgeText = '未授权'; badgeClass = 'never'; }
    const hint = s.status === 'authorized' ? '点击重新授权' : '点击开始授权';
    return `<div class="platform-card" onclick="startAuth('${s.platform}')"><div class="name">${s.name}</div><div class="status-badge ${badgeClass}">${badgeText}</div><div class="auth-hint">${hint}</div></div>`;
  }).join('');
}

function renderDeliverPlatformSelect(statuses) {
  document.getElementById('deliver-platforms').innerHTML = statuses.map(s => `
    <div class="platform-check-item ${s.status === 'authorized' ? 'selected' : 'disabled'}"
         onclick="${s.status === 'authorized' ? 'togglePlatformSelect(this)' : ''}">
      <input type="checkbox" value="${s.platform}" ${s.status === 'authorized' ? 'checked' : 'disabled'}>
      ${s.name}
      ${s.status !== 'authorized' ? ' (未授权)' : ''}
    </div>
  `).join('');
}

function togglePlatformSelect(el) {
  const cb = el.querySelector('input[type="checkbox"]');
  cb.checked = !cb.checked;
  el.classList.toggle('selected', cb.checked);
}

function updateAuthCard(platform, name, status, text) {
  const grid = document.getElementById('platform-list');
  grid.querySelectorAll('.platform-card').forEach(card => {
    if (card.querySelector('.name')?.textContent === name) {
      const badge = card.querySelector('.status-badge');
      badge.className = 'status-badge ' + status;
      badge.textContent = text;
    }
  });
}

async function startAuth(platform) {
  const overlay = document.getElementById('auth-overlay');
  overlay.style.display = 'flex';
  document.getElementById('auth-overlay-text').textContent = `正在打开 ${platform} 授权窗口...`;

  const result = await window.api.startLogin(platform);
  overlay.style.display = 'none';

  if (result.success) {
    toast(`${platform} 授权成功`, 'success');
    await loadAuth();
  } else {
    toast(`授权失败: ${result.error || '超时或取消'}`, 'error');
    await loadAuth();
  }
}

// ═══════════════════════════════════════════════════════════════════
// FILTER
// ═══════════════════════════════════════════════════════════════════

function addTag(inputId, arr, renderFn) {
  const input = document.getElementById(inputId);
  const val = input.value.trim();
  if (val && !arr.includes(val)) {
    arr.push(val);
    renderFn();
    saveFilterSilent();
  }
  input.value = '';
}

function removeTag(arr, idx, renderFn) {
  arr.splice(idx, 1);
  renderFn();
  saveFilterSilent();
}

function addFilterKeyword() { addTag('f-keyword', filterData.keywords, renderFilterKeywords); }
function renderFilterKeywords() {
  document.getElementById('filter-keywords').innerHTML = filterData.keywords.map((k, i) =>
    `<span class="tag">${k} <span class="remove" onclick="removeTag(filterData.keywords,${i},renderFilterKeywords)">✕</span></span>`
  ).join('');
}

function addFilterCity() { addTag('f-city', filterData.cities, renderFilterCities); }
function renderFilterCities() {
  document.getElementById('filter-cities').innerHTML = filterData.cities.map((c, i) =>
    `<span class="tag">${c} <span class="remove" onclick="removeTag(filterData.cities,${i},renderFilterCities)">✕</span></span>`
  ).join('');
}

function addBlackKeyword() { addTag('black-keyword', filterData.blacklist_keywords, renderBlackKeywords); }
function renderBlackKeywords() {
  document.getElementById('blacklist-keywords').innerHTML = filterData.blacklist_keywords.map((k, i) =>
    `<span class="tag blacklist-tag">${k} <span class="remove" onclick="removeTag(filterData.blacklist_keywords,${i},renderBlackKeywords)">✕</span></span>`
  ).join('');
}

function addBlackCompany() { addTag('black-company', filterData.blacklist_companies, renderBlackCompanies); }
function renderBlackCompanies() {
  document.getElementById('blacklist-companies').innerHTML = filterData.blacklist_companies.map((c, i) =>
    `<span class="tag blacklist-tag">${c} <span class="remove" onclick="removeTag(filterData.blacklist_companies,${i},renderBlackCompanies)">✕</span></span>`
  ).join('');
}

function quickAddBlackKeyword(word) {
  if (!filterData.blacklist_keywords.includes(word)) {
    filterData.blacklist_keywords.push(word);
    renderBlackKeywords();
    saveFilterSilent();
  }
}

function presetBlackKeywords() {
  ['外包', '驻场', '996', '大小周', '劳务派遣', '转包', '培训'].forEach(word => {
    if (!filterData.blacklist_keywords.includes(word)) filterData.blacklist_keywords.push(word);
  });
  renderBlackKeywords();
  saveFilterSilent();
  toast('常见黑名单已全部添加', 'success');
}

function collectFilterFromUI() {
  filterData.salary_min = parseInt(document.getElementById('f-salary-min').value) || 0;
  filterData.salary_max = parseInt(document.getElementById('f-salary-max').value) || 0;
  filterData.experience = document.getElementById('f-experience').value;
  filterData.education = document.getElementById('f-education').value;
  filterData.job_type = document.getElementById('f-job-type').value;
  filterData.company_size = document.getElementById('f-company-size').value;
  filterData.date_range = document.getElementById('f-date').value;
  filterData.daily_limit = parseInt(document.getElementById('f-daily-limit').value) || 10;
  filterData.interval_seconds = parseInt(document.getElementById('f-interval').value) || 5;
  filterData.match_threshold = parseInt(document.getElementById('f-threshold').value) || 60;
  filterData.company_types = Array.from(document.querySelectorAll('.check-group input:checked')).map(c => c.value);
}

async function saveFilter() {
  // 保存前自动把输入框里还没回车的内容收进数组
  const kInput = document.getElementById('f-keyword');
  if (kInput && kInput.value.trim() && !filterData.keywords.includes(kInput.value.trim())) {
    filterData.keywords.push(kInput.value.trim());
  }
  const cInput = document.getElementById('f-city');
  if (cInput && cInput.value.trim() && !filterData.cities.includes(cInput.value.trim())) {
    filterData.cities.push(cInput.value.trim());
  }
  const bkInput = document.getElementById('black-keyword');
  if (bkInput && bkInput.value.trim() && !filterData.blacklist_keywords.includes(bkInput.value.trim())) {
    filterData.blacklist_keywords.push(bkInput.value.trim());
  }
  const bcInput = document.getElementById('black-company');
  if (bcInput && bcInput.value.trim() && !filterData.blacklist_companies.includes(bcInput.value.trim())) {
    filterData.blacklist_companies.push(bcInput.value.trim());
  }

  collectFilterFromUI();
  if (filterData.keywords.length === 0) { toast('请至少设置一个岗位关键词', 'warning'); return; }
  await window.api.saveFilter(filterData);
  renderFilterKeywords();
  renderFilterCities();
  renderBlackKeywords();
  renderBlackCompanies();
  toast('筛选条件已保存', 'success');
}

async function saveFilterSilent() {
  collectFilterFromUI();
  await window.api.saveFilter(filterData);
}

async function loadFilter() {
  const data = await window.api.loadFilter();
  if (!data) { renderFilterKeywords(); renderFilterCities(); renderBlackKeywords(); renderBlackCompanies(); return; }
  filterData = data;

  document.getElementById('f-salary-min').value = data.salary_min || '';
  document.getElementById('f-salary-max').value = data.salary_max || '';
  document.getElementById('f-experience').value = data.experience || '';
  document.getElementById('f-education').value = data.education || '';
  document.getElementById('f-job-type').value = data.job_type || '';
  document.getElementById('f-company-size').value = data.company_size || '';
  document.getElementById('f-date').value = data.date_range || '';
  document.getElementById('f-daily-limit').value = data.daily_limit || 10;
  document.getElementById('f-interval').value = data.interval_seconds || 5;
  document.getElementById('f-threshold').value = data.match_threshold || 60;

  renderFilterKeywords();
  renderFilterCities();
  renderBlackKeywords();
  renderBlackCompanies();

  // Restore checkboxes
  const allValues = [...(data.company_types || []), ...(data.funding_stage || [])];
  document.querySelectorAll('.check-group input[type="checkbox"]').forEach(cb => {
    cb.checked = allValues.includes(cb.value);
  });
}

// ═══════════════════════════════════════════════════════════════════
// DELIVERY
// ═══════════════════════════════════════════════════════════════════

function getSelectedPlatforms() {
  return Array.from(document.querySelectorAll('#deliver-platforms input:checked')).map(cb => cb.value);
}

async function startDelivery() {
  const platforms = getSelectedPlatforms();
  if (platforms.length === 0) { toast('请先选择投递平台', 'warning'); return; }
  if (!resumeData.name) { toast('请先填写简历姓名', 'error'); switchNav('resume'); return; }
  if (filterData.keywords.length === 0) { toast('请设置岗位关键词', 'warning'); switchNav('filter'); return; }

  deliveryRunning = true;
  deliveryStartTime = Date.now();
  progressCounts = { total: 0, success: 0, failed: 0, skipped: 0 };
  platformStats = {};  // 重置平台统计

  collectFilterFromUI();

  document.getElementById('btn-start').style.display = 'none';
  document.getElementById('btn-stop').style.display = 'inline-block';
  document.getElementById('progress-panel').style.display = 'block';
  document.getElementById('platform-stats-panel').style.display = 'block';
  document.getElementById('progress-log').innerHTML = '';
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('deliver-status').textContent = '投递中...';
  document.getElementById('deliver-status').className = 'deliver-status';
  document.getElementById('platform-stats-grid').innerHTML = '';
  renderPlatformStats();  // 立即渲染，显示全部5个平台（都是0）

  ['ps-total-num', 'ps-ok-num', 'ps-fail-num', 'ps-skip-num'].forEach(id => {
    document.getElementById(id).textContent = '0';
  });
  document.getElementById('ps-speed-num').textContent = '-';

  const result = await window.api.startDelivery({ platforms, filter: filterData, resume: resumeData });

  deliveryRunning = false;
  document.getElementById('btn-start').style.display = 'inline-block';
  document.getElementById('btn-stop').style.display = 'none';

  const statusEl = document.getElementById('deliver-status');
  if (result && !result.error) {
    statusEl.textContent = `完成: 成功 ${result.success || 0} / 失败 ${result.failed || 0} / 跳过 ${result.skipped || 0}`;
    statusEl.className = 'deliver-status success';
    toast(`投递完成！成功 ${result.success || 0} 份`, 'success', 5000);
  } else {
    statusEl.textContent = result?.error || '投递出错';
    statusEl.className = 'deliver-status error';
    toast(`投递失败: ${result?.error || '出错'}`, 'error', 5000);
  }
  await loadHistory();
  updateStats();
}

async function stopDelivery() {
  if (!deliveryRunning) return;
  document.getElementById('deliver-status').textContent = '正在停止...';
  await window.api.stopDelivery();
  deliveryRunning = false;
  document.getElementById('btn-start').style.display = 'inline-block';
  document.getElementById('btn-stop').style.display = 'none';
  document.getElementById('deliver-status').textContent = '已停止';
  toast('投递已停止', 'warning');
}

function addLog(msg, cls = 'info') {
  const el = document.getElementById('progress-log');
  const time = new Date().toLocaleTimeString();
  el.innerHTML += `<div class="log-line ${cls}">${time}  ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}

function updateProgressBar(current, total) {
  const bar = document.getElementById('progress-bar');
  if (total > 0) bar.style.width = Math.min(100, Math.round((current / total) * 100)) + '%';
}

function updateProgressStats() {
  document.getElementById('ps-total-num').textContent = progressCounts.total;
  document.getElementById('ps-ok-num').textContent = progressCounts.success;
  document.getElementById('ps-fail-num').textContent = progressCounts.failed;
  document.getElementById('ps-skip-num').textContent = progressCounts.skipped;

  if (deliveryStartTime && progressCounts.total > 0) {
    const elapsed = (Date.now() - deliveryStartTime) / 60000;
    const speed = elapsed > 0 ? Math.round(progressCounts.total / elapsed) : 0;
    document.getElementById('ps-speed-num').textContent = speed + '/min';
  }
}

// ═══════════════════════════════════════════════════════════════════
// 平台投递统计渲染
// ═══════════════════════════════════════════════════════════════════

function renderPlatformStats() {
  const el = document.getElementById('platform-stats-grid');
  if (!el) return;

  // ★ 始终展示全部5个平台，没投递的数据显示0
  const ALL_PLATFORMS = ['boss', 'liepin', 'zhilian', 'job51', 'lagou'];

  el.innerHTML = ALL_PLATFORMS.map(p => {
    const s = platformStats[p] || { total: 0, success: 0, failed: 0 };
    const name = PLATFORM_NAMES[p] || p;
    const pct = s.total > 0 ? Math.round((s.success / s.total) * 100) : 0;
    const isEmpty = s.total === 0;
    return `<div class="platform-stat-card${isEmpty ? ' psc-empty' : ''}">
      <div class="psc-name">${name}</div>
      <div class="psc-nums">
        <div class="psc-num"><span class="psc-label">投递</span><span class="psc-val v-total">${s.total}</span></div>
        <div class="psc-num"><span class="psc-label">成功</span><span class="psc-val v-ok">${s.success}</span></div>
        <div class="psc-num"><span class="psc-label">失败</span><span class="psc-val v-fail">${s.failed}</span></div>
      </div>
      <div class="psc-bar"><div class="psc-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

// Progress events
window.api.onDeliveryProgress((data) => {
  const pf = data.platform ? `[${data.platform}] ` : '';
  switch (data.type) {
    case 'phase': addLog(data.message, 'info'); break;
    case 'delivering':
      addLog(pf + data.message, 'delivering');
      progressCounts.total++;
      if (data.platform) {
        if (!platformStats[data.platform]) platformStats[data.platform] = { total: 0, success: 0, failed: 0 };
        platformStats[data.platform].total++;
        renderPlatformStats();
      }
      if (data.current && data.total) updateProgressBar(data.current, data.total);
      updateProgressStats();
      break;
    case 'result':
      addLog(pf + data.message, 'success');
      progressCounts.success++;
      if (data.platform) {
        if (!platformStats[data.platform]) platformStats[data.platform] = { total: 0, success: 0, failed: 0 };
        platformStats[data.platform].success++;
        renderPlatformStats();
      }
      if (data.current && data.total) updateProgressBar(data.current, data.total);
      updateProgressStats();
      break;
    case 'error':
      addLog(pf + data.message, 'error');
      progressCounts.failed++;
      if (data.platform) {
        if (!platformStats[data.platform]) platformStats[data.platform] = { total: 0, success: 0, failed: 0 };
        platformStats[data.platform].failed++;
        renderPlatformStats();
      }
      updateProgressStats();
      break;
    case 'warning': addLog(pf + data.message, 'warning'); break;
    case 'info': addLog(data.message, 'info'); break;
    case 'captcha':
      addLog(pf + `验证码: ${data.job?.company || ''} ${data.job?.title || ''}`, 'warning');
      progressCounts.skipped++;
      updateProgressStats();
      break;
    case 'done':
      addLog(data.message, 'success');
      updateProgressBar(1, 1);
      renderPlatformStats();  // 最终刷新一次
      break;
  }
});

// ═══════════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════════

async function loadHistory() {
  const data = await window.api.getHistory(200);
  const el = document.getElementById('history-table');
  const statusFilter = document.getElementById('history-filter-status')?.value || '';

  if (!data || data.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);padding:8px">暂无投递记录</p>';
    return;
  }

  let filtered = data;
  if (statusFilter) filtered = data.filter(r => r.status === statusFilter);

  const statusMap = { 'success': '成功', 'failed': '失败', 'skipped': '跳过', 'pending': '待投递' };

  // ★ 缺失数据检测：公司名或薪资为空时标记警告
  function missingTag(val, fieldName) {
    if (!val || val.trim() === '' || val.trim() === '-') {
      return `<span class="missing-data-tag">${fieldName}未获取</span>`;
    }
    return '';
  }

  el.innerHTML = `<table class="history-table"><thead><tr>
    <th>平台</th><th>公司</th><th>职位</th><th>薪资</th><th>状态</th><th>时间</th>
  </tr></thead><tbody>${filtered.map(r => {
    const companyDisplay = r.company || '';
    const salaryDisplay = r.salary || '';
    const companyMissing = missingTag(r.company, '公司');
    const salaryMissing = missingTag(r.salary, '薪资');
    const hasMissing = companyMissing || salaryMissing;
    return `
    <tr${hasMissing ? ' class="row-missing"' : ''}>
      <td>${r.platform || ''}</td>
      <td title="${r.company || ''}">${companyDisplay}${companyMissing}</td>
      <td title="${r.title || ''}">${r.title || ''}</td>
      <td>${salaryDisplay}${salaryMissing}</td>
      <td class="status-${r.status}">${statusMap[r.status] || r.status}</td>
      <td>${r.delivered_at ? new Date(r.delivered_at).toLocaleString('zh-CN') : ''}</td>
    </tr>
  `}).join('')}</tbody></table>`;
}

async function exportHistory() {
  const data = await window.api.getHistory(500);
  if (!data || data.length === 0) { toast('暂无数据', 'warning'); return; }
  const header = '平台,公司,职位,薪资,状态,时间\n';
  const rows = data.map(r => `${r.platform},${r.company},${r.title},${r.salary},${r.status},${r.delivered_at || ''}`).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `投递历史_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV 已导出', 'success');
}

async function clearHistory() {
  toast('确认清空？此操作不可恢复', 'warning', 5000);
  // TODO: 需要后端 IPC 支持 history:clear
}

// ═══════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════

async function updateStats() {
  const data = await window.api.getHistory(200);
  if (!data || data.length === 0) {
    document.getElementById('stat-today').textContent = '0';
    document.getElementById('stat-success').textContent = '0';
    document.getElementById('stat-fail').textContent = '0';
    document.getElementById('stat-rate').textContent = '0%';
    return;
  }

  const today = new Date().toLocaleDateString('zh-CN');
  const todayData = data.filter(r => r.delivered_at && new Date(r.delivered_at).toLocaleDateString('zh-CN') === today);
  const total = todayData.length;
  const success = todayData.filter(r => r.status === 'success').length;
  const fail = todayData.filter(r => r.status === 'failed').length;
  const rate = total > 0 ? Math.round((success / total) * 100) : 0;

  document.getElementById('stat-today').textContent = total;
  document.getElementById('stat-success').textContent = success;
  document.getElementById('stat-fail').textContent = fail;
  document.getElementById('stat-rate').textContent = rate + '%';
}

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

async function loadProgressHistory() {
  const log = await window.api.getProgressLog();
  if (!log || log.length === 0) return;
  // Show progress panel with previous session's log
  document.getElementById('progress-panel').style.display = 'block';
  const el = document.getElementById('progress-log');
  el.innerHTML = log.map(e => {
    const time = e.time ? new Date(e.time).toLocaleTimeString() : '';
    const pf = e.platform ? '[' + e.platform + '] ' : '';
    let cls = 'info';
    if (e.type === 'result' || e.type === 'done') cls = 'success';
    else if (e.type === 'error') cls = 'error';
    else if (e.type === 'warning' || e.type === 'captcha') cls = 'warning';
    else if (e.type === 'delivering') cls = 'delivering';
    return '<div class="log-line ' + cls + '">' + time + '  ' + pf + (e.message || '') + '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function init() {
  loadTheme();
  await loadResume();
  await loadAuth();
  await loadFilter();
  await loadHistory();
  await loadProgressHistory();
  updateStats();
}

// ★★★ 临时诊断函数（上线前删） ★★★
async function runDiagnose() {
  const pre = document.getElementById('diagnose-result');
  pre.style.display = 'block';
  pre.textContent = '诊断中...';
  try {
    const r = await window.api.diagnose('boss');
    pre.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    pre.textContent = '诊断失败: ' + e.message;
  }
}

init();
