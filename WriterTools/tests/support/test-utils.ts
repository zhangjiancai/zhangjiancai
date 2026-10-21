/**
 * 引擎测试公共工具。
 *
 * 重要：这里的规范化 JSON 与 SHA-256 校验是**独立实现**（不复用 src/engine/canonical.ts），
 * 用于交叉验证引擎写出的日志与哈希链；静态格式检查也基于它。
 */

import type { EngineOptions, OpfsAdapter } from '../../src/engine/types';
import { createEngine } from '../../src/engine';
import type { LibraryEngine } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// 内存 OPFS 适配器
// ---------------------------------------------------------------------------

export interface MemoryOpfs extends OpfsAdapter {
  readonly files: Map<string, string>;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function createMemoryOpfs(): MemoryOpfs {
  const files = new Map<string, string>();
  return {
    available: true,
    files,
    async read(path: string): Promise<string | null> {
      return files.get(normalizePath(path)) ?? null;
    },
    async write(path: string, data: string): Promise<void> {
      files.set(normalizePath(path), data);
    },
    async list(dir: string): Promise<string[]> {
      const prefix = `${normalizePath(dir).replace(/\/$/, '')}/`;
      const names: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) names.push(rest);
      }
      return names;
    },
    async remove(path: string): Promise<void> {
      files.delete(normalizePath(path));
    },
  };
}

export function mirrorPathOf(docId: string): string {
  return `docs/${docId}.wtlog`;
}

export function readMirror(opfs: MemoryOpfs, docId: string): string | null {
  return opfs.files.get(mirrorPathOf(docId)) ?? null;
}

// ---------------------------------------------------------------------------
// 独立实现的规范化 JSON / SHA-256（交叉校验用）
// ---------------------------------------------------------------------------

export function testCanonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`测试用 canonical JSON 只接受整数：${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => testCanonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${testCanonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`测试用 canonical JSON 不支持的类型：${typeof value}`);
}

export async function testSha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text) as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function testHashText(text: string): Promise<string> {
  return `sha256:${await testSha256Hex(text)}`;
}

/** 按规范 4.2 独立重算事件哈希。 */
export async function testHashEvent(event: Record<string, unknown>): Promise<string> {
  const rest = { ...event };
  delete rest.hash;
  return `sha256:${await testSha256Hex(testCanonicalJson(rest))}`;
}

// ---------------------------------------------------------------------------
// 时钟 / ID / 引擎 harness
// ---------------------------------------------------------------------------

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
  current(): string;
}

export function createTestClock(startIso = '2026-01-01T00:00:00.000Z'): TestClock {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    current: () => new Date(current).toISOString(),
  };
}

/** 确定性 UUIDv4 形态的 ID 生成器（测试用）。 */
export function createIdFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const hex = counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  };
}

let dbCounter = 0;

export function uniqueDbName(prefix = 'wt-test'): string {
  dbCounter += 1;
  return `${prefix}-${dbCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface HarnessOptions {
  dbName?: string;
  autoSnapshot?: { maxEvents?: number; maxIntervalMs?: number };
  autoBackup?: { enabled?: boolean; debounceMs?: number; minIntervalMs?: number };
  fileSystemAccess?: boolean;
  requestPersistence?: boolean;
  /** undefined = 新建内存 OPFS；null = 禁用镜像；否则复用给定适配器。 */
  opfs?: OpfsAdapter | null;
  clock?: TestClock;
  ids?: () => string;
}

export interface Harness {
  engine: LibraryEngine;
  opfs: MemoryOpfs | null;
  clock: TestClock;
  ids: () => string;
  dbName: string;
  options: EngineOptions;
}

/** 创建注入式引擎（fake-indexeddb + 内存 OPFS + 确定性时间/ID）。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = options.clock ?? createTestClock();
  const ids = options.ids ?? createIdFactory();
  const dbName = options.dbName ?? uniqueDbName();
  const memoryOpfs = options.opfs === undefined ? createMemoryOpfs() : options.opfs;
  const engineOptions: EngineOptions = {
    dbName,
    indexedDB: globalThis.indexedDB,
    opfs: memoryOpfs,
    now: clock.now,
    randomUUID: ids,
    autoSnapshot: options.autoSnapshot,
    autoBackup: options.autoBackup,
    fileSystemAccess: options.fileSystemAccess,
    requestPersistence: options.requestPersistence ?? false,
  };
  const engine = await createEngine(engineOptions);
  return { engine, opfs: memoryOpfs as MemoryOpfs | null, clock, ids, dbName, options: engineOptions };
}

/** 用同一数据库/OPS 重新创建引擎（模拟刷新页面）。 */
export async function reopenHarness(harness: Harness, overrides: Partial<HarnessOptions> = {}): Promise<Harness> {
  return createHarness({
    dbName: harness.dbName,
    opfs: harness.opfs,
    clock: overrides.clock ?? createTestClock(),
    ids: overrides.ids ?? createIdFactory(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 原始 IndexedDB 操作（篡改/清库/静态检查用）
// ---------------------------------------------------------------------------

interface RawEventRecord {
  docId: string;
  seq: number;
  event: Record<string, unknown> & { seq: number; hash: string; prev: string };
}

function openRawDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开原始 IndexedDB 失败'));
  });
}

function rawTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('原始 IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('原始 IndexedDB 事务中止'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function eventRange(docId: string): IDBKeyRange {
  return IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);
}

/** 直接读取 events store（不经过引擎）。 */
export async function readRawEvents(dbName: string, docId: string): Promise<RawEventRecord[]> {
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['events'], 'readonly');
    const records = await requestResult(tx.objectStore('events').getAll(eventRange(docId)));
    return (records as RawEventRecord[]).slice().sort((a, b) => a.seq - b.seq);
  } finally {
    db.close();
  }
}

/** 直接读取 docs store 中的作品摘要。 */
export async function readRawDocRecord(dbName: string, docId: string): Promise<Record<string, unknown> | null> {
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['docs'], 'readonly');
    const record = await requestResult(tx.objectStore('docs').get(docId));
    return (record as Record<string, unknown> | undefined) ?? null;
  } finally {
    db.close();
  }
}

/** 篡改某条事件对象（hash 保持旧值 → 哈希链失配）。 */
export async function mutateRawEvent(
  dbName: string,
  docId: string,
  seq: number,
  mutate: (event: Record<string, unknown>) => void,
): Promise<void> {
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['events'], 'readwrite');
    const done = rawTxDone(tx);
    const store = tx.objectStore('events');
    const record = (await requestResult(store.get([docId, seq]))) as RawEventRecord | undefined;
    if (!record) throw new Error(`要篡改的事件不存在：${docId} seq=${seq}`);
    mutate(record.event);
    record.event.seq = seq;
    store.put(record);
    await done;
  } finally {
    db.close();
  }
}

/** 直接删除某条事件（模拟中间事件丢失）。 */
export async function deleteRawEvent(dbName: string, docId: string, seq: number): Promise<void> {
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['events'], 'readwrite');
    const done = rawTxDone(tx);
    tx.objectStore('events').delete([docId, seq]);
    await done;
  } finally {
    db.close();
  }
}

/** 直接删除作品摘要（模拟 docs store 丢失但事件仍在）。 */
export async function deleteRawDocRecord(dbName: string, docId: string): Promise<void> {
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['docs'], 'readwrite');
    const done = rawTxDone(tx);
    tx.objectStore('docs').delete(docId);
    await done;
  } finally {
    db.close();
  }
}

/** 直接清空 docs/events/kv（模拟主存储丢失）。 */
export async function clearRawStores(dbName: string): Promise<void> {
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['docs', 'events', 'kv'], 'readwrite');
    const done = rawTxDone(tx);
    tx.objectStore('docs').clear();
    tx.objectStore('events').clear();
    tx.objectStore('kv').clear();
    await done;
  } finally {
    db.close();
  }
}

/**
 * 重写某条事件并重算其后的哈希链（用于构造"链本身有效但语义/不变量被破坏"的损坏样本）。
 */
export async function rewriteRawEventAndChain(
  dbName: string,
  docId: string,
  targetSeq: number,
  mutate: (event: Record<string, unknown>) => void,
): Promise<void> {
  const records = await readRawEvents(dbName, docId);
  const targetIndex = records.findIndex((record) => record.seq === targetSeq);
  if (targetIndex < 0) throw new Error(`要重写的事件不存在：${docId} seq=${targetSeq}`);
  let prevHash = targetIndex === 0 ? '' : String(records[targetIndex - 1].event.hash);
  const updated: Array<{ seq: number; event: Record<string, unknown> }> = [];
  for (let index = targetIndex; index < records.length; index += 1) {
    const event = records[index].event;
    event.prev = prevHash;
    if (index === targetIndex) mutate(event);
    event.seq = records[index].seq;
    event.hash = await testHashEvent(event);
    prevHash = String(event.hash);
    updated.push({ seq: records[index].seq, event });
  }
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['events'], 'readwrite');
    const done = rawTxDone(tx);
    const store = tx.objectStore('events');
    for (const item of updated) store.put({ docId, seq: item.seq, event: item.event });
    await done;
  } finally {
    db.close();
  }
}

/**
 * 在日志尾部追加一条外部事件（用独立实现计算 prev/hash），
 * 用于测试未知 meta/text 事件的兼容性与恢复逻辑。
 */
export async function appendRawEvent(
  dbName: string,
  docId: string,
  partial: { type: string; affects: 'meta' | 'text'; data: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  // 读取阶段（事务不能跨 await 保持活跃，因此读、算、写分三步）
  const existing = await readRawEvents(dbName, docId);
  const last = existing.length > 0 ? existing[existing.length - 1].event : null;
  const seq = last ? Number(last.seq) + 1 : 0;
  const event: Record<string, unknown> = {
    seq,
    id: `x-raw-${String(seq).padStart(6, '0')}`,
    ts: '2026-01-01T00:00:00.000Z',
    type: partial.type,
    affects: partial.affects,
    prev: last ? String(last.hash) : '',
    data: partial.data,
  };
  event.hash = await testHashEvent(event);
  const db = await openRawDb(dbName);
  try {
    const tx = db.transaction(['events'], 'readwrite');
    const done = rawTxDone(tx);
    tx.objectStore('events').put({ docId, seq, event });
    await done;
    return event;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 静态格式检查（独立于被测实现）
// ---------------------------------------------------------------------------

interface LogEventShape {
  seq: number;
  id: string;
  ts: string;
  type: string;
  affects: 'text' | 'meta';
  prev: string;
  hash: string;
  data: Record<string, unknown>;
  magic?: string;
  format?: string;
  [key: string]: unknown;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`日志静态检查失败：${message}`);
}

/**
 * 独立校验 .wtlog 文本：
 * - 每行合法 JSON 且与独立规范化 JSON 实现逐字节一致；
 * - header（magic/format/seq=0/type）与 seq/prev/hash 链；
 * - 按规范重放文本事件（deleted 必须匹配）；
 * - snapshot 不变量（text/textHash/chars）。
 * 返回解析后的事件列表。
 */
export async function checkLogText(text: string, expected?: { docId?: string }): Promise<LogEventShape[]> {
  assert(typeof text === 'string' && text.length > 0, '日志为空');
  assert(!text.startsWith('\uFEFF'), '文件不应带 BOM');
  assert(!text.includes('\r'), '日志必须使用 LF 换行');
  assert(text.endsWith('\n'), '最后一行应以 \\n 结尾');
  const lines = text.slice(0, -1).split('\n');
  const events: LogEventShape[] = [];
  let prevHash = '';
  let derivedText = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    assert(line.trim() !== '', `第 ${index + 1} 行为空行`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`日志静态检查失败：第 ${index + 1} 行不是合法 JSON`);
    }
    assert(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), `第 ${index + 1} 行不是对象`);
    const event = parsed as LogEventShape;
    // 逐字节规范化比对（独立实现）
    assert(testCanonicalJson(event) === line, `第 ${index + 1} 行不是规范化 JSON（键未排序或含多余空白）`);
    assert(event.seq === index, `第 ${index + 1} 行 seq=${String(event.seq)}，期望 ${index}`);
    assert(ID_RE.test(String(event.id ?? '')), `第 ${index + 1} 行 id 非法`);
    assert(TS_RE.test(String(event.ts ?? '')), `第 ${index + 1} 行 ts 不是毫秒精度 UTC`);
    assert(TYPE_RE.test(String(event.type ?? '')), `第 ${index + 1} 行 type 非法`);
    assert(event.affects === 'text' || event.affects === 'meta', `第 ${index + 1} 行 affects 非法`);
    assert(typeof event.data === 'object' && event.data !== null, `第 ${index + 1} 行 data 不是对象`);
    assert(event.prev === prevHash, `第 ${index + 1} 行 prev 链断裂`);
    assert(HASH_RE.test(String(event.hash ?? '')), `第 ${index + 1} 行 hash 格式非法`);
    assert((await testHashEvent(event as unknown as Record<string, unknown>)) === event.hash, `第 ${index + 1} 行 hash 不匹配`);
    if (index === 0) {
      assert(event.type === 'doc.init', '第 1 行必须是 doc.init');
      assert(event.magic === 'writertools-log', 'header.magic 必须为 writertools-log');
      assert(event.format === '1.0', 'header.format 必须为 1.0');
      assert(event.affects === 'meta', 'header.affects 必须为 meta');
      assert(typeof event.data.docId === 'string' && event.data.docId.length > 0, 'header.data.docId 缺失');
      assert(typeof event.data.title === 'string', 'header.data.title 缺失');
      assert(TS_RE.test(String(event.data.createdAt ?? '')), 'header.data.createdAt 非法');
      const app = event.data.app as Record<string, unknown> | undefined;
      assert(app !== undefined && typeof app.name === 'string' && typeof app.version === 'string', 'header.data.app 非法');
      if (expected?.docId) assert(event.data.docId === expected.docId, 'header.data.docId 与预期不一致');
    } else {
      assert(event.magic === undefined, `第 ${index + 1} 行不允许出现 magic`);
    }
    // 文本重放
    if (event.affects === 'text') {
      const pos = event.data.pos;
      switch (event.type) {
        case 'text.insert': {
          const inserted = event.data.text;
          assert(typeof inserted === 'string' && inserted.length > 0, `seq=${event.seq} 空插入事件`);
          assert(Number.isInteger(pos) && (pos as number) >= 0 && (pos as number) <= derivedText.length, `seq=${event.seq} insert pos 越界`);
          const p = pos as number;
          derivedText = derivedText.slice(0, p) + inserted + derivedText.slice(p);
          break;
        }
        case 'text.delete': {
          const length = event.data.length;
          const deleted = event.data.deleted;
          assert(Number.isInteger(length) && (length as number) > 0, `seq=${event.seq} delete length 非法`);
          assert(Number.isInteger(pos) && (pos as number) >= 0 && (pos as number) + (length as number) <= derivedText.length, `seq=${event.seq} delete 越界`);
          assert(typeof deleted === 'string', `seq=${event.seq} delete 缺少 deleted`);
          const p = pos as number;
          const l = length as number;
          assert(derivedText.slice(p, p + l) === deleted, `seq=${event.seq} delete 的 deleted 与正文不一致`);
          derivedText = derivedText.slice(0, p) + derivedText.slice(p + l);
          break;
        }
        case 'text.replace': {
          const length = event.data.length;
          const deleted = event.data.deleted;
          const replacement = event.data.text;
          assert(Number.isInteger(length) && (length as number) >= 0, `seq=${event.seq} replace length 非法`);
          assert(typeof deleted === 'string' && typeof replacement === 'string', `seq=${event.seq} replace 字段缺失`);
          assert(deleted.length > 0 || replacement.length > 0, `seq=${event.seq} replace 的 deleted/text 同时为空`);
          assert(Number.isInteger(pos) && (pos as number) >= 0 && (pos as number) + (length as number) <= derivedText.length, `seq=${event.seq} replace 越界`);
          const p = pos as number;
          const l = length as number;
          assert(derivedText.slice(p, p + l) === deleted, `seq=${event.seq} replace 的 deleted 与正文不一致`);
          derivedText = derivedText.slice(0, p) + replacement + derivedText.slice(p + l);
          break;
        }
        case 'text.reset':
          assert(typeof event.data.text === 'string', `seq=${event.seq} reset 缺少 text`);
          derivedText = event.data.text as string;
          break;
        default:
          throw new Error(`日志静态检查失败：未知文本事件类型 ${event.type}`);
      }
    } else if (event.type === 'snapshot') {
      assert(typeof event.data.text === 'string', `seq=${event.seq} snapshot 缺少 text`);
      assert(event.data.text === derivedText, `seq=${event.seq} snapshot 记录的正文与重放不一致`);
      assert(event.data.chars === (event.data.text as string).length, `seq=${event.seq} snapshot chars 不一致`);
      assert(event.data.textHash === (await testHashText(event.data.text as string)), `seq=${event.seq} snapshot textHash 不一致`);
      assert(typeof event.data.reason === 'string', `seq=${event.seq} snapshot 缺少 reason`);
    }
    events.push(event);
    prevHash = event.hash;
  }
  return events;
}

/** 从日志文本中取某类事件。 */
export function eventsOfType(events: LogEventShape[], type: string): LogEventShape[] {
  return events.filter((event) => event.type === type);
}

/** 从导出的日志 Blob 读取文本。 */
export async function blobText(blob: Blob): Promise<string> {
  return blob.text();
}

/** 重放日志得到正文（独立实现，供断言用；checkLogText 内部也做同样的事）。 */
export function replayText(events: LogEventShape[]): string {
  let text = '';
  for (const event of events) {
    if (event.affects !== 'text') continue;
    const pos = Number(event.data.pos ?? 0);
    switch (event.type) {
      case 'text.insert':
        text = text.slice(0, pos) + String(event.data.text) + text.slice(pos);
        break;
      case 'text.delete':
        text = text.slice(0, pos) + text.slice(pos + Number(event.data.length));
        break;
      case 'text.replace':
        text = text.slice(0, pos) + String(event.data.text) + text.slice(pos + Number(event.data.length));
        break;
      case 'text.reset':
        text = String(event.data.text);
        break;
      default:
        break;
    }
  }
  return text;
}

/** 等到条件成立（最多 timeoutMs），用于镜像防抖等异步调度。 */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Web Locks 模拟（Node 环境没有 navigator.locks）
// ---------------------------------------------------------------------------

/**
 * 在 `run()` 执行期间把 navigator 替换成只暴露 locks.query/request 的假对象，
 * 让引擎认为 `heldDocIds` 这些作品正被其它上下文（标签页）独占锁定。
 * 仅用于测试 recover()/listDocs() 的外部锁判定；结束后恢复原 navigator。
 */
export async function withFakeWebLocks<T>(heldDocIds: readonly string[], run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const held = heldDocIds.map((docId) => ({
    name: `writertools:doc:${docId}`,
    mode: 'exclusive' as const,
    clientId: 'fake-other-tab',
  }));
  const fakeNavigator = {
    userAgent: 'vitest-fake-navigator',
    platform: 'test',
    locks: {
      async query() {
        return { held, pending: [] };
      },
      async request(name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) {
        return callback({ name, mode: 'exclusive' });
      },
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: fakeNavigator, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}
