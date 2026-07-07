/**
 * logger.js — 投递日志统一入口
 *
 * 职责：
 * 1. 投递事件写入 SQLite delivery_log 表
 * 2. 实时事件通过 callback 推给 UI
 * 3. 文件日志备份（userData/delivery.log）
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const db = require('../data/db');

const LOG_FILE = path.join(app.getPath('userData'), 'delivery.log');

let _onEvent = null;

function setEventHandler(cb) {
  _onEvent = cb;
}

function log(level, platform, message, data) {
  const ts = new Date().toISOString();
  const entry = { ts, level, platform, message, data };
  // 文件日志
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (_) {}
  // 实时推送
  if (_onEvent) {
    try { _onEvent(entry); } catch (_) {}
  }
  // 控制台
  const prefix = `[${level.toUpperCase()}]${platform ? '[' + platform + ']' : ''}`;
  if (level === 'error') console.error(prefix, message, data || '');
  else if (level === 'warn') console.warn(prefix, message, data || '');
  else console.log(prefix, message, data || '');
}

function info(platform, msg, data) { log('info', platform, msg, data); }
function warn(platform, msg, data) { log('warn', platform, msg, data); }
function error(platform, msg, data) { log('error', platform, msg, data); }

// ═══════ 投递记录持久化 ═══════
function recordDelivery(platform, company, title, salary, url, status, failReason, jdText) {
  try {
    db.addDeliveryLog(platform, company, title, salary, url, status, failReason, jdText);
  } catch (e) {
    error(platform, '写入投递记录失败', e.message);
  }
}

function getDeliveryHistory(limit = 100) {
  try { return db.getDeliveryLog(limit); }
  catch (_) { return []; }
}

module.exports = {
  log, info, warn, error,
  setEventHandler, recordDelivery, getDeliveryHistory
};
