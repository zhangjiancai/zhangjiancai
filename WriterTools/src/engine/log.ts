/**
 * 追加式事件日志：事件信封、序列化、解析、哈希链校验、文本重放与快照校验。
 * 规范见 docs/FILE-FORMAT.md（v1.0）。
 */

import { canonicalJson, computeEventHash, hashText } from './canonical';
import type { SnapshotInfo, SnapshotReason } from './types';
import { FORMAT_MAJOR, FORMAT_MINOR, FORMAT_VERSION } from './types';

export const APP_NAME = 'WriterTools';
export const APP_VERSION = '0.2.1';
export const LOG_MAGIC = 'writertools-log';

export type Affect = 'text' | 'meta';

/** 日志事件（信封 + data）。未知字段通过索引签名原样保留（规范 3、8.2）。 */
export interface LogEvent {
  seq: number;
  id: string;
  ts: string;
  type: string;
  affects: Affect;
  prev: string;
  hash: string;
  data: Record<string, unknown>;
  magic?: string;
  format?: string;
  [key: string]: unknown;
}

export type EventData = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 常量与校验正则
// ---------------------------------------------------------------------------

const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORMAT_RE = /^(\d+)\.(\d+)$/;

const TEXT_EVENT_TYPES = new Set(['text.insert', 'text.delete', 'text.replace', 'text.reset']);
const SNAPSHOT_REASONS = new Set<SnapshotReason>(['manual', 'auto', 'session', 'restore', 'import']);

/** 每个事件被拆分成小事件的上限（UTF-16 码元），用于保证单行 ≤ 256KiB。 */
export const SHARD_THRESHOLD = 2000;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

export function isoNow(now: () => Date): string {
  return now().toISOString();
}

/** 毫秒精度的 UTC ISO 时间（`toISOString` 恒为 3 位毫秒 + `Z`）。 */
export function isIsoUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TS_RE.test(value);
}

export function isValidHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 生成错误信息里用于展示的短字符串（避免把长文本整段塞进消息）。 */
export function previewText(text: string, max = 40): string {
  const clamped = text.length > max ? `${text.slice(0, max)}…` : text;
  return JSON.stringify(clamped);
}

// ---------------------------------------------------------------------------
// 事件构造
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  seq: number;
  prev: string;
  type: string;
  affects: Affect;
  data: EventData;
  id: string;
  ts: string;
  /** header 额外字段（magic / format 等）。 */
  extras?: Record<string, unknown>;
}

/** 构造完整事件（含 `hash`）。字段顺序无关——写出行时会做规范化排序。 */
export async function createEvent(input: CreateEventInput): Promise<LogEvent> {
  const base: Record<string, unknown> = {
    seq: input.seq,
    id: input.id,
    ts: input.ts,
    type: input.type,
    affects: input.affects,
    prev: input.prev,
    data: input.data,
  };
  if (input.extras) {
    for (const [key, value] of Object.entries(input.extras)) {
      if (key === 'hash') continue; // hash 恒由引擎计算
      base[key] = value;
    }
  }
  const hash = await computeEventHash(base);
  return { ...(base as unknown as LogEvent), hash };
}

/** 构造 header（doc.init）事件。 */
export async function createHeaderEvent(params: {
  docId: string;
  title: string;
  createdAt: string;
  ts: string;
  id: string;
  device?: EventData;
  settings?: EventData;
}): Promise<LogEvent> {
  const data: EventData = {
    docId: params.docId,
    title: params.title,
    createdAt: params.createdAt,
    app: { name: APP_NAME, version: APP_VERSION },
  };
  if (params.device) data.device = params.device;
  if (params.settings) data.settings = params.settings;
  return createEvent({
    seq: 0,
    prev: '',
    type: 'doc.init',
    affects: 'meta',
    data,
    id: params.id,
    ts: params.ts,
    extras: { magic: LOG_MAGIC, format: FORMAT_VERSION },
  });
}

/** 浏览器环境信息（Node/测试环境缺失时返回空对象）。 */
export function detectDeviceInfo(extra?: { tz?: string }): EventData {
  const device: EventData = {};
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  if (nav?.platform) device.platform = nav.platform;
  if (nav?.userAgent) device.userAgent = nav.userAgent;
  const tz = extra?.tz;
  if (tz) device.tz = tz;
  return device;
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/** 一行日志（规范 4.3：写出即规范化 JSON）。 */
export function serializeEventLine(event: LogEvent): string {
  return canonicalJson(event);
}

/** 完整日志文本：每行一个规范化 JSON 事件，末行以 `\n` 结尾（规范 2）。 */
export function serializeEvents(events: readonly LogEvent[]): string {
  if (events.length === 0) return '';
  return `${events.map(serializeEventLine).join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface LogSource {
  /** 按文件顺序解析出的值（首个解析错误之后的被忽略）。 */
  values: unknown[];
  /** 每个值对应的文件行号（1-based）。 */
  valueLines: number[];
  warnings: string[];
  /** 第一个无法解析的行（1-based）。 */
  parseError?: { line: number; message: string };
  /** 文件总行数（含空行）。 */
  lineCount: number;
}

/** 把已解析的事件对象（如 IndexedDB 中的事件）包装成校验输入。 */
export function logSourceFromEvents(events: readonly LogEvent[]): LogSource {
  return { values: events.slice(), valueLines: [], warnings: [], lineCount: events.length };
}

/** 解析 JSON Lines 日志文本：忽略空行（记警告），遇到首个解析错误停止收集。 */
export function parseLogText(text: string): LogSource {
  const source: LogSource = { values: [], valueLines: [], warnings: [], lineCount: 0 };
  if (text.length === 0) return source;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const isLast = index === lines.length - 1;
    if (isLast && line === '') break; // 容忍末行缺少 \n
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
      source.warnings.push(`第 ${index + 1} 行使用 CRLF 换行（规范要求 LF），已容忍`);
    }
    source.lineCount = index + 1;
    if (line.trim() === '') {
      source.warnings.push(`第 ${index + 1} 行为空行，已忽略（轻微损坏，不影响哈希链）`);
      continue;
    }
    if (source.parseError) continue; // 首个解析错误之后的行不再收集
    try {
      const value: unknown = JSON.parse(line);
      source.values.push(value);
      source.valueLines.push(index + 1);
    } catch (error) {
      source.parseError = { line: index + 1, message: describeError(error) };
    }
  }
  return source;
}

// ---------------------------------------------------------------------------
// 校验 / 重放
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  /** 通过校验的事件（有效前缀）。 */
  events: LogEvent[];
  /** 有效前缀的事件数。 */
  eventCount: number;
  chainOk: boolean;
  seqOk: boolean;
  brokenAt: number | null;
  brokenReason?: string;
  unknownTextEventSeqs: number[];
  snapshotMismatchSeqs: number[];
  warnings: string[];
  /** true：遇到未知 text 事件 / 更高主版本 / 快照不一致，必须只读打开（规范 7.1、8.3）。 */
  readonlyRequired: boolean;
  docId: string | null;
  title: string;
  createdAt: string | null;
  trashed: boolean;
  /** 有效前缀重放出的正文。 */
  text: string;
  lastValidSeq: number;
  lastValidHash: string;
  /** 是否存在 JSON 解析失败（垃圾尾部/截断）。 */
  hasParseError: boolean;
  headerOk: boolean;
}

interface TextApplyResult {
  ok: boolean;
  text: string;
  reason?: string;
}

function applyTextEvent(event: LogEvent, current: string): TextApplyResult {
  const data = event.data;
  const seq = event.seq;
  switch (event.type) {
    case 'text.insert': {
      const pos = data.pos;
      const insertText = data.text;
      if (!isNonNegativeInteger(pos)) return { ok: false, text: current, reason: `seq=${seq} text.insert 的 pos 不是非负整数` };
      if (typeof insertText !== 'string') return { ok: false, text: current, reason: `seq=${seq} text.insert 缺少 text 字符串` };
      if (insertText.length === 0) return { ok: false, text: current, reason: `seq=${seq} text.insert 的 text 为空（规范禁止空插入事件）` };
      if (pos > current.length) return { ok: false, text: current, reason: `seq=${seq} text.insert 的 pos=${pos} 超出正文长度 ${current.length}` };
      return { ok: true, text: `${current.slice(0, pos)}${insertText}${current.slice(pos)}` };
    }
    case 'text.delete': {
      const pos = data.pos;
      const length = data.length;
      const deleted = data.deleted;
      if (!isNonNegativeInteger(pos)) return { ok: false, text: current, reason: `seq=${seq} text.delete 的 pos 不是非负整数` };
      if (!isInteger(length) || length <= 0) return { ok: false, text: current, reason: `seq=${seq} text.delete 的 length 不是正整数` };
      if (typeof deleted !== 'string') return { ok: false, text: current, reason: `seq=${seq} text.delete 缺少 deleted 字符串` };
      if (pos + length > current.length) {
        return { ok: false, text: current, reason: `seq=${seq} text.delete 越界（pos=${pos}, length=${length}, 正文长度=${current.length}）` };
      }
      const actual = current.slice(pos, pos + length);
      if (actual !== deleted) {
        return {
          ok: false,
          text: current,
          reason: `seq=${seq} text.delete 的 deleted 与当时正文不一致（期望 ${previewText(actual)}，实际 ${previewText(deleted)}）`,
        };
      }
      return { ok: true, text: current.slice(0, pos) + current.slice(pos + length) };
    }
    case 'text.replace': {
      const pos = data.pos;
      const length = data.length;
      const deleted = data.deleted;
      const replacement = data.text;
      if (!isNonNegativeInteger(pos)) return { ok: false, text: current, reason: `seq=${seq} text.replace 的 pos 不是非负整数` };
      if (!isInteger(length) || length < 0) return { ok: false, text: current, reason: `seq=${seq} text.replace 的 length 不是非负整数` };
      if (typeof deleted !== 'string') return { ok: false, text: current, reason: `seq=${seq} text.replace 缺少 deleted 字符串` };
      if (typeof replacement !== 'string') return { ok: false, text: current, reason: `seq=${seq} text.replace 缺少 text 字符串` };
      if (deleted.length === 0 && replacement.length === 0) {
        return { ok: false, text: current, reason: `seq=${seq} text.replace 的 deleted 与 text 同时为空（规范禁止）` };
      }
      if (pos + length > current.length) {
        return { ok: false, text: current, reason: `seq=${seq} text.replace 越界（pos=${pos}, length=${length}, 正文长度=${current.length}）` };
      }
      const actual = current.slice(pos, pos + length);
      if (actual !== deleted) {
        return {
          ok: false,
          text: current,
          reason: `seq=${seq} text.replace 的 deleted 与当时正文不一致（期望 ${previewText(actual)}，实际 ${previewText(deleted)}）`,
        };
      }
      return { ok: true, text: current.slice(0, pos) + replacement + current.slice(pos + length) };
    }
    case 'text.reset': {
      if (typeof data.text !== 'string') return { ok: false, text: current, reason: `seq=${seq} text.reset 缺少 text 字符串` };
      return { ok: true, text: data.text };
    }
    default:
      return { ok: false, text: current, reason: `seq=${seq} 未知文本事件类型 ${event.type}（规范 8.3：只能只读打开）` };
  }
}

function validateEnvelopeBase(event: LogEvent, expectedType: 'header' | 'event'): string | null {
  if (!EVENT_ID_RE.test(String(event.id ?? ''))) return '事件 id 不合法';
  if (!isIsoUtcTimestamp(event.ts)) return '事件 ts 不是毫秒精度 UTC 时间';
  if (typeof event.type !== 'string' || !EVENT_TYPE_RE.test(event.type)) return '事件 type 不合法';
  if (event.affects !== 'text' && event.affects !== 'meta') return '事件 affects 必须是 "text" 或 "meta"';
  if (!isPlainObject(event.data)) return '事件 data 必须是对象';
  if (expectedType === 'header') {
    if (event.type !== 'doc.init') return '第 1 行必须是 type="doc.init" 的 header';
    if (event.magic !== LOG_MAGIC) return 'header.magic 必须是 "writertools-log"';
    if (typeof event.format !== 'string') return 'header.format 必须是字符串';
    const match = FORMAT_RE.exec(event.format);
    if (!match) return 'header.format 格式不合法（应为 "主版本.次版本"）';
  }
  return null;
}

function validateHeaderData(event: LogEvent): string | null {
  const data = event.data;
  if (typeof data.docId !== 'string' || data.docId.length === 0) return 'header.data.docId 必须是非空字符串';
  if (typeof data.title !== 'string') return 'header.data.title 必须是字符串';
  if (!isIsoUtcTimestamp(data.createdAt)) return 'header.data.createdAt 必须是 UTC 时间';
  return null;
}

async function validateSnapshot(event: LogEvent, currentText: string): Promise<string | null> {
  const data = event.data;
  if (typeof data.text !== 'string') return 'snapshot.data.text 必须是字符串';
  if (!isValidHash(data.textHash)) return 'snapshot.data.textHash 必须是 sha256:<hex>';
  if (!isNonNegativeInteger(data.chars)) return 'snapshot.data.chars 必须是非负整数';
  if (data.chars !== data.text.length) {
    return `snapshot 的 chars=${data.chars} 与 text.length=${data.text.length} 不一致`;
  }
  if (currentText !== data.text) return 'snapshot 记录的正文与重放得到的正文不一致';
  const expectedHash = await hashText(data.text);
  if (expectedHash !== data.textHash) return 'snapshot 的 textHash 与 data.text 的哈希不一致';
  return null;
}

/**
 * 完整校验并重放日志（规范 7.1）：哈希链 + seq + 文本事件 + 快照不变量。
 * 任何损坏都返回"最长有效前缀"，绝不静默丢弃数据。
 */
export async function verifyLog(source: LogSource): Promise<VerifyResult> {
  const warnings = [...source.warnings];
  const events: LogEvent[] = [];
  const unknownTextEventSeqs: number[] = [];
  const snapshotMismatchSeqs: number[] = [];
  let chainOk = true;
  let seqOk = true;
  let brokenAt: number | null = null;
  let brokenReason: string | undefined;
  let readonlyRequired = false;
  let text = '';
  let docId: string | null = null;
  let title = '';
  let createdAt: string | null = null;
  let trashed = false;
  let prevHash = '';
  let expectedSeq = 0;
  let headerOk = false;
  let stop = false;

  const breakAt = (reason: string, flags?: { chain?: boolean; seq?: boolean }): void => {
    brokenAt = expectedSeq;
    brokenReason = reason;
    if (flags?.chain) chainOk = false;
    if (flags?.seq) seqOk = false;
    stop = true;
  };

  for (let index = 0; index < source.values.length && !stop; index += 1) {
    const raw = source.values[index];
    const line = source.valueLines[index] ?? index + 1;
    if (!isPlainObject(raw)) {
      breakAt(`第 ${line} 行不是 JSON 对象（期望 seq=${expectedSeq}）`, { chain: true });
      break;
    }
    const event = raw as unknown as LogEvent;

    // 1. 序列连续性
    if (!isInteger(event.seq) || event.seq !== expectedSeq) {
      breakAt(`seq 不连续：期望 ${expectedSeq}，实际 ${String(event.seq)}（第 ${line} 行）`, { seq: true, chain: true });
      break;
    }
    // 2. prev 链
    if (typeof event.prev !== 'string' || event.prev !== prevHash) {
      breakAt(`第 ${line} 行 prev 与上一条 hash 不匹配（期望 "${prevHash}"）`, { chain: true });
      break;
    }
    // 3. 信封结构
    const typeCheck = expectedSeq === 0 ? 'header' : 'event';
    const baseError = validateEnvelopeBase(event, typeCheck);
    if (baseError) {
      breakAt(`第 ${line} 行结构非法：${baseError}`, { chain: true });
      break;
    }
    if (expectedSeq === 0) {
      const headerError = validateHeaderData(event);
      if (headerError) {
        breakAt(`header 非法：${headerError}`, { chain: true });
        break;
      }
      const match = FORMAT_RE.exec(String(event.format));
      const major = match ? Number(match[1]) : NaN;
      const minor = match ? Number(match[2]) : NaN;
      if (major > FORMAT_MAJOR) {
        readonlyRequired = true;
        warnings.push(`文件主版本 ${event.format} 高于支持的 ${FORMAT_VERSION}：只读抢救（规范 8.3）`);
      } else if (major === FORMAT_MAJOR && minor > FORMAT_MINOR) {
        warnings.push(`文件次版本 ${event.format} 高于支持的 ${FORMAT_VERSION}，按兼容规则读取`);
      }
      docId = String(event.data.docId);
      title = String(event.data.title);
      createdAt = String(event.data.createdAt);
      trashed = false;
      headerOk = true;
    }
    // 4. 哈希
    const calculated = await computeEventHash(event as unknown as Record<string, unknown>);
    if (calculated !== event.hash) {
      breakAt(`第 ${line} 行 hash 不匹配（事件被篡改或链被破坏）`, { chain: true });
      break;
    }
    // 5. 重放
    if (TEXT_EVENT_TYPES.has(event.type) && event.affects !== 'text') {
      // 核心文本事件必须声明 affects="text"（规范 3/6.2/8.3）；否则正文无法安全重放，不能静默忽略。
      readonlyRequired = true;
      stop = true;
      brokenAt = event.seq;
      brokenReason = `seq=${event.seq} 核心文本事件 ${event.type} 声明 affects="${event.affects}"，规范要求 "text"`;
      warnings.push(`${brokenReason}：已按最长有效前缀只读打开`);
      break;
    }
    if (event.affects === 'text') {
      const result = applyTextEvent(event, text);
      if (!result.ok) {
        if (!TEXT_EVENT_TYPES.has(event.type)) {
          unknownTextEventSeqs.push(event.seq);
          readonlyRequired = true;
        } else {
          readonlyRequired = true;
          warnings.push(`文本事件非法，已按最长有效前缀只读打开：${result.reason ?? ''}`);
        }
        stop = true;
        brokenAt = event.seq;
        brokenReason = result.reason;
        break;
      }
      text = result.text;
    } else if (event.type === 'snapshot') {
      const mismatch = await validateSnapshot(event, text);
      if (mismatch) {
        snapshotMismatchSeqs.push(event.seq);
        readonlyRequired = true;
        warnings.push(`seq=${event.seq} snapshot 不一致：${mismatch}`);
      }
    } else if (event.type === 'doc.title') {
      if (typeof event.data.title !== 'string') {
        readonlyRequired = true;
        brokenAt = event.seq;
        brokenReason = `seq=${event.seq} doc.title 缺少 title 字符串`;
        break;
      }
      title = event.data.title;
    } else if (event.type === 'doc.trash') {
      trashed = true;
    } else if (event.type === 'doc.untrash') {
      trashed = false;
    }
    // 未知 meta 事件：忽略（规范 8.3）

    events.push(event);
    prevHash = event.hash;
    expectedSeq += 1;
  }

  // 解析失败（垃圾尾部/截断）视为损坏，但保留已校验的有效前缀。
  if (!stop && source.parseError) {
    brokenAt = expectedSeq;
    brokenReason = `第 ${source.parseError.line} 行 JSON 解析失败：${source.parseError.message}`;
    chainOk = false;
    stop = true;
  }
  if (!stop && !headerOk) {
    brokenAt = 0;
    brokenReason = source.values.length === 0 ? '文件为空或缺少 doc.init header' : '缺少 doc.init header';
    chainOk = false;
  }

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const ok =
    headerOk &&
    brokenAt === null &&
    chainOk &&
    seqOk &&
    unknownTextEventSeqs.length === 0 &&
    snapshotMismatchSeqs.length === 0 &&
    !readonlyRequired &&
    !source.parseError;

  return {
    ok,
    events,
    eventCount: events.length,
    chainOk,
    seqOk,
    brokenAt,
    brokenReason,
    unknownTextEventSeqs,
    snapshotMismatchSeqs,
    warnings,
    readonlyRequired,
    docId,
    title,
    createdAt,
    trashed,
    text,
    lastValidSeq: lastEvent ? lastEvent.seq : -1,
    lastValidHash: lastEvent ? lastEvent.hash : '',
    hasParseError: source.parseError !== undefined,
    headerOk,
  };
}

/** 从 snapshot 事件读出 SnapshotInfo；非法返回 null。 */
export function snapshotInfoFromEvent(event: LogEvent): SnapshotInfo | null {
  if (event.type !== 'snapshot' || event.affects !== 'meta') return null;
  const data = event.data;
  if (typeof data.text !== 'string') return null;
  if (!isNonNegativeInteger(data.chars)) return null;
  const reason = data.reason;
  if (typeof reason !== 'string' || !SNAPSHOT_REASONS.has(reason as SnapshotReason)) return null;
  return {
    seq: event.seq,
    ts: event.ts,
    message: typeof data.message === 'string' ? data.message : '',
    reason: reason as SnapshotReason,
    chars: data.chars,
    eventCount: event.seq + 1,
  };
}

/** 从事件里取 snapshot 的完整正文；非法返回 null。 */
export function snapshotTextFromEvent(event: LogEvent): string | null {
  if (event.type !== 'snapshot' || event.affects !== 'meta') return null;
  return typeof event.data.text === 'string' ? event.data.text : null;
}

/** 校验并拆分大文本，保证不把代理对拆开（用于大编辑分片，规范 2/6.2）。 */
export function splitTextChunks(text: string, maxChunk = SHARD_THRESHOLD): string[] {
  if (text.length <= maxChunk) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxChunk, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      // 别把一对代理项拆到两个事件里
      if (end - 1 > offset) end -= 1;
      else end += 1; // 极端：单个代理项 + 长度上限为 1
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
