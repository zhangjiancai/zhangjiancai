#!/usr/bin/env node
/**
 * WriterTools 日志格式独立校验器（v1.0）
 * =====================================
 * 完全独立实现 docs/FILE-FORMAT.md 的校验规则，不 import 引擎代码，
 * 用于交叉验证引擎导出的 .wtlog 文件是否合规。
 *
 * 用法：
 *   node tools/wtlog-check.mjs <file.wtlog> [file2.wtlog ...] [选项]
 *   node tools/wtlog-check.mjs --text <file.wtlog>      # 只输出派生正文
 *   node tools/wtlog-check.mjs --json <file.wtlog>      # 输出 JSON 报告
 *   node tools/wtlog-check.mjs --quiet <file.wtlog>     # 只输出一行结论
 *
 * 退出码：0 = 全部合规；1 = 存在不合规；2 = 用法错误 / 文件读取失败。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FORMAT_MAJOR = 1;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const TEXT_EVENTS = new Set(['text.insert', 'text.delete', 'text.replace', 'text.reset']);
const META_EVENTS = new Set([
  'doc.init',
  'session.start',
  'session.end',
  'selection.set',
  'editor.mode',
  'compose.start',
  'compose.update',
  'compose.end',
  'snapshot',
  'doc.title',
  'doc.settings',
  'doc.trash',
  'doc.untrash',
  'app.checkpoint',
]);

// ---------------------------------------------------------------------------
// 规范化 JSON / 哈希（规范第 4 节）
// ---------------------------------------------------------------------------

/** 递归按键名 UTF-16 码元顺序排序；拒绝浮点/undefined。 */
function canonicalize(value, path = '$') {
  const t = typeof value;
  if (value === null) return 'null';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`不允许非整数/不安全整数：${path} = ${value}（规范 4.1）`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys
        .map((k) => {
          if (value[k] === undefined) throw new Error(`不允许 undefined：${path}.${k}（规范 4.1）`);
          return JSON.stringify(k) + ':' + canonicalize(value[k], `${path}.${k}`);
        })
        .join(',') +
      '}'
    );
  }
  throw new Error(`不支持的值类型 ${t}：${path}（规范 4.1）`);
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 事件哈希 = SHA-256(UTF8(canonicalJSON(事件去掉 hash 字段))) */
function computeEventHash(event) {
  const { hash: _ignored, ...rest } = event;
  return 'sha256:' + sha256Hex(canonicalize(rest));
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v) {
  return Number.isSafeInteger(v);
}

// ---------------------------------------------------------------------------
// 单文件校验
// ---------------------------------------------------------------------------

function checkFile(filePath) {
  const report = {
    file: filePath,
    ok: false,
    events: 0,
    snapshots: 0,
    sessions: 0,
    edits: 0,
    textChars: 0,
    format: null,
    docId: null,
    title: null,
    lastSeq: null,
    lastHash: null,
    errors: [],
    warnings: [],
    text: '',
  };

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    report.errors.push(`无法读取文件：${err.message}`);
    return report;
  }

  if (raw.charCodeAt(0) === 0xfeff) {
    report.errors.push('文件带 UTF-8 BOM，不符合格式（规范 1.1）');
    raw = raw.replace(/^\uFEFF/, '');
  }

  let lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1); // 正常结尾换行
  } else if (raw.length > 0) {
    report.warnings.push('最后一行缺少结尾换行（规范 2，可容忍）');
  }

  let text = '';
  let lastHash = '';
  let expectedSeq = 0;
  let sawHeader = false;
  const snapshotSeqs = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const fail = (msg) => {
      report.errors.push(`第 ${lineNo} 行：${msg}`);
    };

    if (lines[i].trim() === '') {
      report.warnings.push(`第 ${lineNo} 行为空行（规范 2 不允许，已跳过）`);
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch (err) {
      fail(`JSON 解析失败：${err.message}`);
      break;
    }
    try {
      // ---- 信封 ----
      if (!isPlainObject(ev)) {
        fail('事件必须是 JSON 对象');
        break;
      }
      if (!isInt(ev.seq) || ev.seq < 0) fail('seq 必须是非负整数');
      if (ev.seq !== expectedSeq) fail(`seq 应为 ${expectedSeq}，实际为 ${ev.seq}（必须连续无空洞）`);
      if (typeof ev.id !== 'string' || !ID_RE.test(ev.id)) fail('id 缺失或格式非法（规范 3）');
      if (typeof ev.ts !== 'string' || !TS_RE.test(ev.ts)) fail('ts 缺失或不是 RFC3339 UTC 毫秒格式');
      if (typeof ev.type !== 'string' || !TYPE_RE.test(ev.type)) fail('type 缺失或格式非法');
      if (ev.affects !== 'text' && ev.affects !== 'meta') fail('affects 必须显式为 "text" 或 "meta"');
      if (typeof ev.prev !== 'string') fail('prev 缺失');
      if (typeof ev.hash !== 'string' || !HASH_RE.test(ev.hash)) fail('hash 缺失或格式非法');
      if (ev.prev !== lastHash) fail(`prev 与上一行 hash 不匹配（预期 ${lastHash || '""'}）`);
      if (!isPlainObject(ev.data)) fail('data 必须是对象');
      if (ev.hash !== computeEventHash(ev)) fail('哈希校验失败（内容被修改过？）');

      // ---- header ----
      if (expectedSeq === 0) {
        if (ev.type !== 'doc.init') fail('第 1 行必须是 doc.init（header）');
        if (ev.magic !== 'writertools-log') fail('header 缺少 magic="writertools-log"');
        if (typeof ev.format !== 'string' || !/^\d+\.\d+$/.test(ev.format)) fail('header format 非法');
        else {
          report.format = ev.format;
          const major = Number(ev.format.split('.')[0]);
          if (major > FORMAT_MAJOR) {
            report.errors.push(`文件主版本 ${major} 高于本校验器支持的 ${FORMAT_MAJOR}（规范 8.3）`);
          }
        }
        if (ev.affects !== 'meta') fail('header 的 affects 必须为 "meta"');
        if (ev.prev !== '') fail('header 的 prev 必须为空字符串');
        if (!isPlainObject(ev.data)) fail('header data 必须是对象');
        else {
          const d = ev.data;
          if (typeof d.docId !== 'string' || d.docId.length === 0) fail('header data.docId 缺失');
          else report.docId = d.docId;
          if (typeof d.title !== 'string') fail('header data.title 必须是字符串');
          else report.title = d.title;
          if (typeof d.createdAt !== 'string' || !TS_RE.test(d.createdAt)) fail('header data.createdAt 非法');
          if (!isPlainObject(d.app) || typeof d.app.name !== 'string' || typeof d.app.version !== 'string') {
            fail('header data.app 必须是 {name,version}');
          }
        }
        sawHeader = true;
      } else {
        if (ev.type === 'doc.init') fail('doc.init 只能出现在第 1 行');
        if (!(ev.affects === 'text' ? TEXT_EVENTS.has(ev.type) || ev.type.startsWith('x.') : true)) {
          // affects=text 的未知类型：规范 8.3 要求旧读者只读；校验器视作无法安全重放
          fail(`未知的 affects="text" 事件类型 "${ev.type}"，无法安全重放（规范 8.3）`);
        }
        if (TEXT_EVENTS.has(ev.type) && ev.affects !== 'text') fail(`${ev.type} 的 affects 必须为 "text"`);
        if (!TEXT_EVENTS.has(ev.type) && !ev.type.startsWith('x.') && !META_EVENTS.has(ev.type)) {
          report.warnings.push(`第 ${lineNo} 行：未知 meta 事件类型 "${ev.type}"（按规范忽略）`);
        }
      }

      // ---- 文本事件重放 ----
      if (ev.affects === 'text') {
        const d = ev.data;
        if (ev.type === 'text.insert') {
          if (!isInt(d.pos) || d.pos < 0 || d.pos > text.length) fail(`insert.pos 越界（${d.pos}）`);
          if (typeof d.text !== 'string') fail('insert.text 必须是字符串');
          else if (d.text.length === 0) fail('insert.text 不得为空（规范 6.2）');
          else if (isInt(d.pos) && d.pos >= 0 && d.pos <= text.length) {
            text = text.slice(0, d.pos) + d.text + text.slice(d.pos);
            report.edits++;
          }
          if (typeof d.source !== 'string') fail('insert.source 缺失');
        } else if (ev.type === 'text.delete') {
          if (!isInt(d.pos) || d.pos < 0) fail('delete.pos 非法');
          if (!isInt(d.length) || d.length <= 0) fail('delete.length 必须为正整数');
          if (typeof d.deleted !== 'string') fail('delete.deleted 必须是字符串（被删原文必须保存）');
          if (isInt(d.pos) && isInt(d.length) && d.pos >= 0 && d.pos + d.length <= text.length) {
            const actual = text.slice(d.pos, d.pos + d.length);
            if (actual !== d.deleted) fail(`delete.deleted 与正文不符（期望 ${JSON.stringify(actual)}）`);
            text = text.slice(0, d.pos) + text.slice(d.pos + d.length);
            report.edits++;
          } else {
            fail('delete 区间越界');
          }
          if (typeof d.source !== 'string') fail('delete.source 缺失');
        } else if (ev.type === 'text.replace') {
          if (!isInt(d.pos) || d.pos < 0) fail('replace.pos 非法');
          if (!isInt(d.length) || d.length < 0) fail('replace.length 必须为非负整数');
          if (typeof d.deleted !== 'string') fail('replace.deleted 必须是字符串');
          if (typeof d.text !== 'string') fail('replace.text 必须是字符串');
          if (isInt(d.pos) && isInt(d.length) && d.pos >= 0 && d.pos + d.length <= text.length) {
            const actual = text.slice(d.pos, d.pos + d.length);
            if (actual !== d.deleted) fail(`replace.deleted 与正文不符（期望 ${JSON.stringify(actual)}）`);
            text = text.slice(0, d.pos) + d.text + text.slice(d.pos + d.length);
            report.edits++;
          } else {
            fail('replace 区间越界');
          }
          if (typeof d.source !== 'string') fail('replace.source 缺失');
        } else if (ev.type === 'text.reset') {
          if (typeof d.text !== 'string') fail('reset.text 必须是字符串');
          else {
            text = d.text;
            report.edits++;
          }
          if (typeof d.reason !== 'string') fail('reset.reason 缺失');
        } else if (ev.type.startsWith('x.')) {
          // 未知文本事件：已在上方报错，这里不重放
        }
      }

      // ---- 快照 ----
      if (ev.type === 'snapshot') {
        report.snapshots++;
        const d = ev.data;
        snapshotSeqs.add(ev.seq);
        if (!isPlainObject(d)) fail('snapshot.data 必须是对象');
        else {
          if (typeof d.reason !== 'string') fail('snapshot.reason 缺失');
          if (typeof d.text !== 'string') fail('snapshot.text 必须是字符串');
          else {
            if (d.text !== text) fail('snapshot.text 与重放正文不一致（快照不变量被破坏）');
            if (typeof d.textHash !== 'string') fail('snapshot.textHash 缺失');
            else {
              const h = 'sha256:' + sha256Hex(d.text);
              if (d.textHash !== h) fail('snapshot.textHash 校验失败');
            }
            if (!isInt(d.chars) || d.chars !== d.text.length) fail('snapshot.chars 与 text.length 不符');
          }
          if (d.message !== undefined && typeof d.message !== 'string') fail('snapshot.message 必须是字符串');
        }
      }

      if (ev.type === 'session.start' || ev.type === 'session.end') report.sessions++;

      lastHash = ev.hash;
      expectedSeq += 1;
      report.events += 1;
      report.lastSeq = ev.seq;
      report.lastHash = ev.hash;
    } catch (err) {
      fail(`校验异常：${err.message}`);
      break;
    }
  }

  if (!sawHeader) report.errors.push('文件为空或缺少 header 行（规范 2）');
  if (report.snapshots === 0) report.warnings.push('文件没有任何 snapshot 事件（建议定期写快照，规范 6.7）');

  report.text = text;
  report.textChars = text.length;
  report.ok = report.errors.length === 0;
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const files = [];
  let mode = 'report';
  for (const arg of argv) {
    if (arg === '--json') mode = 'json';
    else if (arg === '--quiet') mode = 'quiet';
    else if (arg === '--text') mode = 'text';
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return 0;
    } else if (arg.startsWith('--')) {
      console.error(`未知选项：${arg}\n\n${usage()}`);
      return 2;
    } else files.push(arg);
  }
  if (files.length === 0) {
    console.error(usage());
    return 2;
  }

  let allOk = true;
  const reports = [];
  for (const f of files) {
    const r = checkFile(f);
    reports.push(r);
    if (!r.ok) allOk = false;

    if (mode === 'text') {
      if (r.ok) process.stdout.write(r.text);
      continue;
    }
    if (mode === 'json') continue;
    if (mode === 'quiet') {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.file}（${r.events} 事件 / ${r.textChars} 字符 / ${r.snapshots} 快照）`);
      for (const e of r.errors) console.log(`  ✗ ${e}`);
      for (const w of r.warnings) console.log(`  ! ${w}`);
      continue;
    }

    console.log(`\n=== ${r.file} ===`);
    console.log(`结果：${r.ok ? '✅ 合规' : '❌ 不合规'}`);
    console.log(`格式：${r.format ?? '(未知)'}  docId：${r.docId ?? '(未知)'}  标题：${r.title ?? '(未知)'}`);
    console.log(
      `事件：${r.events}（编辑 ${r.edits} / 快照 ${r.snapshots} / 会话 ${r.sessions}）  正文：${r.textChars} 字符  ` +
        `lastSeq：${r.lastSeq ?? '-'}  lastHash：${r.lastHash ? r.lastHash.slice(0, 20) + '…' : '-'}`,
    );
    for (const e of r.errors) console.log(`  ✗ ${e}`);
    for (const w of r.warnings) console.log(`  ! ${w}`);
  }

  if (mode === 'json') {
    process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
  }
  return allOk ? 0 : 1;
}

function usage() {
  return [
    'WriterTools 日志格式独立校验器（格式 v1.0）',
    '',
    '用法：node tools/wtlog-check.mjs <file.wtlog> [more...] [选项]',
    '选项：',
    '  --text    只输出派生正文（便于人工/脚本核对）',
    '  --json    输出 JSON 报告',
    '  --quiet   每个文件一行结论',
    '  -h, --help',
    '',
    '退出码：0 全部合规；1 存在不合规；2 用法/读取错误。',
  ].join('\n');
}

process.exitCode = main(process.argv.slice(2));
