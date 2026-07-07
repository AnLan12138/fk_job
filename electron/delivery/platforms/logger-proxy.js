/**
 * logger-proxy.js — 轻量日志代理
 *
 * 解决 boss.js require logger.js → logger.js require db.js 的链路。
 * 用 lazy require，首次调用时才加载。
 */
let _logger = null;
function get() {
  if (!_logger) {
    try { _logger = require('../logger'); } catch (_) {
      // logger 还没初始化时的兜底
      _logger = {
        info: (...a) => console.log('[INFO]', ...a),
        warn: (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a),
        recordDelivery: () => {},
        setEventHandler: () => {}
      };
    }
  }
  return _logger;
}

module.exports = {
  info: (p, m, d) => get().info(p, m, d),
  warn: (p, m, d) => get().warn(p, m, d),
  error: (p, m, d) => get().error(p, m, d),
  recordDelivery: (...a) => get().recordDelivery(...a),
  setEventHandler: (cb) => get().setEventHandler(cb)
};
