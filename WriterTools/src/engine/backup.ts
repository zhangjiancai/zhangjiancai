/**
 * 备份目录服务（规范第 9 节）——内部按后端驱动抽象：
 * - `fsa`：浏览器 File System Access（showDirectoryPicker + 目录句柄存 IDB kv）；
 * - `native`：原生平台桥（Android Storage Access Framework 等，见 NativeBackupDirectoryBridge）。
 *
 * 公共行为一致：
 * - backupNow 把每个作品导出为 `<title>-<docId前8位>.wtlog` + writertools-manifest.json（含外部锚点）；
 * - 自动备份 / 手动备份 / 从备份目录恢复 / 权限健康检查全部走当前后端驱动；
 * - 没有任何可用后端时 configured=false、backend='none'，所有方法正常降级、不抛异常。
 */

import { canonicalJson, sha256BytesHex } from './canonical';
import type { LogEvent } from './log';
import { APP_NAME, APP_VERSION, serializeEvents } from './log';
import type { DocRecord } from './idb';
import { deleteKv, readKv, writeKv } from './idb';
import type {
  BackupBackend,
  BackupPermission,
  BackupService,
  BackupStatus,
  NativeBackupDirectoryBridge,
} from './types';
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
const LOG_ENTRY_SUFFIX = '.wtlog';

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

/** 文件名校验（备份目录内只允许安全单段文件名）。 */
function isSafeBackupEntryName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  if (name !== name.trim()) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.includes('\\') || name.includes('/') || name.includes('..')) return false;
  return true;
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

// ---------------------------------------------------------------------------
// 驱动抽象（fsa / native）
// ---------------------------------------------------------------------------

interface DriverDirectoryInfo {
  name: string;
  permission: BackupPermission;
  needsPermission: boolean;
}

interface DriverReadAllResult {
  files: Array<{ name: string; text: string }>;
  warnings: string[];
}

/** 备份目录驱动：屏蔽 File System Access 与原生 SAF 的差异。 */
interface BackupDirectoryDriver {
  readonly backend: BackupBackend;
  isAvailable(): boolean;
  /** 当前目录信息（未配置/不可用返回 null）。 */
  loadDirectory(): Promise<DriverDirectoryInfo | null>;
  /** 弹出目录选择器；用户取消返回 null。异常向上抛由服务层转成可读 lastError。 */
  chooseDirectory(): Promise<{ name: string } | null>;
  /** 重新请求权限（用户手势中调用）。 */
  requestPermission(): Promise<void>;
  /** 写备份前确认权限（无手势时不得弹权限请求）。 */
  ensureWritePermission(): Promise<boolean>;
  writeFile(name: string, text: string): Promise<void>;
  readFile(name: string): Promise<string | null>;
  readAllFiles(): Promise<DriverReadAllResult>;
  forgetDirectory(): Promise<void>;
}

/** 浏览器 File System Access 驱动（行为与历史版本保持一致）。 */
function createFsaDriver(deps: BackupDeps, enabled: boolean): BackupDirectoryDriver {
  async function readHandle(): Promise<FileSystemDirectoryHandle | null> {
    try {
      const handle = await readKv(deps.db, KV_DIR_HANDLE);
      return handle && typeof handle === 'object' ? (handle as FileSystemDirectoryHandle) : null;
    } catch {
      return null;
    }
  }

  async function requireHandle(): Promise<FileSystemDirectoryHandle> {
    const handle = await readHandle();
    if (!handle) throw new Error('未配置备份目录');
    return handle;
  }

  return {
    backend: 'fsa',
    isAvailable(): boolean {
      return enabled && getDirectoryPicker() !== null;
    },
    async loadDirectory(): Promise<DriverDirectoryInfo | null> {
      if (!enabled) return null;
      const handle = await readHandle();
      if (!handle) return null;
      const permission = await queryHandlePermission(handle);
      return {
        name: handle.name,
        permission,
        needsPermission: permission === 'prompt' || permission === 'denied',
      };
    },
    async chooseDirectory(): Promise<{ name: string } | null> {
      const picker = getDirectoryPicker();
      if (!picker) return null;
      const handle = await picker({ mode: 'readwrite' });
      await writeKv(deps.db, KV_DIR_HANDLE, handle);
      return { name: handle.name };
    },
    async requestPermission(): Promise<void> {
      const handle = await readHandle();
      if (!handle) return;
      const capable = handle as unknown as PermissionHandle;
      if (typeof capable.requestPermission !== 'function') return;
      try {
        await capable.requestPermission({ mode: 'readwrite' });
      } catch {
        // 用户拒绝或浏览器异常：不抛出，状态查询会反映实情
      }
    },
    async ensureWritePermission(): Promise<boolean> {
      const handle = await readHandle();
      if (!handle) return false;
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
    },
    async writeFile(name: string, text: string): Promise<void> {
      const handle = await requireHandle();
      const fileHandle = await handle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(text);
      } finally {
        await writable.close();
      }
    },
    async readFile(name: string): Promise<string | null> {
      try {
        const handle = await requireHandle();
        const fileHandle = await handle.getFileHandle(name);
        const file = await fileHandle.getFile();
        return await file.text();
      } catch {
        return null;
      }
    },
    async readAllFiles(): Promise<DriverReadAllResult> {
      const handle = await requireHandle();
      const capable = handle as unknown as Partial<DirectoryEntriesCapable>;
      if (typeof capable.entries !== 'function') {
        throw new Error('当前目录句柄不支持枚举文件');
      }
      const files: Array<{ name: string; text: string }> = [];
      const warnings: string[] = [];
      for await (const [name, entry] of capable.entries()) {
        if (!isSafeBackupEntryName(name) || !name.endsWith(LOG_ENTRY_SUFFIX)) continue;
        const fileHandle = entry as FileSystemFileHandle;
        if (fileHandle.kind !== 'file' || typeof fileHandle.getFile !== 'function') continue;
        try {
          const file = await fileHandle.getFile();
          files.push({ name, text: await file.text() });
        } catch (error) {
          warnings.push(`无法读取备份文件 ${name}：${describeError(error)}`);
        }
      }
      return { files, warnings };
    },
    async forgetDirectory(): Promise<void> {
      try {
        await deleteKv(deps.db, KV_DIR_HANDLE);
      } catch {
        // 禁用失败不应让调用方崩溃
      }
    },
  };
}

/** 原生平台桥驱动（Android SAF 等）：目录持久授权由平台层保证。 */
function createNativeDriver(bridge: NativeBackupDirectoryBridge): BackupDirectoryDriver {
  return {
    backend: 'native',
    isAvailable(): boolean {
      return bridge.available === true;
    },
    async loadDirectory(): Promise<DriverDirectoryInfo | null> {
      if (bridge.available !== true) return null;
      try {
        const directory = await bridge.getDirectory();
        if (!directory) return null;
        return { name: directory.name, permission: 'granted', needsPermission: false };
      } catch {
        return null;
      }
    },
    async chooseDirectory(): Promise<{ name: string } | null> {
      if (bridge.available !== true) return null;
      return await bridge.chooseDirectory();
    },
    async requestPermission(): Promise<void> {
      // 原生系统持久授权由桥/平台层负责；这里无需请求。
    },
    async ensureWritePermission(): Promise<boolean> {
      return bridge.available === true;
    },
    async writeFile(name: string, text: string): Promise<void> {
      await bridge.writeFile(name, text);
    },
    async readFile(name: string): Promise<string | null> {
      return await bridge.readFile(name);
    },
    async readAllFiles(): Promise<DriverReadAllResult> {
      const list = await bridge.readFiles();
      const files: Array<{ name: string; text: string }> = [];
      const warnings: string[] = [];
      for (const item of list) {
        if (!item || typeof item.name !== 'string' || typeof item.text !== 'string') {
          warnings.push('原生备份目录返回了非法文件条目，已跳过');
          continue;
        }
        if (!isSafeBackupEntryName(item.name) || !item.name.endsWith(LOG_ENTRY_SUFFIX)) continue;
        files.push({ name: item.name, text: item.text });
      }
      return { files, warnings };
    },
    async forgetDirectory(): Promise<void> {
      try {
        await bridge.forgetDirectory();
      } catch {
        // 忘记目录失败不应让调用方崩溃
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 备份服务
// ---------------------------------------------------------------------------

/**
 * 创建备份服务。
 * @param enabled 是否启用浏览器 File System Access 后端（EngineOptions.fileSystemAccess !== false）；
 *                原生桥可用时优先使用原生后端，与该项无关。
 */
export function createBackupService(
  deps: BackupDeps,
  enabled = true,
  nativeBridge?: NativeBackupDirectoryBridge | null,
): InternalBackupService {
  let inFlight: Promise<BackupStatus> | null = null;

  const nativeDriver = nativeBridge ? createNativeDriver(nativeBridge) : null;
  const fsaDriver = createFsaDriver(deps, enabled);

  /** 当前生效后端：原生桥优先；其次 FSA；都没有返回 null。 */
  function resolveDriver(): BackupDirectoryDriver | null {
    if (nativeDriver && nativeDriver.isAvailable()) return nativeDriver;
    if (fsaDriver.isAvailable()) return fsaDriver;
    return null;
  }

  async function readStatusBase(): Promise<{
    driver: BackupDirectoryDriver | null;
    directory: DriverDirectoryInfo | null;
    status: BackupStatus;
  }> {
    const driver = resolveDriver();
    const directory = driver ? await driver.loadDirectory() : null;
    const lastBackupAt = (await readKv(deps.db, KV_LAST_BACKUP_AT).catch(() => undefined)) as string | undefined;
    const lastError = (await readKv(deps.db, KV_LAST_ERROR).catch(() => undefined)) as string | undefined;
    const docCount = (await readKv(deps.db, KV_DOC_COUNT).catch(() => undefined)) as number | undefined;
    const status: BackupStatus = {
      configured: directory !== null,
      backend: driver ? driver.backend : 'none',
    };
    if (directory) {
      status.directoryName = directory.name;
      // 权限健康检查：FSA 浏览器重启/权限被撤销后会变成 prompt/denied；原生后端视为 granted。
      status.permission = directory.permission;
      status.needsPermission = directory.needsPermission;
    }
    if (typeof lastBackupAt === 'string') status.lastBackupAt = lastBackupAt;
    if (typeof lastError === 'string' && lastError.length > 0) status.lastError = lastError;
    if (typeof docCount === 'number') status.docCount = docCount;
    return { driver, directory, status };
  }

  async function setLastError(message: string | null): Promise<void> {
    try {
      if (message === null) await deleteKv(deps.db, KV_LAST_ERROR);
      else await writeKv(deps.db, KV_LAST_ERROR, message);
    } catch {
      // 状态记录失败不影响主流程
    }
  }

  async function readExistingManifest(
    driver: BackupDirectoryDriver,
  ): Promise<{ createdAt: string; docs: ManifestDocEntry[] } | null> {
    const text = await driver.readFile(BACKUP_MANIFEST_NAME);
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
    const { driver, directory, status } = await readStatusBase();
    if (!driver || !directory) return status;
    try {
      if (!(await driver.ensureWritePermission())) {
        const message = '备份目录权限不足，请在设置中点击「重新授权」后再备份';
        await setLastError(message);
        return { ...status, lastError: message, needsPermission: status.permission !== 'unknown' };
      }
      await deps.flushAll();
      const records = await deps.listDocRecords();
      const existing = await readExistingManifest(driver);

      // 灾备边界保护：本地库为空、但备份目录里已有非空旧清单。
      // 这通常意味着「浏览器数据全丢后重选了同一个备份目录」——此时绝不能把旧作品条目标记为
      // trashed:true（否则随后的一键恢复会把所有作品放进回收站，用户以为恢复失败）。
      // 完全不写文件/清单（保留目录原样，等待 restoreFromBackupDirectory 恢复），
      // 只返回当前配置状态；全新用户（目录里还没有清单）仍按原逻辑写空清单。
      if (records.length === 0 && existing !== null && existing.docs.length > 0) {
        return {
          ...status,
          configured: true,
          directoryName: directory.name,
          docCount: 0,
        };
      }

      const backupAt = deps.now().toISOString();
      const entries: ManifestDocEntry[] = [];
      for (const record of records) {
        const events = await deps.readDocEvents(record.docId);
        const logText = serializeEvents(events);
        const fileName = safeBackupFileName(record.title, record.docId);
        await driver.writeFile(fileName, logText);
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
      await driver.writeFile(
        BACKUP_MANIFEST_NAME,
        `${canonicalJson(manifest as unknown as Record<string, unknown>)}\n`,
      );

      await writeKv(deps.db, KV_LAST_BACKUP_AT, backupAt);
      await writeKv(deps.db, KV_DOC_COUNT, entries.length);
      await setLastError(null);
      return {
        configured: true,
        backend: driver.backend,
        directoryName: directory.name,
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
   * 任何"目录不可用"（未配置 / 不可读 / 无权限 / 枚举失败）返回 null，由上层给出可读错误。
   */
  async function readDirectoryTexts(): Promise<BackupDirectorySnapshot | null> {
    const driver = resolveDriver();
    if (!driver) return null;
    let directory = await driver.loadDirectory();
    if (!directory) return null;
    if (directory.needsPermission) {
      try {
        await driver.requestPermission();
      } catch {
        // 用户拒绝：下面重新读取状态并返回 null
      }
      directory = await driver.loadDirectory();
      if (!directory || directory.needsPermission) return null;
    }
    const manifestText = await driver.readFile(BACKUP_MANIFEST_NAME);
    let all: DriverReadAllResult;
    try {
      all = await driver.readAllFiles();
    } catch {
      return null;
    }
    const files: Record<string, string> = {};
    for (const file of all.files) files[file.name] = file.text;
    return { manifestText, files, warnings: all.warnings };
  }

  return {
    async status(): Promise<BackupStatus> {
      const { status } = await readStatusBase();
      return status;
    },

    readDirectoryTexts,

    async chooseDirectory(): Promise<BackupStatus> {
      const driver = resolveDriver();
      if (!driver) return this.status();
      try {
        const directory = await driver.chooseDirectory();
        if (!directory) return this.status(); // 用户取消不是错误
        await setLastError(null);
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === 'AbortError') return this.status(); // 取消选择不算错误
        const message = describeError(error);
        await setLastError(message);
        return { ...(await this.status()), lastError: message };
      }
      return this.status();
    },

    /**
     * 对已配置的备份目录重新请求 readwrite 权限（浏览器重启/权限被撤销后使用）。
     * 必须在用户手势中调用；原生后端为 no-op；没有可用后端时直接返回当前状态。
     */
    async requestPermission(): Promise<BackupStatus> {
      const driver = resolveDriver();
      if (!driver) return this.status();
      await driver.requestPermission();
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
      const driver = resolveDriver();
      if (driver) await driver.forgetDirectory();
      await setLastError(null);
    },
  };
}
