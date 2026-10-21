#!/usr/bin/env node
/**
 * WriterTools 全量备份包（.wtzip）独立校验器
 * ==========================================
 * 完全独立实现 docs/FILE-FORMAT.md §9 / §9.1 的校验规则，不 import 引擎代码：
 *   - 用 fflate 解压 ZIP（容器格式检查）
 *   - 校验 writertools-manifest.json（magic/format/字段/锚点）
 *   - 把每个 .wtlog 条目交给独立日志校验器 tools/wtlog-check.mjs --json 校验
 *   - 校验 fileHash（整文件 SHA-256）与 manifest 的 lastSeq/lastHash 锚点
 *
 * 用法：
 *   node tools/wtzip-check.mjs <file.wtzip> [more...] [--json|--quiet]
 * 退出码：0 全部合规；1 存在不合规；2 用法/读取错误。
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WTLOG_CHECK = join(__dirname, 'wtlog-check.mjs');
const MANIFEST_NAME = 'writertools-manifest.json';
const MANIFEST_MAGIC = 'writertools-backup-manifest';
const FORMAT_RE = /^\d+\.\d+$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function sha256BufHex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.includes('\\') || name.startsWith('/') || name.includes('\u0000')) return false;
  const parts = name.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function checkArchive(filePath) {
  const report = {
    file: filePath,
    ok: false,
    bytes: 0,
    format: null,
    createdAt: null,
    docCount: 0,
    checkedDocs: [],
    errors: [],
    warnings: [],
  };
  const fail = (message) => report.errors.push(message);

  let raw;
  try {
    raw = readFileSync(filePath);
  } catch (error) {
    fail(`无法读取文件：${error.message}`);
    return report;
  }
  report.bytes = raw.length;
  if (raw.length === 0) {
    fail('文件为空');
    return report;
  }
  let entries;
  try {
    entries = unzipSync(new Uint8Array(raw));
  } catch (error) {
    fail(`ZIP 容器无法解压：${error.message}`);
    return report;
  }
  const names = Object.keys(entries).filter((name) => !name.endsWith('/'));
  if (names.length === 0) {
    fail('ZIP 内没有任何文件');
    return report;
  }

  // ---- manifest ----
  const manifestKey = names.find((name) => name === MANIFEST_NAME);
  if (!manifestKey) {
    fail(`缺少必备条目 ${MANIFEST_NAME}（规范 §9.1）`);
    return report;
  }
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(entries[manifestKey]));
  } catch (error) {
    fail(`manifest JSON 解析失败：${error.message}`);
    return report;
  }
  if (!isPlainObject(manifest)) {
    fail('manifest 必须是 JSON 对象');
    return report;
  }
  if (manifest.magic !== MANIFEST_MAGIC) fail(`manifest.magic 必须是 "${MANIFEST_MAGIC}"`);
  if (typeof manifest.format !== 'string' || !FORMAT_RE.test(manifest.format)) fail('manifest.format 必须是 "主.次" 版本字符串');
  else report.format = manifest.format;
  if (typeof manifest.createdAt !== 'string' || !TS_RE.test(manifest.createdAt)) fail('manifest.createdAt 非法');
  else report.createdAt = manifest.createdAt;
  if (typeof manifest.updatedAt !== 'string' || !TS_RE.test(manifest.updatedAt)) fail('manifest.updatedAt 非法');
  if (!isPlainObject(manifest.app) || typeof manifest.app.name !== 'string' || typeof manifest.app.version !== 'string') {
    fail('manifest.app 必须是 {name,version}');
  }
  if (!Array.isArray(manifest.docs)) {
    fail('manifest.docs 必须是数组');
    return report;
  }
  report.docCount = manifest.docs.length;

  const declaredFiles = new Set();
  const tempDir = mkdtempSync(join(tmpdir(), 'wtzip-check-'));
  try {
    for (let index = 0; index < manifest.docs.length; index += 1) {
      const doc = manifest.docs[index];
      const label = `docs[${index}]`;
      const docResult = { docId: null, file: null, title: null, ok: false, events: null, chars: null, messages: [] };
      report.checkedDocs.push(docResult);
      const docFail = (message) => {
        docResult.messages.push(message);
        fail(`${label}：${message}`);
      };

      if (!isPlainObject(doc)) {
        docFail('必须是 JSON 对象');
        continue;
      }
      if (typeof doc.docId !== 'string' || doc.docId.length === 0) docFail('缺少 docId');
      else docResult.docId = doc.docId;
      if (typeof doc.title !== 'string') docFail('缺少 title 字符串');
      else docResult.title = doc.title;
      if (typeof doc.file !== 'string' || !safeEntryName(doc.file)) {
        docFail('file 缺失或不是安全的相对路径（不得含 .. / 绝对路径 / 反斜杠）');
        continue;
      }
      docResult.file = doc.file;
      if (declaredFiles.has(doc.file)) docFail(`file "${doc.file}" 在 manifest 中重复声明`);
      declaredFiles.add(doc.file);
      if (typeof doc.lastSeq !== 'number' || !Number.isSafeInteger(doc.lastSeq) || doc.lastSeq < 0) {
        docFail('lastSeq 必须是非负整数');
      }
      if (typeof doc.lastHash !== 'string' || !HASH_RE.test(doc.lastHash)) docFail('lastHash 必须是 sha256:<hex>');
      if (typeof doc.chars !== 'number' || !Number.isSafeInteger(doc.chars) || doc.chars < 0) {
        docFail('chars 必须是非负整数');
      }
      if (typeof doc.backupAt !== 'string' || !TS_RE.test(doc.backupAt)) docFail('backupAt 非法');
      if (doc.fileHash !== undefined && (typeof doc.fileHash !== 'string' || !HASH_RE.test(doc.fileHash))) {
        docFail('fileHash 若存在必须是 sha256:<hex>');
      }

      const entry = entries[doc.file];
      if (!entry) {
        docFail(`ZIP 内缺少日志条目 "${doc.file}"`);
        continue;
      }
      // 文件整体哈希（规范 §9/§9.1）
      if (doc.fileHash) {
        const actual = `sha256:${sha256BufHex(Buffer.from(entry))}`;
        if (actual !== doc.fileHash) docFail(`fileHash 不匹配（期望 ${doc.fileHash}，实际 ${actual}）`);
      } else {
        fail(`${label}：manifest 缺少 fileHash（§9.1 要求必备）`);
      }

      // 交给独立日志校验器
      const tempFile = join(tempDir, `${index}-${basename(doc.file)}`);
      writeFileSync(tempFile, Buffer.from(entry));
      let logReport;
      try {
        const output = execFileSync(process.execPath, [WTLOG_CHECK, '--json', tempFile], { encoding: 'utf8' });
        logReport = JSON.parse(output)[0];
      } catch (error) {
        const stdout = String(error.stdout || '');
        try {
          logReport = JSON.parse(stdout)[0];
        } catch {
          docFail(`日志校验器执行失败：${error.message}`);
          continue;
        }
      }
      docResult.events = logReport.events;
      docResult.chars = logReport.textChars;
      if (!logReport.ok) {
        docFail(`日志不合规：${(logReport.errors || []).slice(0, 3).join('；')}`);
      }
      if (logReport.docId !== doc.docId) docFail(`日志 docId（${logReport.docId}）与 manifest（${doc.docId}）不一致`);
      if (logReport.lastSeq !== doc.lastSeq) docFail(`lastSeq 锚点不一致（manifest ${doc.lastSeq}，日志 ${logReport.lastSeq}）`);
      if (logReport.lastHash !== doc.lastHash) docFail('lastHash 锚点不一致（备份可能被截断/改写）');
      if (logReport.textChars !== doc.chars) {
        docResult.messages.push(`chars 与日志正文长度不一致（manifest ${doc.chars}，日志 ${logReport.textChars}）`);
        fail(`${label}：chars 与日志正文长度不一致`);
      }
      docResult.ok = docResult.messages.length === 0;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  // 未在 manifest 声明的日志条目：忽略但提示（规范 §9.1）
  const undeclaredLogs = names.filter((name) => name.endsWith('.wtlog') && !declaredFiles.has(name));
  for (const name of undeclaredLogs) report.warnings.push(`存在未在 manifest 声明的日志条目（已忽略）：${name}`);

  report.ok = report.errors.length === 0;
  return report;
}

function main(argv) {
  const files = [];
  let mode = 'report';
  for (const arg of argv) {
    if (arg === '--json') mode = 'json';
    else if (arg === '--quiet') mode = 'quiet';
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
  for (const file of files) {
    const report = checkArchive(file);
    reports.push(report);
    if (!report.ok) allOk = false;
    if (mode === 'json') continue;
    if (mode === 'quiet') {
      console.log(`${report.ok ? 'OK  ' : 'FAIL'} ${report.file}（${report.docCount} 个作品 / ${report.bytes} 字节）`);
      for (const error of report.errors) console.log(`  ✗ ${error}`);
      for (const warning of report.warnings) console.log(`  ! ${warning}`);
      continue;
    }
    console.log(`\n=== ${report.file} ===`);
    console.log(`结果：${report.ok ? '✅ 合规备份包' : '❌ 不合规'}`);
    console.log(`字节：${report.bytes}  manifest 版本：${report.format ?? '(未知)'}  作品数：${report.docCount}`);
    for (const doc of report.checkedDocs) {
      const status = doc.ok ? '✓' : '✗';
      console.log(`  ${status} ${doc.file ?? '(未知文件)'}  docId=${doc.docId ?? '-'}  事件=${doc.events ?? '-'}  字符=${doc.chars ?? '-'}`);
      for (const message of doc.messages) console.log(`      - ${message}`);
    }
    for (const error of report.errors) console.log(`  ✗ ${error}`);
    for (const warning of report.warnings) console.log(`  ! ${warning}`);
  }
  if (mode === 'json') process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
  return allOk ? 0 : 1;
}

function usage() {
  return [
    'WriterTools 全量备份包（.wtzip）独立校验器（规范 §9.1）',
    '',
    '用法：node tools/wtzip-check.mjs <file.wtzip> [more...] [选项]',
    '选项：',
    '  --json    输出 JSON 报告',
    '  --quiet   每个文件一行结论',
    '  -h, --help',
    '',
    '退出码：0 全部合规；1 存在不合规；2 用法/读取错误。',
  ].join('\n');
}

process.exitCode = main(process.argv.slice(2));
