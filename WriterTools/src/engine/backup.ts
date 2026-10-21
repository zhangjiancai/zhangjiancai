/**
 * File System Access 备份目录服务（规范第 9 节）。
 *
 * - showDirectoryPicker 必须在用户手势中调用；句柄存入 IndexedDB kv，跨会话复用；
 * - backupNow 把每个作品导出为 `<title>-<docId前8位>.wtlog` + writertools-manifest.json（含外部锚点）；
 * - 不支持 File System Access 的环境：configured=false，所有方法正常返回/降级，不抛异常。
 */

import { canonicalJson, sha256BytesHex } from './canonical';
import type { LogEvent } from './log';
import { APP_NAME, APP_VERSION, serializeEvents } from './log';
import type { DocRecord } from './idb';
import { deleteKv, readKv, writeKv } from './idb';
import type { BackupService, BackupStatus, BackupPermission } from './types';
import { BACKUP_MANIFEST_NAME, FORMAT_VERSION } from './types';

const KV_DIR_HANDLE = 'backup.dirHandle';
const KV_LAST_BACKUP_AT = 'backup.lastBackupAt';
const KV_LAST_ERROR = 'backup.lastError';
const KV_DOC_COUNT = 'backup.docCount';

/** 备份状态在 IndexedDB kv 中使用的键（测试/诊断用，非公共契约）。 */
export const BACKUP_KV_KEYS = {
  dirHandle: KV_DIR_HANDLE,
  lastBackupAt: KV_LAST_BACKUP_AT,
  lastError: KV_LAST_ERROR,
  docCount: KV_DOC_COUNT,
} as const;

const MANIFEST_MAGIC = 'writertools-backup-manifest';

interface ManifestDocEntry {
  docId: string;
  title: string;
  file: string;
  lastSeq: number;
  lastHash: string;
  chars: number;
  backupAt: string;
  fileHash?: string;
  trashed?: boolean;
}

interface BackupManifest {
  magic: string;
  format: string;
  createdAt: string;
  updatedAt: string;
  app: { name: string; version: string };
  docs: ManifestDocEntry[];
}

interface PermissionHandle {
  name: string;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

interface DirectoryEntriesCapable {
  entries(): AsyncIterableIterator<[string, unknown]>;
}

/**
 * 备份目录内容快照（用于「从备份目录一键恢复」）：
 * manifest 原文 + 目录内全部 .wtlog 文本；读取过程中的非致命问题记 warnings。
 */
export interface BackupDirectorySnapshot {
  manifestText: string | null;
  files: Record<string, string>;
  warnings: string[];
}

/** 引擎内部使用的备份服务（比公共 BackupService 多一个目录读取能力，不暴露给 UI）。 */
export interface InternalBackupService extends BackupService {
  /** 读取已配置目录中的 manifest 与 .wtlog 文本；未配置/不支持/不可读/无权限返回 null。 */
  readDirectoryTexts(): Promise<BackupDirectorySnapshot | null>;
}

export interface BackupDeps {
  db: IDBDatabase;
  now: () => Date;
  listDocRecords: () => Promise<DocRecord[]>;
  readDocEvents: (docId: string) => Promise<LogEvent[]>;
  /** 备份前等待所有排队写入落盘。 */
  flushAll: () => Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getDirectoryPicker(): DirectoryPicker | null {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof picker === 'function' ? picker : null;
}

/** 当前上下文是否有"瞬态用户激活"（点击/按键手势）；不支持判断的浏览器返回 null（按有手势处理）。 */
function hasTransientUserActivation(): boolean | null {
  const activation = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator
    ?.userActivation;
  if (!activation || typeof activation.isActive !== 'boolean') return null;
  return activation.isActive;
}

/** 查询目录句柄的 readwrite 权限；句柄/浏览器不支持或异常时返回 'unknown'（不误报）。 */
async function queryHandlePermission(handle: FileSystemDirectoryHandle): Promise<BackupPermission> {
  const capable = handle as unknown as PermissionHandle;
  if (typeof capable.queryPermission !== 'function') return 'unknown';
  try {
    const state = await capable.queryPermission({ mode: 'readwrite' });
    if (state === 'granted' || state === 'prompt' || state === 'denied') return state;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 文件名安全化：去掉路径分隔符/控制字符等；空标题回退"无题"。 */
export function safeBackupFileName(title: string, docId: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const base = cleaned.length > 0 ? cleaned : '无题';
  return `${base}-${docId.slice(0, 8)}.wtlog`;
}

async function writeTextFile(directory: FileSystemDirectoryHandle, name: string, data: string): Promise<void> {
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

async function readTextFile(directory: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const fileHandle = await directory.getFileHandle(name);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

export function createBackupService(deps: BackupDeps, enabled: boolean): InternalBackupService {
  let inFlight: Promise<BackupStatus> | null = null;

  async function readHandle(): Promise<FileSystemDirectoryHandle | null> {
    try {
      const handle = await readKv(deps.db, KV_DIR_HANDLE);
      return handle && typeof handle === 'object' ? (handle as FileSystemDirectoryHandle) : null;
    } catch {
      return null;
    }
  }

  async function readStatusBase(): Promise<{ handle: FileSystemDirectoryHandle | null; status: BackupStatus }> {
    const pickerAvailable = getDirectoryPicker() !== null;
    const handle = enabled && pickerAvailable ? await readHandle() : null;
    const lastBackupAt = (await readKv(deps.db, KV_LAST_BACKUP_AT).catch(() => undefined)) as string | undefined;
    const lastError = (await readKv(deps.db, KV_LAST_ERROR).catch(() => undefined)) as string | undefined;
    const docCount = (await readKv(deps.db, KV_DOC_COUNT).catch(() => undefined)) as number | undefined;
    const status: BackupStatus = { configured: handle !== null };
    if (handle) {
      status.directoryName = handle.name;
      // 权限健康检查：浏览器重启/权限被撤销后这里会变成 prompt/denied，UI 可提示「重新授权」
      const permission = await queryHandlePermission(handle);
      status.permission = permission;
      status.needsPermission = permission === 'prompt' || permission === 'denied';
    }
    if (typeof lastBackupAt === 'string') status.lastBackupAt = lastBackupAt;
    if (typeof lastError === 'string' && lastError.length > 0) status.lastError = lastError;
    if (typeof docCount === 'number') status.docCount = docCount;
    return { handle, status };
  }

  async function setLastError(message: string | null): Promise<void> {
    try {
      if (message === null) await deleteKv(deps.db, KV_LAST_ERROR);
      else await writeKv(deps.db, KV_LAST_ERROR, message);
    } catch {
      // 状态记录失败不影响主流程
    }
  }

  async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const capable = handle as unknown as PermissionHandle;
    try {
      if (typeof capable.queryPermission === 'function') {
        const existing = await capable.queryPermission({ mode: 'readwrite' });
        if (existing === 'granted') return true;
        if (existing === 'denied') return false; // 已被拒绝：不尝试无手势的权限请求
      }
      // 自动备份路径没有用户手势：不要在没有手势时弹权限请求（否则静默失败/被浏览器拒绝）。
      // 手动「立即备份」「重新授权」「从备份目录恢复」都发生在点击手势中，允许请求。
      if (hasTransientUserActivation() === false) return false;
      if (typeof capable.requestPermission === 'function') {
        const requested = await capable.requestPermission({ mode: 'readwrite' });
        return requested === 'granted';
      }
      return true;
    } catch {
      return false;
    }
  }

  async function readExistingManifest(
    directory: FileSystemDirectoryHandle,
  ): Promise<{ createdAt: string; docs: ManifestDocEntry[] } | null> {
    const text = await readTextFile(directory, BACKUP_MANIFEST_NAME);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as Partial<BackupManifest>;
      if (parsed.magic !== MANIFEST_MAGIC || !Array.isArray(parsed.docs)) return null;
      const docs = parsed.docs.filter(
        (entry): entry is ManifestDocEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as ManifestDocEntry).docId === 'string' &&
          typeof (entry as ManifestDocEntry).file === 'string',
      );
      return {
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : deps.now().toISOString(),
        docs,
      };
    } catch {
      return null;
    }
  }

  async function runBackup(): Promise<BackupStatus> {
    const { handle, status } = await readStatusBase();
    if (!handle) return status;
    try {
      if (!(await ensurePermission(handle))) {
        const message = '备份目录权限不足，请在设置中点击「重新授权」后再备份';
        await setLastError(message);
        return { ...status, lastError: message, needsPermission: status.permission !== 'unknown' };
      }
      await deps.flushAll();
      const records = await deps.listDocRecords();
      const existing = await readExistingManifest(handle);

      // 灾备边界保护：本地库为空、但备份目录里已有非空旧清单。
      // 这通常意味着「浏览器数据全丢后重选了同一个备份目录」——此时绝不能把旧作品条目标记为
      // trashed:true（否则随后的一键恢复会把所有作品放进回收站，用户以为恢复失败）。
      // 完全不写文件/清单（保留目录原样，等待 restoreFromBackupDirectory 恢复），
      // 只返回当前配置状态；全新用户（目录里还没有清单）仍按原逻辑写空清单。
      if (records.length === 0 && existing !== null && existing.docs.length > 0) {
        return {
          configured: true,
          directoryName: handle.name,
          ...(status.lastBackupAt ? { lastBackupAt: status.lastBackupAt } : {}),
          docCount: 0,
        };
      }

      const backupAt = deps.now().toISOString();
      const entries: ManifestDocEntry[] = [];
      for (const record of records) {
        const events = await deps.readDocEvents(record.docId);
        const logText = serializeEvents(events);
        const fileName = safeBackupFileName(record.title, record.docId);
        await writeTextFile(handle, fileName, logText);
        const fileHash = `sha256:${await sha256BytesHex(new TextEncoder().encode(logText))}`;
        const lastEvent = events.length > 0 ? events[events.length - 1] : null;
        const entry: ManifestDocEntry = {
          docId: record.docId,
          title: record.title,
          file: fileName,
          lastSeq: lastEvent ? lastEvent.seq : 0,
          lastHash: lastEvent ? lastEvent.hash : '',
          chars: record.chars,
          backupAt,
          fileHash,
        };
        if (record.trashed) entry.trashed = true;
        entries.push(entry);
      }

      // 清单只增不删：保留历史条目（当前库中已没有的作品标记 trashed）。
      const currentIds = new Set(entries.map((entry) => entry.docId));
      const keptEntries: ManifestDocEntry[] = [];
      for (const oldEntry of existing?.docs ?? []) {
        if (!currentIds.has(oldEntry.docId)) {
          keptEntries.push({ ...oldEntry, trashed: true });
        }
      }
      const manifest: BackupManifest = {
        magic: MANIFEST_MAGIC,
        format: FORMAT_VERSION,
        createdAt: existing?.createdAt ?? backupAt,
        updatedAt: backupAt,
        app: { name: APP_NAME, version: APP_VERSION },
        docs: [...keptEntries, ...entries],
      };
      await writeTextFile(handle, BACKUP_MANIFEST_NAME, `${canonicalJson(manifest as unknown as Record<string, unknown>)}\n`);

      await writeKv(deps.db, KV_LAST_BACKUP_AT, backupAt);
      await writeKv(deps.db, KV_DOC_COUNT, entries.length);
      await setLastError(null);
      return {
        configured: true,
        directoryName: handle.name,
        lastBackupAt: backupAt,
        docCount: entries.length,
      };
    } catch (error) {
      const message = describeError(error);
      await setLastError(message);
      return { ...status, lastError: message };
    }
  }

  /**
   * 读取已配置备份目录：manifest 原文 + 全部 .wtlog 文本。
   * 任何"目录不可用"（未启用 FSA / 未选择目录 / 无权限 / 枚举失败）返回 null，由上层给出可读错误。
   */
  async function readDirectoryTexts(): Promise<BackupDirectorySnapshot | null> {
    if (!enabled) return null;
    if (getDirectoryPicker() === null) return null; // 当前环境不支持 File System Access
    const handle = await readHandle();
    if (!handle) return null;
    if (!(await ensurePermission(handle))) return null;
    if (typeof (handle as unknown as { entries?: unknown }).entries !== 'function') return null;

    const manifestText = await readTextFile(handle, BACKUP_MANIFEST_NAME);
    const files: Record<string, string> = {};
    const warnings: string[] = [];
    try {
      for await (const [name, entry] of (handle as unknown as DirectoryEntriesCapable).entries()) {
        if (typeof name !== 'string' || !name.endsWith('.wtlog')) continue;
        if (name.includes('/') || name.includes('\\') || name.includes('..')) continue;
        const fileHandle = entry as FileSystemFileHandle;
        if (fileHandle.kind !== 'file' || typeof fileHandle.getFile !== 'function') continue;
        try {
          const file = await fileHandle.getFile();
          files[name] = await file.text();
        } catch (error) {
          warnings.push(`无法读取备份文件 ${name}：${describeError(error)}`);
        }
      }
    } catch {
      return null; // 目录枚举失败 = 不可读
    }
    return { manifestText, files, warnings };
  }

  return {
    async status(): Promise<BackupStatus> {
      const { status } = await readStatusBase();
      return status;
    },

    readDirectoryTexts,

    async chooseDirectory(): Promise<BackupStatus> {
      if (!enabled) return this.status();
      const picker = getDirectoryPicker();
      if (!picker) return this.status();
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await picker({ mode: 'readwrite' });
      } catch (error) {
        // 用户取消选择不算错误（规范：取消不是错误）
        const name = (error as { name?: string } | null)?.name;
        if (name === 'AbortError') return this.status();
        const message = describeError(error);
        await setLastError(message);
        return { ...(await this.status()), lastError: message };
      }
      try {
        await writeKv(deps.db, KV_DIR_HANDLE, handle);
        await setLastError(null);
      } catch (error) {
        const message = describeError(error);
        await setLastError(message);
        return { ...(await this.status()), lastError: message };
      }
      return this.status();
    },

    /**
     * 对已配置的备份目录重新请求 readwrite 权限（浏览器重启/权限被撤销后使用）。
     * 必须在用户手势中调用；不支持的浏览器/未配置目录直接返回当前状态。
     */
    async requestPermission(): Promise<BackupStatus> {
      if (!enabled) return this.status();
      if (getDirectoryPicker() === null) return this.status();
      const handle = await readHandle();
      if (!handle) return this.status();
      const capable = handle as unknown as PermissionHandle;
      if (typeof capable.requestPermission === 'function') {
        try {
          await capable.requestPermission({ mode: 'readwrite' });
        } catch {
          // 用户拒绝或浏览器异常：不抛出，返回新状态（needsPermission 会反映实情）
        }
      }
      return this.status();
    },

    async backupNow(): Promise<BackupStatus> {
      // 同一时刻只跑一个备份，避免并发写同一目录
      if (inFlight) return inFlight;
      inFlight = runBackup().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    async disable(): Promise<void> {
      try {
        await deleteKv(deps.db, KV_DIR_HANDLE);
        await setLastError(null);
      } catch {
        // 禁用失败不应让调用方崩溃
      }
    },
  };
}
