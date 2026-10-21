/**
 * IndexedDB 主存储：docs / events / kv。
 *
 * 结构（库名默认 `writertools`，version 1）：
 * - docs：主键 docId，作品摘要（标题、时间、字数、事件数、回收站、链尾锚点等）；
 * - events：复合主键 [docId, seq]，value = { docId, seq, event }（event 原样保留，含未知字段）；
 * - kv：主键 key，value = { key, value }（备份目录句柄、备份状态等）。
 */

import type { IntegrityState } from './types';
import type { LogEvent } from './log';

export const DEFAULT_DB_NAME = 'writertools';
export const DB_VERSION = 1;
export const STORE_DOCS = 'docs';
export const STORE_EVENTS = 'events';
export const STORE_KV = 'kv';

const EVENTS_RANGE_MAX_SEQ = Number.MAX_SAFE_INTEGER;

export interface DocRecord {
  docId: string;
  title: string;
  /** ISO UTC */
  createdAt: string;
  /** ISO UTC */
  updatedAt: string;
  chars: number;
  eventCount: number;
  snapshotCount: number;
  trashed: boolean;
  lastSeq: number;
  lastHash: string;
  integrity: IntegrityState;
}

export interface EventRecord {
  docId: string;
  seq: number;
  event: LogEvent;
}

export interface KvRecord {
  key: string;
  value: unknown;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 等待事务完成；写事务只有在 complete 后才算真正落盘。 */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

/** 打开（必要时创建）数据库。 */
export function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        db.createObjectStore(STORE_DOCS, { keyPath: 'docId' });
      }
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        db.createObjectStore(STORE_EVENTS, { keyPath: ['docId', 'seq'] });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // 其它标签页要升级版本时，主动让出连接（避免阻塞）
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB 被其它连接阻塞（请关闭其它标签页后重试）'));
  });
}

function docEventsRange(docId: string): IDBKeyRange {
  return IDBKeyRange.bound([docId, 0], [docId, EVENTS_RANGE_MAX_SEQ]);
}

export async function readDocRecord(db: IDBDatabase, docId: string): Promise<DocRecord | null> {
  const tx = db.transaction([STORE_DOCS], 'readonly');
  const request = tx.objectStore(STORE_DOCS).get(docId);
  const result = await requestToPromise<DocRecord | undefined>(request);
  return result ?? null;
}

export async function listDocRecords(db: IDBDatabase): Promise<DocRecord[]> {
  const tx = db.transaction([STORE_DOCS], 'readonly');
  const request = tx.objectStore(STORE_DOCS).getAll();
  const records = await requestToPromise<DocRecord[]>(request);
  return records.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** 读取某作品的全部事件（按 seq 升序）。 */
export async function readDocEvents(db: IDBDatabase, docId: string): Promise<LogEvent[]> {
  const tx = db.transaction([STORE_EVENTS], 'readonly');
  const request = tx.objectStore(STORE_EVENTS).getAll(docEventsRange(docId));
  const records = await requestToPromise<EventRecord[]>(request);
  const events: LogEvent[] = [];
  for (const record of records) {
    if (record && record.event) events.push(record.event);
  }
  return events;
}

export async function countDocEvents(db: IDBDatabase, docId: string): Promise<number> {
  const tx = db.transaction([STORE_EVENTS], 'readonly');
  const request = tx.objectStore(STORE_EVENTS).count(docEventsRange(docId));
  return requestToPromise<number>(request);
}

/**
 * 事件存储中出现过的全部 docId（去重）。
 * 用于"摘要丢失但事件仍在"时仍能导出/恢复，避免备份静默漏掉作品。
 */
export async function listEventDocIds(db: IDBDatabase): Promise<string[]> {
  const tx = db.transaction([STORE_EVENTS], 'readonly');
  const store = tx.objectStore(STORE_EVENTS);
  return new Promise<string[]>((resolve, reject) => {
    const ids = new Set<string>();
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(Array.from(ids));
        return;
      }
      const record = cursor.value as EventRecord;
      if (record && typeof record.docId === 'string') ids.add(record.docId);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 游标读取失败'));
  });
}

/** 原子写入：先更新作品摘要，再追加事件们（同一事务）。 */
export async function writeDocSnapshot(db: IDBDatabase, record: DocRecord, events: readonly LogEvent[]): Promise<void> {
  const tx = db.transaction([STORE_DOCS, STORE_EVENTS], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_DOCS).put(record);
  const eventsStore = tx.objectStore(STORE_EVENTS);
  for (const event of events) {
    const eventRecord: EventRecord = { docId: record.docId, seq: event.seq, event };
    eventsStore.put(eventRecord);
  }
  await done;
}

/** 只更新作品摘要。 */
export async function putDocRecord(db: IDBDatabase, record: DocRecord): Promise<void> {
  const tx = db.transaction([STORE_DOCS], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_DOCS).put(record);
  await done;
}

export async function readKv(db: IDBDatabase, key: string): Promise<unknown> {
  const tx = db.transaction([STORE_KV], 'readonly');
  const request = tx.objectStore(STORE_KV).get(key);
  const record = await requestToPromise<KvRecord | undefined>(request);
  return record ? record.value : undefined;
}

export async function writeKv(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction([STORE_KV], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_KV).put({ key, value } satisfies KvRecord);
  await done;
}

export async function deleteKv(db: IDBDatabase, key: string): Promise<void> {
  const tx = db.transaction([STORE_KV], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_KV).delete(key);
  await done;
}
