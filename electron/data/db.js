const path = require('path');
const fs = require('fs');

let SQL; // Will be loaded async
let db;

let DB_PATH;

async function init(sqlModule) {
  SQL = sqlModule;
  const { app } = require('electron');
  DB_PATH = path.join(app.getPath('userData'), 'fuck_job.db');

  // Load existing or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL');
  initTables();
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized. Call init() first.');
  return db;
}

function saveToDisk() {
  if (!db || !DB_PATH) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function initTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS resume (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      education TEXT DEFAULT '[]',
      work_history TEXT DEFAULT '[]',
      skills TEXT DEFAULT '[]',
      salary_min INTEGER DEFAULT 0,
      salary_max INTEGER DEFAULT 0,
      city TEXT DEFAULT '',
      resume_pdf_path TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS platform_auth (
      platform TEXT PRIMARY KEY,
      status TEXT DEFAULT 'never',
      profile_path TEXT DEFAULT '',
      last_check_at TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS filter_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      keywords TEXT DEFAULT '[]',
      cities TEXT DEFAULT '[]',
      salary_min INTEGER DEFAULT 0,
      experience TEXT DEFAULT '',
      education TEXT DEFAULT '',
      blacklist_keywords TEXT DEFAULT '[]',
      blacklist_companies TEXT DEFAULT '[]',
      date_range TEXT DEFAULT '',
      company_types TEXT DEFAULT '[]',
      company_size TEXT DEFAULT '',
      funding_stage TEXT DEFAULT '[]',
      daily_limit INTEGER DEFAULT 10,
      interval_seconds INTEGER DEFAULT 5,
      match_threshold INTEGER DEFAULT 60,
      updated_at TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT DEFAULT '',
      company TEXT DEFAULT '',
      title TEXT DEFAULT '',
      salary TEXT DEFAULT '',
      url TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      fail_reason TEXT DEFAULT '',
      jd_text TEXT DEFAULT '',
      delivered_at TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS interview_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id INTEGER REFERENCES delivery_log(id),
      stage TEXT DEFAULT 'applied',
      note TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    )
  `);

  // ★★★ 自动诊断记录表 ★★★
  // 每次投递完成后，诊断引擎的发现都会持久化到这里
  // 下次再出现同样问题，可以直接查历史知道根因
  db.run(`
    CREATE TABLE IF NOT EXISTS diagnostic_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT DEFAULT '',
      severity TEXT DEFAULT '',
      problem_id TEXT DEFAULT '',
      problem_name TEXT DEFAULT '',
      root_cause TEXT DEFAULT '',
      suggestion TEXT DEFAULT '',
      details TEXT DEFAULT '',
      pipeline_summary TEXT DEFAULT '',
      healthy INTEGER DEFAULT 0,
      detected_at TEXT DEFAULT ''
    )
  `);

  saveToDisk();
}

// ═══════ Helper: run and get one row ═══════
function getOne(sql, params = []) {
  const d = getDB();
  const stmt = d.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const row = {};
    cols.forEach((c, i) => row[c] = vals[i]);
    return row;
  }
  stmt.free();
  return null;
}

function getAll(sql, params = []) {
  const d = getDB();
  const results = [];
  const stmt = d.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const row = {};
    cols.forEach((c, i) => row[c] = vals[i]);
    results.push(row);
  }
  stmt.free();
  return results;
}

function run(sql, params = []) {
  const d = getDB();
  d.run(sql, params);
  saveToDisk();
}

// ═══════ Resume ═══════
function saveResume(data) {
  const now = new Date().toISOString();
  const exists = getOne('SELECT id FROM resume WHERE id = 1');

  if (exists) {
    run(`UPDATE resume SET name=?, phone=?, email=?, education=?, work_history=?,
      skills=?, salary_min=?, salary_max=?, city=?, resume_pdf_path=?, updated_at=?
      WHERE id=1`,
      [data.name||'', data.phone||'', data.email||'',
       JSON.stringify(data.education||[]), JSON.stringify(data.work_history||[]),
       JSON.stringify(data.skills||[]), data.salary_min||0, data.salary_max||0,
       data.city||'', data.resume_pdf_path||'', now]);
  } else {
    run(`INSERT INTO resume (id,name,phone,email,education,work_history,
      skills,salary_min,salary_max,city,resume_pdf_path,updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.name||'', data.phone||'', data.email||'',
       JSON.stringify(data.education||[]), JSON.stringify(data.work_history||[]),
       JSON.stringify(data.skills||[]), data.salary_min||0, data.salary_max||0,
       data.city||'', data.resume_pdf_path||'', now]);
  }
  return { success: true };
}

function loadResume() {
  const row = getOne('SELECT * FROM resume WHERE id = 1');
  if (!row) return null;
  return {
    ...row,
    education: JSON.parse(row.education || '[]'),
    work_history: JSON.parse(row.work_history || '[]'),
    skills: JSON.parse(row.skills || '[]')
  };
}

// ═══════ Platform Auth ═══════
function getPlatformStatus() {
  const platforms = ['boss', 'liepin', 'zhilian', 'job51', 'lagou'];
  const names = { boss: 'BOSS直聘', liepin: '猎聘', zhilian: '智联招聘', job51: '51job', lagou: '拉勾' };
  return platforms.map(p => {
    const row = getOne('SELECT * FROM platform_auth WHERE platform = ?', [p]);
    return { platform: p, name: names[p], status: row ? row.status : 'never' };
  });
}

function setPlatformStatus(platform, status, profilePath) {
  const now = new Date().toISOString();
  run(`INSERT OR REPLACE INTO platform_auth (platform, status, profile_path, last_check_at)
    VALUES (?, ?, ?, ?)`, [platform, status, profilePath || '', now]);
}

// ═══════ Filter ═══════
function saveFilter(data) {
  const now = new Date().toISOString();
  const exists = getOne('SELECT id FROM filter_config WHERE id = 1');

  const params = [
    JSON.stringify(data.keywords||[]), JSON.stringify(data.cities||[]),
    data.salary_min||0, data.experience||'', data.education||'',
    JSON.stringify(data.blacklist_keywords||[]), JSON.stringify(data.blacklist_companies||[]),
    data.date_range||'', JSON.stringify(data.company_types||[]), data.company_size||'',
    JSON.stringify(data.funding_stage||[]), data.daily_limit||10,
    data.interval_seconds||5, data.match_threshold||60, now
  ];

  if (exists) {
    run(`UPDATE filter_config SET keywords=?, cities=?, salary_min=?, experience=?,
      education=?, blacklist_keywords=?, blacklist_companies=?, date_range=?, company_types=?,
      company_size=?, funding_stage=?, daily_limit=?, interval_seconds=?, match_threshold=?,
      updated_at=? WHERE id=1`, params);
  } else {
    run(`INSERT INTO filter_config (id, keywords, cities, salary_min, experience, education,
      blacklist_keywords, blacklist_companies, date_range, company_types, company_size,
      funding_stage, daily_limit, interval_seconds, match_threshold, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params);
  }
  return { success: true };
}

function loadFilter() {
  const row = getOne('SELECT * FROM filter_config WHERE id = 1');
  if (!row) return null;
  return {
    ...row,
    keywords: JSON.parse(row.keywords || '[]'),
    cities: JSON.parse(row.cities || '[]'),
    blacklist_keywords: JSON.parse(row.blacklist_keywords || '[]'),
    blacklist_companies: JSON.parse(row.blacklist_companies || '[]'),
    company_types: JSON.parse(row.company_types || '[]'),
    funding_stage: JSON.parse(row.funding_stage || '[]')
  };
}

// ═══════ Delivery Log ═══════
function addDeliveryLog(platform, company, title, salary, url, status, failReason, jdText) {
  const now = new Date().toISOString();
  run(`INSERT INTO delivery_log (platform, company, title, salary, url, status, fail_reason, jd_text, delivered_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [platform, company, title, salary, url, status, failReason||'', jdText||'', now]);
}

function getDeliveryLog(limit = 50) {
  return getAll('SELECT * FROM delivery_log ORDER BY delivered_at DESC LIMIT ?', [limit]);
}

// ═══════ Diagnostic Log ═══════
function addDiagnosticLog(runId, severity, problemId, problemName, rootCause, suggestion, details, pipelineSummary, healthy) {
  const now = new Date().toISOString();
  run(`INSERT INTO diagnostic_log (run_id, severity, problem_id, problem_name, root_cause, suggestion, details, pipeline_summary, healthy, detected_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [runId||'', severity||'', problemId||'', problemName||'', rootCause||'', suggestion||'', 
     JSON.stringify(details||{}), JSON.stringify(pipelineSummary||[]), healthy?1:0, now]);
}

function getDiagnosticLog(limit = 20) {
  return getAll('SELECT * FROM diagnostic_log ORDER BY detected_at DESC LIMIT ?', [limit]);
}

function getDiagnosticHistory(problemId) {
  // 查某个问题ID的历史记录——看它之前出现过几次
  return getAll('SELECT * FROM diagnostic_log WHERE problem_id = ? ORDER BY detected_at DESC', [problemId]);
}

module.exports = {
  init, getDB,
  saveResume, loadResume,
  getPlatformStatus, setPlatformStatus,
  saveFilter, loadFilter,
  addDeliveryLog, getDeliveryLog,
  addDiagnosticLog, getDiagnosticLog, getDiagnosticHistory
};
