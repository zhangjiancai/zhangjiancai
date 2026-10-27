/**
 * WriterTools 引擎公共契约（冻结面）
 * =====================================
 * 这是 UI 与引擎之间唯一的接口文件，由 Lead 维护；除 Lead 外不要修改本文件。
 * 引擎实现（src/engine/index.ts 等）必须满足这里的签名；UI 只允许从 '../engine' 导入。
 *
 * 设计约束：
 * - 引擎是纯 TypeScript，不依赖 React、不依赖任何 UI 代码；可以使用浏览器 API
 *   （IndexedDB / OPFS / WebCrypto / File System Access），并对不支持的环境做降级。
 * - 数据安全优先：所有写入必须经过追加式日志，任何路径都不得改写/删除已有历史行。
 * - 记录粒度：每一次文本编辑（含删除的内容与位置）、每一次输入法组合变化都实时落盘。
 * - 文件格式见 docs/FILE-FORMAT.md（v1.0），实现必须严格遵守。
 */

export const FORMAT_MAJOR = 1;
export const FORMAT_MINOR = 0;
export const FORMAT_VERSION = `${FORMAT_MAJOR}.${FORMAT_MINOR}`;
export const LOG_FILE_EXTENSION = '.wtlog';
export const LOG_FILE_MIME = 'application/x-writertools-log';
export const BACKUP_MANIFEST_NAME = 'writertools-manifest.json';
/** 全量备份包（ZIP 容器，内含 manifest + 每作品 .wtlog）的扩展名与 MIME。规范见 FILE-FORMAT.md 9.1。 */
export const ARCHIVE_FILE_EXTENSION = '.wtzip';
export const ARCHIVE_FILE_MIME = 'application/zip';
export const ARCHIVE_MANIFEST_NAME = 'writertools-manifest.json';

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

/** 排版模式。typewriter=打字机（行右端对齐、向左生长）；centered=居中（常规排版、光标固定在屏幕中间）。 */
export type EditorMode = 'typewriter' | 'centered';

/** 文本变化来源。未知值一律降级为 'unknown'。 */
export type EditSource =
  | 'typing'
  | 'ime'
  | 'paste'
  | 'cut'
  | 'drop'
  | 'undo'
  | 'redo'
  | 'programmatic'
  | 'restore'
  | 'recovery'
  | 'unknown';

export type Direction = 'forward' | 'backward' | 'none';
export type DeleteDirection = 'forward' | 'backward';

export type SnapshotReason = 'manual' | 'auto' | 'session' | 'restore' | 'import';

export type SelectionReason = 'caret' | 'click' | 'key' | 'edit' | 'focus' | 'programmatic';

/** 光标/选区。坐标见 docs/FILE-FORMAT.md 5.1（UTF-16 码元偏移）。 */
export interface SelectionState {
  from: number;
  to: number;
  direction?: Direction;
}

/**
 * UI 交给引擎的一次文本编辑"意图"。
 * 引擎会再次校验 pos/deleted 是否与当前正文一致；不一致时抛 EditConflictError，
 * UI 必须用错误里的 currentText 重新同步 textarea（不能强写）。
 */
export type TextEdit =
  | {
      kind: 'insert';
      pos: number;
      text: string;
      source?: EditSource;
      inputType?: string;
    }
  | {
      kind: 'delete';
      pos: number;
      length: number;
      deleted: string;
      source?: EditSource;
      inputType?: string;
      direction?: DeleteDirection;
    }
  | {
      kind: 'replace';
      pos: number;
      length: number;
      deleted: string;
      text: string;
      source?: EditSource;
      inputType?: string;
    }
  | {
      kind: 'reset';
      text: string;
      source?: EditSource;
      reason?: 'restore' | 'import' | 'recovery';
    };

/** 相对上一版文本的差异（由 deriveEdit 计算，供 UI 记录器使用）。 */
export interface DerivedEdit {
  kind: 'insert' | 'delete' | 'replace';
  /** 变化起点（UTF-16 偏移） */
  pos: number;
  /** 被删除的长度 */
  length: number;
  /** 被删除的原文 */
  deleted: string;
  /** 新插入的文本 */
  text: string;
}

/** 输入法组合事件（原样记录浏览器 CompositionEvent 过程）。 */
export type ComposeEvent =
  | { phase: 'start'; data: string; from: number; to: number }
  | { phase: 'update'; data: string; from: number; to: number; candidate?: number }
  | { phase: 'end'; data?: string; committed?: string };

/**
 * 「原始输入回放/查看」条目：把日志里与输入过程相关的事件归一化成一条时间线。
 * - compose：输入法组合过程（原始预编辑串，如拼音）
 * - text：正文编辑（含 IME 上屏、删除、粘贴等）
 * - session / mode：写作场次与排版模式边界，便于在时间线上分组
 */
export type InputTraceEntry =
  | {
      kind: 'compose';
      seq: number;
      ts: string;
      phase: 'start' | 'update' | 'end';
      data: string;
      from?: number;
      to?: number;
      committed?: string;
      candidate?: number;
    }
  | {
      kind: 'text';
      seq: number;
      ts: string;
      op: 'insert' | 'delete' | 'replace' | 'reset';
      pos?: number;
      length?: number;
      text?: string;
      deleted?: string;
      source?: string;
      inputType?: string;
    }
  | {
      kind: 'session';
      seq: number;
      ts: string;
      phase: 'start' | 'end';
      sessionId?: string;
    }
  | {
      kind: 'mode';
      seq: number;
      ts: string;
      mode: EditorMode;
    };

export interface EditContext {
  selectionBefore?: SelectionState;
  selectionAfter?: SelectionState;
  /** DOM InputEvent.inputType，原样保存 */
  inputType?: string;
}

// ---------------------------------------------------------------------------
// 查询/报告类型
// ---------------------------------------------------------------------------

export type IntegrityState = 'ok' | 'broken' | 'unknown';

export interface DocSummary {
  docId: string;
  title: string;
  /** ISO UTC */
  createdAt: string;
  /** ISO UTC */
  updatedAt: string;
  /** 当前正文 UTF-16 长度 */
  chars: number;
  eventCount: number;
  snapshotCount: number;
  trashed: boolean;
  integrity: IntegrityState;
  /** 若该作品正被其它标签页/窗口锁定，则为 true（本标签页只读） */
  readonly: boolean;
}

export interface SnapshotInfo {
  seq: number;
  /** ISO UTC */
  ts: string;
  message: string;
  reason: SnapshotReason;
  chars: number;
  eventCount: number;
}

export interface VerifyReport {
  docId: string;
  title: string;
  ok: boolean;
  eventCount: number;
  /** 校验所依据的副本 */
  source: 'idb' | 'opfs' | 'merged';
  chainOk: boolean;
  seqOk: boolean;
  brokenAt: number | null;
  brokenReason?: string;
  unknownTextEventSeqs: number[];
  snapshotMismatchSeqs: number[];
  /** 是否用冗余副本修复过主存储 */
  repaired: boolean;
  warnings: string[];
}

export interface StorageStatus {
  /** null = 浏览器不支持/未知 */
  persistent: boolean | null;
  usage: number | null;
  quota: number | null;
  /** OPFS 镜像是否可用 */
  opfs: boolean;
  backupConfigured: boolean;
}

/** 备份目录的读写权限（浏览器支持 queryPermission 时）。 */
export type BackupPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/** 备份目录后端：浏览器 File System Access / 原生（Android SAF）/ 不可用。 */
export type BackupBackend = 'fsa' | 'native' | 'none';

export interface BackupStatus {
  configured: boolean;
  directoryName?: string;
  lastBackupAt?: string;
  lastError?: string;
  docCount?: number;
  /** 当前备份目录权限；浏览器/目录句柄不支持时为 'unknown'。 */
  permission?: BackupPermission;
  /** configured 为 true 但权限不是 granted（需要用户在设置里点「重新授权」）。 */
  needsPermission?: boolean;
  /** 当前生效的备份目录后端。 */
  backend?: BackupBackend;
}

export interface RecoveryReport {
  scannedCopies: number;
  recoveredDocs: number;
  conflicts: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 全量备份包（.wtzip）
// ---------------------------------------------------------------------------

/** 备份包导入时单个作品的处理结果。 */
export type ArchiveAction = 'imported' | 'merged' | 'skipped' | 'conflict' | 'failed';

export interface ArchiveDocResult {
  docId: string;
  title: string;
  action: ArchiveAction;
  /** 本次实际新增的事件数（imported = 全部，merged = 缺失部分，其余为 0） */
  eventsAdded: number;
  message?: string;
}

export interface ArchiveImportReport {
  docs: ArchiveDocResult[];
  imported: number;
  merged: number;
  skipped: number;
  conflicts: number;
  failed: number;
  warnings: string[];
}

/** 备份包概要（用于 UI 展示，不包含事件内容）。 */
export interface ArchiveInfo {
  docCount: number;
  bytes: number;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// 事件回调
// ---------------------------------------------------------------------------

export type DocChange =
  | { kind: 'text'; text: string; selection?: SelectionState }
  | { kind: 'title'; title: string }
  | { kind: 'saved'; snapshot: SnapshotInfo }
  | { kind: 'meta' }
  | { kind: 'error'; error: Error };

// ---------------------------------------------------------------------------
// 备份服务
// ---------------------------------------------------------------------------

/** 备份目录服务（File System Access API；不支持的环境 configured 恒为 false）。 */
export interface BackupService {
  status(): Promise<BackupStatus>;
  /** 必须在用户手势（点击）中调用；返回当前状态。取消选择不算错误。 */
  chooseDirectory(): Promise<BackupStatus>;
  /**
   * 对已配置的备份目录重新请求读写权限（浏览器重启/权限被撤销后使用）。
   * 必须在用户手势（点击）中调用；不支持的浏览器返回当前状态。授权成功后会调度一次自动备份。
   */
  requestPermission(): Promise<BackupStatus>;
  /** 立即把所有作品 + manifest 写入备份目录 */
  backupNow(): Promise<BackupStatus>;
  /** 停止自动备份并移除目录句柄（备份文件本身不动） */
  disable(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 作品句柄
// ---------------------------------------------------------------------------

export interface DocHandle {
  readonly docId: string;
  readonly title: string;
  /** 当前派生正文（引擎为唯一真源） */
  readonly text: string;
  readonly readonly: boolean;
  /** ISO UTC */
  readonly updatedAt: string;
  readonly eventCount: number;

  /** 订阅变更。返回取消订阅函数。 */
  on(listener: (change: DocChange) => void): () => void;

  /**
   * 追加一次文本编辑并等待落盘（主存储写入完成即可返回；镜像异步）。
   * 引擎必须校验编辑合法性；冲突抛 EditConflictError。
   */
  appendEdit(edit: TextEdit, context?: EditContext): Promise<void>;

  /** 记录输入法原始过程（不影响正文）。 */
  appendCompose(event: ComposeEvent): Promise<void>;

  /**
   * 读取「原始输入回放/查看」时间线：输入法组合过程（compose.*）、正文编辑（text.*）、
   * 场次与排版模式边界，按 seq 升序返回。只读，不写日志。
   * 默认最多返回最近 2000 条；`limit: 0` 或负数表示不限制。
   */
  getInputTrace(options?: { limit?: number }): Promise<InputTraceEntry[]>;

  /** 记录选区（UI 负责节流/去重）。 */
  setSelection(selection: SelectionState, reason?: SelectionReason): Promise<void>;

  /** 记录排版模式变化（同时写入 editor.mode 事件）。 */
  setMode(mode: EditorMode): Promise<void>;

  /** 修改标题（写 doc.title 事件）。 */
  setTitle(title: string): Promise<void>;

  /** 立即生成一个快照（版本节点），返回快照信息。 */
  snapshot(message?: string, reason?: SnapshotReason): Promise<SnapshotInfo>;

  /** 所有快照（按 seq 升序）。 */
  history(): Promise<SnapshotInfo[]>;

  /** 预览某快照的完整正文。 */
  previewSnapshot(seq: number): Promise<string>;

  /** 恢复到某快照：追加 text.reset + snapshot 事件（历史不丢），返回新快照。 */
  restore(seq: number, message?: string): Promise<SnapshotInfo>;

  /** 完整校验（哈希链 + 文本重放 + 快照一致性）。 */
  verify(): Promise<VerifyReport>;

  /** 导出完整日志文件（.wtlog Blob，内容为追加式日志原文）。 */
  exportLog(): Promise<Blob>;

  /** 导出纯文本（.txt Blob）。 */
  exportText(): Promise<Blob>;

  /** 等待所有排队写入落盘（关闭页面/切后台前调用）。 */
  flush(): Promise<void>;

  /** 关闭句柄（释放锁；不丢失未落盘数据，内部先 flush）。 */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 书架引擎
// ---------------------------------------------------------------------------

export interface LibraryEngine {
  listDocs(options?: { includeTrashed?: boolean }): Promise<DocSummary[]>;

  createDoc(title?: string): Promise<DocHandle>;

  /** 打开已有作品；若被其它标签页锁定，返回 readonly 句柄。 */
  openDoc(docId: string): Promise<DocHandle>;

  /** 从 .wtlog 文件导入；docId 冲突时不覆盖（抛出错误）。 */
  importFile(file: Blob, fileName?: string): Promise<DocSummary>;

  /** 移入回收站（软删除，保留全部日志与文件）。 */
  trashDoc(docId: string): Promise<void>;

  /** 从回收站恢复。 */
  restoreDoc(docId: string): Promise<void>;

  /** 校验所有作品（含回收站）。 */
  verifyAll(): Promise<VerifyReport[]>;

  storageStatus(): Promise<StorageStatus>;

  backup(): BackupService;

  /** 扫描所有本地冗余副本（IDB / OPFS），修复缺失或较短的主存储。 */
  recover(): Promise<RecoveryReport>;

  /**
   * 导出全部作品（含回收站）为单个全量备份包 `.wtzip`（ZIP：manifest + 每作品 .wtlog）。
   * 用于跨设备迁移与灾备；内容为明文日志，不加密。
   */
  exportArchive(): Promise<Blob>;

  /**
   * 从 `.wtzip` 备份包恢复/合并：新作品导入、本地较短的按前缀合并、
   * 已一致或本地更新的跳过、分歧的只报告不覆盖。单个作品失败不影响其它作品。
   */
  importArchive(file: Blob, fileName?: string): Promise<ArchiveImportReport>;

  /**
   * 从**已配置的备份目录**恢复全部作品（灾备闭环）：
   * 读取该目录里的 `writertools-manifest.json` + 各作品 `.wtlog`，按与 `importArchive`
   * 完全相同的校验/前缀合并规则导入（只追加、不覆盖更新副本、分歧只报告）。
   * 未配置备份目录或目录不可读时抛出可读错误。
   */
  restoreFromBackupDirectory(): Promise<ArchiveImportReport>;

  /** 等待所有作品写入落盘。 */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 引擎构造 & 可注入环境（测试用）
// ---------------------------------------------------------------------------

/** OPFS 适配器（测试时注入内存实现；浏览器中由引擎自动创建）。 */
export interface OpfsAdapter {
  readonly available: boolean;
  /** 读取文本文件；不存在返回 null */
  read(path: string): Promise<string | null>;
  /** 覆盖写整个文本文件（自动建目录） */
  write(path: string, data: string): Promise<void>;
  /** 列出目录下文件名（不含路径） */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

/**
 * 原生备份目录桥（Android Storage Access Framework 等平台能力）。
 * 由平台层实现并注入 EngineOptions.backupNative；提供后优先于 File System Access。
 * 目录选择必须由用户手势触发（原生系统选择器）；目录 URI/权限由平台层自行持久化。
 */
export interface NativeBackupDirectoryBridge {
  readonly available: boolean;
  /** 弹出系统目录选择器；用户取消返回 null。必须在用户手势中调用。 */
  chooseDirectory(): Promise<{ name: string } | null>;
  /** 已持久化的目录；未选择或权限已失效返回 null。 */
  getDirectory(): Promise<{ name: string } | null>;
  /** 覆盖写入一个 UTF-8 文本文件（文件名仅限安全单段名）。 */
  writeFile(name: string, text: string): Promise<void>;
  /** 读取单个文本文件；不存在返回 null。 */
  readFile(name: string): Promise<string | null>;
  /** 列出目录内文本文件并读取内容（用于恢复）；不可读时抛错或返回空数组。 */
  readFiles(): Promise<Array<{ name: string; text: string }>>;
  /** 忘记已选目录（不删除目录里的文件）。 */
  forgetDirectory(): Promise<void>;
}

export interface EngineOptions {
  /** IndexedDB 数据库名，默认 'writertools' */
  dbName?: string;
  /** 注入 IndexedDB 工厂（测试用），默认 globalThis.indexedDB */
  indexedDB?: IDBFactory;
  /** 注入 OPFS 适配器；null 表示禁用镜像；不传则自动探测 */
  opfs?: OpfsAdapter | null;
  /** 时间源（测试用） */
  now?: () => Date;
  /** 事件 ID 生成器（测试用） */
  randomUUID?: () => string;
  /** 自动快照策略；默认 { maxEvents: 300, maxIntervalMs: 120_000 } */
  autoSnapshot?: { maxEvents?: number; maxIntervalMs?: number };
  /** 是否请求持久化存储（navigator.storage.persist），默认 true */
  requestPersistence?: boolean;
  /** 是否启用备份目录能力（File System Access），默认 true */
  fileSystemAccess?: boolean;
  /**
   * 自动备份到用户已配置的备份目录（真实 .wtlog 文件 + manifest）。
   * 触发点：任何快照（手动/自动/会话结束）之后，以及应用启动时发现已配置目录；
   * 防抖 + 最小间隔合并，默认开启。默认 { debounceMs: 3000, minIntervalMs: 15000 }。
   */
  autoBackup?: { enabled?: boolean; debounceMs?: number; minIntervalMs?: number };
  /**
   * 原生备份目录桥（Android SAF 等平台能力）：提供后优先于 File System Access 使用。
   * 由平台层（Capacitor 桥）实现并注入；Web 环境不传。
   */
  backupNative?: NativeBackupDirectoryBridge;
}

export type EngineFactory = (options?: EngineOptions) => Promise<LibraryEngine>;

/** 文本编辑冲突：引擎正文与 UI 认为的正文不一致。UI 必须用 currentText 重新同步。 */
export class EditConflictError extends Error {
  readonly currentText: string;
  constructor(message: string, currentText: string) {
    super(message);
    this.name = 'EditConflictError';
    this.currentText = currentText;
  }
}

/**
 * 计算 prev → next 的最小单段差异（公共前后缀法）。
 * 两次文本完全一致时返回 null。UI 记录器用它把 textarea 变化转成 TextEdit。
 */
export type DeriveEdit = (prev: string, next: string) => DerivedEdit | null;

/** 契约要求 src/engine/index.ts 必须导出以下运行时符号： */
export interface EngineModule {
  createEngine: EngineFactory;
  deriveEdit: DeriveEdit;
}
