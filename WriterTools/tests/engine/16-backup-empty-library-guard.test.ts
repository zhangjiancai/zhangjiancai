import { describe, expect, it } from 'vitest';
import { BACKUP_KV_KEYS, createBackupService } from '../../src/engine/backup';
import type { BackupDirectorySnapshot, InternalBackupService } from '../../src/engine/backup';
import type { DocRecord } from '../../src/engine/idb';
import type { LogEvent } from '../../src/engine/log';
import type { LibraryEngine } from '../../src/engine/types';
import { archiveToDirectorySnapshot, MANIFEST_FILE } from '../support/archive-utils';
import { createHarness } from '../support/test-utils';

// ---------------------------------------------------------------------------
// 假 File System Access 目录 + 假 IDBDatabase（Node 无 FSA；只实现 backup.ts 用到的部分）
// ---------------------------------------------------------------------------

interface FakeDirectoryHandle {
  kind: 'directory';
  name: string;
  files: Map<string, string>;
  /** writeTextFile 调用次数（guard 命中时应为 0）。 */
  writes: number;
  queryPermission(): Promise<'granted'>;
  requestPermission(): Promise<'granted'>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  entries(): AsyncIterableIterator<[string, unknown]>;
  removeEntry(name: string): Promise<void>;
}

function createFakeDirectoryHandle(initialFiles: Record<string, string>): FakeDirectoryHandle {
  const files = new Map(Object.entries(initialFiles));
  const directory: FakeDirectoryHandle = {
    kind: 'directory',
    name: 'fake-backup-dir',
    files,
    writes: 0,
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
    async getFileHandle(name, options) {
      if (!files.has(name) && !options?.create) {
        const error = new Error(`NotFoundError: ${name}`);
        error.name = 'NotFoundError';
        throw error;
      }
      return {
        kind: 'file',
        name,
        async getFile() {
          return { text: async () => files.get(name) ?? '' };
        },
        async createWritable() {
          return {
            async write(data: unknown) {
              files.set(name, String(data));
              directory.writes += 1;
            },
            async close() {
              // no-op
            },
          };
        },
      };
    },
    async *entries() {
      for (const [name, text] of files) {
        yield [
          name,
          {
            kind: 'file',
            name,
            async getFile() {
              return { text: async () => text };
            },
          },
        ];
      }
    },
    async removeEntry(name) {
      files.delete(name);
    },
  };
  return directory;
}

/** 最小 IDBDatabase 假实现：backup.ts 只用 kv store 的 get/put/delete。 */
function createFakeKvDatabase(initial: Record<string, unknown>): {
  db: IDBDatabase;
  store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = { ...initial };
  const settle = (apply: () => void, handlers: () => Record<string, unknown>) => {
    queueMicrotask(() => {
      apply();
      const record = handlers();
      (record.onsuccess as (() => void) | null)?.();
    });
  };
  const db = {
    transaction() {
      const tx: Record<string, unknown> = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({
        get(key: string) {
          const request: Record<string, unknown> = { result: undefined };
          settle(
            () => {
              request.result = key in store ? { key, value: store[key] } : undefined;
            },
            () => request,
          );
          return request;
        },
        put(record: { key: string; value: unknown }) {
          const request: Record<string, unknown> = { result: undefined };
          settle(
            () => {
              store[record.key] = record.value;
              (tx.oncomplete as (() => void) | null)?.();
            },
            () => request,
          );
          return request;
        },
        delete(key: string) {
          const request: Record<string, unknown> = { result: undefined };
          settle(
            () => {
              delete store[key];
              (tx.oncomplete as (() => void) | null)?.();
            },
            () => request,
          );
          return request;
        },
      });
      return tx;
    },
  };
  return { db: db as unknown as IDBDatabase, store };
}

async function withFakePicker<T>(handle: unknown, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'showDirectoryPicker');
  Object.defineProperty(globalThis, 'showDirectoryPicker', {
    value: async () => handle,
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'showDirectoryPicker', original);
    else delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  }
}

function createService(options: {
  dir: FakeDirectoryHandle;
  records: DocRecord[];
  events?: Record<string, LogEvent[]>;
}): { service: InternalBackupService; store: Record<string, unknown> } {
  const { db, store } = createFakeKvDatabase({
    [BACKUP_KV_KEYS.dirHandle]: options.dir,
    [BACKUP_KV_KEYS.lastBackupAt]: '2026-01-01T00:00:00.000Z',
    [BACKUP_KV_KEYS.docCount]: 2,
  });
  const service = createBackupService(
    {
      db,
      now: () => new Date('2026-02-01T00:00:00.000Z'),
      listDocRecords: async () => options.records,
      readDocEvents: async (docId) => options.events?.[docId] ?? [],
      flushAll: async () => undefined,
    },
    true,
  );
  return { service, store };
}

function makeEvent(seq: number, type: string, affects: 'text' | 'meta', data: Record<string, unknown>, prev: string, hash: string): LogEvent {
  return {
    seq,
    id: `e0000000-0000-4000-8000-${String(seq + 1).padStart(12, '0')}`,
    ts: '2026-01-01T00:00:00.000Z',
    type,
    affects,
    prev,
    hash,
    data,
  };
}

interface EngineInternals {
  backupServiceInternal: { readDirectoryTexts(): Promise<BackupDirectorySnapshot | null> };
}

async function createOldBackupDirectory(): Promise<{
  dir: FakeDirectoryHandle;
  manifestText: string;
  files: Record<string, string>;
  docIds: string[];
  firstText: string;
}> {
  const source = await createHarness();
  const docA = await source.engine.createDoc('旧作品A');
  await docA.appendEdit({ kind: 'insert', pos: 0, text: '旧正文A' });
  const docB = await source.engine.createDoc('旧作品B');
  await docB.appendEdit({ kind: 'insert', pos: 0, text: '旧正文B' });
  const firstText = docA.text;
  const docIds = [docA.docId, docB.docId];
  await docA.close();
  await docB.close();
  const archive = await source.engine.exportArchive();
  const snapshot = await archiveToDirectorySnapshot(archive);
  const dir = createFakeDirectoryHandle({ [MANIFEST_FILE]: snapshot.manifestText, ...snapshot.files });
  return { dir, manifestText: snapshot.manifestText, files: snapshot.files, docIds, firstText };
}

describe('空库自动备份保护（灾备边界）', () => {
  it('旧清单 + 本地空库：backupNow 不写清单/不标 trashed；随后恢复的作品 trashed=false 且在默认书架', async () => {
    const { dir, manifestText, docIds, firstText } = await createOldBackupDirectory();
    const oldManifest = JSON.parse(manifestText) as { docs: Array<{ docId: string; trashed?: boolean }> };
    expect(oldManifest.docs).toHaveLength(2);
    expect(oldManifest.docs.every((doc) => doc.trashed !== true)).toBe(true);

    // 本地库为空（模拟浏览器数据丢失后重选同一目录）
    const { service, store } = createService({ dir, records: [] });
    const status = await withFakePicker(dir, () => service.backupNow());
    expect(status.configured).toBe(true);
    expect(status.docCount).toBe(0);
    // 目录与 kv 完全未被写入：清单字节不变、旧条目未被标记 trashed、lastBackupAt 保持
    expect(dir.writes).toBe(0);
    expect(dir.files.get(MANIFEST_FILE)).toBe(manifestText);
    expect(store[BACKUP_KV_KEYS.lastBackupAt]).toBe('2026-01-01T00:00:00.000Z');
    const afterManifest = JSON.parse(dir.files.get(MANIFEST_FILE)!) as { docs: Array<{ trashed?: boolean }> };
    expect(afterManifest.docs.every((doc) => doc.trashed !== true)).toBe(true);

    // 通过真实 readDirectoryTexts 读回目录内容，再走「从备份目录一键恢复」
    const snapshot = await withFakePicker(dir, () => service.readDirectoryTexts());
    expect(snapshot).not.toBeNull();
    expect(snapshot?.manifestText).toBe(manifestText);
    expect(Object.keys(snapshot?.files ?? {})).toHaveLength(2);

    const target = await createHarness();
    (target.engine as unknown as EngineInternals).backupServiceInternal.readDirectoryTexts = async () => snapshot;
    const report = await target.engine.restoreFromBackupDirectory();
    expect(report.imported).toBe(2);
    expect(report.failed).toBe(0);

    const visible = await target.engine.listDocs(); // 默认书架（不含回收站）
    expect(visible.map((doc) => doc.docId).sort()).toEqual([...docIds].sort());
    expect(visible.every((doc) => doc.trashed === false)).toBe(true);
    const reopened = await target.engine.openDoc(docIds[0]);
    expect(reopened.text).toBe(firstText);
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('全新用户（备份目录中还没有清单）仍按原逻辑写空清单', async () => {
    const dir = createFakeDirectoryHandle({});
    const { service, store } = createService({ dir, records: [] });
    const status = await withFakePicker(dir, () => service.backupNow());
    expect(status.configured).toBe(true);
    expect(status.docCount).toBe(0);
    const manifestText = dir.files.get(MANIFEST_FILE);
    expect(manifestText).toBeTruthy();
    const manifest = JSON.parse(manifestText!) as { magic: string; docs: unknown[] };
    expect(manifest.magic).toBe('writertools-backup-manifest');
    expect(manifest.docs).toEqual([]);
    expect(store[BACKUP_KV_KEYS.lastBackupAt]).toBe('2026-02-01T00:00:00.000Z');
    expect(store[BACKUP_KV_KEYS.docCount]).toBe(0);
  });

  it('本地有作品时正常备份：新作品写入，旧清单条目保留并标记 trashed（只增不删语义不变）', async () => {
    const oldManifest = {
      magic: 'writertools-backup-manifest',
      format: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      app: { name: 'WriterTools', version: '0.1.1' },
      docs: [
        {
          docId: 'old-doc-id',
          title: '旧条目',
          file: '旧条目-olddocid.wtlog',
          lastSeq: 1,
          lastHash: `sha256:${'a'.repeat(64)}`,
          chars: 3,
          backupAt: '2026-01-01T00:00:00.000Z',
          fileHash: `sha256:${'b'.repeat(64)}`,
        },
      ],
    };
    const dir = createFakeDirectoryHandle({ [MANIFEST_FILE]: `${JSON.stringify(oldManifest)}\n` });

    const docId = 'new-doc-id';
    const events: LogEvent[] = [
      makeEvent(0, 'doc.init', 'meta', { docId, title: '新作品', createdAt: '2026-01-01T00:00:00.000Z', app: { name: 'WriterTools', version: '0.1.1' } }, '', `sha256:${'c'.repeat(64)}`),
      makeEvent(1, 'text.insert', 'text', { pos: 0, text: '新', source: 'typing' }, `sha256:${'c'.repeat(64)}`, `sha256:${'d'.repeat(64)}`),
    ];
    const record: DocRecord = {
      docId,
      title: '新作品',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      chars: 1,
      eventCount: 2,
      snapshotCount: 0,
      trashed: false,
      lastSeq: 1,
      lastHash: `sha256:${'d'.repeat(64)}`,
      integrity: 'ok',
    };
    const { service } = createService({ dir, records: [record], events: { [docId]: events } });
    const status = await withFakePicker(dir, () => service.backupNow());
    expect(status.configured).toBe(true);
    expect(status.docCount).toBe(1);
    expect(dir.writes).toBeGreaterThanOrEqual(2); // 日志文件 + 清单

    const manifest = JSON.parse(dir.files.get(MANIFEST_FILE)!) as {
      docs: Array<{ docId: string; trashed?: boolean }>;
    };
    expect(manifest.docs).toHaveLength(2);
    const kept = manifest.docs.find((doc) => doc.docId === 'old-doc-id');
    expect(kept?.trashed).toBe(true); // 原有"只增不删 + 标记 trashed"语义
    const fresh = manifest.docs.find((doc) => doc.docId === docId);
    expect(fresh?.trashed).toBeUndefined();
    // 新作品日志确实写入了目录
    const newFile = Object.keys(Object.fromEntries(dir.files)).find((name) => name.includes(docId.slice(0, 8)));
    expect(newFile).toBeTruthy();
    expect(dir.files.get(newFile!)).toContain('"type":"text.insert"');
  });
});
