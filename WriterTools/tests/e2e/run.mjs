#!/usr/bin/env node
/**
 * WriterTools Playwright 端到端冒烟测试
 * =====================================
 * 前置：`npm run build` 产物 + `npm run preview`（默认 http://127.0.0.1:4173）。
 * 本脚本会自动检查构建产物（缺失时自动执行 npm run build），也会尝试自己启动 preview；
 * 若服务已存在则直接复用（不负责关闭外部服务）。结束后清理自己启动的进程。
 *
 * 用法：
 *   npm run e2e                     # 构建（如需要）→ 启动 preview → 跑全部步骤 → 关闭 preview
 *   BASE_URL=http://127.0.0.1:4173 node tests/e2e/run.mjs   # 使用已有服务（脚本不启动/不关闭）
 *   node tests/e2e/run.mjs --dry-run     # 只启动 Chrome 打开首页，验证测试环境可用
 *   E2E_BUILD=1 npm run e2e              # 强制重新构建
 *   E2E_HEADLESS=0 npm run e2e           # 有头模式（调试用）
 *   E2E_CHANNEL=msedge npm run e2e       # 用 Edge 跑（默认 chrome；也可 E2E_EXECUTABLE_PATH 指定）
 *   E2E_SKIP_PWA=1 npm run e2e           # 跳过 PWA 资源/Service Worker 检查
 *
 * 输出：每步一行 PASS/FAIL；失败截图写入 tests/e2e/artifacts/；退出码非 0 表示失败。
 *
 * 说明：本脚本使用系统 Chrome（channel: 'chrome'），不下载 Playwright 自带浏览器。
 * 依赖 playwright 的 browser API 与 Node 22 内置 fetch。data-testid 契约由 UI 实现提供。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ARTIFACTS_DIR = path.join(HERE, 'artifacts');

const RAW_BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';
let BASE_URL;
try {
  BASE_URL = new URL(RAW_BASE_URL).origin;
} catch {
  console.error(`[e2e] BASE_URL 不是合法 URL：${RAW_BASE_URL}`);
  process.exit(2);
}

const HEADLESS = process.env.E2E_HEADLESS !== '0' && !process.argv.includes('--headed');
const DRY_RUN = process.argv.includes('--dry-run') || process.env.E2E_DRY === '1';
const KEEP_SERVER = process.argv.includes('--keep-server') || process.env.E2E_KEEP_SERVER === '1';
const SKIP_PWA = process.env.E2E_SKIP_PWA === '1';
const E2E_CHANNEL = process.env.E2E_CHANNEL || 'chrome';
const E2E_EXECUTABLE_PATH = process.env.E2E_EXECUTABLE_PATH || '';
const BROWSER_LABEL = E2E_EXECUTABLE_PATH ? path.basename(E2E_EXECUTABLE_PATH) : E2E_CHANNEL;

/** data-testid 契约（见 AGENTS.md / Lead 任务说明 / UI 契约消息）。 */
const SEL = {
  app: '[data-testid="app"]',
  libraryView: '[data-testid="library-view"]',
  libraryEmpty: '[data-testid="library-empty"]',
  docList: '[data-testid="doc-list"]',
  docItem: '[data-testid="doc-item"]',
  newDoc: '[data-testid="new-doc-button"]',
  importFileInput: '[data-testid="import-file-input"]',
  docExport: '[data-testid="doc-export-button"]',
  editorView: '[data-testid="editor-view"]',
  editorLibraryButton: '[data-testid="editor-library-button"]',
  textarea: '[data-testid="editor-textarea"]',
  readonlyBanner: '[data-testid="readonly-banner"]',
  historyButton: '[data-testid="editor-history-button"]',
  historyPanel: '[data-testid="history-panel"]',
  historyItem: '[data-testid="history-item"]',
  historyPreview: '[data-testid="history-preview"]',
  historyRestore: '[data-testid="history-restore-button"]',
  historyClose: '[data-testid="history-close"]',
  editorSettingsButton: '[data-testid="editor-settings-button"]',
  settingsPanel: '[data-testid="settings-panel"]',
  settingsClose: '[data-testid="settings-close"]',
  themeSelect: '[data-testid="theme-select"]',
  lightBgSelect: '[data-testid="light-bg-select"]',
  saveShortcutInput: '[data-testid="save-shortcut-input"]',
  storageStatus: '[data-testid="storage-status"]',
  verifyAllButton: '[data-testid="verify-all-button"]',
  verifyResult: '[data-testid="verify-result"]',
  backupChooseButton: '[data-testid="backup-choose-button"]',
  backupStatus: '[data-testid="backup-status"]',
  backupHealthToast: '[data-testid="backup-health-toast"]',
  backupGrantButton: '[data-testid="backup-grant-button"]',
  restoreFromBackupButton: '[data-testid="restore-from-backup-button"]',
  librarySettingsButton: '[data-testid="library-settings-button"]',
  editorTitleButton: '[data-testid="editor-title-button"]',
  titleInput: '[data-testid="title-input"]',
  exportArchiveButton: '[data-testid="export-archive-button"]',
  importArchiveInput: '[data-testid="import-archive-input"]',
  archiveImportResult: '[data-testid="archive-import-result"]',
  archiveImportModal: '[data-testid="archive-import-modal"]',
  saveToast: '[data-testid="save-toast"]',
  toast: '[data-testid="toast"]',
  autoRecoverToast: '[data-testid="auto-recover-toast"]',
  confirmDialog: '[data-testid="confirm-dialog"]',
  confirmOk: '[data-testid="confirm-ok"]',
  modeToggle: '[data-testid="mode-toggle"]',
  editorTraceButton: '[data-testid="editor-trace-button"]',
  tracePanel: '[data-testid="trace-panel"]',
  traceSummary: '[data-testid="trace-summary"]',
  traceRow: '[data-testid="trace-row"]',
  traceDetail: '[data-testid="trace-detail"]',
  tracePlayButton: '[data-testid="trace-play-button"]',
  tracePrevButton: '[data-testid="trace-prev-button"]',
  traceNextButton: '[data-testid="trace-next-button"]',
  traceClose: '[data-testid="trace-close"]',
};
const HISTORY_RESTORE_SELECTORS = [
  SEL.historyRestore,
  '[data-testid="history-restore"]',
  '[data-testid="history-item-restore"]',
];

const TYPED_PREFIX = 'WriterTools 写作测试';
const TYPED_EMOJI = '😀';
const TYPED_SUFFIX = 'hello 世界';
const TYPED_TEXT = `${TYPED_PREFIX}${TYPED_EMOJI}${TYPED_SUFFIX}`;
const BACKSPACE_COUNT = 3;
const EXPECTED_TEXT_AFTER_DELETE = TYPED_TEXT.slice(0, -BACKSPACE_COUNT);

// ---------------------------------------------------------------------------
// 输出与结果
// ---------------------------------------------------------------------------

const results = [];
let stepNo = 0;
let page = null;
let browser = null;
let context = null;
let serverChild = null;
let usingExternalServer = false;
const pageErrors = [];

function log(message) {
  console.log(`[e2e] ${message}`);
}

function warn(message) {
  console.warn(`[e2e][warn] ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

async function step(name, fn) {
  stepNo += 1;
  const label = `[${stepNo}] ${name}`;
  console.log('');
  console.log(`▶ ${label}`);
  try {
    const detail = await fn();
    results.push({ no: stepNo, name, ok: true });
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    results.push({ no: stepNo, name, ok: false, error });
    console.log(`FAIL ${label} — ${error.message}`);
    await captureFailure(stepNo, name);
    return false;
  }
}

/** 失败/关键节点截图（截图失败不影响测试结果）。 */
async function screenshot(fileName) {
  if (!page || !browser) return null;
  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const filePath = path.join(ARTIFACTS_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: false });
    log(`截图：${path.relative(ROOT, filePath)}`);
    return filePath;
  } catch (error) {
    warn(`截图失败：${error.message}`);
    return null;
  }
}

async function captureFailure(no, name) {
  const slug = name
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  await screenshot(`fail-${String(no).padStart(2, '0')}-${slug || 'step'}.png`);
}

function cleanupOldArtifacts() {
  try {
    if (!fs.existsSync(ARTIFACTS_DIR)) return;
    for (const entry of fs.readdirSync(ARTIFACTS_DIR)) {
      if (entry === '.gitignore') continue;
      fs.rmSync(path.join(ARTIFACTS_DIR, entry), { force: true, recursive: true });
    }
  } catch {
    /* 清理失败不影响测试 */
  }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询等待：predicate 返回真值即返回该值；超时抛错。
 * @template T
 * @param {() => Promise<T>|T} predicate
 * @param {{timeout?: number, interval?: number, label?: string}} [options]
 * @returns {Promise<T>}
 */
async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 10_000;
  const interval = options.interval ?? 120;
  const label = options.label || '条件';
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const suffix = lastError ? `（最后一次错误：${lastError.message}）` : '';
  throw new Error(`等待超时（${timeout}ms）：${label}${suffix}`);
}

async function locatorVisible(selector) {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return false;
  return locator.isVisible();
}

/** 等待一组选择器中任意一个可见，返回可见的选择器。 */
async function waitAnyVisible(selectors, timeout = 15_000, label) {
  return waitFor(
    async () => {
      for (const selector of selectors) {
        if (await locatorVisible(selector)) return selector;
      }
      return null;
    },
    { timeout, label: label || `任一元素可见：${selectors.join(' | ')}` },
  );
}

/** 在给出的选择器中找第一个当前可见的 locator；找不到返回 null。 */
async function findFirstVisible(selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible())) return { selector, locator };
  }
  return null;
}

async function hasServiceWorker() {
  return page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false, state: 'unsupported' };
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return { supported: true, state: 'none' };
    return {
      supported: true,
      state: registration.active ? 'active' : registration.installing ? 'installing' : registration.waiting ? 'waiting' : 'registered',
    };
  });
}

async function waitAppMounted() {
  await waitFor(
    () =>
      page.evaluate(() => {
        const root = document.querySelector('#root');
        return !!root && root.children.length > 0;
      }),
    { label: 'React 应用挂载（#root 有内容）', timeout: 20_000 },
  );
}

async function openApp(url = `${BASE_URL}/`) {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await waitAppMounted();
}

async function textareaValue() {
  return page.locator(SEL.textarea).first().inputValue();
}

/** 把光标放到 textarea 末尾（点击 textarea 会把光标定位到点击处，追加内容前必须归位）。 */
async function placeCaretAtEnd() {
  await page.locator(SEL.textarea).first().evaluate((element) => {
    const textarea = element;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  });
}

/** 当前所有 toast 的文本（toast 是短提示，2–4s 自动消失）。 */
async function toastTexts() {
  return page
    .locator(SEL.toast)
    .allInnerTexts()
    .catch(() => []);
}

/** 统计包含指定片段的 toast 数量（用于回归：不得出现"正文已同步"误报）。 */
async function countToastsContaining(fragment) {
  const texts = await toastTexts();
  return texts.filter((text) => text.includes(fragment)).length;
}

/** 读取 textarea 值、选区、光标位置。 */
async function readCaretState() {
  return page.locator(SEL.textarea).first().evaluate((element) => ({
    value: element.value,
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd,
  }));
}

/** 在书架上按标题片段找到 doc-item 的 data-doc-id（找不到返回 null）。 */
async function findDocIdByTitle(titleFragment) {
  const items = page.locator(SEL.docItem);
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const text = await item.innerText().catch(() => '');
    if (text.includes(titleFragment)) return item.getAttribute('data-doc-id');
  }
  return null;
}

// ---------------------------------------------------------------------------
// 备份目录（真实 OPFS 伪目录）自动备份场景辅助
// ---------------------------------------------------------------------------

/** 读取 OPFS 中注入的"备份目录"（默认 backup-target）全部文件内容。 */
async function readBackupDirSnapshot(dirName = 'backup-target') {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    let dir = null;
    try {
      dir = await root.getDirectoryHandle(name);
    } catch {
      return { exists: false, files: {} };
    }
    const files = {};
    try {
      for await (const [entryName, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        const file = await handle.getFile();
        files[entryName] = { size: file.size, text: await file.text() };
      }
    } catch {
      /* 忽略读取失败 */
    }
    return { exists: true, files };
  }, dirName);
}

/** 从备份目录快照解析 manifest（不存在/非法返回 null）。 */
function parseBackupManifest(snapshot) {
  const raw = snapshot?.files?.['writertools-manifest.json'];
  if (!raw) return null;
  try {
    return JSON.parse(raw.text);
  } catch {
    return null;
  }
}

/** 轮询备份目录，直到 manifest 满足条件（避免固定 sleep）。 */
async function waitBackupManifest(predicate, label, timeout = 30_000) {
  return waitFor(
    async () => {
      const snapshot = await readBackupDirSnapshot();
      if (!snapshot.exists) return null;
      const manifest = parseBackupManifest(snapshot);
      if (!manifest) return null;
      return predicate(manifest, snapshot) ? { manifest, snapshot } : null;
    },
    { timeout, label, interval: 250 },
  );
}

/** 读取 IndexedDB kv 中的备份状态（不回传目录句柄本体，避免不可序列化）。 */
async function readBackupKvState() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('writertools');
        open.onerror = () => reject(open.error || new Error('打开 IndexedDB 失败'));
        open.onsuccess = () => {
          const db = open.result;
          try {
            if (!db.objectStoreNames.contains('kv')) {
              db.close();
              resolve({ configured: false, lastBackupAt: null, docCount: null, lastError: null });
              return;
            }
            const store = db.transaction('kv', 'readonly').objectStore('kv');
            const keyNames = ['backup.dirHandle', 'backup.lastBackupAt', 'backup.lastError', 'backup.docCount'];
            const result = {};
            let pending = keyNames.length;
            for (const key of keyNames) {
              const request = store.get(key);
              request.onsuccess = () => {
                result[key] = request.result ? request.result.value : undefined;
                pending -= 1;
                if (pending === 0) {
                  db.close();
                  resolve({
                    configured: result['backup.dirHandle'] !== undefined,
                    lastBackupAt: typeof result['backup.lastBackupAt'] === 'string' ? result['backup.lastBackupAt'] : null,
                    lastError: typeof result['backup.lastError'] === 'string' ? result['backup.lastError'] : null,
                    docCount: typeof result['backup.docCount'] === 'number' ? result['backup.docCount'] : null,
                  });
                }
              };
              request.onerror = () => {
                db.close();
                reject(request.error || new Error('读取 kv 失败'));
              };
            }
          } catch (error) {
            try {
              db.close();
            } catch {
              /* 忽略 */
            }
            reject(error);
          }
        };
      }),
  );
}

/**
 * 模拟浏览器本地数据丢失：
 * - 清空 IndexedDB `writertools` 的 `docs` / `events` / `kv` 三个 store（kv 含备份目录句柄）；
 * - 删除 OPFS `docs/` 镜像目录，保留备份目录（`backup-target/`）。
 * 返回实际清空的 store 列表与镜像目录是否删除成功。
 */
async function clearLocalDataForDisaster() {
  const clearedStores = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('writertools');
        open.onerror = () => reject(open.error || new Error('打开 IndexedDB 失败'));
        open.onsuccess = () => {
          const db = open.result;
          try {
            const stores = ['docs', 'events', 'kv'].filter((name) => db.objectStoreNames.contains(name));
            const tx = db.transaction(stores, 'readwrite');
            for (const name of stores) tx.objectStore(name).clear();
            tx.oncomplete = () => {
              db.close();
              resolve(stores);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error || new Error('清空本地数据事务失败'));
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error || new Error('清空本地数据事务中止'));
            };
          } catch (error) {
            try {
              db.close();
            } catch {
              /* 忽略 */
            }
            reject(error);
          }
        };
      }),
  );
  const mirrorRemoved = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('docs', { recursive: true });
      return true;
    } catch {
      return false;
    }
  });
  return { clearedStores, mirrorRemoved };
}

/** 从 IndexedDB docs store 读取作品摘要（用于校验 docs.chars 等）。 */
async function readDocSummaryFromIdb(docId) {
  return page.evaluate(
    (targetDocId) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('writertools');
        open.onerror = () => reject(open.error || new Error('打开 IndexedDB 失败'));
        open.onsuccess = () => {
          const db = open.result;
          try {
            const request = db.transaction('docs', 'readonly').objectStore('docs').get(targetDocId);
            request.onerror = () => {
              db.close();
              reject(request.error || new Error('读取 docs 失败'));
            };
            request.onsuccess = () => {
              const record = request.result || null;
              db.close();
              resolve(record);
            };
          } catch (error) {
            try {
              db.close();
            } catch {
              /* 忽略 */
            }
            reject(error);
          }
        };
      }),
    docId,
  );
}

/**
 * 独立测量"光标行是否垂直居中"（不依赖 UI 自己的镜像实现）：
 * 在页面里临时构造一个与 textarea 同字体/宽度/换行规则的隐藏镜像，在光标处插入零宽标记，
 * 量出光标行的 offsetTop，再与 textarea 的 scrollTop/paddingTop 推算出的理想值比较。
 */
async function readCaretCenteringMetrics() {
  return page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="editor-textarea"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return null;
    const computed = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, {
      position: 'absolute',
      left: '-99999px',
      top: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      boxSizing: 'border-box',
      width: `${textarea.clientWidth}px`,
      margin: '0',
      padding: '0',
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      wordSpacing: computed.wordSpacing,
      tabSize: computed.tabSize,
      whiteSpace: 'pre-wrap',
      overflowWrap: computed.overflowWrap,
      wordBreak: computed.wordBreak,
      textAlign: computed.textAlign,
    });
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    marker.style.height = computed.lineHeight;
    const caret = Math.min(Math.max(0, textarea.selectionStart), textarea.value.length);
    mirror.append(
      document.createTextNode(textarea.value.slice(0, caret)),
      marker,
      document.createTextNode(textarea.value.slice(caret)),
    );
    document.body.appendChild(mirror);
    let caretTop = NaN;
    try {
      caretTop = marker.offsetTop;
    } finally {
      mirror.remove();
    }
    const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.7;
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
    const height = textarea.clientHeight;
    const scrollHeight = textarea.scrollHeight;
    const maxScroll = Math.max(0, scrollHeight - height);
    const ideal = Math.min(Math.max(0, paddingTop + caretTop - (height - lineHeight) / 2), maxScroll);
    return {
      caretTop,
      lineHeight,
      paddingTop,
      height,
      scrollHeight,
      maxScroll,
      scrollTop: textarea.scrollTop,
      ideal,
      caret,
      valueLength: textarea.value.length,
    };
  });
}

/** 等待并断言光标行垂直居中（误差 ≤ 1 行高）；失败时带上最后一次测量值便于定位。 */
async function assertCaretCentered(label) {
  let last = null;
  try {
    return await waitFor(
      async () => {
        const metrics = await readCaretCenteringMetrics();
        if (!metrics || !Number.isFinite(metrics.caretTop)) return null;
        last = metrics;
        const error = Math.abs(metrics.scrollTop - metrics.ideal);
        return error <= metrics.lineHeight + 1 ? { ...metrics, error } : null;
      },
      { label: `光标行垂直居中（${label}，误差 ≤ 1 行高）`, timeout: 8_000 },
    );
  } catch (error) {
    const detail = last
      ? `最后一次测量：scrollTop=${last.scrollTop.toFixed(1)} 理想值=${last.ideal.toFixed(1)} 行高=${last.lineHeight.toFixed(1)} caretTop=${last.caretTop} clientHeight=${last.height} scrollHeight=${last.scrollHeight}`
      : '无法读取测量值';
    throw new Error(`${error.message}；${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 构建 + preview 服务器
// ---------------------------------------------------------------------------

function runCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      windowsHide: true,
      ...options,
    });
    child.on('error', () => resolve({ code: -1 }));
    child.on('exit', (code) => resolve({ code: code ?? -1 }));
  });
}

/** dist 是否比源码/资源旧（源码更新后不重新构建会测到旧版本）。 */
function isDistStale(distIndex) {
  try {
    const distMtime = fs.statSync(distIndex).mtimeMs;
    const watch = [path.join(ROOT, 'src'), path.join(ROOT, 'public')];
    const files = [path.join(ROOT, 'index.html'), path.join(ROOT, 'vite.config.ts'), path.join(ROOT, 'package.json')];
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    for (const dir of watch) walk(dir);
    return files.some((file) => {
      try {
        return fs.statSync(file).mtimeMs > distMtime + 1000;
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
}

async function ensureBuild() {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  const forceBuild = process.env.E2E_BUILD === '1';
  if (fs.existsSync(distIndex) && !forceBuild) {
    if (!isDistStale(distIndex)) {
      log('构建产物存在且不旧于源码，跳过构建（E2E_BUILD=1 可强制重建）');
      return;
    }
    log('检测到源码/资源比 dist 新，自动重新构建…');
  }
  if (!fs.existsSync(distIndex)) log('dist/ 缺失：自动执行 npm run build…');
  else log(forceBuild ? 'E2E_BUILD=1：强制重新构建…' : '重新构建…');
  const { code } = await runCapture('npm', ['run', 'build']);
  if (code !== 0) {
    throw new Error(`npm run build 失败（exit ${code}），请先手动执行 npm run build 查看错误`);
  }
  if (!fs.existsSync(distIndex)) throw new Error('构建完成但 dist/index.html 不存在，请检查 vite build 输出');
  log('构建完成');
}

async function isServerUp(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isServerUp(`${BASE_URL}/`)) {
    usingExternalServer = true;
    log(`检测到已有服务器，直接使用：${BASE_URL}（脚本不负责关闭它）`);
    return;
  }
  if (process.env.BASE_URL) {
    throw new Error(`BASE_URL=${BASE_URL} 不可访问；请先启动 npm run preview，或去掉 BASE_URL 让脚本自动启动`);
  }

  const parsed = new URL(BASE_URL);
  const port = parsed.port || '4173';
  const host = parsed.hostname;
  log(`启动预览服务器：npm run preview -- --host ${host} --port ${port}`);
  serverChild = spawn('npm', ['run', 'preview', '--', '--host', host, '--port', port, '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore', // 本环境管道受限，必须 ignore
    shell: process.platform === 'win32',
    windowsHide: true,
    detached: false,
  });
  serverChild.on('error', (error) => warn(`preview 子进程错误：${error.message}`));

  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (serverChild.exitCode !== null) {
      throw new Error(`preview 进程提前退出（exit ${serverChild.exitCode}），请手动运行 npm run preview 查看原因`);
    }
    if (await isServerUp(`${BASE_URL}/`)) {
      log(`预览服务器就绪：${BASE_URL}`);
      return;
    }
    await sleep(400);
  }
  throw new Error('预览服务器启动超时（60s）');
}

function stopServer() {
  const child = serverChild;
  if (!child || usingExternalServer || KEEP_SERVER) return;
  serverChild = null;
  try {
    if (process.platform === 'win32') {
      // npm.cmd → node → vite 是多层进程，必须 /T 杀整棵树。
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
    log('已关闭自己启动的预览服务器');
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// Chrome 启动
// ---------------------------------------------------------------------------

function chromeCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
  }
  return candidates.filter((candidate) => candidate && fs.existsSync(candidate));
}

async function launchBrowser() {
  const attempts = [];
  if (E2E_EXECUTABLE_PATH) {
    attempts.push({ label: `executablePath=${E2E_EXECUTABLE_PATH}`, options: { executablePath: E2E_EXECUTABLE_PATH } });
  } else {
    attempts.push({ label: `channel=${E2E_CHANNEL}`, options: { channel: E2E_CHANNEL } });
    for (const candidate of chromeCandidates()) {
      attempts.push({ label: `executablePath=${candidate}`, options: { executablePath: candidate } });
    }
  }

  const launchArgs = ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'];
  for (const attempt of attempts) {
    try {
      const launched = await chromium.launch({ headless: HEADLESS, args: launchArgs, ...attempt.options });
      log(`浏览器启动成功：${attempt.label}${HEADLESS ? '（headless）' : '（有头）'}`);
      return launched;
    } catch (error) {
      warn(`启动尝试失败（${attempt.label}）：${String(error.message).split('\n')[0]}`);
    }
  }
  throw new Error(`无法启动浏览器（${BROWSER_LABEL}）。请确认系统 Chrome 已安装，或用 E2E_EXECUTABLE_PATH 指定路径`);
}

// ---------------------------------------------------------------------------
// IndexedDB 读取与事件解析（库名 writertools / store events / 主键 [docId, seq]）
// ---------------------------------------------------------------------------

/**
 * 读取 events store 全部记录。不会在库不存在时意外创建空库。
 * @returns {Promise<{ok: boolean, rows?: any[], reason?: string}>}
 */
async function readEventRecords() {
  return page.evaluate(async () => {
    if (!('indexedDB' in window)) return { ok: false, reason: '浏览器不支持 IndexedDB' };
    let dbNames = null;
    try {
      if (typeof indexedDB.databases === 'function') {
        dbNames = (await indexedDB.databases()).map((info) => info.name);
        if (!dbNames.includes('writertools')) {
          return { ok: false, reason: `IndexedDB 中还没有 writertools 库（现有：${dbNames.length ? dbNames.join(',') : '空'}）` };
        }
      }
    } catch {
      dbNames = null;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let openRequest;
      try {
        openRequest = indexedDB.open('writertools');
      } catch (error) {
        finish({ ok: false, reason: `indexedDB.open 抛错：${error && error.message}` });
        return;
      }
      openRequest.onerror = () => finish({ ok: false, reason: `打开数据库失败：${(openRequest.error && openRequest.error.message) || '未知错误'}` });
      openRequest.onblocked = () => finish({ ok: false, reason: '打开数据库被阻塞（可能有其它页面持有旧版本连接）' });
      openRequest.onsuccess = () => {
        const db = openRequest.result;
        try {
          if (!db.objectStoreNames.contains('events')) {
            const stores = Array.from(db.objectStoreNames);
            db.close();
            finish({ ok: false, reason: `数据库缺少 events store（现有：${stores.length ? stores.join(',') : '空'}）` });
            return;
          }
          const request = db.transaction('events', 'readonly').objectStore('events').getAll();
          request.onerror = () => {
            db.close();
            finish({ ok: false, reason: `读取 events 失败：${(request.error && request.error.message) || '未知错误'}` });
          };
          request.onsuccess = () => {
            const rows = request.result || [];
            db.close();
            finish({ ok: true, rows });
          };
        } catch (error) {
          try {
            db.close();
          } catch {
            /* 忽略 */
          }
          finish({ ok: false, reason: `读取 events 异常：${error && error.message}` });
        }
      };
    });
  });
}

/**
 * 把一条存储记录归一化为事件视图。兼容几种常见存储形态：
 *  { docId, seq, event: {...} } / { docId, seq, ...envelope } / { docId, seq, json: '...' }
 */
function toEventView(record) {
  if (!record || typeof record !== 'object') return null;

  let env = record;
  let nested = null;
  if (record.event && typeof record.event === 'object') nested = record.event;
  else if (record.payload && typeof record.payload === 'object') nested = record.payload;
  else if (record.value && typeof record.value === 'object' && typeof record.value.type === 'string') nested = record.value;
  if (nested) env = nested;
  else if (typeof record.event === 'string' || typeof record.json === 'string' || typeof record.value === 'string') {
    const text = typeof record.event === 'string' ? record.event : typeof record.json === 'string' ? record.json : record.value;
    try {
      env = JSON.parse(text);
    } catch {
      return null;
    }
  }

  let data = env.data && typeof env.data === 'object' ? env.data : {};
  if (typeof env.data === 'string') {
    try {
      data = JSON.parse(env.data);
    } catch {
      data = {};
    }
  }

  const seq = Number.isInteger(record.seq) ? record.seq : Number.isInteger(env.seq) ? env.seq : null;
  const docId =
    (typeof record.docId === 'string' && record.docId) ||
    (typeof record.docId === 'number' && String(record.docId)) ||
    (typeof env.docId === 'string' && env.docId) ||
    (typeof data.docId === 'string' && data.docId) ||
    null;

  return {
    docId,
    seq,
    type: typeof env.type === 'string' ? env.type : null,
    affects: typeof env.affects === 'string' ? env.affects : null,
    prev: env.prev,
    hash: env.hash,
    id: env.id,
    ts: env.ts,
    magic: env.magic,
    format: env.format,
    data,
  };
}

/** @returns {Map<string, ReturnType<typeof toEventView>[]>} docId → 事件（按 seq 升序） */
function groupEventsByDoc(records) {
  const groups = new Map();
  for (const record of records) {
    const view = toEventView(record);
    if (!view) continue;
    const key = view.docId || '__unknown_doc__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(view);
  }
  for (const events of groups.values()) {
    events.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
  }
  return groups;
}

/** 选包含 text.insert 的文档组（e2e 只建一个文档；多个时选事件最多的）。 */
function chooseDocGroup(groups) {
  const candidates = [...groups.entries()].filter(([, events]) => events.some((event) => event.type === 'text.insert'));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b[1].length - a[1].length);
  const [docId, events] = candidates[0];
  return { docId, events };
}

/** 轮询数据库直到 predicate(group) 返回真值。 */
async function waitForDocEvents(predicate, label, timeout = 8_000) {
  return waitFor(
    async () => {
      const result = await readEventRecords();
      if (!result.ok || !result.rows) return null;
      const group = chooseDocGroup(groupEventsByDoc(result.rows));
      if (!group) return null;
      return predicate(group) ? group : null;
    },
    { timeout, label },
  );
}

/** 读取当前文档的事件组（用于"写入后再校验"的场景）。 */
async function readCurrentDocGroup(label = '读取当前文档事件流', timeout = 8_000) {
  return waitFor(
    async () => {
      const result = await readEventRecords();
      if (!result.ok || !result.rows) return null;
      return chooseDocGroup(groupEventsByDoc(result.rows));
    },
    { timeout, label },
  );
}

// ---------------------------------------------------------------------------
// 多副本（OPFS 镜像 / IndexedDB 主存储）操作：用于"主存储破坏 → 自动恢复"场景
// ---------------------------------------------------------------------------

/** 读取某作品的 OPFS 镜像文本（docs/<docId>.wtlog）；不存在/不可用返回 null。 */
async function readOpfsMirrorText(docId) {
  return page.evaluate(async (targetDocId) => {
    try {
      if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
      const root = await navigator.storage.getDirectory();
      const docsDir = await root.getDirectoryHandle('docs');
      const fileHandle = await docsDir.getFileHandle(`${targetDocId}.wtlog`);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }, docId);
}

/** 删除 IndexedDB `writertools`/`events` 中某 docId 的全部事件（保留 docs 记录）。 */
async function deleteDocEventsFromIdb(docId) {
  return page.evaluate(
    (targetDocId) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('writertools');
        open.onerror = () => reject(open.error || new Error('打开 IndexedDB 失败'));
        open.onblocked = () => reject(new Error('打开 IndexedDB 被阻塞'));
        open.onsuccess = () => {
          const db = open.result;
          try {
            if (!db.objectStoreNames.contains('events')) throw new Error('events store 不存在');
            const tx = db.transaction('events', 'readwrite');
            const range = IDBKeyRange.bound([targetDocId, 0], [targetDocId, Number.MAX_SAFE_INTEGER]);
            tx.objectStore('events').delete(range);
            tx.oncomplete = () => {
              db.close();
              resolve(true);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error || new Error('删除事件事务失败'));
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error || new Error('删除事件事务中止'));
            };
          } catch (error) {
            try {
              db.close();
            } catch {
              /* 忽略 */
            }
            reject(error);
          }
        };
      }),
    docId,
  );
}

/** 统计 IndexedDB 中某 docId 的事件行数（主存储实际行数）。 */
async function countDocEventsInIdb(docId) {
  return page.evaluate(
    (targetDocId) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('writertools');
        open.onerror = () => reject(open.error || new Error('打开 IndexedDB 失败'));
        open.onsuccess = () => {
          const db = open.result;
          try {
            const range = IDBKeyRange.bound([targetDocId, 0], [targetDocId, Number.MAX_SAFE_INTEGER]);
            const request = db.transaction('events', 'readonly').objectStore('events').count(range);
            request.onerror = () => {
              db.close();
              reject(request.error || new Error('计数失败'));
            };
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
          } catch (error) {
            try {
              db.close();
            } catch {
              /* 忽略 */
            }
            reject(error);
          }
        };
      }),
    docId,
  );
}

/** 按格式规范 v1.0 重放 text 事件，顺带校验 deleted 与坐标。 */
function replayText(events) {
  let text = '';
  for (const event of events) {
    if (event.affects !== 'text') continue;
    const data = event.data || {};
    if (event.type === 'text.insert') {
      const pos = data.pos;
      if (!Number.isInteger(pos) || pos < 0 || pos > text.length) {
        throw new Error(`text.insert 的 pos 非法（seq ${event.seq}）：${JSON.stringify(data.pos)}`);
      }
      if (typeof data.text !== 'string' || data.text.length === 0) {
        throw new Error(`text.insert 的 text 必须是非空字符串（seq ${event.seq}）`);
      }
      text = text.slice(0, pos) + data.text + text.slice(pos);
    } else if (event.type === 'text.delete') {
      const pos = data.pos;
      const length = data.length;
      if (!Number.isInteger(pos) || !Number.isInteger(length) || length <= 0 || pos + length > text.length) {
        throw new Error(`text.delete 的 pos/length 非法（seq ${event.seq}）：${JSON.stringify({ pos, length })}`);
      }
      const actual = text.slice(pos, pos + length);
      if (actual !== data.deleted) {
        throw new Error(`text.delete 的 deleted 与当时正文不一致（seq ${event.seq}）：期望 ${JSON.stringify(actual)}，实际 ${JSON.stringify(data.deleted)}`);
      }
      text = text.slice(0, pos) + text.slice(pos + length);
    } else if (event.type === 'text.replace') {
      const pos = data.pos;
      const length = data.length;
      const next = typeof data.text === 'string' ? data.text : '';
      if (!Number.isInteger(pos) || !Number.isInteger(length) || pos + length > text.length) {
        throw new Error(`text.replace 的 pos/length 非法（seq ${event.seq}）`);
      }
      if (text.slice(pos, pos + length) !== (typeof data.deleted === 'string' ? data.deleted : '')) {
        throw new Error(`text.replace 的 deleted 与当时正文不一致（seq ${event.seq}）`);
      }
      text = text.slice(0, pos) + next + text.slice(pos + length);
    } else if (event.type === 'text.reset') {
      text = typeof data.text === 'string' ? data.text : '';
    } else {
      throw new Error(`未知的 affects=text 事件类型：${event.type}（seq ${event.seq}），当前实现无法安全重放`);
    }
  }
  return text;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 校验 seq 连续、prev 链、hash/affects/ts 等必需字段（对应 docs/FILE-FORMAT.md 第 3、4 节）。 */
function assertEventEnvelope(events) {
  assert(events.length >= 2, `事件太少（${events.length} 条）`);
  assertEqual(events[0].seq, 0, '第一条事件 seq 必须为 0');
  assertEqual(events[0].type, 'doc.init', '第一条事件必须是 header doc.init');
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assertEqual(event.seq, index, `seq 不连续：第 ${index} 条事件的 seq 为 ${event.seq}`);
    assert(event.affects === 'text' || event.affects === 'meta', `seq ${index} 的 affects 非法：${JSON.stringify(event.affects)}`);
    assert(typeof event.type === 'string' && /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(event.type), `seq ${index} 的 type 非法：${JSON.stringify(event.type)}`);
    assert(typeof event.prev === 'string', `seq ${index} 缺少 prev`);
    assert(typeof event.hash === 'string' && HASH_PATTERN.test(event.hash), `seq ${index} 的 hash 非法：${JSON.stringify(event.hash)}`);
    assert(typeof event.ts === 'string' && TS_PATTERN.test(event.ts), `seq ${index} 的 ts 非法：${JSON.stringify(event.ts)}`);
    if (index === 0) {
      assertEqual(event.prev, '', 'header 的 prev 必须为空字符串');
      assertEqual(event.magic, 'writertools-log', 'header 的 magic 必须是 writertools-log');
      assertEqual(event.format, '1.0', 'header 的 format 必须是 1.0');
      assert(typeof event.data.docId === 'string' && event.data.docId.length > 0, 'header data.docId 缺失');
    } else {
      assertEqual(event.prev, events[index - 1].hash, `seq ${index} 的 prev 与上一行 hash 不匹配（哈希链断裂）`);
    }
  }
}

/**
 * 调用独立校验器 tools/wtzip-check.mjs（--json）；同样用文件重定向避免管道限制。
 * 校验：ZIP 容器、manifest 字段/锚点/fileHash、每个 .wtlog 条目（内部再调用 wtlog-check）。
 */
async function runWtzipChecker(filePath) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const outPath = path.join(ARTIFACTS_DIR, `wtzip-check-${stamp}.json`);
  const errPath = path.join(ARTIFACTS_DIR, `wtzip-check-${stamp}.err`);
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result = { status: -1 };
  try {
    result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'wtzip-check.mjs'), '--json', filePath], {
      cwd: ROOT,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 60_000,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  let reports = [];
  try {
    reports = JSON.parse(stdout);
  } catch {
    reports = [];
  }
  return {
    status: result.status,
    stdout,
    stderr,
    reports,
    output: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim(),
    errors: Array.isArray(reports[0]?.errors) ? reports[0].errors : [],
  };
}

/** 用 fflate 解压 .wtzip，返回 { bytes, entries(名→Uint8Array), manifest(JSON) }。 */
function readArchiveFromDisk(filePath) {
  const bytes = fs.readFileSync(filePath);
  const rawEntries = unzipSync(new Uint8Array(bytes));
  const entries = {};
  for (const [name, data] of Object.entries(rawEntries)) {
    if (!name.endsWith('/')) entries[name] = data;
  }
  const manifestBytes = entries['writertools-manifest.json'];
  const manifest = manifestBytes ? JSON.parse(strFromU8(manifestBytes)) : null;
  return { bytes, entries, manifest };
}

function sha256BufHex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 调用训练数据导出工具 tools/wtlog-to-training.mjs：
 * 把 .wtlog 转为 JSONL（--out）并把摘要写到 --summary 文件（避免管道限制）。
 */
async function runTrainingExport(inputPath) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const outPath = path.join(ARTIFACTS_DIR, 'training-export.jsonl');
  const summaryPath = path.join(ARTIFACTS_DIR, 'training-export-summary.json');
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tools', 'wtlog-to-training.mjs'), inputPath, '--out', outPath, '--summary', summaryPath],
    { cwd: ROOT, stdio: 'ignore', windowsHide: true, timeout: 60_000 },
  );
  let lines = [];
  if (fs.existsSync(outPath)) {
    lines = fs
      .readFileSync(outPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  }
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    summary = null;
  }
  return { status: result.status, lines, summary, outPath, summaryPath };
}
async function runWtlogChecker(filePath) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const outPath = path.join(ARTIFACTS_DIR, `wtlog-check-${stamp}.json`);
  const errPath = path.join(ARTIFACTS_DIR, `wtlog-check-${stamp}.err`);
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result = { status: -1 };
  try {
    result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'wtlog-check.mjs'), '--json', filePath], {
      cwd: ROOT,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 30_000,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  let reports = [];
  try {
    reports = JSON.parse(stdout);
  } catch {
    reports = [];
  }
  return {
    status: result.status,
    stdout,
    stderr,
    reports,
    output: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim(),
    errors: Array.isArray(reports[0]?.errors) ? reports[0].errors : [],
  };
}

// ---------------------------------------------------------------------------
// 测试步骤
// ---------------------------------------------------------------------------

const state = {
  editorTextAfterDelete: '',
  textBeforeReload: '',
  docId: null,
  composeMethod: '',
  snapshotText: '',
  exportedText: '',
  exportPath: '',
  autoRecoveredDocId: '',
  autoRecoveredText: '',
  archivePath: '',
  archiveDocuments: [],
  archiveTruncatedPath: '',
};

async function stepPwa() {
  if (SKIP_PWA) {
    log('E2E_SKIP_PWA=1，跳过 PWA 检查');
    return '已按 E2E_SKIP_PWA 跳过';
  }

  const manifestResponse = await fetch(`${BASE_URL}/manifest.webmanifest`);
  assert(manifestResponse.ok, `/manifest.webmanifest 不可访问（HTTP ${manifestResponse.status}）`);
  const manifest = await manifestResponse.json();
  assert(typeof manifest.name === 'string' && manifest.name.length > 0, 'manifest 缺少 name');
  assert(manifest.start_url === '/', `manifest.start_url 应为 /（实际 ${JSON.stringify(manifest.start_url)}）`);
  assert(manifest.display === 'standalone', `manifest.display 应为 standalone（实际 ${JSON.stringify(manifest.display)}）`);
  assert(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'manifest.icons 至少要有 3 个条目');

  const expectedIcons = [
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  for (const expected of expectedIcons) {
    const icon = manifest.icons.find((candidate) => candidate.src === expected.src);
    assert(icon, `manifest.icons 缺少 ${expected.src}`);
    assertEqual(icon.sizes, expected.sizes, `${expected.src} 的 sizes 不一致`);
    assertEqual(icon.type, expected.type, `${expected.src} 的 type 不一致`);
    if (expected.purpose) assertEqual(icon.purpose, expected.purpose, `${expected.src} 的 purpose 不一致`);
    const iconResponse = await fetch(`${BASE_URL}${expected.src}`);
    assert(iconResponse.ok, `${expected.src} 不可访问（HTTP ${iconResponse.status}）`);
    if (expected.type === 'image/png') {
      const bytes = new Uint8Array(await iconResponse.arrayBuffer());
      assert(bytes.length > 24, `${expected.src} 内容过短`);
      const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      assert(pngMagic.every((value, index) => bytes[index] === value), `${expected.src} 不是合法 PNG`);
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      assertEqual(`${width}x${height}`, expected.sizes, `${expected.src} 实际尺寸与 manifest 不一致`);
    } else {
      const text = await iconResponse.text();
      assert(text.includes('<svg'), `${expected.src} 不是合法 SVG`);
    }
  }

  const swResponse = await fetch(`${BASE_URL}/sw.js`);
  assert(swResponse.ok, `/sw.js 不可访问（HTTP ${swResponse.status}）`);
  const swText = await swResponse.text();
  assert(swText.includes("addEventListener('install'") || swText.includes('addEventListener("install"'), 'sw.js 缺少 install 处理');
  assert(swText.includes("addEventListener('fetch'") || swText.includes('addEventListener("fetch"'), 'sw.js 缺少 fetch 处理');

  // Service Worker 只在应用页面注册（生产构建），所以必须先打开首页再检查。
  await openApp();
  const swState = await waitFor(
    async () => {
      const current = await hasServiceWorker();
      return current.state === 'active' || current.state === 'registered' || current.state === 'waiting' || current.state === 'installing' ? current.state : null;
    },
    { label: 'Service Worker 注册（应用页面）', timeout: 20_000 },
  ).catch(() => null);
  assert(swState, 'Service Worker 未注册（生产构建注册逻辑是否生效？）');

  // 离线应用壳：等 SW 接管页面后断网重载，应能从缓存打开。
  let offlineNote = '；离线检查已跳过';
  if (swState !== 'active') {
    await waitFor(
      () => page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active ? true : null;
      }),
      { label: 'Service Worker 激活', timeout: 20_000 },
    ).catch(() => null);
  }
  const controlled = await waitFor(() => page.evaluate(() => (navigator.serviceWorker.controller ? true : null)), {
    label: '页面被 Service Worker 接管',
    timeout: 15_000,
  }).catch(() => null);

  if (!controlled) {
    warn('Service Worker 尚未接管页面，跳过离线重载检查');
    offlineNote = '；未接管页面，离线检查跳过';
  } else if (process.env.E2E_SKIP_OFFLINE === '1') {
    offlineNote = '；离线检查已按 E2E_SKIP_OFFLINE=1 跳过';
  } else {
    let offlineError = null;
    try {
      await context.setOffline(true);
      await page.reload({ waitUntil: 'load', timeout: 25_000 });
      await waitAppMounted();
      const offlineVisible = await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem], 15_000, '离线重载后书架可见');
      log(`离线重载成功（应用壳来自缓存）：${offlineVisible}`);
      offlineNote = '；离线重载可打开应用壳';
    } catch (error) {
      offlineError = error;
    } finally {
      await context.setOffline(false).catch(() => {});
      // 无论离线检查是否成功，都恢复在线页面，避免污染后续步骤。
      try {
        await page.reload({ waitUntil: 'load', timeout: 30_000 });
        await waitAppMounted();
      } catch (error) {
        warn(`离线检查后恢复在线页面失败：${String(error.message).split('\n')[0]}`);
      }
    }
    if (offlineError) {
      throw new Error(`Service Worker 离线打开失败：${String(offlineError.message).split('\n')[0]}`);
    }
  }

  return `manifest/图标/sw.js 均可用，SW 状态 ${swState}${offlineNote}`;
}

async function stepLibraryAndCreate() {
  // PWA 步骤已经打开过首页；PWA 被跳过时这里负责首次导航。
  if (!page.url().startsWith(`${BASE_URL}/`)) await openApp();
  else await waitAppMounted();

  await screenshot('01-library.png');
  const librarySelector = await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '书架可见（library-empty 或 doc-list）');
  log(`书架可见：${librarySelector}`);
  assert(await locatorVisible(SEL.libraryView), 'library-view 可见');

  const newDocButton = page.locator(SEL.newDoc).first();
  await newDocButton.waitFor({ state: 'visible', timeout: 10_000 });
  await newDocButton.click();

  await waitAnyVisible([SEL.editorView], 15_000, '编辑器视图 editor-view 可见');
  const textarea = await waitAnyVisible([SEL.textarea], 15_000, '编辑输入区 editor-textarea 可见');
  assert(textarea, 'editor-textarea 不可见');

  const focused = await waitFor(
    () => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-testid') === 'editor-textarea'),
    { label: '新文档创建后 textarea 自动聚焦', timeout: 8_000 },
  );
  assert(focused, '新文档创建后 textarea 未获得焦点');
  await screenshot('02-editor-new.png');
  return `书架 → 新建 → 编辑器可见且聚焦（${librarySelector}）`;
}

/**
 * 回归：快速连续输入（无 delay、含空格）时，引擎回声识别不得误报"正文已同步"，
 * 正文不得被回滚，光标必须停在末尾。对应 Lead 截图验收发现的真实 bug。
 */
async function stepRapidTypingRegression() {
  await placeCaretAtEnd();
  const valueBefore = await textareaValue();
  const first = 'a b c d e f g h i j k l m n o p q r s t u v';
  await page.keyboard.type(first); // 无 delay 的快速击键（含空格）
  await waitFor(async () => (await textareaValue()) === valueBefore + first, {
    label: '快速输入英文（含空格）后 textarea.value 正确',
    timeout: 8_000,
  });
  await sleep(1_500);
  const echoAfterFirst = await countToastsContaining('正文已同步');
  assertEqual(echoAfterFirst, 0, '快速连续输入后出现"正文已同步"toast（回声识别误报回归）');
  const stateAfterFirst = await readCaretState();
  assertEqual(stateAfterFirst.value, valueBefore + first, '等待 1.5s 后 textarea.value 被回滚（回声误判导致）');
  assertEqual(stateAfterFirst.selectionStart, stateAfterFirst.value.length, '快速输入后光标不在文本末尾');
  assertEqual(stateAfterFirst.selectionEnd, stateAfterFirst.value.length, '快速输入后选区不在文本末尾');
  log(`快速输入 ${first.length} 字符（含空格）：0 条"正文已同步"，value 未回滚，光标在末尾`);

  const spaces = ' '.repeat(40);
  await page.keyboard.type(spaces);
  await waitFor(async () => (await textareaValue()) === valueBefore + first + spaces, {
    label: '快速输入 40 个空格后 textarea.value 正确',
    timeout: 8_000,
  });
  await sleep(1_500);
  const echoAfterSpaces = await countToastsContaining('正文已同步');
  assertEqual(echoAfterSpaces, 0, '快速连续输入 40 个空格后出现"正文已同步"toast（回声识别误报回归）');
  const stateAfterSpaces = await readCaretState();
  assertEqual(stateAfterSpaces.value, valueBefore + first + spaces, '等待 1.5s 后 textarea.value 被回滚（空格输入）');
  assertEqual(stateAfterSpaces.selectionStart, stateAfterSpaces.value.length, '40 个空格快速输入后光标不在末尾');
  state.editorTextAfterDelete = stateAfterSpaces.value;
  await screenshot('03-rapid-typing.png');
  return `快速输入 ${first.length} 字符 + 40 空格：0 条"正文已同步"、正文未回滚、光标在末尾`;
}

async function stepTypingAndBackspace() {
  await placeCaretAtEnd();
  const base = await textareaValue();
  await page.keyboard.type(TYPED_PREFIX, { delay: 10 });
  await page.keyboard.insertText(TYPED_EMOJI);
  await page.keyboard.type(TYPED_SUFFIX, { delay: 10 });

  const fullText = `${base}${TYPED_TEXT}`;
  await waitFor(async () => (await textareaValue()) === fullText, { label: '输入内容写入 textarea', timeout: 8_000 });
  log(`已输入 ${TYPED_TEXT.length} 个 UTF-16 码元：${JSON.stringify(TYPED_TEXT)}（此前已有 ${base.length} 码元）`);

  for (let index = 0; index < BACKSPACE_COUNT; index += 1) {
    await page.keyboard.press('Backspace');
    await sleep(60);
  }
  const expectedAfterDelete = fullText.slice(0, -BACKSPACE_COUNT);
  await waitFor(async () => (await textareaValue()) === expectedAfterDelete, {
    label: `退格 ${BACKSPACE_COUNT} 次后 textarea.value 正确`,
    timeout: 8_000,
  });

  state.editorTextAfterDelete = expectedAfterDelete;
  await screenshot('03-editor-typed.png');
  return `输入中文/英文/emoji，退格 ${BACKSPACE_COUNT} 次后 value 正确`;
}

async function stepIndexedDbTextEvents() {
  const group = await waitForDocEvents(
    (candidate) => candidate.events.some((event) => event.type === 'text.insert') && candidate.events.some((event) => event.type === 'text.delete'),
    'IndexedDB 中同时出现 text.insert 与 text.delete',
    10_000,
  );
  log(`文档 ${group.docId} 共 ${group.events.length} 条事件`);

  assertEventEnvelope(group.events);

  const inserted = group.events.filter((event) => event.type === 'text.insert');
  const deleted = group.events.filter((event) => event.type === 'text.delete');
  assert(inserted.length > 0, '缺少 text.insert 事件');
  assert(deleted.length > 0, '缺少 text.delete 事件（退格没有被逐字符记录）');

  for (const event of deleted) {
    assert(typeof event.data.deleted === 'string' && event.data.deleted.length > 0, `text.delete 的 deleted 为空（seq ${event.seq}）`);
    assert(Number.isInteger(event.data.pos), `text.delete 的 pos 不是整数（seq ${event.seq}）：${JSON.stringify(event.data.pos)}`);
    assert(Number.isInteger(event.data.length) && event.data.length > 0, `text.delete 的 length 非法（seq ${event.seq}）`);
  }
  for (const event of inserted) {
    assert(typeof event.data.text === 'string' && event.data.text.length > 0, `text.insert 的 text 为空（seq ${event.seq}）`);
    assert(Number.isInteger(event.data.pos), `text.insert 的 pos 不是整数（seq ${event.seq}）`);
  }

  const replayed = replayText(group.events);
  assertEqual(replayed, state.editorTextAfterDelete, '按事件流重放出的正文与 textarea.value 不一致');

  const hashSet = new Set(group.events.map((event) => event.hash));
  const deletes = deleted.map((event) => JSON.stringify(event.data.deleted)).join(',');
  await screenshot('04-indexeddb.png');
  return `${inserted.length} 条 insert / ${deleted.length} 条 delete（deleted=${deletes}），seq 连续、哈希链完整、重放一致，${hashSet.size} 个 hash`;
}

async function stepCompositionEvents() {
  const textarea = page.locator(SEL.textarea).first();
  const valueBefore = await textareaValue();
  let method = '';

  // 方式 1：CDP 真实 IME 组合（Input.imeSetComposition）。
  try {
    const cdp = await context.newCDPSession(page);
    try {
      await textarea.focus();
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
      await sleep(120);
      await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
      await sleep(120);
      // 取消组合（把预编辑串置空），不提交正文，避免影响后续断言。
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    } finally {
      await cdp.detach().catch(() => {});
    }
    const group = await waitForDocEvents(
      (candidate) => candidate.events.some((event) => typeof event.type === 'string' && event.type.startsWith('compose.')),
      'CDP IME 组合后出现 compose.* 事件',
      5_000,
    ).catch(() => null);
    if (group) {
      method = 'CDP Input.imeSetComposition';
      log(`CDP IME 成功记录 compose.*：${group.events.filter((event) => event.type.startsWith('compose.')).map((event) => event.type).join(', ')}`);
    } else {
      log('CDP Input.imeSetComposition 未产生 compose.* 落盘，降级为合成 CompositionEvent');
    }
  } catch (error) {
    log(`CDP IME 方式不可用：${String(error.message).split('\n')[0]}，降级为合成 CompositionEvent`);
  }

  // 方式 2：在 textarea 上派发合成 composition 事件（兜底）。
  if (!method) {
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="editor-textarea"]');
      if (!textarea) throw new Error('找不到 editor-textarea');
      textarea.focus();
      const fire = (type, data) => textarea.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: true }));
      fire('compositionstart', 'ni');
      fire('compositionupdate', 'ni');
      fire('compositionupdate', 'nihao');
      fire('compositionend', '你好');
    });
    method = '合成 CompositionEvent';
  }

  const group = await waitForDocEvents(
    (candidate) => candidate.events.some((event) => typeof event.type === 'string' && event.type.startsWith('compose.')),
    `记录 compose.* 事件（方式：${method}）`,
    8_000,
  );
  const composeEvents = group.events.filter((event) => typeof event.type === 'string' && event.type.startsWith('compose.'));
  assert(composeEvents.length >= 1, '没有 compose.* 事件落盘');
  assert(
    composeEvents.some((event) => event.type === 'compose.start'),
    `缺少 compose.start（实际：${composeEvents.map((event) => event.type).join(', ')}）`,
  );
  for (const event of composeEvents) {
    assertEqual(event.affects, 'meta', `${event.type} 的 affects 应为 meta`);
    assert(typeof event.data === 'object' && event.data !== null, `${event.type} 缺少 data 载荷`);
  }
  // 组合事件不应改变正文（规范 5.3）；若 CDP 意外提交了文字，这里只记录，不判失败。
  const valueAfter = await textareaValue();
  if (valueAfter !== valueBefore) {
    warn(`IME 测试过程中 textarea.value 发生变化（${valueBefore.length} → ${valueAfter.length} 字符），后续持久化断言以当前值为准`);
  }

  // 重新校验哈希链（包含 compose 事件）。
  const freshResult = await readEventRecords();
  if (freshResult.ok && freshResult.rows) {
    const freshGroup = chooseDocGroup(groupEventsByDoc(freshResult.rows));
    if (freshGroup) assertEventEnvelope(freshGroup.events);
  }

  state.composeMethod = method;
  state.textBeforeReload = valueAfter;
  await screenshot('05-composition.png');
  return `compose.* ${composeEvents.length} 条（${[...new Set(composeEvents.map((event) => event.type))].join(', ')}；方式：${method}）`;
}

async function stepReloadPersistence() {
  state.textBeforeReload = await textareaValue();
  await page.reload({ waitUntil: 'load', timeout: 30_000 });
  await waitAppMounted();

  const visible = await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem, SEL.editorView], 15_000, '刷新后回到书架或编辑器');
  log(`刷新后可见：${visible}`);

  if (visible === SEL.editorView) {
    await waitAnyVisible([SEL.textarea], 10_000, '刷新后自动恢复编辑器 textarea');
    log('刷新后应用自动恢复了上次编辑的文档');
  } else {
    const docItemVisible = await waitAnyVisible([SEL.docItem, SEL.docList], 10_000, '刷新后书架出现 doc-item');
    if (docItemVisible === SEL.docList) {
      // doc-list 存在但可能还没有条目，等一下 doc-item。
      await waitAnyVisible([SEL.docItem], 10_000, '刷新后 doc-item 出现');
    }
    const firstDocItem = page.locator(SEL.docItem).first();
    state.docId = await firstDocItem.getAttribute('data-doc-id');
    assert(state.docId, 'doc-item 缺少 data-doc-id 属性');
    log(`刷新后找到作品：${state.docId}`);
    await firstDocItem.click();
    await waitAnyVisible([SEL.editorView], 15_000, '点击 doc-item 后进入编辑器');
  }

  await waitAnyVisible([SEL.textarea], 10_000, '刷新后 textarea 可见');
  const valueAfterReload = await waitFor(async () => {
    const value = await textareaValue();
    return value.length > 0 ? value : null;
  }, { label: '刷新后正文从 IndexedDB 恢复', timeout: 10_000 });
  assertEqual(valueAfterReload, state.textBeforeReload, '刷新后 textarea.value 与刷新前不一致（持久化失败）');
  await screenshot('06-reloaded.png');
  return `刷新后打开作品，正文恢复 ${valueAfterReload.length} 个码元且与刷新前一致（docId=${state.docId || '自动恢复'}）`;
}

async function stepSaveShortcutAndHistory() {
  const textarea = page.locator(SEL.textarea).first();
  await textarea.click();

  const expectedSnapshotText = await textareaValue();
  await page.keyboard.press('Control+s');

  // UI 契约：Ctrl+S → snapshot(manual) + save-toast（"已保存"，约 1.8s 后消失），需立即检查。
  const toastSelector = await waitAnyVisible([SEL.saveToast, SEL.toast], 5_000, '保存提示 save-toast 出现').catch(() => null);
  if (toastSelector) log(`保存提示可见：${toastSelector}`);
  else warn('Ctrl+S 后未观察到 save-toast/toast 提示（不致命，继续校验事件落盘）');

  const group = await waitForDocEvents(
    (candidate) => candidate.events.some((event) => event.type === 'snapshot'),
    'Ctrl+S 后出现 snapshot 事件',
    10_000,
  );
  const snapshot = group.events.filter((event) => event.type === 'snapshot').at(-1);
  assert(snapshot, 'snapshot 事件不存在');
  assert(typeof snapshot.data.reason === 'string' && snapshot.data.reason.length > 0, 'snapshot.data.reason 缺失');
  assert(typeof snapshot.data.text === 'string', 'snapshot.data.text 缺失（快照应包含完整正文）');
  assert(Number.isInteger(snapshot.data.chars), 'snapshot.data.chars 缺失');
  assertEqual(snapshot.data.text, expectedSnapshotText, '快照里的正文与当前 textarea.value 不一致');
  assert(typeof snapshot.data.textHash === 'string' && HASH_PATTERN.test(snapshot.data.textHash), 'snapshot.data.textHash 非法');
  assertEqual(snapshot.data.chars, snapshot.data.text.length, 'snapshot.data.chars 应等于正文 UTF-16 长度');
  state.snapshotText = snapshot.data.text;
  log(`快照落盘：seq=${snapshot.seq} reason=${snapshot.data.reason} chars=${snapshot.data.chars}`);

  const historyButton = page.locator(SEL.historyButton).first();
  await historyButton.waitFor({ state: 'visible', timeout: 10_000 });
  await historyButton.click();
  await waitAnyVisible([SEL.historyPanel], 10_000, '历史面板 history-panel 可见');
  const historyItems = page.locator(SEL.historyItem);
  const itemCount = await waitFor(async () => {
    const count = await historyItems.count();
    return count > 0 ? count : null;
  }, { label: '历史面板中出现 history-item', timeout: 8_000 });
  log(`历史面板可见，共 ${itemCount} 个 history-item`);

  // 预览：点击对应快照的 history-item，history-preview 只读区应显示该快照正文。
  const exactItem = page.locator(`${SEL.historyItem}[data-seq="${snapshot.seq}"]`).first();
  const itemToClick = (await exactItem.count()) > 0 ? exactItem : historyItems.last();
  await itemToClick.click();
  await waitAnyVisible([SEL.historyPreview], 8_000, '历史预览区 history-preview 可见');
  const previewText = await page.locator(SEL.historyPreview).first().innerText();
  assert(previewText.trim().length > 0, 'history-preview 没有显示快照正文');
  await screenshot('07-history.png');
  log(`历史预览可见（${previewText.trim().length} 字符）`);

  // 恢复：history-restore-button → confirm-dialog → confirm-ok；恢复后正文应与快照一致。
  const restoreButton = page.locator(HISTORY_RESTORE_SELECTORS.join(',')).first();
  await restoreButton.waitFor({ state: 'visible', timeout: 8_000 });
  await restoreButton.click();
  await waitAnyVisible([SEL.confirmDialog], 8_000, '恢复确认弹窗 confirm-dialog 可见');
  await page.locator(SEL.confirmOk).first().click();
  // 恢复真实提示（"已恢复"）必须保留——回归：不能为了消除"正文已同步"误报把真实恢复提示也删掉。
  const restoreToastPromise = waitFor(
    async () => {
      const texts = await toastTexts();
      return texts.find((text) => text.includes('已恢复') || text.includes('恢复')) || null;
    },
    { label: '历史恢复后出现恢复提示 toast', timeout: 8_000 },
  ).catch(() => null);
  const restored = await waitFor(async () => {
    const value = await textareaValue();
    return value === state.snapshotText ? value : null;
  }, { label: '确认恢复后 textarea.value 与快照正文一致', timeout: 12_000 });
  const restoreToast = await restoreToastPromise;
  assert(restoreToast, '历史恢复后没有出现恢复提示 toast（真实恢复提示不应被误报修复误删）');
  assert(!restoreToast.includes('正文已同步'), '历史恢复后误报"正文已同步"');
  assertEqual(restored, state.snapshotText, '恢复到快照后正文与快照内容不一致');
  log(`恢复流程完成：确认弹窗 → 恢复提示「${restoreToast.replace(/\s+/g, ' ')}」→ 正文与快照一致（text.reset 已追加，历史未丢）`);

  // 恢复后历史面板可能仍然打开；为下一步模式切换清场。
  const historyClose = page.locator(SEL.historyClose).first();
  if ((await historyClose.count()) > 0 && (await historyClose.isVisible().catch(() => false))) {
    await historyClose.click().catch(() => {});
    await sleep(150);
  }

  return `snapshot seq=${snapshot.seq}（manual，chars=${snapshot.data.chars}），history-item ${itemCount} 个，预览与恢复均通过`;
}

/** text-align 归一化（保留 right/left，兼容 start/end）。 */
function normalizeTextAlign(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'start') return 'left';
  if (normalized === 'end') return 'right';
  return normalized;
}

async function readTextAlign() {
  return page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="editor-textarea"]');
    if (!textarea) return null;
    return getComputedStyle(textarea).textAlign;
  });
}

async function stepModeToggle() {
  await page.locator(SEL.textarea).first().click();
  // 恢复/保存提示可能短暂覆盖界面，先等 toast 消失再点 toggle。
  await page.locator(SEL.toast).first().waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
  const toggle = page.locator(SEL.modeToggle).first();
  await toggle.waitFor({ state: 'visible', timeout: 10_000 });

  const initial = normalizeTextAlign(await readTextAlign());
  await toggle.click();
  const afterOne = normalizeTextAlign(
    await waitFor(async () => {
      const value = normalizeTextAlign(await readTextAlign());
      return value !== initial ? value : null;
    }, { label: '第一次切换后 text-align 变化', timeout: 5_000 }),
  );
  await toggle.click();
  const afterTwo = normalizeTextAlign(
    await waitFor(async () => {
      const value = normalizeTextAlign(await readTextAlign());
      return value === initial ? value : null;
    }, { label: '第二次切换后 text-align 恢复', timeout: 5_000 }),
  );

  const seen = new Set([initial, afterOne, afterTwo]);
  assert(seen.has('right') && seen.has('left'), `text-align 未在 left/right 间切换（观察到：${[...seen].join(', ')}）`);
  assertEqual(afterTwo, initial, '点两次 mode-toggle 后应回到初始排版模式');

  // 排版模式变化应写入 editor.mode 事件（规范 6.5）。
  const modeGroup = await waitForDocEvents(
    (candidate) => candidate.events.some((event) => event.type === 'editor.mode'),
    '模式切换写入 editor.mode 事件',
    6_000,
  ).catch(() => null);
  assert(modeGroup, '切换排版模式后没有 editor.mode 事件落盘');
  const modes = modeGroup.events.filter((event) => event.type === 'editor.mode').map((event) => event.data.mode);
  assert(modes.every((mode) => mode === 'typewriter' || mode === 'centered'), `editor.mode 取值非法：${JSON.stringify(modes)}`);
  await screenshot('08-mode.png');
  return `text-align：${initial} → ${afterOne} → ${afterTwo}；editor.mode 记录 ${modes.length} 次`;
}

/** 读取页面有效背景色（跳过 transparent，body → html 回溯）。 */
async function readEffectiveBackground() {
  return page.evaluate(() => {
    const parse = (raw) => {
      const match = String(raw || '').match(/^rgba?\(([^)]+)\)$/);
      if (!match) return null;
      const parts = match[1].split(',').map((value) => Number.parseFloat(value.trim()));
      if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    for (const element of [document.body, document.documentElement]) {
      if (!element) continue;
      const color = parse(getComputedStyle(element).backgroundColor);
      if (color && color.a > 0.5) return color;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  });
}

function isPureBlack(color) {
  return color && color.r === 0 && color.g === 0 && color.b === 0;
}

function isWhiteOrCream(color) {
  if (!color) return false;
  const min = Math.min(color.r, color.g, color.b);
  const max = Math.max(color.r, color.g, color.b);
  return min >= 225 && max - min <= 20;
}

/** 抽样页面元素的颜色，确认全部为中性色（R≈G≈B，容差 ±4）。 */
async function sampleNeutralColors() {
  const samples = await page.evaluate(() => {
    const selectors = [
      'body',
      '[data-testid="editor-view"]',
      '[data-testid="editor-textarea"]',
      '[data-testid="mode-toggle"]',
      '[data-testid="editor-history-button"]',
      'button',
      'h1',
      'h2',
      'p',
      'span',
    ];
    const seen = new Set();
    const output = [];
    for (const selector of selectors) {
      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selector)).slice(0, 4);
      } catch {
        continue;
      }
      for (const element of elements) {
        if (seen.has(element)) continue;
        seen.add(element);
        const style = getComputedStyle(element);
        output.push({
          selector,
          tag: element.tagName.toLowerCase(),
          testid: element.getAttribute('data-testid') || '',
          color: style.color,
          backgroundColor: style.backgroundColor,
          borderTopColor: style.borderTopColor,
        });
      }
    }
    return output;
  });

  const parse = (raw) => {
    const match = String(raw || '').match(/^rgba?\(([^)]+)\)$/);
    if (!match) return null;
    const parts = match[1].split(',').map((value) => Number.parseFloat(value.trim()));
    if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const offenders = [];
  let checked = 0;
  for (const sample of samples) {
    for (const property of ['color', 'backgroundColor', 'borderTopColor']) {
      const color = parse(sample[property]);
      if (!color || color.a === 0) continue;
      checked += 1;
      const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
      if (spread > 4) {
        offenders.push(`${sample.tag}${sample.testid ? `[data-testid=${sample.testid}]` : ''} ${property}=rgb(${color.r},${color.g},${color.b})`);
      }
    }
  }
  return { checked, offenders, sampleCount: samples.length };
}

/**
 * 回归：100+ 字符快速输入后，双模式（typewriter/centered）光标行仍垂直居中（误差 ≤ 1 行高），
 * 且不得出现"正文已同步"误报/正文回滚。
 */
async function stepCenteringAfterRapidInput() {
  await placeCaretAtEnd();
  const before = await textareaValue();
  const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(3); // 135 字符
  await page.keyboard.type(longText); // 无 delay
  await waitFor(async () => (await textareaValue()) === before + longText, {
    label: '快速输入 135 字符后 textarea.value 正确',
    timeout: 10_000,
  });
  await sleep(1_200);
  const echoCount = await countToastsContaining('正文已同步');
  assertEqual(echoCount, 0, '100+ 字符快速输入后出现"正文已同步"toast（回声识别误报回归）');
  const caret = await readCaretState();
  assertEqual(caret.value, before + longText, '100+ 字符快速输入后正文被回滚');
  assertEqual(caret.selectionStart, caret.value.length, '100+ 字符快速输入后光标不在末尾');

  const toggle = page.locator(SEL.modeToggle).first();
  await toggle.waitFor({ state: 'visible', timeout: 10_000 });
  // 确保当前为打字机模式（typewriter = right）。
  if (normalizeTextAlign(await readTextAlign()) !== 'right') {
    await toggle.click();
    await waitFor(async () => (normalizeTextAlign(await readTextAlign()) === 'right' ? true : null), {
      label: '切回打字机模式（text-align=right）',
      timeout: 5_000,
    });
  }
  const typewriterMetrics = await assertCaretCentered('打字机模式');

  await toggle.click();
  await waitFor(async () => (normalizeTextAlign(await readTextAlign()) === 'left' ? true : null), {
    label: '切换到居中模式（text-align=left）',
    timeout: 5_000,
  });
  const centeredMetrics = await assertCaretCentered('居中模式');

  // 切回打字机模式，保持后续步骤默认状态。
  await toggle.click();
  await waitFor(async () => (normalizeTextAlign(await readTextAlign()) === 'right' ? true : null), {
    label: '恢复打字机模式（text-align=right）',
    timeout: 5_000,
  });
  await screenshot('09-centering.png');
  const fmt = (metrics) => `误差 ${metrics.error.toFixed(1)}px / 行高 ${metrics.lineHeight.toFixed(1)}px`;
  return `135 字符快速输入 + 0 条"正文已同步"；光标行居中：typewriter ${fmt(typewriterMetrics)}，centered ${fmt(centeredMetrics)}`;
}

async function stepTheme() {
  const before = await readEffectiveBackground();
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await waitFor(async () => {
    const color = await readEffectiveBackground();
    return isPureBlack(color) ? color : null;
  }, { label: '暗色模式下 body 背景为纯黑 rgb(0,0,0)', timeout: 8_000 });
  await screenshot('09-theme-dark.png');

  const darkNeutral = await sampleNeutralColors();
  assert(darkNeutral.offenders.length === 0, `暗色模式存在彩色元素：${darkNeutral.offenders.slice(0, 6).join('；')}`);

  await page.emulateMedia({ colorScheme: 'light' });
  const light = await waitFor(async () => {
    const color = await readEffectiveBackground();
    return isWhiteOrCream(color) ? color : null;
  }, { label: '亮色模式下 body 背景为纯白/奶白', timeout: 8_000 });
  await screenshot('10-theme-light.png');

  const lightNeutral = await sampleNeutralColors();
  assert(lightNeutral.offenders.length === 0, `亮色模式存在彩色元素：${lightNeutral.offenders.slice(0, 6).join('；')}`);
  log(`切换前背景：rgb(${before.r},${before.g},${before.b})`);

  return `暗色 rgb(${dark.r},${dark.g},${dark.b}) / 亮色 rgb(${light.r},${light.g},${light.b})；抽样 ${darkNeutral.sampleCount + lightNeutral.sampleCount} 个元素均为中性色`;
}

async function stepMobile() {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'load', timeout: 30_000 });
  await waitAppMounted();

  const visible = await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem, SEL.editorView], 15_000, '移动端刷新后书架或编辑器可见');
  if (visible !== SEL.editorView) {
    await waitAnyVisible([SEL.docItem], 10_000, '移动端书架出现 doc-item');
    const firstDocItem = page.locator(SEL.docItem).first();
    await firstDocItem.click();
    await waitAnyVisible([SEL.editorView], 15_000, '移动端点击作品后进入编辑器');
  }
  await waitAnyVisible([SEL.textarea], 10_000, '移动端 textarea 可见');

  const before = await textareaValue();
  await placeCaretAtEnd();
  await page.keyboard.type('OK', { delay: 20 });
  await waitFor(async () => (await textareaValue()) === `${before}OK`, { label: '移动端输入生效', timeout: 8_000 });

  const overflow = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
  }));
  assert(
    overflow.documentScrollWidth <= overflow.innerWidth + 1,
    `移动端横向溢出：documentElement.scrollWidth=${overflow.documentScrollWidth} > innerWidth=${overflow.innerWidth}`,
  );
  assert(overflow.bodyScrollWidth <= overflow.innerWidth + 1, `移动端横向溢出：body.scrollWidth=${overflow.bodyScrollWidth} > innerWidth=${overflow.innerWidth}`);
  await screenshot('11-mobile-390x844.png');
  return `390x844 下可输入，无横向溢出（scrollWidth=${overflow.documentScrollWidth} / innerWidth=${overflow.innerWidth}）`;
}

async function stepNoPageErrors() {
  if (pageErrors.length === 0) return '无未捕获的页面异常';
  const errorText = pageErrors.slice(0, 5).join('；');
  throw new Error(`页面出现 ${pageErrors.length} 个未捕获异常：${errorText}`);
}

/** 编辑来源映射：IME 上屏 source=ime、粘贴 paste、撤销 undo、重做 redo（且 inputType 正确）。 */
async function stepSourceMapping() {
  const textarea = page.locator(SEL.textarea).first();
  /** @type {Map<string, {seq: number, data: Record<string, unknown>}>} */
  const sources = new Map();

  const waitSource = async (source, label, timeout = 8_000) => {
    const group = await waitForDocEvents(
      (candidate) => candidate.events.some((event) => event.affects === 'text' && event.data && event.data.source === source),
      `出现 source=${source} 的正文事件（${label}）`,
      timeout,
    );
    const event = group.events.filter((item) => item.affects === 'text' && item.data && item.data.source === source).at(-1);
    sources.set(source, event);
    return event;
  };

  // 1) IME 上屏：CDP 组合 + 提交，录制器应写 source='ime' 的正文事件。
  await placeCaretAtEnd();
  let imeEvent = null;
  try {
    const cdp = await context.newCDPSession(page);
    try {
      await textarea.focus();
      await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
      await sleep(80);
      await cdp.send('Input.insertText', { text: '你好' });
    } finally {
      await cdp.detach().catch(() => {});
    }
    imeEvent = await waitSource('ime', 'CDP Input.imeSetComposition 提交', 5_000).catch(() => null);
  } catch (error) {
    log(`CDP IME 提交方式不可用：${String(error.message).split('\n')[0]}，改用合成 CompositionEvent`);
  }
  if (!imeEvent) {
    await placeCaretAtEnd();
    await page.evaluate(() => {
      const element = document.querySelector('[data-testid="editor-textarea"]');
      if (!element) throw new Error('找不到 editor-textarea');
      element.focus();
      element.dispatchEvent(new CompositionEvent('compositionstart', { data: 'ni', bubbles: true }));
      element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'nihao', bubbles: true }));
    });
    await page.keyboard.insertText('你好');
    await page.evaluate(() => {
      const element = document.querySelector('[data-testid="editor-textarea"]');
      if (!element) throw new Error('找不到 editor-textarea');
      element.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }));
    });
    imeEvent = await waitSource('ime', '合成 CompositionEvent 提交');
  }
  assert(imeEvent, 'IME 上屏没有记录 source=ime 的正文事件');
  log(`IME source 事件：seq=${imeEvent.seq} inputType=${JSON.stringify(imeEvent.data.inputType)}`);

  // 2) 粘贴：真实剪贴板 + Ctrl+V，inputType 应为 insertFromPaste。
  const pasteContent = '【粘贴内容】XYZ';
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, pasteContent);
  await placeCaretAtEnd();
  await page.keyboard.press('Control+v');
  await waitFor(async () => (await textareaValue()).endsWith(pasteContent), { label: '粘贴内容进入 textarea', timeout: 8_000 });
  const pasteEvent = await waitSource('paste', 'Ctrl+V 粘贴');
  assertEqual(pasteEvent.data.inputType, 'insertFromPaste', '粘贴事件的 inputType 应为 insertFromPaste');
  const valueAfterPaste = await textareaValue();
  log(`粘贴事件：seq=${pasteEvent.seq}，正文 ${valueAfterPaste.length} 码元`);

  // 3) 撤销：inputType=historyUndo，source=undo。
  await page.keyboard.press('Control+z');
  await waitFor(async () => (await textareaValue()) !== valueAfterPaste, { label: '撤销后正文发生变化', timeout: 8_000 });
  const undoEvent = await waitSource('undo', 'Ctrl+Z 撤销');
  assertEqual(undoEvent.data.inputType, 'historyUndo', '撤销事件的 inputType 应为 historyUndo');
  const valueAfterUndo = await textareaValue();

  // 4) 重做：inputType=historyRedo，source=redo。
  await page.keyboard.press('Control+y');
  await waitFor(async () => (await textareaValue()) === valueAfterPaste, { label: '重做后正文恢复到粘贴后状态', timeout: 8_000 });
  const redoEvent = await waitSource('redo', 'Ctrl+Y 重做');
  assertEqual(redoEvent.data.inputType, 'historyRedo', '重做事件的 inputType 应为 historyRedo');

  // 加入这些来源后，整条事件流仍必须可安全重放。
  const group = await readCurrentDocGroup('重放 IME/粘贴/撤销/重做后的完整事件流');
  assertEventEnvelope(group.events);
  const replayed = replayText(group.events);
  assertEqual(replayed, await textareaValue(), '事件流重放出的正文与 textarea.value 不一致（source 映射写入有问题）');

  await screenshot('06-source-mapping.png');
  return `ime/paste/undo/redo 均已落盘且 source/inputType 正确；粘贴后 ${valueAfterPaste.length} → 撤销后 ${valueAfterUndo.length} → 重做恢复，重放一致`;
}

/** 设置面板：默认值、奶白背景、应用内校验全部、备份目录入口（FSA 选择器需人工验证）。 */
async function stepSettingsAndBackupEntry() {
  await page.locator(SEL.editorSettingsButton).first().click();
  await waitAnyVisible([SEL.settingsPanel], 10_000, '设置面板 settings-panel 可见');
  const statusLocator = page.locator(SEL.storageStatus).first();
  await statusLocator.waitFor({ state: 'visible', timeout: 10_000 });
  const statusText = (await statusLocator.innerText()).trim();
  assert(statusText.length > 0, 'storage-status 文本为空');
  log(`存储状态：${statusText.replace(/\s+/g, ' ').slice(0, 160)}`);

  assertEqual(await page.locator(SEL.themeSelect).first().inputValue(), 'system', '默认主题应为跟随系统（system）');
  assertEqual(await page.locator(SEL.lightBgSelect).first().inputValue(), 'white', '默认浅色背景应为纯白（white）');
  const shortcutValue = (await page.locator(SEL.saveShortcutInput).first().inputValue()).trim();
  assert(/s/i.test(shortcutValue) && shortcutValue.length > 0, `保存快捷键默认值异常：${JSON.stringify(shortcutValue)}`);
  log(`默认保存快捷键：${shortcutValue}`);

  // 奶白背景（设置项联动 CSS 变量）
  await page.locator(SEL.themeSelect).first().selectOption('light');
  await page.locator(SEL.lightBgSelect).first().selectOption('cream');
  await waitFor(
    async () => {
      const color = await readEffectiveBackground();
      return color && color.r === 250 && color.g === 246 && color.b === 236 ? color : null;
    },
    { label: '奶白主题背景为 rgb(250,246,236)', timeout: 8_000 },
  );
  // 恢复默认，避免影响后续步骤
  await page.locator(SEL.themeSelect).first().selectOption('system');
  await page.locator(SEL.lightBgSelect).first().selectOption('white');
  await waitFor(
    async () => {
      const color = await readEffectiveBackground();
      return isWhiteOrCream(color) ? color : null;
    },
    { label: '恢复纯白背景', timeout: 8_000 },
  );

  // 应用内"校验全部"：哈希链 + 文本重放 + 快照一致性（与外部校验器互为交叉验证）
  await page.locator(SEL.verifyAllButton).first().click();
  const verifyText = await waitFor(
    async () => {
      const locator = page.locator(SEL.verifyResult).first();
      if ((await locator.count()) === 0 || !(await locator.isVisible())) return null;
      const text = (await locator.innerText()).trim();
      return text.length > 0 ? text : null;
    },
    { label: 'verify-result 出现校验结果', timeout: 20_000 },
  );
  assert(verifyText.includes('校验通过'), `应用内校验全部未通过：${verifyText}`);
  log(`应用内校验：${verifyText.replace(/\s+/g, ' ').slice(0, 160)}`);

  // 备份目录入口（headless 无法操作原生目录选择器 → 人工验证；只确认入口与状态可读）
  const backupButton = page.locator(SEL.backupChooseButton).first();
  assert(await backupButton.isVisible(), 'backup-choose-button 不可见');
  const backupLine = statusText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes('备份目录'));
  const backupNowDisabled = await page.locator('[data-testid="backup-now-button"]').first().isDisabled();
  const restoreFromBackupDisabled = await page.locator(SEL.restoreFromBackupButton).first().isDisabled();
  assert(await page.locator(SEL.restoreFromBackupButton).first().isVisible(), 'restore-from-backup-button 不可见');
  assert(restoreFromBackupDisabled, '未配置备份目录时"从备份目录恢复"按钮应禁用');
  await page.locator(SEL.settingsClose).first().click();
  await sleep(200);
  return `设置面板默认值正确（system/white/${shortcutValue}）；奶白 rgb(250,246,236) 生效；${verifyText.replace(/\s+/g, ' ')}；备份入口可见、未配置时"立即备份"/"从备份目录恢复"均禁用（${backupNowDisabled}/${restoreFromBackupDisabled}）——FSA 目录选择器需人工验证${backupLine ? `；状态行：${backupLine}` : ''}`;
}

/** 导出 .wtlog → 独立校验器检查 → 篡改检测。 */
async function stepExportAndChecker() {
  assert(page, '页面未初始化');
  state.exportedText = await textareaValue();
  await page.keyboard.press('Escape');
  await waitAnyVisible([SEL.docList], 15_000, 'Esc 返回书架后 doc-list 可见');

  const docItem = page.locator(SEL.docItem).first();
  state.docId = await docItem.getAttribute('data-doc-id');
  assert(state.docId, '书架 doc-item 缺少 data-doc-id');

  const exportButton = page.locator(`${SEL.docItem}[data-doc-id="${state.docId}"] ${SEL.docExport}`).first();
  await exportButton.waitFor({ state: 'visible', timeout: 10_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
  await exportButton.click();
  const download = await downloadPromise;
  const exportPath = path.join(ARTIFACTS_DIR, 'export.wtlog');
  await download.saveAs(exportPath);
  assert(fs.existsSync(exportPath), '导出的 .wtlog 文件不存在');
  const size = fs.statSync(exportPath).size;
  assert(size > 0, '导出的 .wtlog 文件为空');
  log(`已下载导出文件：${path.relative(ROOT, exportPath)}（${size} 字节，建议文件名 ${download.suggestedFilename()}）`);

  // 原始字节检查：UTF-8 无 BOM、LF、末行以换行结尾
  const rawBytes = fs.readFileSync(exportPath);
  assert(!(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf), '导出的 .wtlog 带有 UTF-8 BOM（规范 1.1）');
  const rawText = rawBytes.toString('utf8');
  assert(rawText.endsWith('\n'), '导出的 .wtlog 最后一行缺少结尾换行');
  assert(!rawText.includes('\r'), '导出的 .wtlog 不应包含 CR（规范要求 LF）');

  // 独立校验器（不 import 引擎代码，交叉验证格式）
  const check = await runWtlogChecker(exportPath);
  assertEqual(check.status, 0, `独立校验器判定导出文件不合规：${check.errors.join('；') || check.output.slice(0, 600)}`);
  const report = check.reports[0];
  assert(report, '校验器没有输出 JSON 报告');
  assertEqual(report.ok, true, '校验器报告 ok=false');
  assertEqual(report.format, '1.0', '导出文件格式版本应为 1.0');
  assertEqual(report.docId, state.docId, '导出文件 docId 与书架 doc-item 不一致');
  assert(report.events > 5, `导出文件事件数过少：${report.events}`);
  assert(report.snapshots >= 1, '导出文件应包含至少一个 snapshot（规范 6.7）');
  assertEqual(report.text, state.exportedText, '导出文件重放出的正文与编辑器正文不一致');
  const lines = rawText.split('\n').filter((line, index, array) => !(index === array.length - 1 && line === ''));
  assertEqual(lines.length, report.events, '导出文件行数与校验器统计的事件数不一致');
  const headerEvent = JSON.parse(lines[0]);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assertEqual(headerEvent.data?.app?.version, packageVersion, `导出 .wtlog 的 header app.version 应为 ${packageVersion}`);
  log(`独立校验通过：${report.events} 事件 / ${report.snapshots} 快照 / ${report.textChars} 字符 / lastSeq=${report.lastSeq}`);

  // 篡改检测：修改一行 text.insert 的 data.text，校验器必须报哈希错误
  const tamperedPath = path.join(ARTIFACTS_DIR, 'export-tampered.wtlog');
  const tamperedLines = lines.slice();
  let tamperedLineNo = -1;
  for (let index = 1; index < tamperedLines.length; index += 1) {
    const event = JSON.parse(tamperedLines[index]);
    if (event.type === 'text.insert' && event.data && typeof event.data.text === 'string' && event.data.text.length > 0) {
      event.data.text = `${event.data.text}X`;
      tamperedLines[index] = JSON.stringify(event);
      tamperedLineNo = index + 1;
      break;
    }
  }
  assert(tamperedLineNo > 0, '导出文件中找不到可篡改的 text.insert 行');
  fs.writeFileSync(tamperedPath, `${tamperedLines.join('\n')}\n`, 'utf8');
  const tamperedCheck = await runWtlogChecker(tamperedPath);
  assertEqual(tamperedCheck.status, 1, '篡改后的文件应被校验器判为不合规（退出码 1）');
  const tamperedReport = tamperedCheck.reports[0];
  assert(tamperedReport, '篡改文件校验器没有输出报告');
  assertEqual(tamperedReport.ok, false, '篡改后校验器报告 ok 仍为 true');
  assert(
    tamperedReport.errors.some((message) => String(message).includes('哈希')),
    `篡改后未报告哈希校验失败：${tamperedReport.errors.join('；')}`,
  );
  log(`篡改第 ${tamperedLineNo} 行后校验器正确报错：${tamperedReport.errors[0]}`);

  state.exportPath = exportPath;
  await screenshot('12-export-check.png');
  return `导出 ${size} 字节；独立校验器通过（${report.events} 事件 / ${report.snapshots} 快照 / ${report.textChars} 字符）；篡改第 ${tamperedLineNo} 行被哈希校验发现`;
}

/**
 * v0.1.5 可选附加：用 tools/wtlog-to-training.mjs 把 e2e 导出的 .wtlog 转成训练 JSONL，
 * 校验行数/字段（op、text、deleted、compose.data、snapshot 等）并证明工具可用。
 */
async function stepTrainingDataExport() {
  assert(state.exportPath && fs.existsSync(state.exportPath), '缺少导出的 .wtlog 文件');
  const training = await runTrainingExport(state.exportPath);
  assertEqual(training.status, 0, '训练数据导出工具退出码非 0');
  assert(training.summary, '训练数据摘要 JSON 缺失');
  assert(training.lines.length > 0, '训练 JSONL 为空');
  assertEqual(training.lines.length, training.summary.events, '训练 JSONL 行数应等于摘要 events');
  assertEqual(training.summary.countedDocs, 1, '训练摘要 countedDocs 应为 1');

  const records = training.lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`训练 JSONL 第 ${index + 1} 行不是合法 JSON：${error.message}`);
    }
  });
  assertEqual(records[0].type, 'doc.init', '训练记录第一条应为 doc.init');
  const insertRecord = records.find(
    (record) => record.type === 'text.insert' && record.op === 'insert' && typeof record.text === 'string' && record.text.length > 0,
  );
  assert(insertRecord, '训练记录缺少 text.insert/op=insert/text');
  const deleteRecord = records.find(
    (record) => record.type === 'text.delete' && record.op === 'delete' && typeof record.deleted === 'string' && record.deleted.length > 0,
  );
  assert(deleteRecord, '训练记录缺少 text.delete/op=delete/deleted（被删内容应保留）');
  const composeRecord = records.find((record) => record.type === 'compose.update' && typeof record.data === 'string');
  assert(composeRecord, '训练记录缺少 compose.update/data（输入法原始过程）');
  const snapshotRecord = records.find((record) => record.type === 'snapshot');
  assert(snapshotRecord, '训练记录缺少 snapshot');
  assert(training.summary.stats.inserts > 0 && training.summary.stats.deletes > 0, '训练摘要 stats.inserts/deletes 计数异常');
  assertEqual(
    training.summary.events,
    (await runWtlogChecker(state.exportPath)).reports[0].events,
    '训练事件数与日志校验器事件数不一致',
  );
  log(`训练 JSONL：${training.lines.length} 行；insert=${training.summary.stats.inserts}，delete=${training.summary.stats.deletes}，compose=${training.summary.stats.compositions}，snapshot=${training.summary.stats.snapshots}`);
  return `训练数据导出工具可用：${training.lines.length} 行 JSONL = 日志 ${training.summary.events} 事件；insert/delete(deleted)/compose/snapshot 字段齐全，摘要 countedDocs=1`;
}

/** 导出文件再导入到全新浏览器上下文，正文必须一致；重复导入同 docId 不得覆盖/新增。 */
async function stepImportRoundTrip() {
  assert(state.exportPath && fs.existsSync(state.exportPath), '缺少上一步导出的 .wtlog 文件');
  const importContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    colorScheme: 'light',
  });
  const mainPage = page;
  try {
    page = await importContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[import-context] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '全新上下文中书架可见');
    log('新上下文（空 IndexedDB）已打开');

    await page.locator(SEL.importFileInput).first().setInputFiles(state.exportPath);
    const importedItem = page.locator(`${SEL.docItem}[data-doc-id="${state.docId}"]`).first();
    await importedItem.waitFor({ state: 'visible', timeout: 20_000 });
    log(`导入成功：doc-item data-doc-id=${state.docId}`);

    await importedItem.click();
    await waitAnyVisible([SEL.editorView], 15_000, '导入后打开作品进入编辑器');
    const importedText = await waitFor(
      async () => {
        const value = await textareaValue();
        return value === state.exportedText ? value : null;
      },
      { label: '导入后正文与导出前一致', timeout: 15_000 },
    );
    assertEqual(importedText, state.exportedText, '导入后的正文与导出前不一致');
    await screenshot('13-imported.png');

    // 重复导入同一 docId：属于冲突，必须失败提示且不新增作品（规范 8.4：不得覆盖）
    await page.locator(SEL.editorLibraryButton).first().click();
    await waitAnyVisible([SEL.docList], 10_000, '返回书架');
    const countBefore = await page.locator(SEL.docItem).count();
    await page.locator(SEL.importFileInput).first().setInputFiles(state.exportPath);
    const conflictToast = await waitFor(
      async () => {
        const toast = page.locator(SEL.toast).first();
        if ((await toast.count()) === 0 || !(await toast.isVisible())) return null;
        const text = (await toast.innerText()).trim();
        return text.includes('导入失败') ? text : null;
      },
      { label: '重复导入同一作品时出现失败提示', timeout: 10_000 },
    ).catch(() => null);
    const countAfter = await page.locator(SEL.docItem).count();
    assertEqual(countAfter, countBefore, '重复导入同一 docId 不应新增作品');
    assert(conflictToast, '重复导入同一 docId 没有出现"导入失败"提示（冲突应显式报错，不得静默覆盖）');
    log(`重复导入被拒绝：${conflictToast.replace(/\s+/g, ' ').slice(0, 100)}`);
    return `新上下文导入成功（${importedText.length} 码元与导出前一致，docId=${state.docId}）；重复导入同 docId 被拒绝且作品数仍为 ${countAfter}`;
  } finally {
    await importContext.close().catch(() => {});
    page = mainPage;
  }
}

/** 双标签页只读锁：第二个标签页打开同一作品应为只读（readonly-banner + 不可写）。 */
async function stepReadonlyLock() {
  // 主标签页重新打开作品，持有写锁。
  await waitAnyVisible([SEL.docItem], 10_000, '书架 doc-item 可见');
  await page.locator(`${SEL.docItem}[data-doc-id="${state.docId}"]`).first().click();
  await waitAnyVisible([SEL.editorView], 15_000, '主标签页打开作品进入编辑器');
  await waitAnyVisible([SEL.textarea], 10_000, '主标签页 textarea 可见');
  assert(!(await locatorVisible(SEL.readonlyBanner)), '主标签页不应显示只读横幅');
  log('主标签页持有写锁');

  const secondPage = await context.newPage();
  try {
    secondPage.on('pageerror', (error) => pageErrors.push(`[second-tab] ${error.message}`));
    await secondPage.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 30_000 });
    await secondPage.waitForFunction(
      () => {
        const root = document.querySelector('#root');
        return !!root && root.children.length > 0;
      },
      null,
      { timeout: 20_000 },
    );
    await secondPage.locator(`${SEL.docItem}[data-doc-id="${state.docId}"]`).first().waitFor({ state: 'visible', timeout: 15_000 });
    await secondPage.locator(`${SEL.docItem}[data-doc-id="${state.docId}"]`).first().click();
    await secondPage.locator(SEL.editorView).first().waitFor({ state: 'visible', timeout: 20_000 });

    // 只读横幅：首选契约 testid；若 UI 漏了 data-testid，用类名兜底并在结果中标注契约偏差。
    let bannerNote = 'readonly-banner';
    let bannerVisible = false;
    const bannerLocator = secondPage.locator(SEL.readonlyBanner).first();
    if ((await bannerLocator.count()) > 0 && (await bannerLocator.isVisible().catch(() => false))) {
      bannerVisible = true;
    } else {
      const fallbackBanner = secondPage.locator('.readonly-banner').first();
      if ((await fallbackBanner.count()) > 0 && (await fallbackBanner.isVisible().catch(() => false))) {
        bannerVisible = true;
        bannerNote = '.readonly-banner（data-testid="readonly-banner" 缺失，契约偏差）';
        warn('只读横幅缺少 data-testid="readonly-banner"，已用 .readonly-banner 类名兜底；请 UI 补属性后重跑严格版');
      }
    }
    assert(bannerVisible, '第二个标签页没有显示只读横幅（readonly-banner）');

    const readOnly = await secondPage.locator(SEL.textarea).first().evaluate((element) => element.readOnly);
    assert(readOnly, '第二个标签页的 editor-textarea 应为只读');

    const valueBefore = await secondPage.locator(SEL.textarea).first().inputValue();
    await secondPage.locator(SEL.textarea).first().evaluate((element) => element.focus());
    await secondPage.keyboard.type('X');
    await sleep(400);
    const valueAfter = await secondPage.locator(SEL.textarea).first().inputValue();
    assertEqual(valueAfter, valueBefore, '第二个标签页只读状态下输入不应改变正文');
    log(`第二个标签页：${bannerNote} 可见，textarea.readOnly=true，输入被忽略（${valueBefore.length} 码元未变）`);
    await screenshot('14-readonly-second-tab.png');
    return `双标签页只读锁生效：主标签页可写；第二个标签页显示 ${bannerNote} 且输入无效`;
  } finally {
    await secondPage.close().catch(() => {});
    // 主标签页关闭作品，释放写锁，避免影响移动端步骤。
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docList], 10_000, '主标签页返回书架').catch(() => null);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * v0.1.1 回归：主存储（IndexedDB events）被破坏后，应用启动时自动从 OPFS 镜像恢复。
 * 流程：新建作品 → 输入中文 → 等 OPFS 镜像写入 → 回书架 → 删除该 docId 全部 IDB 事件 →
 *       刷新 → 断言自动恢复提示/书架刷新/正文一致/校验全部通过/导出文件仍合规。
 */
async function stepAutoRecoveryFromMirror() {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload({ waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
  await waitAppMounted();
  await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '自动恢复场景开始：书架可见');
  const docsBefore = await page.locator(SEL.docItem).count();

  // 1) 新建作品并输入一段中文
  await page.locator(SEL.newDoc).first().click();
  await waitAnyVisible([SEL.editorView], 15_000, '自动恢复场景：新作品编辑器可见');
  await waitAnyVisible([SEL.textarea], 10_000, '自动恢复场景：textarea 可见');
  await placeCaretAtEnd();
  const expectedText = '镜像自动恢复测试：这段中文必须完整回来。';
  await page.keyboard.type(expectedText);
  await waitFor(async () => (await textareaValue()) === expectedText, {
    label: '自动恢复场景：中文输入完成',
    timeout: 8_000,
  });
  await sleep(1_200); // 等 OPFS 镜像防抖写入（引擎约 400ms 防抖 + 余量）

  // 2) 回书架，记录新作品的 docId
  await page.keyboard.press('Escape');
  await waitAnyVisible([SEL.docItem], 15_000, '自动恢复场景：返回书架');
  const docCountAfterCreate = await page.locator(SEL.docItem).count();
  assertEqual(docCountAfterCreate, docsBefore + 1, '新建作品后书架作品数未增加');
  const newDocItem = page.locator(SEL.docItem).first();
  const docId = await newDocItem.getAttribute('data-doc-id');
  assert(docId, '新作品 doc-item 缺少 data-doc-id');
  state.autoRecoveredDocId = docId;
  state.autoRecoveredText = expectedText;

  // 3) 确认 OPFS 镜像已包含完整正文
  const mirrorText = await waitFor(
    async () => {
      const text = await readOpfsMirrorText(docId);
      return text && text.includes(expectedText) ? text : null;
    },
    { label: 'OPFS 镜像 docs/<docId>.wtlog 已写入完整正文', timeout: 15_000 },
  );
  log(`OPFS 镜像就绪：${mirrorText.split('\n').filter((line) => line.trim().length > 0).length} 行`);

  // 4) 破坏主存储：删除该 docId 在 IndexedDB events store 中的全部事件（保留 docs 记录）
  await deleteDocEventsFromIdb(docId);
  assertEqual(await countDocEventsInIdb(docId), 0, '删除后 IDB events 仍非空（主存储破坏未生效）');
  log('已删除该作品在 IndexedDB 中的全部事件（模拟主存储丢失）');

  // 5) 刷新页面 → 启动时自动恢复
  await page.reload({ waitUntil: 'load', timeout: 30_000 });
  const recoverToastSelector = await waitAnyVisible([SEL.autoRecoverToast], 25_000, '启动自动恢复提示 auto-recover-toast');
  const recoverToastText = (await page.locator(SEL.autoRecoverToast).first().innerText()).trim();
  assert(recoverToastText.includes('已从镜像恢复'), `自动恢复提示文案不含"已从镜像恢复"：${recoverToastText}`);
  log(`自动恢复提示：${recoverToastText}`);
  await waitAppMounted();
  await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem], 15_000, '自动恢复后书架可见');
  await screenshot('15-auto-recover-toast.png');

  // 6) 书架应有该作品，且恢复后字数更新
  const recoveredItem = page.locator(`${SEL.docItem}[data-doc-id="${docId}"]`).first();
  await recoveredItem.waitFor({ state: 'visible', timeout: 20_000 });
  await waitFor(
    async () => {
      const text = await recoveredItem.innerText();
      return text.includes(`${expectedText.length} 字`) ? text : null;
    },
    { label: '自动恢复后书架字数刷新为完整正文长度', timeout: 20_000 },
  );
  const eventsAfterRecover = await waitFor(
    async () => {
      const count = await countDocEventsInIdb(docId);
      return count > 0 ? count : null;
    },
    { label: '自动恢复后 IDB events 已补回', timeout: 20_000 },
  );
  log(`自动恢复完成：IDB events 补回 ${eventsAfterRecover} 条，书架字数已刷新`);

  // 7) 打开作品，正文与预期完全一致 + 光标在文末
  await recoveredItem.click();
  await waitAnyVisible([SEL.editorView], 15_000, '自动恢复后打开作品');
  await waitAnyVisible([SEL.textarea], 10_000, '自动恢复后 textarea 可见');
  const recoveredText = await waitFor(
    async () => {
      const value = await textareaValue();
      return value === expectedText ? value : null;
    },
    { label: '自动恢复后正文与预期完全一致', timeout: 15_000 },
  );
  const caretAfterRecover = await readCaretState();
  assertEqual(caretAfterRecover.selectionStart, caretAfterRecover.value.length, '自动恢复后光标不在文末');
  // 恢复后应回到可写状态（只读横幅不出现、textarea.readOnly=false）。
  assert(!(await locatorVisible(SEL.readonlyBanner)), '自动恢复后作品仍显示只读横幅（recover 未把主存储修复为可写）');
  const recoveredReadOnly = await page.locator(SEL.textarea).first().evaluate((element) => element.readOnly);
  assertEqual(recoveredReadOnly, false, '自动恢复后 textarea 仍为只读（recover 未把主存储修复为可写）');

  // 8) 设置 → 校验全部：恢复后的哈希链与快照必须一致
  await page.locator(SEL.editorSettingsButton).first().click();
  await waitAnyVisible([SEL.settingsPanel], 10_000, '自动恢复后设置面板可见');
  await page.locator(SEL.verifyAllButton).first().click();
  const verifyText = await waitFor(
    async () => {
      const locator = page.locator(SEL.verifyResult).first();
      if ((await locator.count()) === 0 || !(await locator.isVisible())) return null;
      const text = (await locator.innerText()).trim();
      return text.length > 0 ? text : null;
    },
    { label: '自动恢复后校验全部结果出现', timeout: 20_000 },
  );
  assert(verifyText.includes('校验通过'), `自动恢复后校验全部未通过：${verifyText}`);
  await page.locator(SEL.settingsClose).first().click();
  await sleep(200);
  log(`自动恢复后应用内校验：${verifyText.replace(/\s+/g, ' ').slice(0, 160)}`);

  // 9) 恢复后导出 .wtlog，用独立校验器交叉验证
  await page.keyboard.press('Escape');
  await waitAnyVisible([SEL.docList], 15_000, '自动恢复后返回书架');
  const exportButton = page.locator(`${SEL.docItem}[data-doc-id="${docId}"] ${SEL.docExport}`).first();
  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
  await exportButton.click();
  const download = await downloadPromise;
  const exportPath = path.join(ARTIFACTS_DIR, 'export-recovered.wtlog');
  await download.saveAs(exportPath);
  const check = await runWtlogChecker(exportPath);
  assertEqual(check.status, 0, `自动恢复后导出的 .wtlog 未通过独立校验器：${check.errors.join('；') || check.output.slice(0, 600)}`);
  const report = check.reports[0];
  assert(report, '自动恢复后导出文件缺少校验器报告');
  assertEqual(report.ok, true, '自动恢复后导出文件校验器 ok=false');
  assertEqual(report.docId, docId, '自动恢复后导出文件 docId 与书架不一致');
  assertEqual(report.text, expectedText, '自动恢复后导出文件重放正文与预期不一致');
  log(`恢复后导出校验通过：${report.events} 事件 / ${report.snapshots} 快照 / ${report.textChars} 字符`);

  await screenshot('15-auto-recover.png');
  return `IDB events 被清空后刷新：提示「${recoverToastText}」；补回 ${eventsAfterRecover} 条事件，正文/光标/校验全部/导出（${report.events} 事件）均一致`;
}

/**
 * v0.1.1 反向回归：无任何损坏时刷新页面，不得出现自动恢复/副本分歧提示，
 * 也不得重复补写主存储（事件数不变）。
 */
async function stepHealthyReloadHasNoRecoveryNoise() {
  const docId = state.autoRecoveredDocId;
  assert(docId, '缺少自动恢复场景记录的 docId');
  await waitAnyVisible([SEL.docItem], 10_000, '反向场景：书架可见');
  await sleep(800); // 让关闭作品后的镜像/元数据写入落定
  const eventsBefore = await countDocEventsInIdb(docId);
  assert(eventsBefore > 0, '反向场景开始前 events 为空，主存储状态异常');

  await page.reload({ waitUntil: 'load', timeout: 30_000 });
  await waitAppMounted();
  await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem], 15_000, '无损坏刷新后书架可见');
  await sleep(2_500); // 给后台自动恢复扫描留出时间（普通加载不应弹提示）

  const recoverToastCount = await page.locator(SEL.autoRecoverToast).count();
  assertEqual(recoverToastCount, 0, '无损坏刷新后仍出现 auto-recover-toast');
  const noise = (await toastTexts()).filter((text) => text.includes('已从镜像恢复') || text.includes('副本存在分歧'));
  assertEqual(noise.length, 0, `无损坏刷新后出现恢复/分歧提示：${noise.join('；')}`);

  const eventsAfter = await countDocEventsInIdb(docId);
  assertEqual(eventsAfter, eventsBefore, `无损坏刷新后事件数变化（疑似重复补写）：${eventsBefore} → ${eventsAfter}`);
  const docCount = await page.locator(SEL.docItem).count();
  assert(docCount >= 2, `无损坏刷新后作品数异常：${docCount}（应保留恢复后的所有作品）`);
  await screenshot('16-no-false-recovery.png');
  return `无损坏刷新：无恢复/分歧提示、事件数 ${eventsAfter} 未变、作品 ${docCount} 个`;
}

// ---------------------------------------------------------------------------
// 全量备份包（.wtzip）场景：导出 → 独立校验 → 全新环境恢复 → 重复导入 → 损坏包隔离
// v0.1.2（task-8/task-9/task-10）
// ---------------------------------------------------------------------------

/** 断言备份包导入汇总文本（UI 格式：导入 N · 合并 N · 跳过 N · 冲突 N · 失败 N）。 */
function assertArchiveSummary(text, expected) {
  const pattern = new RegExp(
    `导入\\s*${expected.imported}\\s*·\\s*合并\\s*${expected.merged}\\s*·\\s*跳过\\s*${expected.skipped}\\s*·\\s*冲突\\s*${expected.conflicts}\\s*·\\s*失败\\s*${expected.failed}`,
  );
  assert(pattern.test(String(text)), `备份包导入汇总不符：期望 ${JSON.stringify(expected)}，实际：${text}`);
}

/** 读取 settings 面板里的 archive-import-result 文本（等待其出现/更新）。 */
async function waitArchiveResult(predicate, label, timeout = 40_000) {
  return waitFor(
    async () => {
      const locator = page.locator(SEL.archiveImportResult).first();
      if ((await locator.count()) === 0) return null;
      const text = (await locator.innerText().catch(() => '')).trim();
      if (text.length === 0) return null;
      return predicate(text) ? text : null;
    },
    { timeout, label },
  );
}

/**
 * 第 1 步（v0.1.2）：在全新 context 中建 2 篇作品（改名 + 不同中文，其一 Ctrl+S 快照），
 * 从设置导出 .wtzip；并回归书架导入入口的 .wtzip 路由（重复导入出现「跳过 2」汇总）。
 */
async function stepArchiveExport() {
  const sourceContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  const mainPage = page;
  try {
    page = await sourceContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[archive-source] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '备份包导出：空书架可见');

    const specs = [
      { title: '备份甲', text: '备份包甲：第一篇的中文正文内容。', snapshot: true },
      { title: '备份乙', text: '备份包乙：第二篇的中文正文内容。', snapshot: false },
    ];
    const documents = [];
    for (const spec of specs) {
      await page.locator(SEL.newDoc).first().click();
      await waitAnyVisible([SEL.editorView], 15_000, `新建作品「${spec.title}」`);
      // 改名，便于 manifest/书架断言文件名与标题
      await page.locator(SEL.editorTitleButton).first().click();
      const titleInput = page.locator(SEL.titleInput).first();
      await titleInput.waitFor({ state: 'visible', timeout: 8_000 });
      await titleInput.fill(spec.title);
      await titleInput.press('Enter');
      await waitFor(
        async () => {
          const title = await page.locator(SEL.editorTitleButton).first().innerText().catch(() => '');
          return title.includes(spec.title) ? title : null;
        },
        { label: `作品改名为「${spec.title}」`, timeout: 8_000 },
      );
      await placeCaretAtEnd();
      await page.keyboard.type(spec.text);
      await waitFor(async () => (await textareaValue()) === spec.text, { label: `输入「${spec.title}」正文`, timeout: 8_000 });
      if (spec.snapshot) {
        await page.keyboard.press('Control+s');
        await waitAnyVisible([SEL.saveToast], 6_000, `「${spec.title}」Ctrl+S 快照保存提示`);
      }
      await page.keyboard.press('Escape');
      await waitAnyVisible([SEL.docItem], 15_000, `返回书架（${spec.title}）`);
      const docId = await findDocIdByTitle(spec.title);
      assert(docId, `书架上找不到「${spec.title}」的 doc-item`);
      documents.push({ ...spec, docId });
      log(`已创建作品「${spec.title}」docId=${docId}，正文 ${spec.text.length} 码元${spec.snapshot ? '，含手动快照' : ''}`);
    }
    assertEqual(await page.locator(SEL.docItem).count(), 2, '备份包导出前书架作品数应为 2');

    // 从设置导出 .wtzip
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '设置面板（导出备份包）可见');
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator(SEL.exportArchiveButton).first().click();
    const download = await downloadPromise;
    const archivePath = path.join(ARTIFACTS_DIR, 'backup.wtzip');
    await download.saveAs(archivePath);
    const archiveSize = fs.statSync(archivePath).size;
    assert(archiveSize > 0, '导出的 .wtzip 备份包为空');
    await waitFor(
      async () => {
        const texts = await toastTexts();
        return texts.find((text) => text.includes('已导出 2 个作品的备份包')) || null;
      },
      { label: '导出备份包成功 toast（已导出 2 个作品）', timeout: 10_000 },
    );
    log(`已导出备份包：${download.suggestedFilename()}（${archiveSize} 字节）`);

    // 回归书架导入入口的 .wtzip 路由：同一包再导入 → 汇总「跳过 2」，不新增作品、不弹冲突 Modal
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 10_000, '关闭设置返回书架');
    const docsBeforeRoute = await page.locator(SEL.docItem).count();
    await page.locator(SEL.importFileInput).first().setInputFiles(archivePath);
    const routeToast = await waitFor(
      async () => {
        const texts = await toastTexts();
        return texts.find((text) => text.includes('备份包导入完成')) || null;
      },
      { label: '书架导入 .wtzip 路由成功 toast', timeout: 30_000 },
    );
    assertArchiveSummary(routeToast, { imported: 0, merged: 0, skipped: 2, conflicts: 0, failed: 0 });
    assertEqual(await page.locator(SEL.archiveImportModal).count(), 0, '无冲突的 .wtzip 导入不应弹出 archive-import-modal');
    assertEqual(await page.locator(SEL.docItem).count(), docsBeforeRoute, '书架 .wtzip 路由导入后作品数不应变化');
    log(`书架 .wtzip 路由回归：toast「${routeToast.replace(/\s+/g, ' ')}」，未新增作品`);

    state.archivePath = archivePath;
    state.archiveDocuments = documents;
    await screenshot('17-archive-export.png');
    return `2 篇作品（备份甲含快照、备份乙）导出 ${archiveSize} 字节 .wtzip；书架 .wtzip 路由导入显示「跳过 2」且未新增作品`;
  } finally {
    await sourceContext.close().catch(() => {});
    page = mainPage;
  }
}

/** 第 2 步（v0.1.2）：Node 侧用 tools/wtzip-check.mjs + fflate 独立校验备份包/manifest/条目。 */
async function stepArchiveNodeVerification() {
  assert(state.archivePath && fs.existsSync(state.archivePath), '缺少上一步导出的 .wtzip');
  assert(Array.isArray(state.archiveDocuments) && state.archiveDocuments.length === 2, '备份包文档信息缺失');
  const archivePath = state.archivePath;
  const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  const check = await runWtzipChecker(archivePath);
  assertEqual(check.status, 0, `独立校验器判定备份包不合规：${check.errors.join('；') || check.output.slice(0, 600)}`);
  const report = check.reports[0];
  assert(report, 'wtzip-check 没有输出 JSON 报告');
  assertEqual(report.ok, true, 'wtzip-check 报告 ok=false');
  assertEqual(report.format, '1.0', 'manifest.format 应为 1.0');
  assertEqual(report.docCount, 2, 'manifest 作品数应为 2');
  for (const doc of report.checkedDocs) {
    assertEqual(doc.ok, true, `wtzip-check 条目不合规：${JSON.stringify(doc.messages)}`);
  }
  log(`wtzip-check 通过：${report.docCount} 个作品 / ${report.bytes} 字节`);

  // fflate 解压 + manifest/条目逐项核对（独立于引擎实现）
  const archive = readArchiveFromDisk(archivePath);
  const manifest = archive.manifest;
  assert(manifest, '备份包缺少 manifest');
  assertEqual(manifest.magic, 'writertools-backup-manifest', 'manifest.magic 非法');
  assertEqual(manifest.format, '1.0', 'manifest.format 非法');
  assertEqual(manifest.app?.name, 'WriterTools', 'manifest.app.name 非法');
  assertEqual(manifest.app?.version, packageVersion, `manifest.app.version 应为 ${packageVersion}`);
  assert(Array.isArray(manifest.docs) && manifest.docs.length === 2, 'manifest.docs 数量应为 2');
  const entryNames = Object.keys(archive.entries);
  assertEqual(entryNames.length, 3, `ZIP 条目数应为 3（manifest + 2 个 .wtlog），实际：${entryNames.join(', ')}`);
  assert(entryNames.includes('writertools-manifest.json'), 'ZIP 缺少 manifest 条目');
  for (const name of entryNames) {
    assert(!name.includes('..') && !name.startsWith('/') && !name.includes('\\'), `ZIP 条目不是安全相对路径：${name}`);
  }

  let checkedLogs = 0;
  let totalEvents = 0;
  for (const spec of state.archiveDocuments) {
    const manifestDoc = manifest.docs.find((doc) => doc.docId === spec.docId);
    assert(manifestDoc, `manifest 缺少作品 ${spec.title}（${spec.docId}）`);
    assertEqual(manifestDoc.title, spec.title, `manifest 标题不一致：${spec.title}`);
    assertEqual(manifestDoc.chars, spec.text.length, `manifest.chars 不等于正文长度（${spec.title}）`);
    assert(typeof manifestDoc.file === 'string' && manifestDoc.file.endsWith('.wtlog'), `manifest.file 非法（${spec.title}）`);
    assert(manifestDoc.file.includes(spec.docId.slice(0, 8)), `manifest.file 应含 docId 前 8 位（${spec.title}）：${manifestDoc.file}`);
    assert(Number.isInteger(manifestDoc.lastSeq) && manifestDoc.lastSeq >= 0, `manifest.lastSeq 非法（${spec.title}）`);
    assert(/^sha256:[0-9a-f]{64}$/.test(manifestDoc.lastHash), `manifest.lastHash 非法（${spec.title}）`);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifestDoc.backupAt), `manifest.backupAt 非法（${spec.title}）`);

    const entryBytes = archive.entries[manifestDoc.file];
    assert(entryBytes, `ZIP 缺少日志条目：${manifestDoc.file}`);
    assertEqual(
      manifestDoc.fileHash,
      `sha256:${sha256BufHex(Buffer.from(entryBytes))}`,
      `manifest.fileHash 与实际条目字节不一致（${spec.title}）`,
    );
    // 把条目落盘，交给独立日志校验器交叉校验
    const entryPath = path.join(ARTIFACTS_DIR, `archive-${spec.docId.slice(0, 8)}.wtlog`);
    fs.writeFileSync(entryPath, Buffer.from(entryBytes));
    const logCheck = await runWtlogChecker(entryPath);
    assertEqual(logCheck.status, 0, `备份包内日志不合规（${spec.title}）：${logCheck.errors.join('；')}`);
    const logReport = logCheck.reports[0];
    assertEqual(logReport.docId, spec.docId, `备份包内日志 docId 不一致（${spec.title}）`);
    assertEqual(logReport.text, spec.text, `备份包内日志重放正文与预期不一致（${spec.title}）`);
    assertEqual(logReport.lastSeq, manifestDoc.lastSeq, `日志 lastSeq 与 manifest 锚点不一致（${spec.title}）`);
    assertEqual(logReport.lastHash, manifestDoc.lastHash, `日志 lastHash 与 manifest 锚点不一致（${spec.title}）`);
    if (spec.snapshot) {
      assert(logReport.snapshots >= 1, `「${spec.title}」应包含至少 1 个快照`);
    }
    checkedLogs += 1;
    totalEvents += logReport.events;
    log(`条目校验通过：${manifestDoc.file}（docId=${spec.docId}，${logReport.events} 事件 / ${logReport.snapshots} 快照 / ${logReport.textChars} 字符）`);
  }
  assertEqual(checkedLogs, 2, '应校验 2 个日志条目');
  await screenshot('17b-archive-check.png');
  return `wtzip-check 合规（2 作品 / ${report.bytes} 字节）；manifest magic/format/app(${packageVersion})/锚点/fileHash 均正确；2 个 .wtlog 条目经 wtlog-check 校验通过（合计 ${totalEvents} 事件）`;
}

/** 第 3 步（v0.1.2）：全新 context 导入备份包 → 正文/版本历史/校验全部 → 重复导入 skipped=2。 */
async function stepArchiveImport() {
  assert(state.archivePath && fs.existsSync(state.archivePath), '缺少 .wtzip 备份包');
  const importContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  const mainPage = page;
  try {
    page = await importContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[archive-import] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty], 15_000, '恢复环境：空书架可见（全新 context）');
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '恢复环境：设置面板可见');

    // 首次导入
    await page.locator(SEL.importArchiveInput).first().setInputFiles(state.archivePath);
    const importedText = await waitArchiveResult((text) => text.includes('备份包导入结果'), '备份包导入结果出现');
    assertArchiveSummary(importedText, { imported: 2, merged: 0, skipped: 0, conflicts: 0, failed: 0 });
    log(`备份包导入结果：${importedText.replace(/\s+/g, ' ')}`);

    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '导入完成后书架可见');
    assertEqual(await page.locator(SEL.docItem).count(), 2, '导入后书架应有 2 篇作品');

    // 逐篇打开：正文一致；含快照的作品历史里应有版本
    for (const spec of state.archiveDocuments) {
      const item = page.locator(`${SEL.docItem}[data-doc-id="${spec.docId}"]`).first();
      await item.waitFor({ state: 'visible', timeout: 15_000 });
      await item.click();
      await waitAnyVisible([SEL.editorView], 15_000, `打开导入作品「${spec.title}」`);
      await waitAnyVisible([SEL.textarea], 10_000, `导入作品「${spec.title}」textarea 可见`);
      const value = await waitFor(
        async () => {
          const text = await textareaValue();
          return text === spec.text ? text : null;
        },
        { label: `导入作品「${spec.title}」正文逐字符一致`, timeout: 15_000 },
      );
      assertEqual(value, spec.text, `导入作品「${spec.title}」正文不一致`);
      if (spec.snapshot) {
        await page.locator(SEL.historyButton).first().click();
        await waitAnyVisible([SEL.historyPanel], 10_000, `导入作品「${spec.title}」历史面板可见`);
        const historyCount = await waitFor(
          async () => {
            const count = await page.locator(SEL.historyItem).count();
            return count > 0 ? count : null;
          },
          { label: `导入作品「${spec.title}」历史版本存在`, timeout: 10_000 },
        );
        log(`导入作品「${spec.title}」历史版本数：${historyCount}`);
        await page.locator(SEL.historyClose).first().click();
        await sleep(200);
      }
      await page.keyboard.press('Escape');
      await waitAnyVisible([SEL.docList], 15_000, `关闭导入作品「${spec.title}」回到书架`);
    }

    // 设置「校验全部」：恢复后的哈希链与快照一致
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '恢复环境：再次打开设置面板');
    await page.locator(SEL.verifyAllButton).first().click();
    const verifyText = await waitFor(
      async () => {
        const locator = page.locator(SEL.verifyResult).first();
        if ((await locator.count()) === 0 || !(await locator.isVisible())) return null;
        const text = (await locator.innerText()).trim();
        return text.length > 0 ? text : null;
      },
      { label: '导入后校验全部结果出现', timeout: 25_000 },
    );
    assert(verifyText.includes('校验通过'), `导入后校验全部未通过：${verifyText}`);
    assert(verifyText.includes('2 个作品'), `导入后校验应覆盖 2 个作品：${verifyText}`);
    log(`导入后应用内校验：${verifyText.replace(/\s+/g, ' ')}`);

    // 重复导入：skipped=2，无重复作品、事件数不变
    const eventsBefore = {};
    for (const spec of state.archiveDocuments) eventsBefore[spec.docId] = await countDocEventsInIdb(spec.docId);
    await waitFor(() => page.locator(SEL.importArchiveInput).first().evaluate((element) => !element.disabled), {
      label: '备份包导入入口可用（校验完成后解除 busy）',
      timeout: 15_000,
    }).catch(() => null);
    await page.locator(SEL.importArchiveInput).first().setInputFiles(state.archivePath);
    const skippedText = await waitArchiveResult((text) => text.includes('跳过 2'), '重复导入显示「跳过 2」', 40_000);
    assertArchiveSummary(skippedText, { imported: 0, merged: 0, skipped: 2, conflicts: 0, failed: 0 });
    log(`重复导入结果：${skippedText.replace(/\s+/g, ' ')}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '重复导入后书架可见');
    assertEqual(await page.locator(SEL.docItem).count(), 2, '重复导入后作品数不应变化');
    for (const spec of state.archiveDocuments) {
      const eventsAfter = await countDocEventsInIdb(spec.docId);
      assertEqual(eventsAfter, eventsBefore[spec.docId], `重复导入后「${spec.title}」事件数变化（疑似重复补写）`);
    }
    await screenshot('18-archive-import.png');
    return `全新环境导入 2 篇成功（正文/历史/校验全部通过）；重复导入「跳过 2」、作品数仍 2、事件数未变`;
  } finally {
    await importContext.close().catch(() => {});
    page = mainPage;
  }
}

/** 第 4 步（v0.1.2）：损坏（截断）备份包导入必须可读报错、不白屏、不影响本地数据。 */
async function stepArchiveCorrupt() {
  assert(state.archivePath && fs.existsSync(state.archivePath), '缺少 .wtzip 备份包');
  const corruptContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  const mainPage = page;
  try {
    page = await corruptContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[archive-corrupt] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty], 15_000, '损坏包场景：空书架可见');

    // 先正常导入，作为"原有作品"
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '损坏包场景：设置面板可见');
    await page.locator(SEL.importArchiveInput).first().setInputFiles(state.archivePath);
    await waitArchiveResult((text) => text.includes('备份包导入结果'), '损坏包场景：先正常导入备份包');
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '损坏包场景：正常导入后书架可见');
    assertEqual(await page.locator(SEL.docItem).count(), 2, '损坏包场景：正常导入后应有 2 篇作品');
    const eventsBefore = {};
    for (const spec of state.archiveDocuments) eventsBefore[spec.docId] = await countDocEventsInIdb(spec.docId);

    // 截断 ZIP 字节（保留前 60%）作为损坏包
    const raw = fs.readFileSync(state.archivePath);
    const truncatedPath = path.join(ARTIFACTS_DIR, 'backup-truncated.wtzip');
    fs.writeFileSync(truncatedPath, raw.subarray(0, Math.max(16, Math.floor(raw.length * 0.6))));
    const truncatedSize = fs.statSync(truncatedPath).size;
    state.archiveTruncatedPath = truncatedPath;
    log(`已生成截断备份包：${truncatedSize} / ${raw.length} 字节`);

    // 导入损坏包：应出现可读错误提示（结果区 archive-import-result 或 error toast），不白屏
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '损坏包场景：再次打开设置面板');
    await page.locator(SEL.importArchiveInput).first().setInputFiles(truncatedPath);
    const errorText = await waitFor(
      async () => {
        const locator = page.locator(SEL.archiveImportResult).first();
        const direct = (await locator.count()) > 0 ? (await locator.innerText().catch(() => '')).trim() : '';
        if (direct.length > 0 && /失败|错误|不合法|ZIP|解压|备份包/.test(direct)) return direct;
        const toasts = await toastTexts();
        return toasts.find((text) => /导入备份包失败|失败|不合法|ZIP/.test(text)) || null;
      },
      { label: '损坏备份包出现可读错误提示', timeout: 30_000 },
    );
    log(`损坏包导入提示：${String(errorText).replace(/\s+/g, ' ').slice(0, 160)}`);

    // 不白屏 + 原有作品不受影响
    const rootChildren = await page.evaluate(() => document.querySelector('#root')?.children.length ?? 0);
    assert(rootChildren > 0, '损坏包导入后应用白屏（#root 无内容）');
    assert(await locatorVisible(SEL.settingsPanel), '损坏包导入后设置面板应仍可见（应用未崩溃）');
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '损坏包导入后返回书架');
    assertEqual(await page.locator(SEL.docItem).count(), 2, '损坏包导入后原有作品数不应变化');
    for (const spec of state.archiveDocuments) {
      const eventsAfter = await countDocEventsInIdb(spec.docId);
      assertEqual(eventsAfter, eventsBefore[spec.docId], `损坏包导入后「${spec.title}」事件数变化`);
    }
    // 应用仍可正常打开作品
    const firstSpec = state.archiveDocuments[0];
    await page.locator(`${SEL.docItem}[data-doc-id="${firstSpec.docId}"]`).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '损坏包场景：原有作品仍可打开');
    assertEqual(await textareaValue(), firstSpec.text, '损坏包导入后原有作品正文被破坏');
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docList], 10_000, '损坏包场景：返回书架');
    await screenshot('19-archive-corrupt.png');
    return `截断包（${truncatedSize}/${raw.length} 字节）导入显示可读错误、应用未白屏、2 篇原有作品与事件数均不受影响`;
  } finally {
    await corruptContext.close().catch(() => {});
    page = mainPage;
  }
}

// ---------------------------------------------------------------------------
// 备份目录自动备份场景（v0.1.3，task-11 / task-12 / task-13）
// headless 无原生目录选择器：用真实 OPFS 子目录冒充 showDirectoryPicker 返回值
// ---------------------------------------------------------------------------

/**
 * 第 1 步（v0.1.3）：备份目录真实写盘 + 自动备份。
 * - addInitScript 把 showDirectoryPicker 换成返回 OPFS `backup-target` 目录（真实 FileSystemDirectoryHandle）；
 * - 建作品 → Ctrl+S → 设置「选择备份目录」→ 断言 backup-status「已配置 + 上次备份」、目录内 manifest + .wtlog；
 * - 独立校验 manifest/锚点/fileHash 与 .wtlog（node tools/wtlog-check.mjs）；
 * - 继续输入 + Ctrl+S → 等待防抖+最小间隔后的自动备份：日志变长且以旧日志为前缀、manifest lastSeq 增加；
 * - 与 UI 导出的 .wtlog 做字节前缀比对（导出会追加 session 事件，故为前缀关系）；
 * - 刷新页面 → 启动补齐自动备份（manifest.updatedAt 与 kv.lastBackupAt 更新）。
 */
async function stepBackupDirectoryAutoBackup() {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const backupContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  await backupContext.addInitScript(() => {
    try {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        writable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle('backup-target', { create: true });
        },
      });
    } catch {
      /* 注入失败时后续断言会明确失败 */
    }
  });
  const mainPage = page;
  try {
    page = await backupContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[backup-dir] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '自动备份场景：书架可见');

    // 1) 建作品 + 手工快照
    await page.locator(SEL.newDoc).first().click();
    await waitAnyVisible([SEL.editorView], 15_000, '自动备份场景：编辑器可见');
    await placeCaretAtEnd();
    const text1 = '备份目录自动备份：第一段中文。';
    await page.keyboard.type(text1);
    await waitFor(async () => (await textareaValue()) === text1, { label: '自动备份场景：第一段正文输入', timeout: 8_000 });
    await page.keyboard.press('Control+s');
    await waitAnyVisible([SEL.saveToast], 6_000, '自动备份场景：Ctrl+S 保存提示');
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docItem], 15_000, '自动备份场景：返回书架');
    const docId = await page.locator(SEL.docItem).first().getAttribute('data-doc-id');
    assert(docId, '自动备份场景：缺少 docId');

    // 2) 设置 → 选择备份目录（注入的 OPFS 伪目录）→ 首次备份
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '自动备份场景：设置面板可见');
    await page.locator(SEL.backupChooseButton).first().click();
    const statusText = await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('已配置') && text.includes('上次备份') ? text : null;
      },
      { label: '备份目录状态显示「已配置 + 上次备份」', timeout: 30_000 },
    );
    log(`备份目录状态：${statusText.replace(/\s+/g, ' ')}`);

    // 3) OPFS 伪目录真实写盘 + manifest/日志独立校验
    const first = await waitBackupManifest(
      (manifest) => Array.isArray(manifest.docs) && manifest.docs.some((doc) => doc.docId === docId),
      '首次备份写入 backup-target/（manifest + .wtlog）',
      30_000,
    );
    const manifest1 = first.manifest;
    assertEqual(manifest1.magic, 'writertools-backup-manifest', '备份 manifest.magic 非法');
    assertEqual(manifest1.format, '1.0', '备份 manifest.format 非法');
    assertEqual(manifest1.app?.version, packageVersion, `备份 manifest.app.version 应为 ${packageVersion}`);
    const entry1 = manifest1.docs.find((doc) => doc.docId === docId);
    assert(entry1, 'manifest 缺少当前作品');
    const wtlogName1 = entry1.file;
    assert(typeof wtlogName1 === 'string' && wtlogName1.endsWith('.wtlog'), 'manifest.file 非法');
    const wtlog1 = first.snapshot.files[wtlogName1];
    assert(wtlog1, `备份目录缺少日志文件：${wtlogName1}`);
    assert(Number.isInteger(entry1.lastSeq) && entry1.lastSeq >= 0, 'manifest.lastSeq 非法');
    assert(/^sha256:[0-9a-f]{64}$/.test(entry1.lastHash), 'manifest.lastHash 非法');
    assert(/^sha256:[0-9a-f]{64}$/.test(entry1.fileHash), 'manifest.fileHash 非法');
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry1.backupAt), 'manifest.backupAt 非法');
    assertEqual(entry1.chars, text1.length, 'manifest.chars 与正文长度不一致');
    assertEqual(entry1.fileHash, `sha256:${sha256BufHex(Buffer.from(wtlog1.text, 'utf8'))}`, 'manifest.fileHash 与备份日志字节不一致');
    const backupLog1 = path.join(ARTIFACTS_DIR, `backup-dir-${docId.slice(0, 8)}.wtlog`);
    fs.writeFileSync(backupLog1, wtlog1.text, 'utf8');
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'backup-dir-manifest.json'), JSON.stringify(manifest1, null, 2), 'utf8');
    const logCheck1 = await runWtlogChecker(backupLog1);
    assertEqual(logCheck1.status, 0, `备份目录日志未通过独立校验：${logCheck1.errors.join('；')}`);
    const logReport1 = logCheck1.reports[0];
    assertEqual(logReport1.docId, docId, '备份日志 docId 不一致');
    assertEqual(logReport1.text, text1, '备份日志重放正文与预期不一致');
    assertEqual(logReport1.lastSeq, entry1.lastSeq, '备份日志 lastSeq 与 manifest 锚点不一致');
    assertEqual(logReport1.lastHash, entry1.lastHash, '备份日志 lastHash 与 manifest 锚点不一致');
    const kv1 = await readBackupKvState();
    assertEqual(kv1.configured, true, 'IDB kv 中 backup.dirHandle 未保存');
    assert(typeof kv1.lastBackupAt === 'string', 'IDB kv 中 backup.lastBackupAt 缺失');
    log(`首次备份：${Object.keys(first.snapshot.files).length} 个文件；日志 lastSeq=${entry1.lastSeq}，${logReport1.events} 事件；kv.lastBackupAt=${kv1.lastBackupAt}`);

    // 4) 继续输入 + Ctrl+S → 自动备份增量（防抖 3s + 最小间隔 15s）
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '自动备份场景：关闭设置返回书架');
    await page.locator(`${SEL.docItem}[data-doc-id="${docId}"]`).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '自动备份场景：重新打开作品');
    await placeCaretAtEnd();
    const text2 = '第二段增量内容。';
    await page.keyboard.type(text2);
    await waitFor(async () => (await textareaValue()) === text1 + text2, { label: '自动备份场景：增量正文输入', timeout: 8_000 });
    await page.keyboard.press('Control+s');
    await waitAnyVisible([SEL.saveToast], 6_000, '自动备份场景：增量 Ctrl+S 保存提示');
    const second = await waitBackupManifest(
      (manifest) => {
        const entry = Array.isArray(manifest.docs) ? manifest.docs.find((doc) => doc.docId === docId) : null;
        return !!entry && entry.lastSeq > entry1.lastSeq;
      },
      '快照后自动备份更新 manifest/.wtlog（防抖 3s + 最小间隔 15s）',
      35_000,
    );
    const entry2 = second.manifest.docs.find((doc) => doc.docId === docId);
    const wtlog2 = second.snapshot.files[entry2.file];
    assert(wtlog2, '增量备份缺少日志文件');
    assert(wtlog2.text.startsWith(wtlog1.text), '第二次备份日志不是第一次的前缀（疑似重写了历史行）');
    assert(wtlog2.text.length > wtlog1.text.length, '第二次备份日志未变长');
    const backupLog2 = path.join(ARTIFACTS_DIR, `backup-dir-${docId.slice(0, 8)}-2.wtlog`);
    fs.writeFileSync(backupLog2, wtlog2.text, 'utf8');
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'backup-dir-manifest-2.json'), JSON.stringify(second.manifest, null, 2), 'utf8');
    const logCheck2 = await runWtlogChecker(backupLog2);
    assertEqual(logCheck2.status, 0, `增量备份日志未通过独立校验：${logCheck2.errors.join('；')}`);
    assertEqual(logCheck2.reports[0].text, text1 + text2, '增量备份日志重放正文与预期不一致');
    log(`增量自动备份：lastSeq ${entry1.lastSeq} → ${entry2.lastSeq}，日志 ${wtlog1.text.length} → ${wtlog2.text.length} 字节`);

    // 5) 与 .wtlog 导出的字节关系（导出会追加 session.start 等，备份内容必须是导出的字节前缀）
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docList], 15_000, '自动备份场景：增量后返回书架');
    const exportButton = page.locator(`${SEL.docItem}[data-doc-id="${docId}"] ${SEL.docExport}`).first();
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await exportButton.click();
    const download = await downloadPromise;
    const exportPath = path.join(ARTIFACTS_DIR, 'backup-dir-export.wtlog');
    await download.saveAs(exportPath);
    const exportText = fs.readFileSync(exportPath, 'utf8');
    assert(exportText.startsWith(wtlog2.text), '备份日志不是同期 .wtlog 导出的字节前缀（备份内容与导出不一致）');
    log('备份日志与 .wtlog 导出的字节前缀一致性校验通过');

    // 6) 刷新页面 → 启动补齐自动备份（应用重启后若已配置目录会调度一次）
    const kvBeforeReload = await readBackupKvState();
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAppMounted();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem], 15_000, '刷新后书架可见');
    const catchUp = await waitBackupManifest(
      (manifest) => manifest.updatedAt !== second.manifest.updatedAt,
      '刷新启动后自动补齐备份（manifest.updatedAt 更新）',
      40_000,
    );
    const kvAfterReload = await waitFor(
      async () => {
        const kv = await readBackupKvState();
        return kv.lastBackupAt && kv.lastBackupAt !== kvBeforeReload.lastBackupAt ? kv : null;
      },
      { label: '启动补齐后 backup.lastBackupAt 更新', timeout: 40_000 },
    ).catch(() => null);
    assert(kvAfterReload, '刷新后 backup.lastBackupAt 未更新（启动补齐自动备份未生效）');
    log(`启动补齐：manifest.updatedAt ${second.manifest.updatedAt} → ${catchUp.manifest.updatedAt}；lastBackupAt 已更新`);
    await screenshot('20-backup-directory.png');
    return `OPFS 伪目录真实写盘成功：首次备份 ${Object.keys(first.snapshot.files).length} 个文件（日志 ${logReport1.events} 事件/lastSeq=${entry1.lastSeq}）；增量后 lastSeq ${entry1.lastSeq}→${entry2.lastSeq}、日志变长且为 .wtlog 导出字节前缀；刷新后启动补齐 manifest.updatedAt 更新、kv.lastBackupAt 更新`;
  } finally {
    await backupContext.close().catch(() => {});
    page = mainPage;
  }
}

/** 第 2 步（v0.1.3）：未配置备份目录时，写作品/快照/刷新都不应创建备份文件、无备份报错。 */
async function stepUnconfiguredBackupNoop() {
  const plainContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  const mainPage = page;
  try {
    page = await plainContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[backup-unconfigured] ${error.message}`));
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty], 15_000, '未配置备份目录场景：空书架可见');

    // 写作品 + 手工快照 + 关闭（不应触发任何备份写盘）
    await page.locator(SEL.newDoc).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '未配置场景：编辑器可见');
    await placeCaretAtEnd();
    const text = '未配置备份目录：不应写盘。';
    await page.keyboard.type(text);
    await waitFor(async () => (await textareaValue()) === text, { label: '未配置场景：正文输入', timeout: 8_000 });
    await page.keyboard.press('Control+s');
    await waitAnyVisible([SEL.saveToast], 6_000, '未配置场景：Ctrl+S 保存提示');
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docItem], 15_000, '未配置场景：返回书架');
    await sleep(2_000);

    const readRootNames = () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const names = [];
        for await (const [name, handle] of root.entries()) names.push(`${name}${handle.kind === 'directory' ? '/' : ''}`);
        return names;
      });
    const rootNames = await readRootNames();
    assert(!rootNames.some((name) => name.startsWith('backup-target')), `未配置备份目录却出现备份目录：${rootNames.join(',')}`);
    assert(!rootNames.includes('writertools-manifest.json'), `未配置备份目录却写入了 manifest：${rootNames.join(',')}`);
    const kv = await readBackupKvState();
    assertEqual(kv.configured, false, '未配置备份目录却存在 backup.dirHandle');
    log(`未配置场景 OPFS 根目录：${rootNames.join(', ') || '(空)'}`);

    // 设置状态显示未配置
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '未配置场景：设置面板可见');
    const statusText = await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('未配置') ? text : null;
      },
      { label: '未配置场景：backup-status 显示未配置', timeout: 10_000 },
    );
    log(`未配置状态行：${statusText.replace(/\s+/g, ' ')}`);
    await page.locator(SEL.settingsClose).first().click();

    // 刷新后仍不应写盘/产生备份错误
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAppMounted();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem], 15_000, '未配置场景：刷新后书架可见');
    await sleep(2_000);
    const rootNamesAfterReload = await readRootNames();
    assert(!rootNamesAfterReload.some((name) => name.startsWith('backup-target')), '刷新后未配置目录却出现 backup-target');
    assert(!rootNamesAfterReload.includes('writertools-manifest.json'), '刷新后未配置目录却写入 manifest');
    const kvAfterReload = await readBackupKvState();
    assertEqual(kvAfterReload.configured, false, '刷新后未配置目录却存在 backup.dirHandle');
    assert(kvAfterReload.lastError === null, `未配置目录却出现备份错误：${kvAfterReload.lastError}`);
    assertEqual(
      await page.locator(SEL.backupHealthToast).count(),
      0,
      '未配置备份目录却出现 backup-health-toast 健康告警',
    );
    await screenshot('21-backup-unconfigured.png');
    return `未配置备份目录：写作品/快照/刷新均未创建 backup-target 或 manifest、kv 无 backup.dirHandle/无备份错误、backup-status 显示「未配置」、无异常`;
  } finally {
    await plainContext.close().catch(() => {});
    page = mainPage;
  }
}

/**
 * v0.1.4 灾备闭环：模拟"浏览器本地数据全部丢失" → 重新选择备份目录（OPFS 伪目录）→
 * 一键从备份目录恢复 → 正文/版本历史一致 → 重复恢复 skipped → 校验全部通过。
 * 重点回归：空库重新选择目录**不能**把备份清单旧条目标记 trashed（否则作品会进回收站）。
 */
async function stepDisasterRecoveryFromBackupDirectory() {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const disasterContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  await disasterContext.addInitScript(() => {
    try {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        writable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle('backup-target', { create: true });
        },
      });
    } catch {
      /* 注入失败时后续断言会明确失败 */
    }
  });
  const mainPage = page;
  try {
    page = await disasterContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[disaster] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '灾备场景：书架可见');

    // 1) 建 2 篇作品（灾备甲含 Ctrl+S 快照、灾备乙普通）
    const specs = [
      { title: '灾备甲', text: '灾备恢复测试甲：第一篇中文正文。', snapshot: true },
      { title: '灾备乙', text: '灾备恢复测试乙：第二篇中文正文。', snapshot: false },
    ];
    const documents = [];
    for (const spec of specs) {
      await page.locator(SEL.newDoc).first().click();
      await waitAnyVisible([SEL.editorView], 15_000, `灾备场景：新建「${spec.title}」`);
      await page.locator(SEL.editorTitleButton).first().click();
      const titleInput = page.locator(SEL.titleInput).first();
      await titleInput.waitFor({ state: 'visible', timeout: 8_000 });
      await titleInput.fill(spec.title);
      await titleInput.press('Enter');
      await waitFor(
        async () => {
          const title = await page.locator(SEL.editorTitleButton).first().innerText().catch(() => '');
          return title.includes(spec.title) ? title : null;
        },
        { label: `灾备场景：作品改名为「${spec.title}」`, timeout: 8_000 },
      );
      await placeCaretAtEnd();
      await page.keyboard.type(spec.text);
      await waitFor(async () => (await textareaValue()) === spec.text, { label: `灾备场景：输入「${spec.title}」正文`, timeout: 8_000 });
      if (spec.snapshot) {
        await page.keyboard.press('Control+s');
        await waitAnyVisible([SEL.saveToast], 6_000, '灾备场景：Ctrl+S 保存提示');
      }
      await page.keyboard.press('Escape');
      await waitAnyVisible([SEL.docItem], 15_000, `灾备场景：返回书架（${spec.title}）`);
      const docId = await findDocIdByTitle(spec.title);
      assert(docId, `灾备场景：书架上找不到「${spec.title}」`);
      documents.push({ ...spec, docId });
      log(`灾备场景已创建「${spec.title}」docId=${docId}（${spec.text.length} 码元${spec.snapshot ? '，含快照' : ''}）`);
    }
    assertEqual(await page.locator(SEL.docItem).count(), 2, '灾备场景：应有 2 篇作品');

    // 2) 选择备份目录 → 首次备份 → manifest/日志独立校验
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '灾备场景：设置面板可见');
    await page.locator(SEL.backupChooseButton).first().click();
    const firstManifest = await waitBackupManifest(
      (manifest) => Array.isArray(manifest.docs) && manifest.docs.length === 2,
      '灾备场景：首次备份 manifest 含 2 个作品',
      30_000,
    );
    const manifest1 = firstManifest.manifest;
    assertEqual(manifest1.magic, 'writertools-backup-manifest', '灾备 manifest.magic 非法');
    assertEqual(manifest1.format, '1.0', '灾备 manifest.format 非法');
    assertEqual(manifest1.app?.version, packageVersion, `灾备 manifest.app.version 应为 ${packageVersion}`);
    assertEqual(manifest1.docs.length, 2, '灾备 manifest 应有 2 个作品');
    assert(manifest1.docs.every((doc) => doc.trashed !== true), '首次备份 manifest 不应含 trashed 条目');
    const firstWtlogTexts = {};
    for (const spec of documents) {
      const entry = manifest1.docs.find((doc) => doc.docId === spec.docId);
      assert(entry, `灾备 manifest 缺少「${spec.title}」`);
      assertEqual(entry.title, spec.title, `灾备 manifest 标题不一致：${spec.title}`);
      assertEqual(entry.chars, spec.text.length, `灾备 manifest.chars 不一致：${spec.title}`);
      const entryBytes = firstManifest.snapshot.files[entry.file];
      assert(entryBytes, `灾备备份目录缺少日志：${entry.file}`);
      assertEqual(entry.fileHash, `sha256:${sha256BufHex(Buffer.from(entryBytes.text, 'utf8'))}`, `灾备 fileHash 不一致：${spec.title}`);
      const entryPath = path.join(ARTIFACTS_DIR, `disaster-${spec.docId.slice(0, 8)}.wtlog`);
      fs.writeFileSync(entryPath, entryBytes.text, 'utf8');
      const logCheck = await runWtlogChecker(entryPath);
      assertEqual(logCheck.status, 0, `灾备日志未通过独立校验：${spec.title}：${logCheck.errors.join('；')}`);
      assertEqual(logCheck.reports[0].text, spec.text, `灾备日志重放正文不一致：${spec.title}`);
      if (spec.snapshot) assert(logCheck.reports[0].snapshots >= 1, '灾备甲应包含至少 1 个快照');
      firstWtlogTexts[entry.file] = entryBytes.text;
    }
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'disaster-manifest.json'), JSON.stringify(manifest1, null, 2), 'utf8');
    log(`灾备备份就绪：2 个作品 / ${manifest1.docs.map((doc) => `${doc.title}(lastSeq=${doc.lastSeq})`).join('、')}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 10_000, '灾备场景：关闭设置返回书架');

    // 3) 模拟浏览器本地数据全部丢失（清空 IDB docs/events/kv + 删除 OPFS docs/ 镜像，保留 backup-target）
    const cleared = await clearLocalDataForDisaster();
    assertEqual(cleared.clearedStores.sort().join(','), 'docs,events,kv', '灾备场景：未清空全部本地 store');
    assert(cleared.mirrorRemoved, '灾备场景：OPFS docs/ 镜像目录未能删除');
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAppMounted();
    await waitAnyVisible([SEL.libraryEmpty], 15_000, '灾备场景：数据丢失后空书架可见');
    assertEqual(await page.locator(SEL.docItem).count(), 0, '灾备场景：数据丢失后书架仍存在作品');
    log('已模拟浏览器数据丢失：IDB docs/events/kv 清空 + OPFS docs/ 镜像删除（backup-target 保留）');

    // 4) 重新选择备份目录：空库不得把灾备清单旧条目标记 trashed
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '灾备场景：数据丢失后设置面板可见');
    await page.locator(SEL.backupChooseButton).first().click();
    const reselectHint = await waitFor(
      async () => {
        const texts = await toastTexts();
        return texts.find((text) => text.includes('本地暂无作品') || text.includes('从备份目录恢复')) || null;
      },
      { label: '重新选择目录后提示可「从备份目录恢复」', timeout: 15_000 },
    ).catch(() => null);
    if (reselectHint) log(`重新选择目录提示：${reselectHint.replace(/\s+/g, ' ')}`);
    const reselectedStatus = await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('已配置') ? text : null;
      },
      { label: '重新选择目录后 backup-status 显示已配置', timeout: 15_000 },
    );
    log(`重新选择目录后状态：${reselectedStatus.replace(/\s+/g, ' ')}`);
    const afterReselect = await readBackupDirSnapshot();
    const manifestAfterReselect = parseBackupManifest(afterReselect);
    assert(manifestAfterReselect, '重新选择目录后备份 manifest 丢失');
    assertEqual(manifestAfterReselect.docs.length, 2, '重新选择目录后 manifest 作品数变化（空库备份覆盖了灾备清单）');
    assert(manifestAfterReselect.docs.every((doc) => doc.trashed !== true), '空库重新选择目录后旧条目被标记 trashed（灾备清单被破坏）');
    for (const spec of documents) {
      const before = manifest1.docs.find((doc) => doc.docId === spec.docId);
      const after = manifestAfterReselect.docs.find((doc) => doc.docId === spec.docId);
      assert(after, `重新选择目录后 manifest 缺少「${spec.title}」`);
      assertEqual(after.lastSeq, before.lastSeq, `重新选择目录后「${spec.title}」lastSeq 变化`);
      assertEqual(after.fileHash, before.fileHash, `重新选择目录后「${spec.title}」fileHash 变化`);
    }
    for (const file of Object.keys(firstWtlogTexts)) {
      assert(afterReselect.files[file], `重新选择目录后备份日志丢失：${file}`);
      assertEqual(afterReselect.files[file].text, firstWtlogTexts[file], `重新选择目录后备份日志被改写：${file}`);
    }
    log('重新选择目录后灾备清单与日志保持不变（空库未被标记 trashed）');

    // 5) 一键从备份目录恢复
    await page.locator(SEL.restoreFromBackupButton).first().click();
    const restoreText = await waitArchiveResult(
      (text) => text.includes('从备份目录恢复结果') || text.includes('备份包导入结果'),
      '从备份目录恢复结果出现',
      40_000,
    );
    assertArchiveSummary(restoreText, { imported: 2, merged: 0, skipped: 0, conflicts: 0, failed: 0 });
    log(`从备份目录恢复结果：${restoreText.replace(/\s+/g, ' ')}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '灾备恢复后书架可见');
    assertEqual(await page.locator(SEL.docItem).count(), 2, '灾备恢复后书架应有 2 篇作品');

    // 6) 逐篇验证标题/正文/版本历史
    for (const spec of documents) {
      const item = page.locator(`${SEL.docItem}[data-doc-id="${spec.docId}"]`).first();
      await item.waitFor({ state: 'visible', timeout: 15_000 });
      const itemText = (await item.innerText()).replace(/\s+/g, ' ');
      assert(itemText.includes(spec.title), `灾备恢复后书架标题不一致：${spec.title}（实际：${itemText}）`);
      await item.click();
      await waitAnyVisible([SEL.textarea], 10_000, `灾备恢复后打开「${spec.title}」`);
      const value = await waitFor(
        async () => {
          const text = await textareaValue();
          return text === spec.text ? text : null;
        },
        { label: `灾备恢复后「${spec.title}」正文逐字符一致`, timeout: 15_000 },
      );
      assertEqual(value, spec.text, `灾备恢复后正文不一致：${spec.title}`);
      if (spec.snapshot) {
        await page.locator(SEL.historyButton).first().click();
        await waitAnyVisible([SEL.historyPanel], 10_000, '灾备恢复后历史面板可见');
        const historyCount = await waitFor(
          async () => {
            const count = await page.locator(SEL.historyItem).count();
            return count > 0 ? count : null;
          },
          { label: '灾备恢复后版本历史存在', timeout: 10_000 },
        );
        log(`灾备恢复后「${spec.title}」历史版本数：${historyCount}`);
        await page.locator(SEL.historyClose).first().click();
        await sleep(200);
      }
      await page.keyboard.press('Escape');
      await waitAnyVisible([SEL.docList], 15_000, `灾备恢复后关闭「${spec.title}」`);
    }

    // 7) 应用内校验全部 + 重复恢复 skipped
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '灾备场景：恢复后设置面板可见');
    await page.locator(SEL.verifyAllButton).first().click();
    const verifyText = await waitFor(
      async () => {
        const locator = page.locator(SEL.verifyResult).first();
        if ((await locator.count()) === 0 || !(await locator.isVisible())) return null;
        const text = (await locator.innerText()).trim();
        return text.length > 0 ? text : null;
      },
      { label: '灾备恢复后校验全部结果出现', timeout: 25_000 },
    );
    assert(verifyText.includes('校验通过'), `灾备恢复后校验全部未通过：${verifyText}`);
    assert(verifyText.includes('2 个作品'), `灾备恢复后校验应覆盖 2 个作品：${verifyText}`);
    const eventsBefore = {};
    for (const spec of documents) eventsBefore[spec.docId] = await countDocEventsInIdb(spec.docId);
    await waitFor(() => page.locator(SEL.restoreFromBackupButton).first().evaluate((element) => !element.disabled), {
      label: '从备份目录恢复按钮恢复可用（校验完成解除 busy）',
      timeout: 15_000,
    }).catch(() => null);
    await page.locator(SEL.restoreFromBackupButton).first().click();
    const skippedText = await waitArchiveResult((text) => text.includes('跳过 2'), '重复从备份目录恢复显示「跳过 2」', 40_000);
    assertArchiveSummary(skippedText, { imported: 0, merged: 0, skipped: 2, conflicts: 0, failed: 0 });
    log(`重复从备份目录恢复结果：${skippedText.replace(/\s+/g, ' ')}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '重复恢复后书架可见');
    assertEqual(await page.locator(SEL.docItem).count(), 2, '重复恢复后作品数不应变化');
    for (const spec of documents) {
      assertEqual(await countDocEventsInIdb(spec.docId), eventsBefore[spec.docId], `重复恢复后「${spec.title}」事件数变化`);
    }
    await screenshot('22-disaster-recovery.png');
    return `灾备闭环通过：数据丢失后重新选目录（清单未被 trashed 破坏）→「从备份目录恢复」导入 2 篇，标题/正文/历史一致、校验全部通过；重复恢复「跳过 2」、事件数不变`;
  } finally {
    await disasterContext.close().catch(() => {});
    page = mainPage;
  }
}

/**
 * v0.1.5 失败路径韧性（备份/灾备出错时真实数据不能丢）：
 * A) 注入 FileSystemFileHandle.createWritable 抛错（模拟磁盘满/权限撤销）：
 *    选备份目录后首次备份 → 可读失败提示 + backup-status/kv.lastError 记录、无 manifest 落盘、应用不白屏；
 *    失败后继续编辑/保存/刷新，正文与历史仍完整；自动备份失败不打断编辑、不刷屏。
 * B) 删除备份目录（读取失败）→ 点「从备份目录恢复」显示可读错误、书架数据不变、校验全部仍通过。
 */
async function stepBackupFailureResilience() {
  const failureContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  await failureContext.addInitScript(() => {
    // 注入"写盘失败"：所有文件句柄 createWritable 一律拒绝（仅该 context 生效）。
    try {
      const failCreateWritable = () =>
        Promise.reject(new DOMException('模拟磁盘写入失败（e2e 注入）', 'NotAllowedError'));
      Object.defineProperty(FileSystemFileHandle.prototype, 'createWritable', {
        configurable: true,
        writable: true,
        value: failCreateWritable,
      });
    } catch {
      /* 注入失败时后续断言会明确失败 */
    }
    // 真实 OPFS 子目录冒充备份目录选择器。
    try {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        writable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle('backup-target', { create: true });
        },
      });
    } catch {
      /* 同上 */
    }
  });
  const mainPage = page;
  try {
    page = await failureContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[backup-failure] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '失败注入场景：书架可见');

    // 1) 建作品写中文 + Ctrl+S 快照
    await page.locator(SEL.newDoc).first().click();
    await waitAnyVisible([SEL.editorView], 15_000, '失败注入场景：编辑器可见');
    await page.locator(SEL.editorTitleButton).first().click();
    const titleInput = page.locator(SEL.titleInput).first();
    await titleInput.waitFor({ state: 'visible', timeout: 8_000 });
    await titleInput.fill('韧性甲');
    await titleInput.press('Enter');
    await placeCaretAtEnd();
    const text1 = '备份写入失败韧性测试：正文必须保留。';
    await page.keyboard.type(text1);
    await waitFor(async () => (await textareaValue()) === text1, { label: '失败注入场景：正文输入', timeout: 8_000 });
    await page.keyboard.press('Control+s');
    await waitAnyVisible([SEL.saveToast], 6_000, '失败注入场景：Ctrl+S 保存提示');
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docItem], 15_000, '失败注入场景：返回书架');
    const docId = await page.locator(SEL.docItem).first().getAttribute('data-doc-id');
    assert(docId, '失败注入场景：缺少 docId');
    log(`失败注入场景作品「韧性甲」docId=${docId}（${text1.length} 码元）`);

    // 2) 选备份目录 → createWritable 抛错 → 可读失败提示 + lastError
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '失败注入场景：设置面板可见');
    await page.locator(SEL.backupChooseButton).first().click();
    const failureToast = await waitFor(
      async () => {
        const texts = await toastTexts();
        return texts.find((text) => text.includes('首次备份失败') || text.includes('备份失败') || text.includes('无法选择备份目录')) || null;
      },
      { label: '选目录后出现可读的备份失败提示', timeout: 30_000 },
    );
    const failureStatus = await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('已配置') && (text.includes('备份错误') || text.includes('失败')) ? text : null;
      },
      { label: 'backup-status 显示已配置 + 备份错误', timeout: 20_000 },
    ).catch(() => null);
    const kvFailed = await readBackupKvState();
    assert(kvFailed.lastError && kvFailed.lastError.length > 0, `备份失败后 kv backup.lastError 未记录（status=${failureStatus ?? 'n/a'}）`);
    log(`写入失败提示：${failureToast.replace(/\s+/g, ' ').slice(0, 140)}`);
    if (failureStatus) log(`备份状态：${failureStatus.replace(/\s+/g, ' ').slice(0, 140)}`);
    const rootChildren = await page.evaluate(() => document.querySelector('#root')?.children.length ?? 0);
    assert(rootChildren > 0, '备份写入失败后应用白屏');
    assert(await locatorVisible(SEL.settingsPanel), '备份写入失败后设置面板应仍可见');
    const failedDir = await readBackupDirSnapshot();
    assert(failedDir.exists, '备份目录未能创建（伪目录选择器异常）');
    assert(!failedDir.files['writertools-manifest.json'], '写入全部失败却写出了 manifest');
    await screenshot('23-backup-write-failure.png');

    // 3) 失败后继续编辑/保存 → 自动备份失败不打断编辑、不刷屏
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 10_000, '失败注入场景：返回书架');
    await page.locator(`${SEL.docItem}[data-doc-id="${docId}"]`).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '失败注入场景：重新打开作品');
    await waitFor(async () => (await textareaValue()) === text1, { label: '备份失败后原正文完整', timeout: 10_000 });
    await placeCaretAtEnd();
    const text2 = '写盘失败后继续输入。';
    await page.keyboard.type(text2);
    await waitFor(async () => (await textareaValue()) === text1 + text2, { label: '备份失败后仍可继续编辑', timeout: 10_000 });
    await page.keyboard.press('Control+s');
    await waitAnyVisible([SEL.saveToast], 6_000, '失败注入场景：失败后 Ctrl+S 保存提示');
    await sleep(4_000); // 给自动备份调度一次失败机会（防抖 3s）
    const toastNoise = (await toastTexts()).filter((text) => text.includes('备份失败') || text.includes('写入失败')).length;
    assert(toastNoise <= 2, `自动备份失败产生过多错误提示（${toastNoise} 条），不应刷屏打断编辑`);
    assertEqual(await textareaValue(), text1 + text2, '自动备份失败打断了编辑/改写了正文');
    await page.keyboard.type('可');
    await page.keyboard.press('Backspace');
    await waitFor(async () => (await textareaValue()) === text1 + text2, { label: '备份失败后编辑器仍可正常输入', timeout: 8_000 });

    // 4) 刷新后主存储（正文/历史）完整；启动健康检查应提示"备份需要处理"（lastError 分支）
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAppMounted();
    await waitAnyVisible([SEL.docItem], 15_000, '失败场景刷新后书架可见');
    await waitAnyVisible([SEL.backupHealthToast], 25_000, '备份失败后启动健康告警 backup-health-toast');
    const failureHealthText = (await page.locator(SEL.backupHealthToast).first().innerText()).trim();
    assert(failureHealthText.includes('备份'), `备份失败健康告警文案不含「备份」：${failureHealthText}`);
    assert(failureHealthText.includes('需要处理') || failureHealthText.includes('设置'), `备份失败健康告警文案异常：${failureHealthText}`);
    log(`备份失败后启动健康告警：${failureHealthText.replace(/\s+/g, ' ')}`);
    await page.locator(`${SEL.docItem}[data-doc-id="${docId}"]`).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '失败场景刷新后打开作品');
    const afterReloadValue = await waitFor(
      async () => {
        const value = await textareaValue();
        return value === text1 + text2 ? value : null;
      },
      { label: '备份写盘失败后刷新，正文仍完整', timeout: 15_000 },
    );
    await page.locator(SEL.historyButton).first().click();
    await waitAnyVisible([SEL.historyPanel], 10_000, '失败场景刷新后历史面板可见');
    const historyCount = await waitFor(
      async () => {
        const count = await page.locator(SEL.historyItem).count();
        return count > 0 ? count : null;
      },
      { label: '备份写盘失败后历史版本仍存在', timeout: 10_000 },
    );
    await page.locator(SEL.historyClose).first().click();
    await sleep(200);
    log(`写盘失败后刷新：正文完整（${afterReloadValue.length} 码元），历史版本 ${historyCount} 个`);

    // 5) 读取失败：删除备份目录后再点「从备份目录恢复」→ 可读错误、数据不变
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docList], 15_000, '失败场景：回到书架');
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '失败场景：再次打开设置面板');
    const dirRemoved = await page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry('backup-target', { recursive: true });
        return true;
      } catch {
        return false;
      }
    });
    assert(dirRemoved, '读取失败场景：未能删除备份目录');
    await page.locator(SEL.restoreFromBackupButton).first().click();
    const restoreError = await waitFor(
      async () => {
        const locator = page.locator(SEL.archiveImportResult).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        // 注意排除恢复中的瞬时文案（"正在从备份目录恢复作品…"）。
        return /恢复失败|不可读|不合法|错误/.test(text) && !text.includes('正在从备份目录恢复') ? text : null;
      },
      { label: '备份目录不可读时出现可读错误提示', timeout: 30_000 },
    );
    assert(/失败|不可读/.test(restoreError), `备份目录读取失败提示不可读：${restoreError}`);
    log(`读取失败提示：${restoreError.replace(/\s+/g, ' ').slice(0, 160)}`);
    const rootChildrenAfterReadFailure = await page.evaluate(() => document.querySelector('#root')?.children.length ?? 0);
    assert(rootChildrenAfterReadFailure > 0, '备份目录读取失败后应用白屏');

    // 6) 其它数据安全能力不受备份目录故障影响：校验全部仍通过
    await page.locator(SEL.verifyAllButton).first().click();
    const verifyText = await waitFor(
      async () => {
        const locator = page.locator(SEL.verifyResult).first();
        if ((await locator.count()) === 0 || !(await locator.isVisible())) return null;
        const text = (await locator.innerText()).trim();
        return text.length > 0 ? text : null;
      },
      { label: '备份目录故障下校验全部结果出现', timeout: 25_000 },
    );
    assert(verifyText.includes('校验通过'), `备份目录故障下校验全部未通过：${verifyText}`);
    log(`备份目录故障下应用内校验：${verifyText.replace(/\s+/g, ' ')}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '失败场景：返回书架');
    assertEqual(await page.locator(SEL.docItem).count(), 1, '备份/恢复失败后作品数不应变化');
    await page.locator(`${SEL.docItem}[data-doc-id="${docId}"]`).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '失败场景：备份目录故障后仍可打开作品');
    assertEqual(await textareaValue(), text1 + text2, '备份目录故障后正文被破坏');
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docList], 10_000, '失败场景：最终返回书架');
    await screenshot('23b-backup-read-failure.png');
    return `备份写盘失败：可读提示 + kv.lastError 记录、无 manifest 落盘、应用不白屏；失败后继续编辑/保存/刷新正文与历史完整、自动备份失败未打断编辑；备份目录删除（读取失败）：恢复显示可读错误、作品数与正文不变、校验全部仍通过`;
  } finally {
    await failureContext.close().catch(() => {});
    page = mainPage;
  }
}

/**
 * v0.1.6 备份目录权限健康检查与恢复：
 * - 首次 granted：建作品 → 选备份目录 → 首次备份成功；
 * - 模拟浏览器重启后权限变 prompt（localStorage 状态机 + 原型补丁）：reload → 启动健康告警
 *   `backup-health-toast`、backup-status 显示需重新授权、自动备份暂停（快照后不写盘）；
 * - 点 `backup-grant-button` 重新授权 → needsPermission 消失、自动补备份（manifest/lastBackupAt 更新）；
 * - 再次刷新无健康告警、正文完整；未配置目录不出现健康告警（由未配置步骤断言）。
 */
async function stepBackupPermissionRecovery() {
  const permissionContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  await permissionContext.addInitScript(() => {
    // 权限状态机：granted/prompt/denied 由 localStorage 控制；requestPermission 成功后置 granted。
    try {
      Object.defineProperty(FileSystemHandle.prototype, 'queryPermission', {
        configurable: true,
        writable: true,
        value: async () => localStorage.getItem('e2e.perm') || 'granted',
      });
      Object.defineProperty(FileSystemHandle.prototype, 'requestPermission', {
        configurable: true,
        writable: true,
        value: async () => {
          localStorage.setItem('e2e.perm', 'granted');
          return 'granted';
        },
      });
    } catch {
      /* 注入失败时后续断言会明确失败 */
    }
    // 真实 OPFS 子目录冒充备份目录选择器。
    try {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        writable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle('backup-target', { create: true });
        },
      });
    } catch {
      /* 同上 */
    }
  });
  const mainPage = page;
  try {
    page = await permissionContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[backup-permission] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, '权限场景：书架可见');

    // 1) 建作品 + 选备份目录 + 首次备份（初始权限 granted）
    await page.locator(SEL.newDoc).first().click();
    await waitAnyVisible([SEL.editorView], 15_000, '权限场景：编辑器可见');
    await page.locator(SEL.editorTitleButton).first().click();
    const titleInput = page.locator(SEL.titleInput).first();
    await titleInput.waitFor({ state: 'visible', timeout: 8_000 });
    await titleInput.fill('权限甲');
    await titleInput.press('Enter');
    await placeCaretAtEnd();
    const text1 = '备份权限撤销测试：正文必须保留。';
    await page.keyboard.type(text1);
    await waitFor(async () => (await textareaValue()) === text1, { label: '权限场景：正文输入', timeout: 8_000 });
    await page.keyboard.press('Control+s');
    await waitAnyVisible([SEL.saveToast], 6_000, '权限场景：Ctrl+S 保存提示');
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docItem], 15_000, '权限场景：返回书架');
    const docId = await page.locator(SEL.docItem).first().getAttribute('data-doc-id');
    assert(docId, '权限场景：缺少 docId');

    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '权限场景：设置面板可见');
    await page.locator(SEL.backupChooseButton).first().click();
    await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('已配置') && !text.includes('需要重新授权') ? text : null;
      },
      { label: '权限场景：首次备份后状态已配置且无需授权', timeout: 30_000 },
    );
    const firstBackup = await waitBackupManifest(
      (manifest) => Array.isArray(manifest.docs) && manifest.docs.some((doc) => doc.docId === docId),
      '权限场景：首次备份写入 manifest/.wtlog',
      30_000,
    );
    const manifest1UpdatedAt = firstBackup.manifest.updatedAt;
    const firstFileCount = Object.keys(firstBackup.snapshot.files).length;
    const kv1 = await readBackupKvState();
    assert(typeof kv1.lastBackupAt === 'string', '权限场景：首次备份 lastBackupAt 缺失');
    const kv1LastBackupAt = kv1.lastBackupAt;
    log(`首次备份（granted）：${firstFileCount} 个文件，manifest.updatedAt=${manifest1UpdatedAt}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 10_000, '权限场景：关闭设置返回书架');

    // 2) 模拟浏览器重启后权限变 prompt → reload → 启动健康告警
    await page.evaluate(() => localStorage.setItem('e2e.perm', 'prompt'));
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAnyVisible([SEL.backupHealthToast], 25_000, '启动备份健康告警 backup-health-toast');
    const healthText = (await page.locator(SEL.backupHealthToast).first().innerText()).trim();
    assert(healthText.includes('备份'), `健康告警文案不含「备份」：${healthText}`);
    assert(healthText.includes('重新授权') || healthText.includes('暂停'), `健康告警文案不含「重新授权/暂停」：${healthText}`);
    log(`启动健康告警：${healthText.replace(/\s+/g, ' ')}`);
    await waitAppMounted();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem], 15_000, '权限提示后书架可见');
    const rootChildren = await page.evaluate(() => document.querySelector('#root')?.children.length ?? 0);
    assert(rootChildren > 0, '权限缺失提示后应用白屏');

    // 3) 设置显示需重新授权；自动备份被暂停（快照后不写盘）
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '权限场景：权限失效后设置面板可见');
    const needsAuthStatus = await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('已配置') && text.includes('需要重新授权') ? text : null;
      },
      { label: 'backup-status 显示「需要重新授权」', timeout: 15_000 },
    );
    assert(await page.locator(SEL.backupGrantButton).first().isVisible(), 'backup-grant-button 不可见');
    log(`权限失效状态：${needsAuthStatus.replace(/\s+/g, ' ')}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 10_000, '权限场景：权限失效后返回书架');
    await page.locator(`${SEL.docItem}[data-doc-id="${docId}"]`).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '权限场景：权限失效后打开作品');
    await placeCaretAtEnd();
    const text2 = '权限撤销后继续写作。';
    await page.keyboard.type(text2);
    await waitFor(async () => (await textareaValue()) === text1 + text2, { label: '权限失效后仍可继续编辑', timeout: 10_000 });
    await page.keyboard.press('Control+s');
    await waitAnyVisible([SEL.saveToast], 6_000, '权限场景：权限失效后 Ctrl+S 提示');
    await sleep(8_000); // 覆盖自动备份防抖（3s）——权限门控下必须零写入
    const pausedDir = await readBackupDirSnapshot();
    const pausedManifest = parseBackupManifest(pausedDir);
    assert(pausedManifest, '权限失效期间备份 manifest 丢失');
    assertEqual(pausedManifest.updatedAt, manifest1UpdatedAt, '权限失效时自动备份仍写入了 manifest（暂停失效）');
    assertEqual(Object.keys(pausedDir.files).length, firstFileCount, '权限失效时备份目录文件数变化（自动备份未暂停）');
    const kvPaused = await readBackupKvState();
    assertEqual(kvPaused.lastBackupAt, kv1LastBackupAt, '权限失效时自动备份更新了 lastBackupAt（未暂停）');
    log('权限失效期间自动备份已暂停：manifest/lastBackupAt/文件数均未变化');

    // 4) 点「重新授权」→ 权限恢复 + 自动补备份
    await page.locator(SEL.editorLibraryButton).first().click();
    await waitAnyVisible([SEL.docList], 15_000, '权限场景：编辑后返回书架');
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, '权限场景：重新打开设置面板');
    await page.locator(SEL.backupGrantButton).first().click();
    const grantToast = await waitFor(
      async () => {
        const texts = await toastTexts();
        return texts.find((text) => text.includes('已重新授权') || text.includes('已补备份')) || null;
      },
      { label: '重新授权后有成功提示', timeout: 20_000 },
    ).catch(() => null);
    if (grantToast) log(`重新授权提示：${grantToast.replace(/\s+/g, ' ')}`);
    const statusAfterGrant = await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('已配置') && !text.includes('需要重新授权') ? text : null;
      },
      { label: '重新授权后 backup-status 不再显示需要授权', timeout: 20_000 },
    );
    log(`重新授权后状态：${statusAfterGrant.replace(/\s+/g, ' ')}`);
    const backupAfterGrant = await waitBackupManifest(
      (manifest) => manifest.updatedAt !== manifest1UpdatedAt,
      '重新授权后自动补备份（manifest.updatedAt 更新）',
      35_000,
    );
    const kvAfterGrant = await waitFor(
      async () => {
        const kv = await readBackupKvState();
        return kv.lastBackupAt && kv.lastBackupAt !== kv1LastBackupAt ? kv : null;
      },
      { label: '重新授权后 backup.lastBackupAt 更新', timeout: 35_000 },
    ).catch(() => null);
    assert(kvAfterGrant, '重新授权后 backup.lastBackupAt 未更新（补备份未执行）');
    log(`重新授权后补备份：manifest.updatedAt ${manifest1UpdatedAt} → ${backupAfterGrant.manifest.updatedAt}`);
    await page.locator(SEL.settingsClose).first().click();
    await waitAnyVisible([SEL.docList], 10_000, '权限场景：授权后返回书架');

    // 5) 再次刷新：权限已恢复、不应再出现健康告警；正文完整
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAppMounted();
    await waitAnyVisible([SEL.docItem], 15_000, '权限恢复后刷新书架可见');
    await sleep(2_500);
    assertEqual(await page.locator(SEL.backupHealthToast).count(), 0, '权限恢复后刷新仍出现 backup-health-toast');
    await page.locator(`${SEL.docItem}[data-doc-id="${docId}"]`).first().click();
    await waitAnyVisible([SEL.textarea], 10_000, '权限恢复后打开作品');
    const finalValue = await waitFor(
      async () => {
        const value = await textareaValue();
        return value === text1 + text2 ? value : null;
      },
      { label: '权限恢复后正文仍完整', timeout: 15_000 },
    );
    await page.keyboard.press('Escape');
    await waitAnyVisible([SEL.docList], 10_000, '权限恢复后返回书架');

    // 6) denied 分支：健康告警仍出现、状态显示「权限被拒绝（自动备份已暂停）」
    await page.evaluate(() => localStorage.setItem('e2e.perm', 'denied'));
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAnyVisible([SEL.backupHealthToast], 25_000, 'denied 权限启动健康告警 backup-health-toast');
    const deniedHealthText = (await page.locator(SEL.backupHealthToast).first().innerText()).trim();
    assert(
      deniedHealthText.includes('重新授权') || deniedHealthText.includes('暂停'),
      `denied 健康告警文案异常：${deniedHealthText}`,
    );
    log(`denied 健康告警：${deniedHealthText.replace(/\s+/g, ' ')}`);
    await waitAppMounted();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList, SEL.docItem], 15_000, 'denied 权限后书架可见');
    await page.locator(SEL.librarySettingsButton).first().click();
    await waitAnyVisible([SEL.settingsPanel], 10_000, 'denied 权限后设置面板可见');
    const deniedStatus = await waitFor(
      async () => {
        const locator = page.locator(SEL.backupStatus).first();
        if ((await locator.count()) === 0) return null;
        const text = (await locator.innerText().catch(() => '')).trim();
        return text.includes('权限被拒绝') && text.includes('自动备份已暂停') ? text : null;
      },
      { label: 'denied 时 backup-status 显示「权限被拒绝（自动备份已暂停）」', timeout: 15_000 },
    );
    log(`denied 状态：${deniedStatus.replace(/\s+/g, ' ')}`);
    await page.locator(SEL.settingsClose).first().click();
    await screenshot('24-backup-permission.png');
    return `权限 granted→prompt 重启：健康告警「${healthText.replace(/\s+/g, ' ').slice(0, 60)}…」、状态需重新授权、自动备份暂停（manifest/lastBackupAt/文件数零变化）；点重新授权后补备份（manifest.updatedAt 更新、lastBackupAt 更新）、再次刷新无告警、正文完整（${finalValue.length} 码元）；denied 分支健康告警与「权限被拒绝（自动备份已暂停）」文案正常`;
  } finally {
    await permissionContext.close().catch(() => {});
    page = mainPage;
  }
}

/**
 * v0.1.7 数据丢失回归：输入后立即返回书架不得丢字。
 * - 模式 A（等待 textarea 值确认后立即 Esc）×10；
 * - 模式 B（输入后不等待、立即 Esc）×10；
 * 每次都以 IndexedDB events 真实重放正文 === 预期，并断言 docs.chars === 长度、末尾正文事件为 text.insert；
 * 追加 IME 上屏后立即 Esc、pagehide 后重开两个变体。
 */
async function stepEscapeFlushNoDataLoss() {
  const flushContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', colorScheme: 'light' });
  const mainPage = page;
  const MODE_A_COUNT = 10;
  const MODE_B_COUNT = 10;
  try {
    page = await flushContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(`[escape-flush] ${error.message}`));
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* 忽略 */
      }
    });
    await openApp();
    await waitAnyVisible([SEL.libraryEmpty, SEL.docList], 15_000, 'Esc 丢字回归：书架可见');

    // 新建作品（模式 A 第一轮直接在当前编辑器里输入）
    await page.locator(SEL.newDoc).first().click();
    await waitAnyVisible([SEL.editorView], 15_000, 'Esc 丢字回归：新建作品编辑器可见');
    await page.locator(SEL.editorTitleButton).first().click();
    const titleInput = page.locator(SEL.titleInput).first();
    await titleInput.waitFor({ state: 'visible', timeout: 8_000 });
    await titleInput.fill('Esc韧性');
    await titleInput.press('Enter');
    await placeCaretAtEnd();

    const openDoc = async () => {
      await page.locator(SEL.docItem).first().click();
      await waitAnyVisible([SEL.textarea], 10_000, 'Esc 丢字回归：重新打开作品');
    };
    const backToLibrary = async (label) => {
      await page.keyboard.press('Escape');
      await waitAnyVisible([SEL.docList], 15_000, label);
    };
    const assertReplay = async (label, timeout = 25_000) => {
      const result = await waitFor(
        async () => {
          const group = await readCurrentDocGroup('读取 Esc 丢字回归事件流');
          const text = replayText(group.events);
          return text === expected ? { group, text } : null;
        },
        { label: `${label}：IndexedDB 事件重放正文与预期一致`, timeout },
      );
      return result;
    };

    let expected = '';
    let docId = null;
    let inEditor = true;

    // 模式 A：等待 textarea.value === 预期后立即 Esc ×10
    for (let index = 1; index <= MODE_A_COUNT; index += 1) {
      if (!inEditor) await openDoc();
      await placeCaretAtEnd();
      const chunk = `确认后立即返回第${index}段：中文内容必须完整落盘。`;
      await page.keyboard.type(chunk);
      await waitFor(async () => (await textareaValue()) === expected + chunk, {
        label: `模式A 第${index}段 textarea.value 确认`,
        timeout: 8_000,
      });
      expected += chunk;
      await backToLibrary(`模式A 第${index}次 Esc 返回书架`);
      inEditor = false;
      if (!docId) docId = await page.locator(SEL.docItem).first().getAttribute('data-doc-id');
    }
    assert(docId, 'Esc 丢字回归：缺少 docId');
    const replayA = await assertReplay('模式A 结束后');
    const textEventsA = replayA.group.events.filter((event) => event.affects === 'text');
    assertEqual(textEventsA.at(-1)?.type, 'text.insert', '模式A 事件流末尾的正文事件应为 text.insert');
    assertEqual(
      (await readDocSummaryFromIdb(docId)).chars,
      expected.length,
      '模式A 结束后 docs.chars 与预期长度不一致',
    );
    log(`模式A（确认后 Esc）${MODE_A_COUNT} 次：IndexedDB 重放正文 ${expected.length} 码元与预期完全一致`);

    // 重新打开 UI 再确认一次
    await openDoc();
    await waitFor(async () => (await textareaValue()) === expected, { label: '模式A 后重新打开正文一致', timeout: 10_000 });
    await backToLibrary('模式A 验证后返回书架');

    // 模式 B：输入后不等待，立即 Esc ×10
    for (let index = 1; index <= MODE_B_COUNT; index += 1) {
      await openDoc();
      await placeCaretAtEnd();
      const chunk = `立即返回第${index}段：没有等待确认也必须完整。`;
      await page.keyboard.type(chunk);
      expected += chunk;
      await backToLibrary(`模式B 第${index}次立即 Esc 返回书架`);
    }
    const replayB = await assertReplay('模式B 结束后');
    const textEventsB = replayB.group.events.filter((event) => event.affects === 'text');
    assertEqual(textEventsB.at(-1)?.type, 'text.insert', '模式B 事件流末尾的正文事件应为 text.insert');
    assert(
      textEventsB.every((event) => event.type === 'text.insert'),
      'Esc 丢字回归过程中不应出现 delete/replace 等非预期正文事件',
    );
    const docSummaryB = await readDocSummaryFromIdb(docId);
    assert(docSummaryB, 'Esc 丢字回归：读取 docs 摘要失败');
    assertEqual(docSummaryB.chars, expected.length, '模式B 结束后 docs.chars 与预期长度不一致');
    await openDoc();
    await waitFor(async () => (await textareaValue()) === expected, { label: '模式B 后重新打开正文一致', timeout: 10_000 });
    log(`模式B（输入后立即 Esc）${MODE_B_COUNT} 次：IndexedDB 重放正文 ${expected.length} 码元与预期完全一致`);

    // 变体 1：IME 上屏后立即 Esc
    await placeCaretAtEnd();
    const cdp = await flushContext.newCDPSession(page);
    try {
      await page.locator(SEL.textarea).first().focus();
      await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
      await cdp.send('Input.insertText', { text: '你好' });
    } finally {
      await cdp.detach().catch(() => {});
    }
    expected += '你好';
    await backToLibrary('IME 上屏后立即 Esc 返回书架');
    const replayIme = await assertReplay('IME 后');
    const composeEvents = replayIme.group.events.filter((event) => typeof event.type === 'string' && event.type.startsWith('compose.'));
    assert(composeEvents.length >= 3, `IME 变体 compose.* 事件不足：${composeEvents.length}`);
    await openDoc();
    await waitFor(async () => (await textareaValue()) === expected, { label: 'IME 上屏后立即 Esc 正文完整', timeout: 10_000 });
    log(`IME 上屏后立即 Esc：正文含「你好」，compose.* 事件 ${composeEvents.length} 条`);

    // 变体 2：输入后派发 pagehide（模拟标签页隐藏/关闭）再 reload 重开
    await placeCaretAtEnd();
    const pagehideChunk = 'pagehide后也必须落盘。';
    await page.keyboard.type(pagehideChunk);
    expected += pagehideChunk;
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    });
    await sleep(300);
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await waitAppMounted();
    await waitAnyVisible([SEL.docItem], 15_000, 'pagehide 后刷新书架可见');
    await openDoc();
    await waitFor(async () => (await textareaValue()) === expected, { label: 'pagehide 后刷新正文完整', timeout: 15_000 });
    await backToLibrary('pagehide 验证后返回书架');
    const replayFinal = await assertReplay('pagehide 后');
    const finalSummary = await readDocSummaryFromIdb(docId);
    assertEqual(finalSummary.chars, expected.length, '最终 docs.chars 与预期长度不一致');
    assertEqual(replayFinal.text, expected, '最终 IndexedDB 重放正文与预期不一致');
    log(`pagehide 变体：刷新后正文完整（${expected.length} 码元），IndexedDB 重放一致`);
    await screenshot('25-escape-flush.png');
    return `Esc 丢字回归通过：模式A（确认后 Esc）×${MODE_A_COUNT} + 模式B（立即 Esc）×${MODE_B_COUNT} 均以 IndexedDB 真实重放校验（最终 ${expected.length} 码元，docs.chars 一致、末尾为 text.insert）；IME 上屏后立即 Esc（compose ${composeEvents.length} 条）与 pagehide 后刷新重开均不丢字`;
  } finally {
    await flushContext.close().catch(() => {});
    page = mainPage;
  }
}

/**
 * v0.2.0 原始输入回放/查看面板：
 * 复用 CDP 真实 IME 组合（ni → nihao → 上屏「你好」）+ 普通键盘输入 + 退格，
 * 打开 editor-trace-button → trace-panel：summary 计数、时间线内容（预编辑/上屏/输入/删除）、
 * 点击详情 JSON、播放/上一步下一步、关闭按钮与 Esc。
 */
async function stepInputTracePanel() {
  await waitAnyVisible([SEL.docList, SEL.libraryEmpty], 15_000, '原始输入面板：书架可见');
  assert((await page.locator(SEL.docItem).count()) > 0, '原始输入面板：需要已有作品');
  await page.locator(SEL.docItem).first().click();
  await waitAnyVisible([SEL.textarea], 10_000, '原始输入面板：打开作品');
  await placeCaretAtEnd();
  const baseValue = await textareaValue();

  // 1) CDP 真实 IME：ni → nihao 预编辑变化后提交「你好」
  const cdp = await context.newCDPSession(page);
  try {
    await page.locator(SEL.textarea).first().focus();
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
    await cdp.send('Input.insertText', { text: '你好' });
  } finally {
    await cdp.detach().catch(() => {});
  }
  // 2) 普通键盘输入 + 退格删除
  await page.keyboard.type('trace普通输入');
  await waitFor(async () => (await textareaValue()) === `${baseValue}你好trace普通输入`, {
    label: '原始输入面板：IME 上屏 + 普通输入后正文符合预期',
    timeout: 10_000,
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  const expectedValue = `${baseValue}你好trace普通`;
  await waitFor(async () => (await textareaValue()) === expectedValue, {
    label: '原始输入面板：退格删除后正文符合预期',
    timeout: 10_000,
  });

  // 3) 打开面板
  await page.locator(SEL.editorTraceButton).first().click();
  await waitAnyVisible([SEL.tracePanel], 10_000, '原始输入面板 trace-panel 可见');
  await waitFor(async () => (await page.locator(SEL.traceRow).count()) > 0, {
    label: '原始输入面板：trace-row 时间线行出现',
    timeout: 10_000,
  });
  const summaryText = (await page.locator(SEL.traceSummary).first().innerText()).replace(/\s+/g, ' ').trim();
  assert(summaryText.includes('组合事件') && summaryText.includes('IME 上屏'), `trace-summary 内容异常：${summaryText}`);
  const composeCount = Number((summaryText.match(/组合事件\s*(\d+)/) || [])[1] ?? '0');
  const imeCount = Number((summaryText.match(/IME 上屏\s*(\d+)/) || [])[1] ?? '0');
  const textCount = Number((summaryText.match(/正文编辑\s*(\d+)/) || [])[1] ?? '0');
  assert(composeCount >= 3, `组合事件计数异常：${composeCount}`);
  assert(imeCount >= 1, `IME 上屏计数异常：${imeCount}`);
  assert(textCount >= 3, `正文编辑计数异常：${textCount}`);
  log(`trace-summary：${summaryText}`);
  assert((await page.locator(SEL.traceDetail).first().isVisible()), 'trace-detail 初始不可见');

  // 4) 时间线内容：预编辑拼音 / 上屏「你好」/ 普通输入 / 删除
  const rowTexts = (await page.locator(SEL.traceRow).allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
  const composeUpdateIndex = rowTexts.findIndex((text) => text.includes('预编辑「nihao」'));
  assert(composeUpdateIndex >= 0, `时间线缺少原始拼音行「预编辑「nihao」」：${rowTexts.slice(0, 12).join(' | ')}`);
  const imeInsertIndex = rowTexts.findIndex((text) => text.includes('上屏') && text.includes('你好') && text.includes('+2'));
  assert(imeInsertIndex >= 0, '时间线缺少 IME 上屏「你好」正文行');
  const composeEndIndex = rowTexts.findIndex((text) => text.includes('组合结束') && text.includes('上屏「你好」'));
  assert(composeEndIndex >= 0, '时间线缺少「组合结束 → 上屏「你好」」行');
  const typingIndex = rowTexts.findIndex((text) => text.includes('键盘输入'));
  assert(typingIndex >= 0, '时间线缺少普通键盘输入行（含「键盘输入」）');
  const deleteIndex = rowTexts.findIndex((text) => text.includes('删除'));
  assert(deleteIndex >= 0, '时间线缺少退格删除行');
  log(`时间线 ${rowTexts.length} 行；命中：预编辑#${composeUpdateIndex}、IME 上屏#${imeInsertIndex}、组合结束#${composeEndIndex}、键盘#${typingIndex}、删除#${deleteIndex}`);

  // 5) 点击行 → trace-detail JSON
  const nihaoRow = page.locator(SEL.traceRow).nth(composeUpdateIndex);
  await nihaoRow.click();
  assertEqual(await nihaoRow.getAttribute('aria-selected'), 'true', '点击后 nihao 行未 aria-selected');
  const nihaoDetail = await page.locator(SEL.traceDetail).first().innerText();
  assert(nihaoDetail.includes('"kind": "compose"'), `trace-detail 缺少 kind=compose：${nihaoDetail.slice(0, 160)}`);
  assert(nihaoDetail.includes('"phase": "update"'), 'trace-detail 缺少 phase=update');
  assert(nihaoDetail.includes('"data": "nihao"'), 'trace-detail 缺少原始拼音 data=nihao');

  await page.locator(SEL.traceRow).nth(composeEndIndex).click();
  const endDetail = await page.locator(SEL.traceDetail).first().innerText();
  assert(endDetail.includes('"phase": "end"'), 'trace-detail 缺少 phase=end');
  assert(endDetail.includes('"committed": "你好"'), 'trace-detail 缺少 committed=你好');

  await page.locator(SEL.traceRow).nth(imeInsertIndex).click();
  const imeDetail = await page.locator(SEL.traceDetail).first().innerText();
  assert(imeDetail.includes('"source": "ime"'), 'trace-detail 缺少 source=ime');
  assert(imeDetail.includes('"op": "insert"'), 'trace-detail 缺少 op=insert');

  // 6) 播放推进 + 上一条/下一条单步
  const selectedIndex = async () => {
    const row = page.locator(`${SEL.traceRow}[aria-selected="true"]`).first();
    return Number(await row.getAttribute('data-index'));
  };
  await page.locator(SEL.traceRow).first().click();
  const beforePlay = await selectedIndex();
  await page.locator(SEL.tracePlayButton).first().click();
  await waitFor(async () => (await selectedIndex()) > beforePlay, { label: '播放后高亮行推进', timeout: 6_000 });
  const afterPlay = await selectedIndex();
  assertEqual(await page.locator(SEL.tracePlayButton).first().getAttribute('aria-pressed'), 'true', '播放中按钮 aria-pressed 应为 true');
  await page.locator(SEL.tracePlayButton).first().click(); // 暂停
  await waitFor(async () => (await page.locator(SEL.tracePlayButton).first().getAttribute('aria-pressed')) === 'false', {
    label: '暂停后播放按钮状态复位',
    timeout: 5_000,
  });
  assert(!(await page.locator(SEL.tracePrevButton).first().isDisabled()), 'trace-prev-button 在非空时间线时应可用');
  assert(!(await page.locator(SEL.traceNextButton).first().isDisabled()), 'trace-next-button 在非空时间线时应可用');
  await page.locator(SEL.traceNextButton).first().click();
  const afterNext = await selectedIndex();
  assert(afterNext > afterPlay, `下一条未推进：${afterPlay} → ${afterNext}`);
  await page.locator(SEL.tracePrevButton).first().click();
  const afterPrev = await selectedIndex();
  assertEqual(afterPrev, afterNext - 1, '上一条未回退一行');
  log(`播放推进 ${beforePlay}→${afterPlay}；下一条→${afterNext}；上一条→${afterPrev}`);
  await screenshot('26-input-trace.png');

  // 7) 关闭按钮 + 重开后 Esc 关闭（Esc 只关面板，不退出编辑器）
  await page.locator(SEL.traceClose).first().click();
  await waitFor(async () => (await page.locator(SEL.tracePanel).count()) === 0, {
    label: 'trace-close 关闭面板',
    timeout: 5_000,
  });
  await page.locator(SEL.editorTraceButton).first().click();
  await waitAnyVisible([SEL.tracePanel], 10_000, '原始输入面板：重开 trace-panel');
  await page.keyboard.press('Escape');
  await waitFor(async () => (await page.locator(SEL.tracePanel).count()) === 0, {
    label: 'Esc 关闭原始输入面板',
    timeout: 5_000,
  });
  assert(await page.locator(SEL.textarea).first().isVisible(), 'Esc 关闭面板后应仍停留在编辑器');
  await page.keyboard.press('Escape');
  await waitAnyVisible([SEL.docList], 15_000, '原始输入面板：返回书架');
  return `原始输入面板通过：summary 组合事件 ${composeCount} / IME 上屏 ${imeCount} / 正文编辑 ${textCount}；时间线含「预编辑「nihao」」、上屏「你好」、键盘输入、删除行；详情 JSON 含 phase/data/committed/source；播放 ${beforePlay}→${afterPlay}、上一步/下一步可用；关闭按钮与 Esc 均只关面板`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function printSummary() {
  const passed = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);
  console.log('');
  console.log('============================================================');
  console.log(`E2E 结果：${passed}/${results.length} 项通过，${failed.length} 项失败（浏览器：${BROWSER_LABEL}，BASE_URL：${BASE_URL}）`);
  if (failed.length > 0) {
    for (const item of failed) {
      console.log(`  FAIL [${item.no}] ${item.name}`);
      console.log(`       ${String(item.error && item.error.message).split('\n')[0]}`);
    }
    console.log(`失败截图目录：${path.relative(ROOT, ARTIFACTS_DIR)}`);
  }
  console.log('============================================================');
  return failed.length;
}

async function main() {
  console.log(`[e2e] WriterTools 冒烟测试${DRY_RUN ? '（dry-run）' : ''}`);
  cleanupOldArtifacts();
  await ensureBuild();
  await ensureServer();

  browser = await launchBrowser();
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    colorScheme: 'light',
    // 剪贴板权限：用于验证粘贴事件 source='paste'（真实 Ctrl+V）。
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page = await context.newPage();
  page.on('pageerror', (error) => {
    pageErrors.push(String(error && error.message ? error.message : error));
  });
  page.on('console', (message) => {
    if (message.type() === 'error') log(`[browser console.error] ${message.text().slice(0, 300)}`);
  });
  page.on('dialog', async (dialog) => {
    log(`接受浏览器对话框：${dialog.type()} ${JSON.stringify(dialog.message().slice(0, 120))}`);
    try {
      await dialog.accept();
    } catch {
      /* 对话框可能已自动关闭 */
    }
  });

  if (DRY_RUN) {
    await openApp();
    const info = await page.evaluate(() => ({
      title: document.title,
      rootChildren: document.querySelector('#root') ? document.querySelector('#root').children.length : 0,
      bodyText: (document.body.innerText || '').slice(0, 120),
    }));
    log(`页面标题：${info.title}`);
    log(`#root 子节点数：${info.rootChildren}`);
    log(`页面文本片段：${JSON.stringify(info.bodyText)}`);
    console.log('');
    console.log(`PASS dry-run — Chrome（${BROWSER_LABEL}）启动、页面打开、React 挂载均正常`);
    return 0;
  }

  await step('PWA 资源与 Service Worker', stepPwa);
  await step('首页书架 → 新建作品 → 编辑器可见且聚焦', stepLibraryAndCreate);
  await step('回归：快速连续输入（含空格）无"正文已同步"误报 / 无回滚 / 光标在末尾', stepRapidTypingRegression);
  await step('逐字符输入（中/英/emoji）与退格删除', stepTypingAndBackspace);
  await step('IndexedDB 事件流：text.insert / text.delete / seq 连续 / 哈希链', stepIndexedDbTextEvents);
  await step('输入法组合过程 compose.* 落盘', stepCompositionEvents);
  await step('编辑来源映射：IME 上屏 / 粘贴 / 撤销 / 重做', stepSourceMapping);
  await step('刷新后持久化（书架 doc-item → 打开 → 正文一致）', stepReloadPersistence);
  await step('Ctrl+S 快照与历史面板（预览 + 确认恢复 + 恢复提示）', stepSaveShortcutAndHistory);
  await step('排版模式切换（typewriter/centered ↔ text-align right/left）', stepModeToggle);
  await step('回归：100+ 字符快速输入后双模式光标行垂直居中（≤ 1 行高）', stepCenteringAfterRapidInput);
  await step('跟随系统明暗主题（纯黑/纯白或奶白、无彩色）', stepTheme);
  await step('设置面板：默认值 / 奶白背景 / 校验全部 / 备份入口', stepSettingsAndBackupEntry);
  await step('导出 .wtlog + 独立校验器 + 篡改检测', stepExportAndChecker);
  await step('v0.1.5：训练数据导出工具（wtlog-to-training → JSONL 字段抽查）', stepTrainingDataExport);
  await step('导出文件再导入（全新浏览器上下文）', stepImportRoundTrip);
  await step('双标签页只读锁（readonly-banner）', stepReadonlyLock);
  await step('回归：主存储（IndexedDB events）被清空 → 启动自动从 OPFS 镜像恢复', stepAutoRecoveryFromMirror);
  await step('回归：无损坏刷新不出现自动恢复/副本分歧提示、不重复补写', stepHealthyReloadHasNoRecoveryNoise);
  await step('v0.1.2：全量备份包 .wtzip 导出（2 作品含快照）+ 书架 .wtzip 路由', stepArchiveExport);
  await step('v0.1.2：备份包独立校验（wtzip-check + fflate manifest/条目 wtlog-check）', stepArchiveNodeVerification);
  await step('v0.1.2：全新环境导入备份包 + 重复导入「跳过 2」+ 校验/历史一致', stepArchiveImport);
  await step('v0.1.2：损坏（截断）备份包导入 → 可读报错、不白屏、本地数据不受影响', stepArchiveCorrupt);
  await step('v0.1.3：备份目录真实写盘 + 自动备份增量 + 启动补齐（OPFS 伪目录）', stepBackupDirectoryAutoBackup);
  await step('v0.1.3：未配置备份目录 → 不写盘、无报错、状态显示未配置', stepUnconfiguredBackupNoop);
  await step('v0.1.4：灾备闭环（清空本地数据 → 重选备份目录 → 一键恢复 → 重复恢复跳过）', stepDisasterRecoveryFromBackupDirectory);
  await step('v0.1.5：备份写入失败/备份目录读取失败 → 可读报错、数据零丢失、编辑不中断', stepBackupFailureResilience);
  await step('v0.1.6：备份目录权限撤销 → 健康告警 → 重新授权 → 自动备份恢复', stepBackupPermissionRecovery);
  await step('v0.1.7：输入后立即返回书架不丢字（IndexedDB 真实重放 ×20 + IME/pagehide 变体）', stepEscapeFlushNoDataLoss);
  await step('v0.2.0：原始输入回放/查看面板（CDP 真实 IME → 时间线/详情/播放）', stepInputTracePanel);
  await step('移动端 390x844：可输入、无横向溢出', stepMobile);
  await step('页面无未捕获异常', stepNoPageErrors);

  return printSummary();
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  console.error('');
  console.error(`[e2e][fatal] ${error.message}`);
  exitCode = 2;
} finally {
  try {
    if (context) await context.close();
  } catch {
    /* 忽略 */
  }
  try {
    if (browser) await browser.close();
  } catch {
    /* 忽略 */
  }
  stopServer();
}

if (exitCode !== 0) {
  console.error(`[e2e] 退出码 ${exitCode}`);
} else {
  log('全部冒烟步骤通过');
}
process.exit(exitCode);
