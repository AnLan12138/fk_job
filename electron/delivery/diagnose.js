/**
 * diagnose.js — 诊断工具（临时辅助，上线前删除）
 *
 * 用法：在 main.js 里 require 后调用 diagnose.run(win, 'boss')
 * 返回：页面状态、登录态、反爬标记
 * 结果同时写入：%APPDATA%\fuck-job\diagnose_<platform>.json
 */
const browser = require('./browser');
const selector = require('./selector-engine');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

async function run(win, platform) {
  const url = win.webContents.getURL();
  const cookies = await browser.getCookies(platform);

  const antiDetectResult = await browser.evalJS(win, `
    (function() {
      return JSON.stringify({
        webdriver: navigator.webdriver,
        pluginsLen: navigator.plugins ? navigator.plugins.length : -1,
        languages: navigator.languages,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        maxTouchPoints: navigator.maxTouchPoints,
        hasChrome: !!window.chrome,
        hasChromeRuntime: !!(window.chrome && window.chrome.runtime),
        title: document.title,
        bodyText: (document.body.innerText || '').substring(0, 500),
        bodyHTMLLen: (document.body.innerHTML || '').length,
        hasGeetest: !!document.querySelector('.geetest'),
        hasCaptcha: !!document.querySelector('[class*="captcha"]'),
        hasSlideVerify: !!document.querySelector('.slider-captcha'),
        hasPassport: window.location.href.includes('/passport/'),
        hasVerifyInUrl: window.location.href.includes('security_check') || window.location.href.includes('verify'),
        jobCardCount: document.querySelectorAll('.job-card-wrapper, .job-list-box .job-card').length,
        jobNameCount: document.querySelectorAll('.job-name').length,
        companyCount: document.querySelectorAll('.company-name').length,
        allClassesWithJob: Array.from(new Set(
          Array.from(document.querySelectorAll('[class*="job"]')).map(e => e.className).filter(c => c.length < 80)
        )).slice(0, 30)
      });
    })();
  `);

  let parsed;
  try { parsed = JSON.parse(antiDetectResult); } catch (e) { parsed = { error: antiDetectResult }; }

  return {
    platform,
    url,
    cookieCount: cookies.length,
    cookieNames: cookies.map(c => c.name).slice(0, 20),
    ...parsed
  };
}

async function diagnoseAll(win, platform) {
  const result = await run(win, platform);

  const lines = [];
  const out = (s) => { console.log(s); lines.push(s); };

  out('\n════════════════════════════════════════════');
  out(`[诊断] ${platform} @ ${result.url}`);
  out('════════════════════════════════════════════');
  out('');
  out('── Cookie ──');
  out(`  总数: ${result.cookieCount}`);
  out(`  名称: ${result.cookieNames.join(', ')}`);
  out('');
  out('── Navigator ──');
  out(`  webdriver: ${result.webdriver}  ${result.webdriver === undefined ? '✅' : '❌ Boss能检测到!'}`);
  out(`  plugins: ${result.pluginsLen}  ${result.pluginsLen >= 3 ? '✅' : '❌ 太少'}`);
  out(`  languages: ${result.languages}`);
  out(`  chrome.runtime: ${result.hasChromeRuntime}  ${result.hasChromeRuntime ? '✅' : '❌'}`);
  out('');
  out('── 反爬标记 ──');
  out(`  geetest: ${result.hasGeetest ? '❌ 检测到!' : '✅ 无'}`);
  out(`  captcha: ${result.hasCaptcha ? '❌ 检测到!' : '✅ 无'}`);
  out(`  slideVerify: ${result.hasSlideVerify ? '❌ 检测到!' : '✅ 无'}`);
  out(`  url含verify: ${result.hasVerifyInUrl ? '❌ 检测到!' : '✅ 无'}`);
  out('');
  out('── 页面内容 ──');
  out(`  jobCardCount: ${result.jobCardCount}`);
  out(`  jobNameCount: ${result.jobNameCount}`);
  out(`  bodyHTML长度: ${result.bodyHTMLLen}`);
  out(`  正文片段: ${result.bodyText.substring(0, 200)}`);
  out('════════════════════════════════════════════');

  // 写入文件
  const diagFile = path.join(app.getPath('userData'), `diagnose_${platform}.json`);
  try {
    fs.writeFileSync(diagFile, JSON.stringify(result, null, 2));
    out(`[诊断结果已写入] ${diagFile}`);
  } catch (e) {
    out(`[写入失败] ${e.message}`);
  }

  // 写入 latest.txt（方便直接看）
  const latestFile = path.join(app.getPath('userData'), 'diagnose_latest.txt');
  try {
    fs.writeFileSync(latestFile, lines.join('\n'));
  } catch (_) {}

  return result;
}

module.exports = { run, diagnoseAll };

// 临时：诊断详情页按钮
async function diagnoseDetail(win, jobUrl) {
  if (jobUrl) {
    await require('./browser').loadURL(win, jobUrl, 15000);
    await new Promise(r => setTimeout(r, 3000));
  }
  const r = await require('./browser').evalJS(win, `
    (function() {
      var buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      var visible = buttons.filter(b => b.offsetParent !== null || b.offsetWidth > 0);
      var withText = visible.map(b => ({
        tag: b.tagName,
        class: (b.className || '').substring(0, 80),
        text: (b.textContent || '').trim().substring(0, 50),
        href: b.href || '',
        rect: (function(){ var r = b.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()
      })).filter(b => /沟通|投递|应聘|申请|发送|聊天|投简历/i.test(b.text + b.class));
      return JSON.stringify({
        url: window.location.href,
        title: document.title,
        allButtonsCount: buttons.length,
        matchButtons: withText.slice(0, 15),
        bodySnippet: (document.body.innerText || '').substring(0, 400)
      });
    })();
  `);
  console.log('\n=== 详情页按钮诊断 ===');
  console.log(r);
  return JSON.parse(r || '{}');
}

module.exports.diagnoseDetail = diagnoseDetail;
