/**
 * 书架引擎：多作品管理、索引/事件主存储、OPFS 镜像、备份目录、恢复与校验。
 *
 * 并发：优先使用 navigator.locks 对 docId 加独占锁；拿不到锁返回只读句柄；
 * 无 Web Locks 的环境（如测试/Node）按可写处理。同一引擎内多次 open 同一作品返回同一句柄。
 */

import { canonicalJson } from './canonical';
import { createEvent, createHeaderEvent, detectDeviceInfo, isoNow, logSourceFromEvents, parseLogText, serializeEvents, verifyLog, type LogEvent } from './log';
import type { DocRecord } from './idb';
import {
  countDocEvents,
  listDocRecords,
  listEventDocIds,
  openDatabase,
  readDocEvents,
  readDocRecord,
  writeDocSnapshot,
  DEFAULT_DB_NAME,
} from './idb';
import { createAutoOpfsAdapter, docIdFromMirrorFile, mirrorPath, MIRROR_DIR } from './opfs';
import { createBackupService, type InternalBackupService } from './backup';
import { createAutoBackupScheduler, type AutoBackupScheduler } from './auto-backup';
import { countSnapshots, recordFromVerify } from './records';
import { createArchiveBlobFromTexts, exportArchiveFromStorage, importArchiveFromFile } from './archive';
import type { HandleCore, DocLockInfo } from './handle';
import { DocHandleImpl } from './handle';
import type {
  ArchiveImportReport,
  BackupService,
  DocHandle,
  DocSummary,
  EngineFactory,
  EngineOptions,
  IntegrityState,
  LibraryEngine,
  OpfsAdapter,
  RecoveryReport,
  StorageStatus,
  VerifyReport,
} from './types';
import { FORMAT_VERSION } from './types';

const LOCK_PREFIX = 'writertools:doc:';

/** 自动备份默认参数（契约：防抖 3s、最小间隔 15s）。 */
const DEFAULT_AUTO_BACKUP_DEBOUNCE_MS = 3000;
const DEFAULT_AUTO_BACKUP_MIN_INTERVAL_MS = 15_000;

function normalizeDuration(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function lockName(docId: string): string {
  return `${LOCK_PREFIX}${docId}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function defaultUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 两份副本的同一 seq 事件是否完全一致（hash 与载荷都要一致；载荷被改但 hash 未改也视为分歧）。 */
function sameCopyEvent(left: LogEvent, right: LogEvent): boolean {
  if (left.seq !== right.seq) return false;
  if (left.hash !== right.hash) return false;
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

class LibraryEngineImpl implements LibraryEngine {
  private readonly options: EngineOptions;
  private readonly dbName: string;
  private db!: IDBDatabase;
  private opfs: OpfsAdapter | null = null;
  private core!: HandleCore;
  /** 内部真实备份服务（自动备份、从备份目录恢复直接使用）。 */
  private backupServiceInternal!: InternalBackupService;
  /** 对外暴露的备份服务（包装：记录手动备份时间、配置后触发首次自动备份）。 */
  private backupService!: BackupService;
  private autoBackupScheduler!: AutoBackupScheduler;
  private autoBackupEnabled = true;
  private backupConfigured = false;
  private readonly openHandles = new Map<string, DocHandleImpl>();
  private readonly pendingOpens = new Map<string, Promise<DocHandleImpl>>();
  private readonly heldLocks = new Set<string>();
  private readonly integrityCache = new Map<string, IntegrityState>();
  private persistRequested = false;
  private nowFn: () => Date = () => new Date();
  private uuidFn: () => string = defaultUuid;

  constructor(options: EngineOptions) {
    this.options = options;
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
  }

  async init(): Promise<LibraryEngine> {
    const factory = this.options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) throw new Error('当前环境不支持 IndexedDB，无法初始化引擎');
    this.db = await openDatabase(factory, this.dbName);

    if (this.options.opfs === null) {
      this.opfs = null;
    } else if (this.options.opfs !== undefined) {
      this.opfs = this.options.opfs;
    } else {
      this.opfs = await createAutoOpfsAdapter();
    }

    const now = this.options.now ?? (() => new Date());
    const uuid = this.options.randomUUID ?? defaultUuid;
    this.nowFn = now;
    this.uuidFn = uuid;
    const maxEvents = this.options.autoSnapshot?.maxEvents ?? 300;
    const maxIntervalMs = this.options.autoSnapshot?.maxIntervalMs ?? 120_000;
    this.core = {
      db: this.db,
      opfs: this.opfs,
      now,
      uuid,
      autoSnapshot: { maxEvents, maxIntervalMs },
      writeMirror: (docId, text) => this.writeMirror(docId, text),
      onClosed: (docId) => {
        this.openHandles.delete(docId);
        this.heldLocks.delete(docId);
      },
      // 任何快照落盘后调度一次自动备份（防抖 + 最小间隔，见 auto-backup.ts）
      onSnapshot: () => this.handleSnapshotForAutoBackup(),
    };

    this.backupServiceInternal = createBackupService(
      {
        db: this.db,
        now,
        listDocRecords: () => listDocRecords(this.db),
        readDocEvents: (docId) => readDocEvents(this.db, docId),
        flushAll: () => this.flush(),
      },
      this.options.fileSystemAccess !== false,
    );

    this.initAutoBackup();

    if (this.options.requestPersistence !== false) {
      await this.requestPersistence();
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // 自动备份（快照后防抖调度真实 .wtlog 文件）
  // -------------------------------------------------------------------------

  private initAutoBackup(): void {
    const autoBackup = this.options.autoBackup ?? {};
    this.autoBackupEnabled = autoBackup.enabled !== false;
    const debounceMs = normalizeDuration(autoBackup.debounceMs, DEFAULT_AUTO_BACKUP_DEBOUNCE_MS);
    const minIntervalMs = normalizeDuration(
      autoBackup.minIntervalMs,
      DEFAULT_AUTO_BACKUP_MIN_INTERVAL_MS,
    );
    this.autoBackupScheduler = createAutoBackupScheduler(
      { enabled: this.autoBackupEnabled, debounceMs, minIntervalMs },
      {
        isConfigured: async () => {
          try {
            const status = await this.backupServiceInternal.status();
            // 权限被撤销/浏览器重启后（needsPermission）暂停自动备份，等用户重新授权
            return status.configured && !status.needsPermission;
          } catch {
            return false;
          }
        },
        backupNow: () => this.backupServiceInternal.backupNow(),
        now: () => Date.now(),
      },
    );

    // 对外备份服务包装：保持 BackupStatus 语义不变，仅附加手动备份计时与配置后调度。
    this.backupService = {
      status: () => this.backupServiceInternal.status(),
      chooseDirectory: async () => {
        const status = await this.backupServiceInternal.chooseDirectory();
        this.backupConfigured = status.configured;
        if (status.configured && !status.needsPermission) this.autoBackupScheduler.schedule();
        return status;
      },
      requestPermission: async () => {
        const status = await this.backupServiceInternal.requestPermission();
        this.backupConfigured = status.configured;
        // 重新授权成功：立刻调度一次自动备份，把离线期间的快照补写到目录
        if (status.configured && status.permission === 'granted' && !status.needsPermission) {
          this.autoBackupScheduler.schedule();
        }
        return status;
      },
      backupNow: async () => {
        this.autoBackupScheduler.noteBackupStarted();
        const status = await this.backupServiceInternal.backupNow();
        this.backupConfigured = status.configured;
        return status;
      },
      disable: async () => {
        this.autoBackupScheduler.cancel();
        this.backupConfigured = false;
        await this.backupServiceInternal.disable();
      },
    };

    // 启动补齐：已配置且权限可用时调度一次（应用重启后把离线期间的快照补写到目录）。
    // 注意只"提升" backupConfigured，不把已配置状态改回 false（避免与 init 后立即 chooseDirectory 的竞态）。
    void (async () => {
      try {
        const status = await this.backupServiceInternal.status();
        if (!status.configured) return;
        this.backupConfigured = true;
        if (!status.needsPermission) this.autoBackupScheduler.schedule();
      } catch {
        // 启动补齐失败静默
      }
    })();
  }

  /** 快照成功后的自动备份入口：未启用/未配置目录时不产生任何定时器与错误。 */
  private handleSnapshotForAutoBackup(): void {
    if (!this.autoBackupEnabled || !this.backupConfigured) return;
    this.autoBackupScheduler.schedule();
  }

  // -------------------------------------------------------------------------
  // OPFS 镜像
  // -------------------------------------------------------------------------

  /** 串行化镜像写入：保证先发起的写入不会后完成（避免旧内容覆盖新内容）。 */
  private mirrorQueue: Promise<void> = Promise.resolve();

  private writeMirror(docId: string, text: string): Promise<void> {
    const opfs = this.opfs;
    if (!opfs?.available) return Promise.resolve();
    const task = this.mirrorQueue.then(() => opfs.write(mirrorPath(docId), text));
    this.mirrorQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async readMirror(docId: string): Promise<string | null> {
    const opfs = this.opfs;
    if (!opfs?.available) return null;
    try {
      return await opfs.read(mirrorPath(docId));
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Web Locks
  // -------------------------------------------------------------------------

  private getLockManager(): LockManager | null {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    return nav?.locks ?? null;
  }

  private async acquireDocLock(docId: string): Promise<DocLockInfo> {
    const locks = this.getLockManager();
    if (!locks) return { acquired: true, release: () => undefined, held: false };
    let markReady: (acquired: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
      markReady = resolve;
    });
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const request = locks.request(lockName(docId), { mode: 'exclusive', ifAvailable: true }, (lock) => {
      markReady(lock !== null);
      if (!lock) return Promise.resolve();
      return hold;
    });
    request.catch(() => markReady(false));
    const acquired = await ready;
    if (!acquired) return { acquired: false, release: () => undefined, held: false };
    return { acquired: true, held: true, release: () => releaseHold() };
  }

  private async queryExternallyLockedDocIds(): Promise<Set<string>> {
    const result = new Set<string>();
    const locks = this.getLockManager();
    if (!locks) return result;
    try {
      const state = await locks.query();
      for (const held of state.held ?? []) {
        const name = held.name;
        if (typeof name !== 'string' || !name.startsWith(LOCK_PREFIX)) continue;
        const docId = name.slice(LOCK_PREFIX.length);
        if (!this.heldLocks.has(docId) && !this.pendingOpens.has(docId) && !this.openHandles.has(docId)) {
          result.add(docId);
        }
      }
    } catch {
      // 查询失败按未锁定处理
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 作品列表 / 打开 / 创建
  // -------------------------------------------------------------------------

  async listDocs(options?: { includeTrashed?: boolean }): Promise<DocSummary[]> {
    const records = await listDocRecords(this.db);
    const externallyLocked = await queryExternalLocksSafely(this.queryExternallyLockedDocIds.bind(this));
    const includeTrashed = options?.includeTrashed === true;
    const summaries: DocSummary[] = [];
    for (const record of records) {
      if (!includeTrashed && record.trashed) continue;
      summaries.push({
        docId: record.docId,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        chars: record.chars,
        eventCount: record.eventCount,
        snapshotCount: record.snapshotCount,
        trashed: record.trashed,
        integrity: this.integrityCache.get(record.docId) ?? record.integrity ?? 'unknown',
        readonly: externallyLocked.has(record.docId),
      });
    }
    return summaries;
  }

  async createDoc(title?: string): Promise<DocHandle> {
    const docTitle = typeof title === 'string' ? title : '';
    // 防止注入的 ID 生成器返回重复值而覆盖已有作品（真实环境 crypto.randomUUID 不会重复）
    let docId = this.uuidFn();
    for (let attempt = 0; ; attempt += 1) {
      const existingRecord = await readDocRecord(this.db, docId);
      const existingEvents = existingRecord ? 0 : await countDocEvents(this.db, docId);
      if (!existingRecord && existingEvents === 0) break;
      if (attempt >= 4) throw new Error(`无法生成唯一的 docId（${docId}），请检查 randomUUID 注入`);
      docId = this.uuidFn();
    }
    const ts = isoNow(this.nowFn);
    const header = await createHeaderEvent({
      docId,
      title: docTitle,
      createdAt: ts,
      ts,
      id: this.uuidFn(),
      device: detectDeviceInfo(),
    });
    const record: DocRecord = {
      docId,
      title: docTitle,
      createdAt: ts,
      updatedAt: ts,
      chars: 0,
      eventCount: 1,
      snapshotCount: 0,
      trashed: false,
      lastSeq: 0,
      lastHash: header.hash,
      integrity: 'ok',
    };
    await writeDocSnapshot(this.db, record, [header]);
    this.integrityCache.set(docId, 'ok');
    void this.writeMirror(docId, serializeEvents([header])).catch(() => undefined);
    return this.openDoc(docId);
  }

  async openDoc(docId: string): Promise<DocHandle> {
    const existing = this.openHandles.get(docId);
    if (existing) return existing;
    const pending = this.pendingOpens.get(docId);
    if (pending) return pending;
    const task = this.openDocInternal(docId).finally(() => {
      this.pendingOpens.delete(docId);
    });
    this.pendingOpens.set(docId, task);
    return task;
  }

  private async openDocInternal(docId: string): Promise<DocHandleImpl> {
    const lock = await this.acquireDocLock(docId);
    try {
      const handle = await DocHandleImpl.open(this.core, docId, lock);
      if (lock.held) this.heldLocks.add(docId);
      this.openHandles.set(docId, handle);
      this.integrityCache.set(docId, handle.integrity);
      return handle;
    } catch (error) {
      if (lock.held) lock.release();
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // 导入
  // -------------------------------------------------------------------------

  async importFile(file: Blob, fileName?: string): Promise<DocSummary> {
    const label = fileName ? `（${fileName}）` : '';
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      throw new Error(`导入失败${label}：无法读取文件内容（${describeError(error)}）`);
    }
    if (text.trim().length === 0) throw new Error(`导入失败${label}：文件为空`);
    const source = parseLogText(text);
    const result = await verifyLog(source);
    if (!result.headerOk || !result.docId) {
      throw new Error(`导入失败${label}：文件缺少合法的 doc.init header`);
    }
    if (!result.ok) {
      if (result.unknownTextEventSeqs.length > 0) {
        throw new Error(
          `导入失败${label}：文件包含当前版本无法安全重放的文本事件（seq=${result.unknownTextEventSeqs.join(',')}），请升级应用`,
        );
      }
      throw new Error(
        `导入失败${label}：日志校验失败（${result.brokenReason ?? '数据损坏'}），未写入任何数据`,
      );
    }
    const docId = result.docId;
    const existingRecord = await readDocRecord(this.db, docId);
    const existingEventCount = await countDocEvents(this.db, docId);
    if (existingRecord || existingEventCount > 0) {
      throw new Error(`导入失败${label}：作品已存在（docId=${docId}），不会覆盖现有数据`);
    }
    const events = result.events;
    const record = recordFromVerify(docId, result);
    await writeDocSnapshot(this.db, record, events);
    this.integrityCache.set(docId, 'ok');
    void this.writeMirror(docId, serializeEvents(events)).catch(() => undefined);
    return {
      docId,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      chars: record.chars,
      eventCount: record.eventCount,
      snapshotCount: record.snapshotCount,
      trashed: record.trashed,
      integrity: 'ok',
      readonly: false,
    };
  }

  // -------------------------------------------------------------------------
  // 回收站（软删除）
  // -------------------------------------------------------------------------

  async trashDoc(docId: string): Promise<void> {
    await this.appendDocMeta(docId, 'doc.trash', {});
  }

  async restoreDoc(docId: string): Promise<void> {
    await this.appendDocMeta(docId, 'doc.untrash', {});
  }

  private async appendDocMeta(
    docId: string,
    type: 'doc.trash' | 'doc.untrash',
    data: Record<string, unknown>,
  ): Promise<void> {
    const pending = this.pendingOpens.get(docId);
    if (pending) await pending.catch(() => undefined);
    const handle = this.openHandles.get(docId);
    if (handle) {
      await handle.appendEngineMeta(type, data);
      return;
    }
    const record = await readDocRecord(this.db, docId);
    if (!record) throw new Error(`作品不存在：${docId}`);
    if (record.integrity === 'broken' || this.integrityCache.get(docId) === 'broken') {
      throw new Error(`作品日志已损坏，只能只读查看：${docId}`);
    }
    const lock = await this.acquireDocLock(docId);
    if (!lock.acquired) throw new Error('作品正被其它标签页或窗口打开，无法修改');
    try {
      const events = await readDocEvents(this.db, docId);
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      const event = await createEvent({
        seq: lastEvent ? lastEvent.seq + 1 : 0,
        prev: lastEvent ? lastEvent.hash : '',
        type,
        affects: 'meta',
        data,
        id: this.uuidFn(),
        ts: isoNow(this.nowFn),
      });
      const eventsNext = [...events, event];
      const nextRecord: DocRecord = {
        ...record,
        updatedAt: event.ts,
        eventCount: eventsNext.length,
        snapshotCount: countSnapshots(eventsNext),
        lastSeq: event.seq,
        lastHash: event.hash,
        trashed: type === 'doc.trash',
        integrity: 'ok',
      };
      await writeDocSnapshot(this.db, nextRecord, [event]);
      this.integrityCache.set(docId, 'ok');
      void this.writeMirror(docId, serializeEvents(eventsNext)).catch(() => undefined);
    } finally {
      if (lock.held) lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  async verifyAll(): Promise<VerifyReport[]> {
    const records = await listDocRecords(this.db);
    const reports: VerifyReport[] = [];
    for (const record of records) {
      const events = await readDocEvents(this.db, record.docId);
      const result = await verifyLog(logSourceFromEvents(events));
      this.integrityCache.set(record.docId, result.ok ? 'ok' : 'broken');
      reports.push({
        docId: record.docId,
        title: record.title,
        ok: result.ok,
        eventCount: result.events.length,
        source: 'idb',
        chainOk: result.chainOk,
        seqOk: result.seqOk,
        brokenAt: result.brokenAt,
        brokenReason: result.brokenReason,
        unknownTextEventSeqs: result.unknownTextEventSeqs,
        snapshotMismatchSeqs: result.snapshotMismatchSeqs,
        repaired: false,
        warnings: result.warnings,
      });
    }
    return reports;
  }

  // -------------------------------------------------------------------------
  // 存储状态
  // -------------------------------------------------------------------------

  private async requestPersistence(): Promise<void> {
    if (this.persistRequested) return;
    this.persistRequested = true;
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const storage = nav?.storage;
    if (!storage || typeof storage.persist !== 'function') return;
    try {
      await storage.persist();
    } catch {
      // 不支持持久化请求时忽略
    }
  }

  async storageStatus(): Promise<StorageStatus> {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const storage = nav?.storage;
    let persistent: boolean | null = null;
    let usage: number | null = null;
    let quota: number | null = null;
    if (storage) {
      if (this.options.requestPersistence !== false) await this.requestPersistence();
      try {
        if (typeof storage.persisted === 'function') persistent = await storage.persisted();
      } catch {
        persistent = null;
      }
      try {
        if (typeof storage.estimate === 'function') {
          const estimate = await storage.estimate();
          usage = typeof estimate.usage === 'number' ? estimate.usage : null;
          quota = typeof estimate.quota === 'number' ? estimate.quota : null;
        }
      } catch {
        usage = null;
        quota = null;
      }
    }
    const backupStatus = await this.backupService.status();
    return {
      persistent,
      usage,
      quota,
      opfs: this.opfs?.available === true,
      backupConfigured: backupStatus.configured,
    };
  }

  backup(): BackupService {
    return this.backupService;
  }

  // -------------------------------------------------------------------------
  // 全量备份包（.wtzip，§9.1）
  // -------------------------------------------------------------------------

  /** 导出全部作品（含回收站）为 `.wtzip`：先 flush 所有未落盘写入，再读主存储打包。 */
  async exportArchive(): Promise<Blob> {
    await this.flush();
    return exportArchiveFromStorage({
      listDocRecords: () => listDocRecords(this.db),
      listDocIdsWithEvents: () => listEventDocIds(this.db),
      readDocEvents: (docId) => readDocEvents(this.db, docId),
      now: () => this.nowFn(),
    });
  }

  /** 从 `.wtzip` 恢复/合并；ZIP/manifest 信封非法抛错，单作品失败只记入报告。 */
  async importArchive(file: Blob, fileName?: string): Promise<ArchiveImportReport> {
    await this.flush();
    return importArchiveFromFile(
      {
        readDocRecord: (docId) => readDocRecord(this.db, docId),
        readDocEvents: (docId) => readDocEvents(this.db, docId),
        writeDocSnapshot: (record, events) => writeDocSnapshot(this.db, record, events),
        writeMirror: (docId, text) => this.writeMirror(docId, text),
        queryExternallyLockedDocIds: () => this.queryExternallyLockedDocIds(),
        isDocOpen: (docId) => this.openHandles.has(docId),
        setIntegrity: (docId, integrity) => this.integrityCache.set(docId, integrity),
      },
      file,
      fileName,
    );
  }

  /**
   * 从已配置的备份目录一键恢复：读取目录里的 manifest + 全部 .wtlog，
   * 在内存打包为 `.wtzip` 后复用 `importArchive()`（校验/前缀合并/冲突/锁语义完全一致）。
   * 未配置目录或目录不可读/缺 manifest/无日志时抛出中文可读错误。
   */
  async restoreFromBackupDirectory(): Promise<ArchiveImportReport> {
    await this.flush();
    const snapshot = await this.backupServiceInternal.readDirectoryTexts();
    if (!snapshot) {
      throw new Error('未配置备份目录或备份目录不可读，请先在设置中选择并授权备份目录');
    }
    if (snapshot.manifestText === null) {
      throw new Error('备份目录缺少 writertools-manifest.json，无法恢复（请先执行一次备份）');
    }
    if (Object.keys(snapshot.files).length === 0) {
      throw new Error('备份目录中没有可恢复的作品日志（.wtlog），无法恢复');
    }
    const blob = createArchiveBlobFromTexts(snapshot.manifestText, snapshot.files);
    const report = await this.importArchive(blob, 'backup-directory');
    if (snapshot.warnings.length > 0) report.warnings.unshift(...snapshot.warnings);
    return report;
  }

  // -------------------------------------------------------------------------
  // 副本恢复
  // -------------------------------------------------------------------------

  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { scannedCopies: 0, recoveredDocs: 0, conflicts: [], warnings: [] };
    const opfs = this.opfs;
    if (!opfs?.available) {
      report.warnings.push('OPFS 镜像不可用，未扫描镜像副本');
      return report;
    }
    let files: string[] = [];
    try {
      files = await opfs.list(MIRROR_DIR);
    } catch {
      files = [];
    }
    const healthyMirrorIds = new Set<string>();
    const conflictedDocIds = new Set<string>();
    /** 镜像里通过校验的事件数（含损坏镜像的有效前缀）；未扫描到镜像则无记录。 */
    const mirrorEventCounts = new Map<string, number>();
    // 自动恢复不得与被其它标签页持有的作品并发写：跳过外部 Web Lock 锁定的作品
    const externallyLocked = await this.queryExternallyLockedDocIds();
    const lockedWarned = new Set<string>();
    const skipExternallyLocked = (docId: string): boolean => {
      if (!externallyLocked.has(docId)) return false;
      if (!lockedWarned.has(docId)) {
        lockedWarned.add(docId);
        report.warnings.push(
          `作品 ${docId} 正被其它标签页/窗口写入（Web Lock），已跳过自动恢复以避免并发冲突`,
        );
      }
      return true;
    };
    for (const file of files) {
      const docId = docIdFromMirrorFile(file);
      if (!docId) continue;
      report.scannedCopies += 1;
      if (skipExternallyLocked(docId)) continue;
      const text = await this.readMirror(docId);
      if (text === null || text.trim().length === 0) {
        report.warnings.push(`镜像副本为空或不可读：${file}`);
        continue;
      }
      const result = await verifyLog(parseLogText(text));
      if (!result.headerOk || !result.docId) {
        report.warnings.push(`镜像副本缺少合法 header，已跳过：${file}`);
        continue;
      }
      if (result.docId !== docId) {
        report.conflicts.push(`镜像文件名与 header.docId 不一致（文件名 ${docId}，header ${result.docId}），已跳过`);
        conflictedDocIds.add(docId);
        continue;
      }
      if (result.ok) healthyMirrorIds.add(docId);
      const mirrorEvents = result.events;
      mirrorEventCounts.set(docId, mirrorEvents.length);
      const idbRecord = await readDocRecord(this.db, docId);
      const idbEvents = await readDocEvents(this.db, docId);

      // 1) 主存储完全没有该作品的事件
      if (idbEvents.length === 0) {
        if (!idbRecord) {
          const record = recordFromVerify(docId, result);
          await writeDocSnapshot(this.db, record, mirrorEvents);
          this.integrityCache.set(docId, result.ok ? 'ok' : 'broken');
          report.recoveredDocs += 1;
          if (!result.ok) {
            report.warnings.push(`从镜像恢复 ${docId} 的最长有效前缀（镜像损坏：${result.brokenReason ?? '未知原因'}）`);
          }
          continue;
        }
        // 摘要存在但事件丢失：要求镜像链尾与摘要锚点一致才补写，避免误覆盖
        const anchor = mirrorEvents.find((event) => event.seq === idbRecord.lastSeq);
        const anchorMatches = idbRecord.lastSeq === 0 ? true : anchor !== undefined && anchor.hash === idbRecord.lastHash;
        if (!anchorMatches && idbRecord.lastSeq > 0) {
          report.conflicts.push(`作品 ${docId} 的 IDB 摘要锚点与 OPFS 副本不一致，未自动补写`);
          continue;
        }
        const record: DocRecord = {
          ...recordFromVerify(docId, result),
          createdAt: idbRecord.createdAt,
        };
        await writeDocSnapshot(this.db, record, mirrorEvents);
        this.integrityCache.set(docId, result.ok ? 'ok' : 'broken');
        report.recoveredDocs += 1;
        report.warnings.push(`作品 ${docId} 的 IDB 事件缺失，已从镜像补写 ${mirrorEvents.length} 条事件`);
        continue;
      }

      // 2) 两边都有事件：比较最长公共前缀（hash 与载荷都要一致）
      const common = Math.min(idbEvents.length, mirrorEvents.length);
      let prefixMatches = true;
      for (let index = 0; index < common; index += 1) {
        if (!sameCopyEvent(idbEvents[index], mirrorEvents[index])) {
          prefixMatches = false;
          break;
        }
      }
      if (!prefixMatches) {
        conflictedDocIds.add(docId);
        report.conflicts.push(
          `作品 ${docId} 的 IDB 与 OPFS 副本在相同 seq 处哈希分歧；未覆盖任何一份，请人工确认（规范 8.4）`,
        );
        continue;
      }
      if (mirrorEvents.length > idbEvents.length) {
        const missing = mirrorEvents.slice(idbEvents.length);
        const baseRecord = idbRecord ?? recordFromVerify(docId, result);
        const merged: DocRecord = {
          ...baseRecord,
          title: result.title,
          updatedAt: mirrorEvents[mirrorEvents.length - 1].ts,
          eventCount: mirrorEvents.length,
          snapshotCount: countSnapshots(mirrorEvents),
          trashed: result.trashed,
          lastSeq: mirrorEvents[mirrorEvents.length - 1].seq,
          lastHash: mirrorEvents[mirrorEvents.length - 1].hash,
          chars: result.text.length,
          integrity: result.ok ? 'ok' : 'broken',
        };
        await writeDocSnapshot(this.db, merged, missing);
        this.integrityCache.set(docId, result.ok ? 'ok' : 'broken');
        report.recoveredDocs += 1;
        if (!result.ok) {
          report.warnings.push(`镜像副本损坏，只补写了 ${mirrorEvents.length} 条有效事件（${result.brokenReason ?? '未知原因'}）`);
        }
      }
    }

    // 3) IDB 有作品但镜像缺失/损坏/较短：用主存储补写镜像（不覆盖有分歧的副本）
    try {
      const records = await listDocRecords(this.db);
      for (const record of records) {
        if (conflictedDocIds.has(record.docId)) continue;
        if (skipExternallyLocked(record.docId)) continue;
        const events = await readDocEvents(this.db, record.docId);
        if (events.length === 0) continue;
        const mirroredCount = mirrorEventCounts.get(record.docId);
        // 健康的镜像且不短于主存储：无需补写
        if (healthyMirrorIds.has(record.docId) && mirroredCount !== undefined && mirroredCount >= events.length) {
          continue;
        }
        // 只有主存储本身校验通过时才用它覆盖/补写镜像，避免把损坏的主存储写进冗余副本
        const idbVerify = await verifyLog(logSourceFromEvents(events));
        if (!idbVerify.ok) {
          report.warnings.push(`作品 ${record.docId} 的主存储校验失败，未用其重写 OPFS 镜像`);
          continue;
        }
        try {
          await this.writeMirror(record.docId, serializeEvents(events));
        } catch (error) {
          report.warnings.push(`无法为 ${record.docId} 补写镜像：${describeError(error)}`);
        }
      }
    } catch {
      // 忽略
    }
    return report;
  }

  // -------------------------------------------------------------------------
  // flush
  // -------------------------------------------------------------------------

  async flush(): Promise<void> {
    const pending = Array.from(this.pendingOpens.values());
    if (pending.length > 0) await Promise.allSettled(pending);
    const handles = Array.from(this.openHandles.values());
    await Promise.all(
      handles.map(async (handle) => {
        try {
          await handle.flush();
        } catch {
          // 单个作品 flush 失败不影响其它作品
        }
      }),
    );
  }
}

async function queryExternalLocksSafely(fn: () => Promise<Set<string>>): Promise<Set<string>> {
  try {
    return await fn();
  } catch {
    return new Set<string>();
  }
}

/** 创建引擎（契约 EngineFactory）。 */
export const createEngine: EngineFactory = async (options?: EngineOptions): Promise<LibraryEngine> => {
  const engine = new LibraryEngineImpl(options ?? {});
  return engine.init();
};

/** 供测试/诊断使用：默认库名与格式版本。 */
export const ENGINE_DEFAULTS = {
  dbName: DEFAULT_DB_NAME,
  formatVersion: FORMAT_VERSION,
} as const;
