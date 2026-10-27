/**
 * 纯内存假引擎 —— 仅开发自测用。
 *
 * 通过 URL 带 `?demo` 时由 useEngine 动态 import（生产构建不会引用本文件）。
 * 目的：在真实引擎尚未就绪时，能完整体验书架 → 编辑器 → 录制 → 历史 → 设置 的界面流程。
 * 它不实现 IndexedDB/OPFS/哈希链，也没有持久化；任何正式行为以 src/engine 为准。
 */
import { EditConflictError } from '../../engine/types';
import type {
  ArchiveImportReport,
  BackupService,
  BackupStatus,
  ComposeEvent,
  DocChange,
  DocHandle,
  DocSummary,
  EditContext,
  EditorMode,
  LibraryEngine,
  RecoveryReport,
  SelectionReason,
  SelectionState,
  SnapshotInfo,
  SnapshotReason,
  StorageStatus,
  TextEdit,
  InputTraceEntry,
  VerifyReport,
} from '../../engine/types';

type Listener = (change: DocChange) => void;

interface FakeEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  ts: string;
}

interface FakeSnapshot {
  info: SnapshotInfo;
  text: string;
}

interface FakeDoc {
  docId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  text: string;
  mode: EditorMode;
  trashed: boolean;
  readonly: boolean;
  events: FakeEvent[];
  snapshots: FakeSnapshot[];
  listeners: Set<Listener>;
}

const APP_INFO = { name: 'WriterTools', version: '0.2.1' };

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `fake-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDocRecord(title: string, text = ''): FakeDoc {
  const ts = nowIso();
  const docId = newId();
  return {
    docId,
    title: title.trim() || '无题',
    createdAt: ts,
    updatedAt: ts,
    text,
    mode: 'typewriter',
    trashed: false,
    readonly: false,
    events: [
      {
        seq: 0,
        type: 'doc.init',
        ts,
        data: { docId, title: title.trim() || '无题', createdAt: ts, app: APP_INFO },
      },
    ],
    snapshots: [],
    listeners: new Set<Listener>(),
  };
}

class FakeDocHandle implements DocHandle {
  private readonly doc: FakeDoc;
  private closed = false;

  constructor(doc: FakeDoc) {
    this.doc = doc;
  }

  get docId(): string {
    return this.doc.docId;
  }

  get title(): string {
    return this.doc.title;
  }

  get text(): string {
    return this.doc.text;
  }

  get readonly(): boolean {
    return this.doc.readonly;
  }

  get updatedAt(): string {
    return this.doc.updatedAt;
  }

  get eventCount(): number {
    return this.doc.events.length;
  }

  private emit(change: DocChange): void {
    this.doc.listeners.forEach((listener) => listener(change));
  }

  private pushEvent(type: string, data: Record<string, unknown>): void {
    this.doc.events.push({ seq: this.doc.events.length, type, data, ts: nowIso() });
    this.doc.updatedAt = nowIso();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('作品已关闭');
  }

  on(listener: Listener): () => void {
    this.doc.listeners.add(listener);
    return () => {
      this.doc.listeners.delete(listener);
    };
  }

  async appendEdit(edit: TextEdit, context?: EditContext): Promise<void> {
    this.assertOpen();
    const doc = this.doc;
    const text = doc.text;
    switch (edit.kind) {
      case 'insert': {
        if (!Number.isInteger(edit.pos) || edit.pos < 0 || edit.pos > text.length || edit.text.length === 0) {
          throw new EditConflictError('insert 与当前正文不一致', text);
        }
        doc.text = text.slice(0, edit.pos) + edit.text + text.slice(edit.pos);
        this.pushEvent('text.insert', {
          pos: edit.pos,
          text: edit.text,
          source: edit.source ?? 'typing',
          ...(edit.inputType ? { inputType: edit.inputType } : {}),
        });
        break;
      }
      case 'delete': {
        if (
          !Number.isInteger(edit.pos) ||
          !Number.isInteger(edit.length) ||
          edit.length <= 0 ||
          edit.pos < 0 ||
          edit.pos + edit.length > text.length ||
          text.slice(edit.pos, edit.pos + edit.length) !== edit.deleted
        ) {
          throw new EditConflictError('delete 与当前正文不一致', text);
        }
        doc.text = text.slice(0, edit.pos) + text.slice(edit.pos + edit.length);
        this.pushEvent('text.delete', {
          pos: edit.pos,
          length: edit.length,
          deleted: edit.deleted,
          source: edit.source ?? 'typing',
          ...(edit.direction ? { direction: edit.direction } : {}),
          ...(edit.inputType ? { inputType: edit.inputType } : {}),
        });
        break;
      }
      case 'replace': {
        if (
          edit.pos < 0 ||
          edit.length < 0 ||
          edit.pos + edit.length > text.length ||
          text.slice(edit.pos, edit.pos + edit.length) !== edit.deleted
        ) {
          throw new EditConflictError('replace 与当前正文不一致', text);
        }
        doc.text = text.slice(0, edit.pos) + edit.text + text.slice(edit.pos + edit.length);
        this.pushEvent('text.replace', {
          pos: edit.pos,
          length: edit.length,
          deleted: edit.deleted,
          text: edit.text,
          source: edit.source ?? 'typing',
          ...(edit.inputType ? { inputType: edit.inputType } : {}),
        });
        break;
      }
      case 'reset': {
        doc.text = edit.text;
        this.pushEvent('text.reset', { text: edit.text, source: edit.source ?? 'restore', reason: edit.reason ?? 'restore' });
        break;
      }
      default:
        break;
    }
    this.emit({ kind: 'text', text: doc.text, selection: context?.selectionAfter });
  }

  async appendCompose(event: ComposeEvent): Promise<void> {
    this.assertOpen();
    this.pushEvent(`compose.${event.phase}`, { ...event });
  }

  async setSelection(selection: SelectionState, reason?: SelectionReason): Promise<void> {
    this.assertOpen();
    this.pushEvent('selection.set', { ...selection, ...(reason ? { reason } : {}) });
  }

  async setMode(mode: EditorMode): Promise<void> {
    this.assertOpen();
    this.doc.mode = mode;
    this.pushEvent('editor.mode', { mode });
  }

  async setTitle(title: string): Promise<void> {
    this.assertOpen();
    const next = title.trim() || '无题';
    this.doc.title = next;
    this.pushEvent('doc.title', { title: next });
    this.emit({ kind: 'title', title: next });
  }

  private createSnapshot(message: string, reason: SnapshotReason): SnapshotInfo {
    const doc = this.doc;
    const info: SnapshotInfo = {
      seq: doc.events.length,
      ts: nowIso(),
      message,
      reason,
      chars: doc.text.length,
      eventCount: doc.events.length,
    };
    this.pushEvent('snapshot', {
      message,
      reason,
      text: doc.text,
      chars: doc.text.length,
    });
    doc.snapshots.push({ info, text: doc.text });
    return info;
  }

  async snapshot(message?: string, reason: SnapshotReason = 'manual'): Promise<SnapshotInfo> {
    return this.createSnapshot(message?.trim() || '手动保存', reason);
  }

  async history(): Promise<SnapshotInfo[]> {
    return [...this.doc.snapshots].map((item) => item.info).sort((a, b) => a.seq - b.seq);
  }

  async previewSnapshot(seq: number): Promise<string> {
    const found = this.doc.snapshots.find((item) => item.info.seq === seq);
    if (!found) throw new Error(`快照 ${seq} 不存在`);
    return found.text;
  }

  async restore(seq: number, message?: string): Promise<SnapshotInfo> {
    this.assertOpen();
    const found = this.doc.snapshots.find((item) => item.info.seq === seq);
    if (!found) throw new Error(`快照 ${seq} 不存在`);
    const doc = this.doc;
    doc.text = found.text;
    this.pushEvent('text.reset', { text: doc.text, reason: 'restore', targetSeq: seq, source: 'restore' });
    const info = this.createSnapshot(message?.trim() || `恢复到 ${new Date(found.info.ts).toLocaleString('zh-CN')}`, 'restore');
    this.emit({ kind: 'text', text: doc.text });
    this.emit({ kind: 'saved', snapshot: info });
    return info;
  }

  async verify(): Promise<VerifyReport> {
    return {
      docId: this.doc.docId,
      title: this.doc.title,
      ok: true,
      eventCount: this.doc.events.length,
      source: 'idb',
      chainOk: true,
      seqOk: true,
      brokenAt: null,
      unknownTextEventSeqs: [],
      snapshotMismatchSeqs: [],
      repaired: false,
      warnings: ['演示模式使用内存假引擎，未做真实哈希链校验'],
    };
  }

  async exportLog(): Promise<Blob> {
    const lines = this.doc.events.map((event) => {
      const header = event.type === 'doc.init';
      return JSON.stringify({
        seq: event.seq,
        id: newId(),
        ts: event.ts,
        type: event.type,
        affects: event.type.startsWith('text.') ? 'text' : 'meta',
        prev: event.seq === 0 ? '' : 'sha256:demo',
        hash: 'sha256:demo',
        data: event.data,
        ...(header ? { magic: 'writertools-log', format: '1.0' } : {}),
      });
    });
    return new Blob([`${lines.join('\n')}\n`], { type: 'application/x-writertools-log' });
  }

  async exportText(): Promise<Blob> {
    return new Blob([this.doc.text], { type: 'text/plain;charset=utf-8' });
  }

  /** 从内存事件归一化出原始输入时间线（演示模式用；真实实现见引擎）。 */
  async getInputTrace(options?: { limit?: number }): Promise<InputTraceEntry[]> {
    const rawLimit = options?.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
    const entries: InputTraceEntry[] = [];
    for (const event of this.doc.events) {
      const data = event.data;
      switch (event.type) {
        case 'compose.start':
        case 'compose.update':
        case 'compose.end': {
          const phase = event.type.slice('compose.'.length) as 'start' | 'update' | 'end';
          const entry: Extract<InputTraceEntry, { kind: 'compose' }> = {
            kind: 'compose',
            seq: event.seq,
            ts: event.ts,
            phase,
            data: str(data.data) ?? '',
          };
          if (phase !== 'end') {
            entry.from = num(data.from);
            entry.to = num(data.to);
          }
          if (typeof data.committed === 'string') entry.committed = data.committed;
          if (phase === 'update' && typeof data.candidate === 'number') entry.candidate = data.candidate;
          entries.push(entry);
          break;
        }
        case 'text.insert':
        case 'text.delete':
        case 'text.replace':
        case 'text.reset': {
          const entry: Extract<InputTraceEntry, { kind: 'text' }> = {
            kind: 'text',
            seq: event.seq,
            ts: event.ts,
            op: event.type.slice('text.'.length) as 'insert' | 'delete' | 'replace' | 'reset',
          };
          if (typeof data.pos === 'number') entry.pos = data.pos;
          if (typeof data.length === 'number') entry.length = data.length;
          if (typeof data.text === 'string') entry.text = data.text;
          if (typeof data.deleted === 'string') entry.deleted = data.deleted;
          if (typeof data.source === 'string') entry.source = data.source;
          if (typeof data.inputType === 'string') entry.inputType = data.inputType;
          entries.push(entry);
          break;
        }
        case 'session.start':
        case 'session.end': {
          const entry: Extract<InputTraceEntry, { kind: 'session' }> = {
            kind: 'session',
            seq: event.seq,
            ts: event.ts,
            phase: event.type === 'session.start' ? 'start' : 'end',
          };
          if (typeof data.sessionId === 'string') entry.sessionId = data.sessionId;
          entries.push(entry);
          break;
        }
        case 'editor.mode': {
          entries.push({
            kind: 'mode',
            seq: event.seq,
            ts: event.ts,
            mode: (data.mode === 'typewriter' ? 'typewriter' : 'centered') as EditorMode,
          });
          break;
        }
        default:
          break;
      }
    }
    return limit > 0 ? entries.slice(-limit) : entries;
  }

  async flush(): Promise<void> {
    /* 内存实现无需落盘 */
  }

  async close(): Promise<void> {
    this.closed = true;
    this.doc.listeners.clear();
  }
}

function toSummary(doc: FakeDoc): DocSummary {
  return {
    docId: doc.docId,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    chars: doc.text.length,
    eventCount: doc.events.length,
    snapshotCount: doc.snapshots.length,
    trashed: doc.trashed,
    integrity: 'ok',
    readonly: doc.readonly,
  };
}

const fakeBackupService: BackupService = {
  async status(): Promise<BackupStatus> {
    return { configured: false };
  },
  async chooseDirectory(): Promise<BackupStatus> {
    throw new Error('演示模式（?demo）使用内存假引擎，不支持选择备份目录');
  },
  async backupNow(): Promise<BackupStatus> {
    throw new Error('演示模式（?demo）不支持备份，请使用真实引擎');
  },
  async requestPermission(): Promise<BackupStatus> {
    // 演示模式没有真实目录句柄：直接返回当前状态（configured=false）。
    return this.status();
  },
  async disable(): Promise<void> {
    /* 无目录可移除 */
  },
};

class FakeLibrary implements LibraryEngine {
  private readonly docs = new Map<string, FakeDoc>();

  async listDocs(options?: { includeTrashed?: boolean }): Promise<DocSummary[]> {
    return [...this.docs.values()]
      .filter((doc) => (options?.includeTrashed ? true : !doc.trashed))
      .map(toSummary);
  }

  async createDoc(title?: string): Promise<DocHandle> {
    const doc = createDocRecord(title ?? '无题');
    this.docs.set(doc.docId, doc);
    return new FakeDocHandle(doc);
  }

  async openDoc(docId: string): Promise<DocHandle> {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error('作品不存在');
    return new FakeDocHandle(doc);
  }

  async importFile(file: Blob, fileName?: string): Promise<DocSummary> {
    const content = await file.text();
    const docs = this.parseLog(content, fileName);
    const doc = docs[0];
    if (!doc) throw new Error('文件里没有可导入的作品');
    if ([...this.docs.keys()].some((id) => id === doc.docId)) throw new Error('同名作品已存在，请先删除或另存为副本');
    this.docs.set(doc.docId, doc);
    return toSummary(doc);
  }

  private parseLog(content: string, fileName?: string): FakeDoc[] {
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const headerLine = lines[0];
    let header: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(headerLine);
      if (parsed && typeof parsed === 'object') header = parsed as Record<string, unknown>;
    } catch {
      throw new Error('不是有效的 .wtlog 文件（首行无法解析）');
    }
    const headerData = (header?.data ?? {}) as Record<string, unknown>;
    if (header?.type !== 'doc.init' || typeof headerData.docId !== 'string') {
      throw new Error('不是有效的 .wtlog 文件（缺少 doc.init 头）');
    }
    const title = typeof headerData.title === 'string' ? headerData.title : (fileName ?? '无题');
    const doc = createDocRecord(title);
    doc.docId = headerData.docId;
    doc.events[0].data.docId = headerData.docId;
    doc.title = title.trim() || '无题';
    for (const line of lines.slice(1)) {
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') continue;
        event = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === 'text.insert' && typeof data.pos === 'number' && typeof data.text === 'string') {
        doc.text = doc.text.slice(0, data.pos) + data.text + doc.text.slice(data.pos);
      } else if (
        event.type === 'text.delete' &&
        typeof data.pos === 'number' &&
        typeof data.deleted === 'string'
      ) {
        doc.text = doc.text.slice(0, data.pos) + doc.text.slice(data.pos + data.deleted.length);
      } else if (event.type === 'text.reset' && typeof data.text === 'string') {
        doc.text = data.text;
      }
    }
    return [doc];
  }

  async trashDoc(docId: string): Promise<void> {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error('作品不存在');
    doc.trashed = true;
    doc.updatedAt = nowIso();
  }

  async restoreDoc(docId: string): Promise<void> {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error('作品不存在');
    doc.trashed = false;
    doc.updatedAt = nowIso();
  }

  async verifyAll(): Promise<VerifyReport[]> {
    return [...this.docs.values()].map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      ok: true,
      eventCount: doc.events.length,
      source: 'idb' as const,
      chainOk: true,
      seqOk: true,
      brokenAt: null,
      unknownTextEventSeqs: [],
      snapshotMismatchSeqs: [],
      repaired: false,
      warnings: ['演示模式未做真实校验'],
    }));
  }

  async storageStatus(): Promise<StorageStatus> {
    return { persistent: null, usage: null, quota: null, opfs: false, backupConfigured: false };
  }

  backup(): BackupService {
    return fakeBackupService;
  }

  async recover(): Promise<RecoveryReport> {
    return {
      scannedCopies: 0,
      recoveredDocs: 0,
      conflicts: [],
      warnings: ['演示模式（?demo）使用内存假引擎，不提供扫描恢复'],
    };
  }

  async exportArchive(): Promise<Blob> {
    throw new Error('演示模式（?demo）使用内存假引擎，不支持导出全量备份包');
  }

  async importArchive(_file: Blob, _fileName?: string): Promise<ArchiveImportReport> {
    throw new Error('演示模式（?demo）使用内存假引擎，不支持导入全量备份包');
  }

  async restoreFromBackupDirectory(): Promise<ArchiveImportReport> {
    throw new Error('演示模式（?demo）使用内存假引擎，不支持从备份目录恢复');
  }

  async flush(): Promise<void> {
    /* 内存实现无需落盘 */
  }

  /** 开发者自测：把内存里的作品与事件暴露出来（仅 ?demo 模式可用）。 */
  debugSnapshot(): Array<{ docId: string; title: string; text: string; trashed: boolean; events: FakeEvent[] }> {
    return [...this.docs.values()].map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      text: doc.text,
      trashed: doc.trashed,
      events: doc.events,
    }));
  }
}

export function createFakeEngine(): Promise<LibraryEngine> {
  const library = new FakeLibrary();
  if (typeof window !== 'undefined') {
    (window as unknown as { __writerToolsDemo?: FakeLibrary }).__writerToolsDemo = library;
  }
  return Promise.resolve(library);
}
