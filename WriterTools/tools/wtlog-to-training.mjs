#!/usr/bin/env node
/**
 * WriterTools 训练数据导出工具
 * ============================
 * 把 WTL v1.0 日志（.wtlog / .wtzip / 目录）转换为便于训练/分析的 JSONL：
 * 每个事件一行，字段归一化（文本操作、输入法组合、选区、静默元事件等），
 * 时间戳保持 UTC 毫秒；未知事件原样保留 type/data，保证"只增不删"的数据不丢。
 *
 * 默认每个文件先经独立校验器 tools/wtlog-check.mjs 校验（可用 --no-validate 跳过）。
 *
 * 用法：
 *   node tools/wtlog-to-training.mjs <input...> [--out <file.jsonl>] [--summary <file.json>]
 *        [--no-validate] [--with-raw]
 *   node tools/wtlog-to-training.mjs --self-test
 *
 * 输入：.wtlog 文件、.wtzip 备份包、目录（递归扫描 .wtlog/.wtzip）。
 * 输出：JSONL（每行一个事件记录，见 docs/TRAINING-DATA.md）。
 *       不给 --out 时写到 stdout；摘要写 stderr（或 --summary 文件）。
 *
 * 退出码：0 成功；1 存在无效输入/校验失败；2 用法错误。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const WTLOG_CHECK = join(__dirname, 'wtlog-check.mjs');
const TRAINING_SCHEMA_VERSION = 1;

function usage() {
  return [
    'WriterTools 训练数据导出工具',
    '',
    '用法：node tools/wtlog-to-training.mjs <input...> [--out <file.jsonl>] [--summary <file.json>]',
    '       [--no-validate] [--with-raw]',
    '       node tools/wtlog-to-training.mjs --self-test',
    '',
    '输入：.wtlog 文件、.wtzip 备份包、或包含它们的目录（递归）',
    '输出：JSONL（默认 stdout）；摘要 stderr 或 --summary 文件',
    '退出码：0 成功；1 有无效输入；2 用法错误',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 读取输入（.wtlog / .wtzip / 目录）
// ---------------------------------------------------------------------------

/** 递归收集输入路径下的日志来源。 */
function collectSources(inputs) {
  const sources = []; // { label, text }
  let hadError = false;
  const walk = (path) => {
    let info;
    try {
      info = statSync(path);
    } catch (error) {
      console.error(`[错误] 无法访问 ${path}：${error.message}`);
      hadError = true;
      return;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        walk(join(path, entry.name));
      }
      return;
    }
    const ext = extname(path).toLowerCase();
    if (ext === '.wtlog' || ext === '.jsonl') {
      try {
        sources.push({ label: relative(REPO_ROOT, path) || basename(path), text: readFileSync(path, 'utf8') });
      } catch (error) {
        console.error(`[错误] 读取失败 ${path}：${error.message}`);
        hadError = true;
      }
    } else if (ext === '.wtzip') {
      try {
        const zip = unzipSync(new Uint8Array(readFileSync(path)));
        const labelPrefix = relative(REPO_ROOT, path) || basename(path);
        for (const name of Object.keys(zip).sort()) {
          if (!name.toLowerCase().endsWith('.wtlog')) continue;
          sources.push({ label: `${labelPrefix}::${name}`, text: strFromU8(zip[name]) });
        }
      } catch (error) {
        console.error(`[错误] 无法解压备份包 ${path}：${error.message}`);
        hadError = true;
      }
    }
  };
  for (const input of inputs) walk(input);
  return { sources, hadError };
}

// ---------------------------------------------------------------------------
// 校验 + 解析
// ---------------------------------------------------------------------------

function validateLog(text, label) {
  const dir = mkdtempSync(join(tmpdir(), 'wttrain-'));
  const file = join(dir, `${createHash('sha256').update(label).digest('hex').slice(0, 12)}.wtlog`);
  try {
    writeFileSync(file, text, 'utf8');
    const output = execFileSync(process.execPath, [WTLOG_CHECK, '--json', file], { encoding: 'utf8' });
    return JSON.parse(output)[0];
  } catch (error) {
    const stdout = String(error.stdout || '');
    try {
      return JSON.parse(stdout)[0];
    } catch {
      return { ok: false, events: 0, errors: [String(error.message || error)], warnings: [], textChars: 0, docId: null };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COMMON_KEYS = new Set(['v', 'label', 'docId', 'title', 'seq', 'ts', 'type', 'affects']);

/** 把单个事件归一化为训练记录（不丢信息：未知事件带 data，--with-raw 带完整原始事件）。 */
function eventToRecord(event, context, docTitle, withRaw) {
  const data = event.data || {};
  const record = {
    v: TRAINING_SCHEMA_VERSION,
    label: context.label,
    docId: context.docId,
    title: docTitle,
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    affects: event.affects,
  };
  switch (event.type) {
    case 'text.insert':
      record.op = 'insert';
      record.pos = data.pos;
      record.text = data.text;
      record.source = data.source;
      if (data.inputType !== undefined) record.inputType = data.inputType;
      break;
    case 'text.delete':
      record.op = 'delete';
      record.pos = data.pos;
      record.length = data.length;
      record.deleted = data.deleted;
      record.source = data.source;
      if (data.direction !== undefined) record.direction = data.direction;
      if (data.inputType !== undefined) record.inputType = data.inputType;
      break;
    case 'text.replace':
      record.op = 'replace';
      record.pos = data.pos;
      record.length = data.length;
      record.deleted = data.deleted;
      record.text = data.text;
      record.source = data.source;
      if (data.inputType !== undefined) record.inputType = data.inputType;
      break;
    case 'text.reset':
      record.op = 'reset';
      record.text = data.text;
      if (data.reason !== undefined) record.reason = data.reason;
      if (data.targetSeq !== undefined) record.targetSeq = data.targetSeq;
      break;
    case 'compose.start':
    case 'compose.update':
    case 'compose.end':
      record.phase = event.type.slice('compose.'.length);
      if (data.data !== undefined) record.data = data.data;
      if (data.from !== undefined) record.from = data.from;
      if (data.to !== undefined) record.to = data.to;
      if (data.committed !== undefined) record.committed = data.committed;
      if (data.candidate !== undefined) record.candidate = data.candidate;
      break;
    case 'selection.set':
      record.from = data.from;
      record.to = data.to;
      if (data.direction !== undefined) record.direction = data.direction;
      if (data.reason !== undefined) record.reason = data.reason;
      break;
    case 'editor.mode':
      record.mode = data.mode;
      break;
    case 'doc.title':
      record.newTitle = data.title;
      break;
    case 'snapshot':
      record.reason = data.reason;
      if (data.message !== undefined) record.message = data.message;
      record.chars = data.chars;
      record.textHash = data.textHash;
      if (data.eventsSince !== undefined) record.eventsSince = data.eventsSince;
      break;
    case 'session.start':
      record.sessionId = data.sessionId;
      record.startedAt = data.startedAt;
      if (data.device !== undefined) record.device = data.device;
      if (data.editorMode !== undefined) record.editorMode = data.editorMode;
      break;
    case 'session.end':
      record.sessionId = data.sessionId;
      record.endedAt = data.endedAt;
      break;
    case 'doc.init':
      record.docId = data.docId;
      record.title = data.title;
      record.createdAt = data.createdAt;
      if (data.app !== undefined) record.app = data.app;
      if (data.settings !== undefined) record.settings = data.settings;
      break;
    case 'doc.trash':
    case 'doc.untrash':
      if (data.reason !== undefined) record.reason = data.reason;
      break;
    case 'app.checkpoint':
      record.anchor = data.anchor;
      record.target = data.target;
      break;
    default:
      // 未知事件（未来版本/x.*）：保留 data，保证信息不丢
      record.data = data;
      break;
  }
  if (withRaw) record.raw = event;
  return record;
}

/** 解析一个日志来源为记录数组 + 元信息。 */
function parseSource(source, withRaw) {
  const lines = source.text.split('\n').filter((line) => line.trim() !== '');
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      events.push(JSON.parse(lines[index]));
    } catch (error) {
      throw new Error(`${source.label} 第 ${index + 1} 行 JSON 解析失败：${error.message}`);
    }
  }
  if (events.length === 0) throw new Error(`${source.label} 为空`);
  const header = events[0];
  const context = { label: source.label, docId: header?.data?.docId ?? null };
  let title = typeof header?.data?.title === 'string' ? header.data.title : '';
  const records = [];
  for (const event of events) {
    if (event.type === 'doc.title' && typeof event.data?.title === 'string') title = event.data.title;
    records.push(eventToRecord(event, context, title, withRaw));
  }
  return { label: source.label, docId: context.docId, records, events };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function summarize(docs, records) {
  const byType = {};
  let compos = 0;
  let deletes = 0;
  let inserts = 0;
  let resets = 0;
  let snapshots = 0;
  let selections = 0;
  let textChars = 0;
  for (const record of records) {
    byType[record.type] = (byType[record.type] || 0) + 1;
    if (record.type.startsWith('compose.')) compos += 1;
    if (record.op === 'delete') deletes += 1;
    if (record.op === 'insert') inserts += 1;
    if (record.op === 'reset') resets += 1;
    if (record.type === 'snapshot') {
      snapshots += 1;
      if (typeof record.chars === 'number') textChars = record.chars;
    }
    if (record.type === 'selection.set') selections += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: TRAINING_SCHEMA_VERSION,
    docs: docs.map((doc) => ({ label: doc.label, docId: doc.docId, events: doc.records.length })),
    countedDocs: docs.length,
    events: records.length,
    byType,
    stats: { inserts, deletes, resets, compositions: compos, snapshots, selections, finalCharsApprox: textChars },
  };
}

function run(inputs, options) {
  const { sources, hadError } = collectSources(inputs);
  if (sources.length === 0) {
    console.error('没有找到可转换的 .wtlog / .wtzip 输入。');
    return 2;
  }
  let invalid = false;
  const docs = [];
  for (const source of sources) {
    if (options.validate) {
      const report = validateLog(source.text, source.label);
      if (!report.ok) {
        invalid = true;
        console.error(`[无效] ${source.label} 未通过独立格式校验：${(report.errors || []).slice(0, 3).join('；')}`);
        continue;
      }
    }
    try {
      docs.push(parseSource(source, options.withRaw));
    } catch (error) {
      invalid = true;
      console.error(`[错误] ${source.label}：${error.message}`);
    }
  }
  if (docs.length === 0) {
    console.error('所有输入都无效，未生成训练数据。');
    return 1;
  }
  const records = docs.flatMap((doc) => doc.records);
  const lines = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(options.out, lines, 'utf8');
    console.error(`已写入 ${options.out}：${docs.length} 个作品 / ${records.length} 条事件`);
  } else {
    process.stdout.write(lines);
  }
  const summary = summarize(docs, records);
  if (options.summary) {
    mkdirSync(dirname(resolve(options.summary)), { recursive: true });
    writeFileSync(options.summary, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.error(`摘要已写入 ${options.summary}`);
  } else {
    console.error(
      `摘要：${summary.countedDocs} 个作品 / ${summary.events} 条事件（insert ${summary.stats.inserts}，delete ${summary.stats.deletes}，` +
        `compose ${summary.stats.compositions}，snapshot ${summary.stats.snapshots}，selection ${summary.stats.selections}）`,
    );
  }
  if (invalid || hadError) return 1;
  return 0;
}

function selfTest() {
  const fixture = join(REPO_ROOT, 'tests', 'fixtures', 'v1.0-golden.wtlog');
  const failures = [];
  const expect = (name, condition, detail = '') => {
    if (!condition) failures.push(`${name}${detail ? '（' + detail + '）' : ''}`);
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };
  let docs;
  try {
    const text = readFileSync(fixture, 'utf8');
    docs = [parseSource({ label: 'fixture', text }, false)];
  } catch (error) {
    console.error('金标准 fixture 读取/解析失败：', error.message);
    return 1;
  }
  const records = docs[0].records;
  expect('事件条数 = 18', records.length === 18, String(records.length));
  expect('docId 解析正确', records[0].docId === '0f4c9a2e-6b1d-4c8a-9f0e-2a7b3c5d8e11', String(records[0].docId));
  const deleteRecord = records.find((record) => record.op === 'delete');
  expect('删除事件保留被删文本', Boolean(deleteRecord && typeof deleteRecord.deleted === 'string' && deleteRecord.deleted.length > 0), JSON.stringify(deleteRecord?.deleted));
  const composeRecord = records.find((record) => record.type === 'compose.update');
  expect('输入法 update 事件保留原始 data', composeRecord?.data === 'nihao', String(composeRecord?.data));
  const titleRecord = records.find((record) => record.type === 'doc.title');
  expect('标题事件归一化', titleRecord?.newTitle === '金标准作品', String(titleRecord?.newTitle));
  const unknown = records.find((record) => record.type === 'x.test.meta');
  expect('未知事件保留 data', unknown?.data?.foo === 'bar');
  const reset = records.find((record) => record.op === 'reset');
  expect('text.reset 保留完整正文', reset?.text === '全新正文', String(reset?.text));
  const snapshot = records.find((record) => record.type === 'snapshot');
  expect('snapshot 不重复输出全文但保留 chars', Boolean(snapshot) && typeof snapshot.chars === 'number' && snapshot.text === undefined, String(snapshot?.chars));
  expect('记录带 schema 版本', records.every((record) => record.v === 1));
  console.log(failures.length === 0 ? '\n===== 训练导出 self-test 全部通过 =====' : `\n===== self-test 失败 ${failures.length} 项 =====`);
  return failures.length === 0 ? 0 : 1;
}

function main(argv) {
  const inputs = [];
  const options = { validate: true, withRaw: false, out: null, summary: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') return selfTest();
    if (arg === '--no-validate') options.validate = false;
    else if (arg === '--with-raw') options.withRaw = true;
    else if (arg === '--out') options.out = argv[(index += 1)];
    else if (arg === '--summary') options.summary = argv[(index += 1)];
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return 0;
    } else if (arg.startsWith('--')) {
      console.error(`未知选项：${arg}\n\n${usage()}`);
      return 2;
    } else inputs.push(arg);
  }
  if (inputs.length === 0) {
    console.error(usage());
    return 2;
  }
  if (options.out === undefined || (options.out !== null && options.out.trim() === '')) {
    console.error('--out 需要文件路径');
    return 2;
  }
  return run(inputs, options);
}

process.exitCode = main(process.argv.slice(2));
