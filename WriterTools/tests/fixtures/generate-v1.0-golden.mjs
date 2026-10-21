#!/usr/bin/env node
/**
 * 生成并固定 v1.0 格式金标准 fixture：tests/fixtures/v1.0-golden.wtlog
 *
 * 目的：作为「只增不删」的回归护栏——未来格式演进时，这个文件必须永远可读。
 * 该脚本独立于应用实现（自带规范化 JSON + node:crypto SHA-256），
 * 输出内容覆盖：doc.init / session.start|end / text.insert|delete|replace|reset /
 * snapshot / compose.* / selection.set / editor.mode / doc.title，
 * 并故意包含未知 meta 事件与未知字段（验证前向兼容忽略行为）。
 *
 * 用法：node tests/fixtures/generate-v1.0-golden.mjs
 * （固定提交后一般不需要重跑；重跑会覆盖同一路径，改动必须显式提交并被审查。）
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`fixture 只允许整数：${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function hashText(text) {
  return `sha256:${sha256Hex(text)}`;
}

const DOC_ID = '0f4c9a2e-6b1d-4c8a-9f0e-2a7b3c5d8e11';
const SESSION_ID = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

// 正文坐标（UTF-16 码元）演练：
// 0: insert "你好世界" -> "你好世界"
// 1: insert "，" (pos 2) -> "你好，世界"
// 2: delete pos 1 length 2 deleted "好，" -> "你世界"
// 3: replace pos 1 length 2 deleted "世界" text "🌍" -> "你🌍"
// 4: snapshot text "你🌍" (chars 3)
// 5: insert "!" (pos 3) -> "你🌍!"
// 6: text.reset "全新正文" -> "全新正文"
// 7: snapshot text "全新正文" (chars 4)
const TEXT_AFTER_FIRST_SNAPSHOT = '\u4f60\u{1F30D}'; // 你🌍
const FINAL_TEXT = '\u5168\u65b0\u6b63\u6587'; // 全新正文

function ts(seq) {
  const seconds = 32 + Math.floor(seq / 10);
  const millis = (seq % 10) * 100;
  return `2026-10-20T15:${String(seconds).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.${String(millis).padStart(3, '0')}Z`;
}

function eventId(index) {
  return `e0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

const events = [
  {
    type: 'doc.init',
    affects: 'meta',
    ts: ts(0),
    data: {
      docId: DOC_ID,
      title: '\u91d1\u6807\u51c6', // 金标准
      createdAt: ts(0),
      app: { name: 'WriterTools', version: '0.1.0' },
      device: { platform: 'Win32', tz: 'Asia/Shanghai' },
      settings: { editorMode: 'typewriter' },
    },
    extras: { magic: 'writertools-log', format: '1.0' },
  },
  {
    type: 'session.start',
    affects: 'meta',
    ts: ts(1),
    data: {
      sessionId: SESSION_ID,
      startedAt: ts(1),
      device: { platform: 'Win32', userAgent: 'Mozilla/5.0 (fixture)', tz: 'Asia/Shanghai' },
    },
  },
  {
    type: 'text.insert',
    affects: 'text',
    ts: ts(2),
    data: { pos: 0, text: '\u4f60\u597d\u4e16\u754c', source: 'typing', inputType: 'insertText' },
    extras: { x_note: 'unknown-envelope-field-must-be-preserved' },
  },
  {
    type: 'compose.start',
    affects: 'meta',
    ts: ts(3),
    data: { data: 'ni', from: 2, to: 2 },
  },
  {
    type: 'compose.update',
    affects: 'meta',
    ts: ts(4),
    data: { data: 'nihao', from: 2, to: 2, candidate: 1 },
  },
  {
    type: 'compose.end',
    affects: 'meta',
    ts: ts(5),
    data: { data: '', committed: '\uff0c' }, // ，
  },
  {
    type: 'text.insert',
    affects: 'text',
    ts: ts(6),
    data: { pos: 2, text: '\uff0c', source: 'ime', inputType: 'insertCompositionText' },
  },
  {
    type: 'selection.set',
    affects: 'meta',
    ts: ts(7),
    data: { from: 3, to: 3, reason: 'caret', x_extra: 'preserved' },
    extras: { x_future: { version: 2 } },
  },
  {
    type: 'editor.mode',
    affects: 'meta',
    ts: ts(8),
    data: { mode: 'typewriter' },
  },
  {
    type: 'doc.title',
    affects: 'meta',
    ts: ts(9),
    data: { title: '\u91d1\u6807\u51c6\u4f5c\u54c1' }, // 金标准作品
  },
  {
    type: 'text.delete',
    affects: 'text',
    ts: ts(10),
    data: {
      pos: 1,
      length: 2,
      deleted: '\u597d\uff0c', // 好，
      source: 'typing',
      inputType: 'deleteContentBackward',
      direction: 'backward',
    },
  },
  {
    type: 'text.replace',
    affects: 'text',
    ts: ts(11),
    data: { pos: 1, length: 2, deleted: '\u4e16\u754c', text: '\u{1F30D}', source: 'paste' }, // 世界 -> 🌍
  },
  {
    type: 'snapshot',
    affects: 'meta',
    ts: ts(12),
    data: {
      reason: 'manual',
      message: '\u91d1\u6807\u51c6\u5feb\u7167', // 金标准快照
      text: TEXT_AFTER_FIRST_SNAPSHOT,
      textHash: hashText(TEXT_AFTER_FIRST_SNAPSHOT),
      chars: TEXT_AFTER_FIRST_SNAPSHOT.length,
      eventsSince: 12,
    },
  },
  {
    type: 'x.test.meta',
    affects: 'meta',
    ts: ts(13),
    data: { foo: 'bar', nested: { a: 1 } },
    extras: { x_future: { version: 2 } },
  },
  {
    type: 'text.insert',
    affects: 'text',
    ts: ts(14),
    data: { pos: 3, text: '!', source: 'typing' },
  },
  {
    type: 'text.reset',
    affects: 'text',
    ts: ts(15),
    data: { text: FINAL_TEXT, reason: 'recovery', source: 'recovery' },
  },
  {
    type: 'snapshot',
    affects: 'meta',
    ts: ts(16),
    data: {
      reason: 'auto',
      text: FINAL_TEXT,
      textHash: hashText(FINAL_TEXT),
      chars: FINAL_TEXT.length,
      eventsSince: 4,
    },
  },
  {
    type: 'session.end',
    affects: 'meta',
    ts: ts(17),
    data: { sessionId: SESSION_ID, endedAt: ts(17) },
  },
];

let prevHash = '';
const lines = [];
let derivedText = '';
for (let index = 0; index < events.length; index += 1) {
  const spec = events[index];
  const event = {
    seq: index,
    id: eventId(index),
    ts: spec.ts,
    type: spec.type,
    affects: spec.affects,
    prev: prevHash,
    data: spec.data,
    ...(spec.extras ?? {}),
  };
  const hash = `sha256:${sha256Hex(canonicalJson(event))}`;
  event.hash = hash;
  prevHash = hash;
  lines.push(canonicalJson(event));

  // 独立重放（仅用于生成时自检）
  if (spec.affects === 'text') {
    const data = spec.data;
    switch (spec.type) {
      case 'text.insert':
        derivedText = derivedText.slice(0, data.pos) + data.text + derivedText.slice(data.pos);
        break;
      case 'text.delete':
        derivedText = derivedText.slice(0, data.pos) + derivedText.slice(data.pos + data.length);
        break;
      case 'text.replace':
        derivedText = derivedText.slice(0, data.pos) + data.text + derivedText.slice(data.pos + data.length);
        break;
      case 'text.reset':
        derivedText = data.text;
        break;
      default:
        break;
    }
  }
}

if (derivedText !== FINAL_TEXT) {
  throw new Error(`fixture 重放自检失败：${JSON.stringify(derivedText)} != ${JSON.stringify(FINAL_TEXT)}`);
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });
const target = join(here, 'v1.0-golden.wtlog');
const content = `${lines.join('\n')}\n`;
writeFileSync(target, content, 'utf8');
console.log(`wrote ${target}: ${lines.length} events, ${Buffer.byteLength(content, 'utf8')} bytes`);
