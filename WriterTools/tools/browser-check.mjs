#!/usr/bin/env node
/**
 * WriterTools 浏览器独立验收脚本（Lead 维护，不依赖 QA 的 tests/e2e）
 * ================================================================
 * 用系统 Chrome（Playwright channel=chrome）对真实应用做一遍端到端检查，
 * 产出 PASS/FAIL 与截图（默认 .lead-tmp/shots/）。
 *
 * 用法：
 *   1) 先起服务：npm run dev -- --port 5174   （或 npm run build && npm run preview）
 *   2) BASE_URL=http://localhost:5174 node tools/browser-check.mjs
 *
 * 说明：FSA 备份目录选择器需要真实用户手势 + 系统弹窗，headless 无法自动化，
 * 本脚本只验证入口/状态可读；人工验证请用 --headed 并手动点击"选择备份目录"。
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5174';
const SHOTS = process.env.SHOT_DIR || '.lead-tmp/shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isNeutral(cssColor) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cssColor || '');
  if (!match) return false;
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return Math.abs(r - g) <= 4 && Math.abs(g - b) <= 4;
}

const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + String(error.message || error)));

  // ---- 1. 书架 ----
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="library-view"]', { timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/01-library-empty.png` });
  check('书架加载', true);

  // ---- 2. 新建作品 + 逐字符输入 + 删除 ----
  await page.click('[data-testid="new-doc-button"]');
  const textarea = page.locator('[data-testid="editor-textarea"]');
  await textarea.waitFor({ timeout: 10000 });
  await textarea.click();
  check('新建后进入编辑器且输入框可用', true);
  check('默认打字机模式 text-align=right', (await textarea.evaluate((el) => getComputedStyle(el).textAlign)) === 'right');

  const line1 = '第一行：你好，世界。Hello 2026。';
  const line2 = '第二行：逐字符记录，删除也要留档！';
  await page.keyboard.type(line1);
  await page.keyboard.press('Enter');
  await page.keyboard.type(line2);
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Backspace');
  await sleep(900);
  const expected = `${line1}\n${line2.slice(0, -6)}`;
  const actual = await textarea.inputValue();
  check('输入与退格后正文正确', actual === expected, JSON.stringify(actual));
  await page.screenshot({ path: `${SHOTS}/02-typewriter-light.png` });

  // ---- 3. 实时落盘：事件流（含删除位置与被删内容） ----
  const eventStats = await page.evaluate(async () => {
    const openRequest = indexedDB.open('writertools');
    const db = await new Promise((resolve, reject) => {
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(['events'], 'readonly');
      const request = tx.objectStore('events').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const events = records.map((record) => record.event);
    const byType = {};
    for (const event of events) byType[event.type] = (byType[event.type] || 0) + 1;
    const deletes = events.filter((event) => event.type === 'text.delete');
    return {
      count: events.length,
      byType,
      deleteOk: deletes.length >= 6 && deletes.every((event) =>
        typeof event.data.deleted === 'string' && event.data.deleted.length > 0 && Number.isInteger(event.data.pos)),
      lastDeletes: deletes.slice(-6).map((event) => ({ pos: event.data.pos, deleted: event.data.deleted, source: event.data.source })),
    };
  });
  check('事件实时落盘（text.insert / text.delete）', eventStats.count > 10 && eventStats.deleteOk, JSON.stringify(eventStats.byType));
  check('删除事件保存位置与被删文字', eventStats.deleteOk, JSON.stringify(eventStats.lastDeletes));

  // ---- 4. Ctrl+S 快照 + 历史面板 ----
  await page.keyboard.press('Control+s');
  await sleep(700);
  await page.click('[data-testid="editor-history-button"]');
  await page.waitForSelector('[data-testid="history-panel"]', { timeout: 5000 });
  const historyCount = await page.locator('[data-testid="history-item"]').count();
  check('Ctrl+S 生成快照并在历史可见', historyCount >= 1, `history-item=${historyCount}`);
  await page.screenshot({ path: `${SHOTS}/03-history.png` });
  await page.click('[data-testid="history-close"]');
  await sleep(300);

  // ---- 5. 居中模式 ----
  await page.click('[data-testid="mode-toggle"]');
  await sleep(400);
  check('切换居中模式 text-align=left', (await textarea.evaluate((el) => getComputedStyle(el).textAlign)) === 'left');
  await page.screenshot({ path: `${SHOTS}/04-centered-light.png` });
  await page.click('[data-testid="mode-toggle"]');
  await sleep(300);

  // ---- 6. 深色主题：纯黑背景、中性色 ----
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(500);
  const dark = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    html: getComputedStyle(document.documentElement).backgroundColor,
    text: getComputedStyle(document.querySelector('[data-testid="editor-textarea"]')).color,
  }));
  check('深色模式背景纯黑', dark.body === 'rgb(0, 0, 0)' || dark.html === 'rgb(0, 0, 0)', JSON.stringify(dark));
  check('深色模式文字为中性色', await isNeutral(dark.text), dark.text);
  await page.screenshot({ path: `${SHOTS}/05-typewriter-dark.png` });

  // ---- 7. 光标行垂直居中（滚动位置应把当前行放在视口中央） ----
  const centering = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="editor-textarea"]');
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 32;
    const paddingTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
    // 用与编辑器相同的镜像测量当前光标行位置
    const mirror = document.createElement('div');
    const cs = getComputedStyle(el);
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'width', 'whiteSpace', 'overflowWrap', 'wordBreak']) {
      mirror.style[prop] = cs[prop];
    }
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.textContent = el.value.slice(0, el.selectionStart);
    const marker = document.createElement('span');
    marker.textContent = '▍';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const caretTop = marker.offsetTop;
    mirror.remove();
    const scrollTop = el.scrollTop;
    const visibleTop = paddingTop + caretTop - scrollTop;
    return { visibleTop, lineHeight, clientHeight: el.clientHeight, scrollTop, paddingTop, caretTop };
  });
  const caretCenter = centering.visibleTop + centering.lineHeight / 2;
  check(
    '光标行垂直居中（误差 ≤ 2 行高）',
    Math.abs(caretCenter - centering.clientHeight / 2) <= centering.lineHeight * 2,
    `caretCenter=${caretCenter.toFixed(1)} viewportCenter=${(centering.clientHeight / 2).toFixed(1)}`,
  );

  // ---- 8. 刷新持久化 ----
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="library-view"]', { timeout: 15000 });
  const docCount = await page.locator('[data-testid="doc-item"]').count();
  check('刷新后书架有作品', docCount >= 1, `doc-item=${docCount}`);
  const docId = await page.locator('[data-testid="doc-item"]').first().getAttribute('data-doc-id');
  await page.locator('[data-testid="doc-item"]').first().click();
  await page.waitForSelector('[data-testid="editor-textarea"]', { timeout: 5000 });
  await sleep(500);
  check('刷新后正文持久化', (await page.locator('[data-testid="editor-textarea"]').inputValue()) === expected);

  // ---- 9. 导出 .wtlog + 独立校验器 ----
  await page.click('[data-testid="editor-library-button"]');
  await page.waitForSelector('[data-testid="library-view"]', { timeout: 5000 });
  await sleep(300);
  const item = page.locator('[data-testid="doc-item"]').first();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    item.locator('[data-testid="doc-export-button"]').click(),
  ]);
  const exportPath = `${SHOTS}/exported.wtlog`;
  await download.saveAs(exportPath);
  let lintOutput = '';
  let lintOk = false;
  try {
    lintOutput = execFileSync(process.execPath, ['tools/wtlog-check.mjs', exportPath], { encoding: 'utf8' });
    lintOk = lintOutput.includes('合规');
  } catch (error) {
    lintOutput = String(error.stdout || error.message);
  }
  check('导出 .wtlog 通过独立格式校验器', lintOk, lintOutput.split('\n').filter(Boolean).slice(-3).join(' | '));

  // ---- 10. 全新上下文导入 ----
  const freshContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const freshPage = await freshContext.newPage();
  await freshPage.goto(BASE, { waitUntil: 'networkidle' });
  await freshPage.waitForSelector('[data-testid="library-view"]', { timeout: 20000 });
  await freshPage.setInputFiles('[data-testid="import-file-input"]', exportPath);
  await freshPage.waitForSelector('[data-testid="doc-item"]', { timeout: 10000 });
  await freshPage.locator('[data-testid="doc-item"]').first().click();
  await freshPage.waitForSelector('[data-testid="editor-textarea"]', { timeout: 5000 });
  await sleep(600);
  const imported = await freshPage.locator('[data-testid="editor-textarea"]').inputValue();
  check('导出文件可在全新环境导入且正文一致', imported === expected, JSON.stringify(imported));
  await freshContext.close();

  // ---- 11. 双标签页只读锁（保持第一页停在编辑器） ----
  const duplicateId = await page.locator('[data-testid="doc-item"]').first().getAttribute('data-doc-id');
  await page.locator('[data-testid="doc-item"]').first().click();
  await page.waitForSelector('[data-testid="editor-textarea"]', { timeout: 5000 });
  const secondTab = await context.newPage();
  await secondTab.goto(BASE, { waitUntil: 'networkidle' });
  await secondTab.waitForSelector('[data-testid="library-view"]', { timeout: 15000 });
  await secondTab.locator(`[data-testid="doc-item"][data-doc-id="${duplicateId}"]`).first().click();
  await secondTab.waitForSelector('[data-testid="editor-view"]', { timeout: 5000 });
  await sleep(900);
  const readonlyVisible = await secondTab.locator('[data-testid="readonly-banner"]').isVisible().catch(() => false);
  const readOnly = await secondTab.locator('[data-testid="editor-textarea"]').evaluate((el) => el.readOnly).catch(() => null);
  check('第二标签页只读并显示横幅', readonlyVisible && readOnly === true, `banner=${readonlyVisible} readOnly=${readOnly}`);
  const readonlyToastText = await secondTab.locator('[data-testid="toast"]').allInnerTexts().catch(() => []);
  check('只读标签页不弹出写入失败错误', !readonlyToastText.some((text) => text.includes('写入失败')), JSON.stringify(readonlyToastText));
  await secondTab.close();

  // ---- 12. 设置面板：存储状态、备份入口、校验 ----
  await page.click('[data-testid="editor-settings-button"]');
  await page.waitForSelector('[data-testid="settings-panel"]', { timeout: 5000 });
  await sleep(700);
  const storageStatus = await page.locator('[data-testid="storage-status"]').innerText();
  check('设置面板可读存储安全状态', storageStatus.length > 0 && storageStatus.includes('OPFS'), storageStatus.replace(/\s+/g, ' ').slice(0, 100));
  check('备份目录入口存在', (await page.locator('[data-testid="backup-choose-button"]').count()) > 0);
  await page.screenshot({ path: `${SHOTS}/06-settings-light.png` });
  await page.click('[data-testid="settings-close"]');
  await sleep(300);

  // ---- 13. 界面无彩色抽查 ----
  const colorful = await page.evaluate(() => {
    const bad = [];
    for (const element of Array.from(document.querySelectorAll('body *')).slice(0, 300)) {
      const style = getComputedStyle(element);
      for (const property of ['color', 'backgroundColor', 'borderTopColor']) {
        const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(style[property]);
        if (!match) continue;
        const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
        const alpha = match[4] === undefined ? 1 : Number(match[4]);
        if (alpha === 0) continue;
        if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6) bad.push({ property, value: style[property], tag: element.tagName });
      }
    }
    return bad;
  });
  check('界面无彩色（中性色抽查）', colorful.length === 0, JSON.stringify(colorful.slice(0, 3)));

  // ---- 14. 移动端 390x844 ----
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(BASE, { waitUntil: 'networkidle' });
  await mobilePage.waitForSelector('[data-testid="library-view"]', { timeout: 15000 });
  await mobilePage.click('[data-testid="new-doc-button"]');
  await mobilePage.waitForSelector('[data-testid="editor-textarea"]', { timeout: 5000 });
  await mobilePage.locator('[data-testid="editor-textarea"]').click();
  await mobilePage.keyboard.type('移动端输入测试。');
  await sleep(500);
  await mobilePage.screenshot({ path: `${SHOTS}/07-mobile.png` });
  const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('移动端 390x844 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  await mobileContext.close();

  // ---- 15. 控制台错误 ----
  check('无 console/page 错误', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 4)));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`\n===== 浏览器独立验收：${results.length - failed.length}/${results.length} 通过 =====`);
console.log(`截图目录：${SHOTS}`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const item of failed) console.log(`- ${item.name} ${item.detail}`);
  process.exitCode = 1;
}
