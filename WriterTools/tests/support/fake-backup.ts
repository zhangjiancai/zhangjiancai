/**
 * 备份目录相关单测的假 File System Access 目录 + 假 IDBDatabase（Node 无 FSA）。
 * 只实现 backup.ts 用到的接口：句柄存 kv、权限查询/请求、读写文件、列目录。
 */

import type { BackupPermission } from '../../src/engine/types';

export interface FakeDirectoryHandleOptions {
  files?: Record<string, string>;
  name?: string;
  permission?: BackupPermission;
  /** 调用 requestPermission 后是否把权限置为 granted（默认 true）。 */
  grantOnRequest?: boolean;
  /** false = 模拟不支持 queryPermission 的句柄/浏览器。 */
  supportQueryPermission?: boolean;
  /** false = 模拟不支持 requestPermission 的句柄/浏览器。 */
  supportRequestPermission?: boolean;
}

export interface FakeDirectoryHandle {
  kind: 'directory';
  name: string;
  files: Map<string, string>;
  /** writeTextFile 调用次数。 */
  writes: number;
  permission: BackupPermission;
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  entries(): AsyncIterableIterator<[string, unknown]>;
  removeEntry(name: string): Promise<void>;
}

export function createFakeDirectoryHandle(options: FakeDirectoryHandleOptions = {}): FakeDirectoryHandle {
  const files = new Map(Object.entries(options.files ?? {}));
  const directory: FakeDirectoryHandle = {
    kind: 'directory',
    name: options.name ?? 'fake-backup-dir',
    files,
    writes: 0,
    permission: options.permission ?? 'granted',
    async getFileHandle(name, fileOptions) {
      if (!files.has(name) && !fileOptions?.create) {
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
  if (options.supportQueryPermission !== false) {
    directory.queryPermission = async () => directory.permission as PermissionState;
  }
  if (options.supportRequestPermission !== false) {
    directory.requestPermission = async () => {
      if (options.grantOnRequest !== false) directory.permission = 'granted';
      return directory.permission as PermissionState;
    };
  }
  return directory;
}

/** 最小 IDBDatabase 假实现：backup.ts 只用 kv store 的 get/put/delete。 */
export function createFakeKvDatabase(initial: Record<string, unknown>): {
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

export async function withFakePicker<T>(handle: unknown, run: () => Promise<T>): Promise<T> {
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
