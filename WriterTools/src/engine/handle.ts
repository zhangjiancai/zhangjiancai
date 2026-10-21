/**
 * 单个作品的引擎句柄：追加编辑 / 输入法记录 / 选区 / 模式 / 标题 / 快照 / 恢复 / 校验 / 导入导出。
 *
 * 所有写操作经内部串行队列执行：同一 docId 的事件 seq 与 prev 链不会竞争；
 * appendEdit 的 promise 在 IndexedDB 事务 oncomplete 后才 resolve（主存储已落盘）。
 * OPFS 镜像与自动快照另行调度：镜像写入防抖（约 400ms），flush()/close() 强制落盘。
 */

import { hashText } from './canonical';
import type {
  ComposeEvent,
  DocChange,
  DocHandle,
  EditorMode,
  EditContext,
  InputTraceEntry,
  OpfsAdapter,
  SelectionReason,
  SelectionState,
  SnapshotInfo,
  SnapshotReason,
  TextEdit,
  VerifyReport,
} from './types';
import { EditConflictError, LOG_FILE_MIME } from './types';
import type { DocRecord } from './idb';
import { readDocEvents, readDocRecord, writeDocSnapshot } from './idb';
import type { Affect, EventData, LogEvent } from './log';
import {
  createEvent,
  detectDeviceInfo,
  isNonNegativeInteger,
  isInteger,
  isoNow,
  logSourceFromEvents,
  previewText,
  serializeEvents,
  snapshotInfoFromEvent,
  snapshotTextFromEvent,
  splitTextChunks,
  verifyLog,
} from './log';

/** OPFS 镜像写入防抖间隔（毫秒）。 */
const MIRROR_DEBOUNCE_MS = 400;

export interface DocLockInfo {
  acquired: boolean;
  release: () => void;
  /** 是否真正持有 Web Lock（false = 当前环境没有 Web Locks）。 */
  held: boolean;
}

export interface AutoSnapshotOptions {
  maxEvents: number;
  maxIntervalMs: number;
}

/** 引擎注入给句柄的能力（避免句柄直接依赖库实现）。 */
export interface HandleCore {
  db: IDBDatabase;
  opfs: OpfsAdapter | null;
  now: () => Date;
  uuid: () => string;
  autoSnapshot: AutoSnapshotOptions;
  writeMirror(docId: string, text: string): Promise<void>;
  onClosed(docId: string): void;
  /**
   * 快照成功（已落盘且已 emit('saved')）后的内部回调：LibraryEngine 用它调度自动备份。
   * 不得抛错，也不得等待耗时操作（保持快照/编辑路径的响应速度）。
   */
  onSnapshot?(docId: string): void;
}

interface PendingEvent {
  type: string;
  affects: Affect;
  data: EventData;
}

interface CommitOptions {
  /** 提交后的正文（仅文本事件需要）。 */
  finalText?: string;
  /** 提交后的标题。 */
  title?: string;
  /** 提交后的回收站状态。 */
  trashed?: boolean;
  /** 附加到作品摘要的补丁。 */
  docPatch?: Partial<DocRecord>;
  /** 提交成功后通知监听者。 */
  notify?: DocChange | null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isSelection(value: SelectionState | undefined): value is SelectionState {
  return value !== undefined && isNonNegativeInteger(value.from) && isNonNegativeInteger(value.to);
}

function isSelectionReason(value: string): value is SelectionReason {
  return ['caret', 'click', 'key', 'edit', 'focus', 'programmatic'].includes(value);
}

export class DocHandleImpl implements DocHandle {
  readonly docId: string;

  private readonly core: HandleCore;
  private readonly lock: DocLockInfo;
  private readonly sessionId: string;
  private readonly sessionStartTs: string;

  private doc: DocRecord;
  private eventsList: LogEvent[];
  private textValue: string;
  private titleValue: string;
  private readonlyValue: boolean;
  private readonlyReason: string;
  private integrityState: 'ok' | 'broken';
  /** 主存储被截断时，第一个缺失事件的 seq（null = 未检测到截断）。 */
  private truncatedFromSeq: number | null = null;
  /** 截断检测时记录锚点声明的最后 seq（用于报告）。 */
  private expectedAnchorSeq = 0;

  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closing = false;
  private listeners = new Set<(change: DocChange) => void>();

  private lastSeq: number;
  private lastHash: string;
  private snapshotsCache: SnapshotInfo[];

  private eventsSinceSnapshot: number;
  /** 距上次快照的文本编辑事件数（自动快照阈值只按正文编辑计，避免选区/输入法事件刷屏触发快照）。 */
  private textEventsSinceSnapshot = 0;
  private textChangedSinceSnapshot = false;
  private lastSnapshotAtMs: number;

  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  private mirrorDirty = false;
  private mirrorRevision = 0;
  private lastMirrorText = '';
  /** lastMirrorText 中已包含的事件数（日志只增，镜像可增量拼接，避免每次全量序列化）。 */
  private mirroredEventCount = 0;

  private constructor(
    core: HandleCore,
    docId: string,
    record: DocRecord,
    verify: Awaited<ReturnType<typeof verifyLog>>,
    lock: DocLockInfo,
  ) {
    this.core = core;
    this.docId = docId;
    this.lock = lock;
    this.doc = record;
    this.eventsList = verify.events;
    this.textValue = verify.text;
    this.titleValue = verify.headerOk ? verify.title : record.title;
    this.lastSeq = verify.lastValidSeq;
    this.lastHash = verify.lastValidHash;
    this.readonlyValue = !lock.acquired || !verify.ok;
    this.integrityState = verify.ok ? 'ok' : 'broken';
    this.readonlyReason = !lock.acquired
      ? '作品正被其它标签页或窗口打开'
      : !verify.ok
        ? `日志校验失败（${verify.brokenReason ?? '数据损坏'}），只能按最长有效前缀只读打开`
        : '';
    this.snapshotsCache = [];
    const lastEvent = verify.events.length > 0 ? verify.events[verify.events.length - 1] : null;
    let lastSnapshot: LogEvent | null = null;
    for (const event of verify.events) {
      const info = snapshotInfoFromEvent(event);
      if (info) {
        this.snapshotsCache.push(info);
        lastSnapshot = event;
      }
    }
    const lastSnapshotSeq = lastSnapshot ? lastSnapshot.seq : -1;
    this.eventsSinceSnapshot = lastSnapshotSeq >= 0 ? verify.events.length - lastSnapshotSeq - 1 : verify.events.length;
    this.textEventsSinceSnapshot = 0;
    for (const event of verify.events) {
      if (event.seq <= lastSnapshotSeq) continue;
      if (event.affects === 'text') this.textEventsSinceSnapshot += 1;
    }
    this.sessionId = core.uuid();
    this.sessionStartTs = isoNow(core.now);
    this.lastSnapshotAtMs = lastSnapshot ? Date.parse(lastSnapshot.ts) : Date.parse(this.sessionStartTs);
    if (!Number.isFinite(this.lastSnapshotAtMs)) this.lastSnapshotAtMs = core.now().getTime();
    this.doc = {
      ...record,
      title: this.titleValue,
      chars: this.textValue.length,
      eventCount: this.eventsList.length,
      snapshotCount: this.snapshotsCache.length,
      trashed: verify.headerOk ? verify.trashed : record.trashed,
      lastSeq: this.lastSeq,
      lastHash: this.lastHash,
      updatedAt: lastEvent ? lastEvent.ts : record.updatedAt,
      integrity: verify.ok ? 'ok' : 'broken',
    };
  }

  /** 打开作品：读取 IDB、校验日志、确定可写性，可写时写 session.start。 */
  static async open(core: HandleCore, docId: string, lock: DocLockInfo): Promise<DocHandleImpl> {
    const rawEvents = await readDocEvents(core.db, docId);
    let record = await readDocRecord(core.db, docId);
    let verify: Awaited<ReturnType<typeof verifyLog>>;
    if (!record) {
      if (rawEvents.length === 0) throw new Error(`作品不存在：${docId}`);
      verify = await verifyLog(logSourceFromEvents(rawEvents));
      if (!verify.headerOk || verify.docId !== docId) throw new Error(`作品不存在或日志头损坏：${docId}`);
      // docs 摘要丢失但事件还在：以日志为真源重建摘要（主存储自修复，不丢数据）
      const last = verify.events[verify.events.length - 1];
      record = {
        docId,
        title: verify.title,
        createdAt: verify.createdAt ?? rawEvents[0].ts,
        updatedAt: last ? last.ts : rawEvents[0].ts,
        chars: verify.text.length,
        eventCount: verify.events.length,
        snapshotCount: verify.events.filter((event) => event.type === 'snapshot').length,
        trashed: verify.trashed,
        lastSeq: last ? last.seq : 0,
        lastHash: last ? last.hash : '',
        integrity: verify.ok ? 'ok' : 'broken',
      };
      await writeDocSnapshot(core.db, record, []);
    } else {
      verify = await verifyLog(logSourceFromEvents(rawEvents));
    }
    const handle = new DocHandleImpl(core, docId, record, verify, lock);
    // 主存储锚点（docs.lastSeq）显示还应有更多事件，但事件流已经缩短 = 主存储被截断。
    // 以只读前缀打开并保留锚点，交给 recover() 用冗余副本修复；绝不静默改写记录、丢失可恢复数据。
    if (lock.acquired && record.lastSeq > verify.lastValidSeq) {
      handle.markTruncated(verify.lastValidSeq + 1, record.lastSeq);
    }
    await handle.init();
    return handle;
  }

  /** 标记主存储被截断（只读，等待 recover 用镜像/备份修复）。 */
  private markTruncated(firstMissingSeq: number, expectedLastSeq: number): void {
    this.truncatedFromSeq = firstMissingSeq;
    this.expectedAnchorSeq = expectedLastSeq;
    this.readonlyValue = true;
    this.integrityState = 'broken';
    this.readonlyReason = `主存储事件缺失（记录显示应有 seq=${expectedLastSeq} 的事件，实际止于 seq=${firstMissingSeq - 1}），请先用"扫描恢复"从冗余副本修复`;
  }

  private async init(): Promise<void> {
    if (this.readonlyValue) return;
    // 可写：以日志为真源同步一次作品摘要，然后写 session.start（会一并持久化摘要）。
    this.doc = {
      ...this.doc,
      title: this.titleValue,
      chars: this.textValue.length,
      eventCount: this.eventsList.length,
      snapshotCount: this.snapshotsCache.length,
      trashed: this.doc.trashed,
      lastSeq: this.lastSeq,
      lastHash: this.lastHash,
      integrity: 'ok',
    };
    const data: EventData = {
      sessionId: this.sessionId,
      startedAt: this.sessionStartTs,
      device: detectDeviceInfo(),
    };
    await this.commitEvents([{ type: 'session.start', affects: 'meta', data }], {});
    this.textChangedSinceSnapshot = false;
  }

  // -------------------------------------------------------------------------
  // DocHandle 只读属性
  // -------------------------------------------------------------------------

  get title(): string {
    return this.titleValue;
  }

  get text(): string {
    return this.textValue;
  }

  get readonly(): boolean {
    return this.readonlyValue;
  }

  get updatedAt(): string {
    return this.doc.updatedAt;
  }

  get eventCount(): number {
    return this.eventsList.length;
  }

  /** 引擎内部用：打开时校验得到的完整性状态。 */
  get integrity(): 'ok' | 'broken' | 'unknown' {
    return this.integrityState;
  }

  on(listener: (change: DocChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: DocChange): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(change);
      } catch {
        // 监听者异常不能影响引擎写入
      }
    }
  }

  // -------------------------------------------------------------------------
  // 串行队列
  // -------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ensureWritable(): void {
    if (this.closed || this.closing) throw new Error('作品句柄已关闭');
    if (this.readonlyValue) throw new Error(`作品为只读模式：${this.readonlyReason}`);
  }

  private conflict(message: string): never {
    throw new EditConflictError(message, this.textValue);
  }

  // -------------------------------------------------------------------------
  // 文本编辑
  // -------------------------------------------------------------------------

  async appendEdit(edit: TextEdit, context?: EditContext): Promise<void> {
    if (this.readonlyValue) throw new Error(`作品为只读模式：${this.readonlyReason}`);
    return this.enqueue(async () => {
      this.ensureWritable();
      const planned = this.planEdit(edit, context);
      if (planned.pending.length === 0) return;
      await this.commitEvents(planned.pending, {
        finalText: planned.text,
        notify: { kind: 'text', text: planned.text, selection: context?.selectionAfter },
      });
      await this.maybeAutoSnapshot();
    });
  }

  /**
   * 校验编辑意图并把大编辑拆成多个语义等价的小事件（单行 ≤ 256 KiB 建议值）。
   * 位置/长度/deleted 与当前正文不一致抛 EditConflictError（带 currentText 供 UI 重新同步）。
   */
  private planEdit(edit: TextEdit, context?: EditContext): { pending: PendingEvent[]; text: string } {
    const current = this.textValue;
    const inputType = context && typeof context.inputType === 'string' ? context.inputType : undefined;
    switch (edit.kind) {
      case 'insert': {
        if (!isNonNegativeInteger(edit.pos) || edit.pos > current.length) {
          this.conflict(`插入位置越界：pos=${String(edit.pos)}，当前正文长度=${current.length}`);
        }
        if (typeof edit.text !== 'string') this.conflict('插入内容必须是字符串');
        if (edit.text.length === 0) return { pending: [], text: current };
        const source = edit.source ?? 'typing';
        const chunks = splitTextChunks(edit.text);
        const pending: PendingEvent[] = [];
        let pos = edit.pos;
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const data: EventData = { pos, text: chunk, source };
          const it = edit.inputType ?? inputType;
          if (it) data.inputType = it;
          if (index === chunks.length - 1) attachSelectionContext(data, context);
          pending.push({ type: 'text.insert', affects: 'text', data });
          pos += chunk.length;
        }
        return { pending, text: `${current.slice(0, edit.pos)}${edit.text}${current.slice(edit.pos)}` };
      }
      case 'delete': {
        if (!isInteger(edit.length) || edit.length < 0) this.conflict(`删除长度非法：length=${String(edit.length)}`);
        if (!isNonNegativeInteger(edit.pos) || edit.pos + edit.length > current.length) {
          this.conflict(`删除范围越界：pos=${String(edit.pos)}, length=${String(edit.length)}，当前正文长度=${current.length}`);
        }
        if (typeof edit.deleted !== 'string') this.conflict('删除事件必须提供 deleted 原文');
        const actual = current.slice(edit.pos, edit.pos + edit.length);
        if (actual !== edit.deleted) {
          this.conflict(`删除内容与当前正文不一致：pos=${edit.pos} 处为 ${previewText(actual)}，收到 ${previewText(edit.deleted)}`);
        }
        if (edit.length === 0) return { pending: [], text: current };
        const source = edit.source ?? 'typing';
        const chunks = splitTextChunks(edit.deleted);
        const pending: PendingEvent[] = [];
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const data: EventData = { pos: edit.pos, length: chunk.length, deleted: chunk, source };
          if (edit.direction) data.direction = edit.direction;
          const it = edit.inputType ?? inputType;
          if (it) data.inputType = it;
          if (index === chunks.length - 1) attachSelectionContext(data, context);
          pending.push({ type: 'text.delete', affects: 'text', data });
        }
        return {
          pending,
          text: current.slice(0, edit.pos) + current.slice(edit.pos + edit.length),
        };
      }
      case 'replace': {
        if (!isInteger(edit.length) || edit.length < 0) this.conflict(`替换长度非法：length=${String(edit.length)}`);
        if (!isNonNegativeInteger(edit.pos) || edit.pos + edit.length > current.length) {
          this.conflict(`替换范围越界：pos=${String(edit.pos)}, length=${String(edit.length)}，当前正文长度=${current.length}`);
        }
        if (typeof edit.deleted !== 'string') this.conflict('替换事件必须提供 deleted 原文');
        if (typeof edit.text !== 'string') this.conflict('替换内容必须是字符串');
        const actual = current.slice(edit.pos, edit.pos + edit.length);
        if (actual !== edit.deleted) {
          this.conflict(`替换内容与当前正文不一致：pos=${edit.pos} 处为 ${previewText(actual)}，收到 ${previewText(edit.deleted)}`);
        }
        if (edit.length === 0 && edit.text.length === 0) return { pending: [], text: current };
        const source = edit.source ?? 'typing';
        const sameText = edit.deleted === edit.text && edit.length === edit.text.length;
        const pending: PendingEvent[] = [];
        if (sameText) {
          // 文本未变（如输入法中间态）：仍然记录一次 replace，保持"每次编辑都有事件"。
          const data: EventData = { pos: edit.pos, length: edit.length, deleted: edit.deleted, text: edit.text, source };
          const it = edit.inputType ?? inputType;
          if (it) data.inputType = it;
          attachSelectionContext(data, context);
          pending.push({ type: 'text.replace', affects: 'text', data });
        } else if (edit.deleted.length <= 2000 && edit.text.length <= 2000) {
          const data: EventData = { pos: edit.pos, length: edit.length, deleted: edit.deleted, text: edit.text, source };
          const it = edit.inputType ?? inputType;
          if (it) data.inputType = it;
          attachSelectionContext(data, context);
          pending.push({ type: 'text.replace', affects: 'text', data });
        } else {
          // 大替换：先按块删除旧文本，再按块插入新文本（语义等价，便于只增日志与追回原文）。
          if (edit.deleted.length > 0) {
            for (const chunk of splitTextChunks(edit.deleted)) {
              const data: EventData = { pos: edit.pos, length: chunk.length, deleted: chunk, source };
              const it = edit.inputType ?? inputType;
              if (it) data.inputType = it;
              pending.push({ type: 'text.delete', affects: 'text', data });
            }
          }
          let pos = edit.pos;
          const insertChunks = splitTextChunks(edit.text);
          for (let index = 0; index < insertChunks.length; index += 1) {
            const chunk = insertChunks[index];
            const data: EventData = { pos, text: chunk, source };
            const it = edit.inputType ?? inputType;
            if (it) data.inputType = it;
            if (index === insertChunks.length - 1) attachSelectionContext(data, context);
            pending.push({ type: 'text.insert', affects: 'text', data });
            pos += chunk.length;
          }
        }
        return {
          pending,
          text: current.slice(0, edit.pos) + edit.text + current.slice(edit.pos + edit.length),
        };
      }
      case 'reset': {
        if (typeof edit.text !== 'string') this.conflict('text.reset 必须提供完整正文');
        const source = edit.source ?? (edit.reason === 'import' ? 'recovery' : 'restore');
        const data: EventData = {
          text: edit.text,
          reason: edit.reason ?? 'recovery',
          source,
        };
        return { pending: [{ type: 'text.reset', affects: 'text', data }], text: edit.text };
      }
      default:
        this.conflict(`未知编辑类型：${String((edit as { kind?: unknown }).kind)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 其它记录事件
  // -------------------------------------------------------------------------

  async appendCompose(event: ComposeEvent): Promise<void> {
    if (this.readonlyValue) throw new Error(`作品为只读模式：${this.readonlyReason}`);
    return this.enqueue(async () => {
      this.ensureWritable();
      let type: string;
      const data: EventData = {};
      switch (event.phase) {
        case 'start':
          type = 'compose.start';
          data.data = event.data;
          data.from = event.from;
          data.to = event.to;
          break;
        case 'update':
          type = 'compose.update';
          data.data = event.data;
          data.from = event.from;
          data.to = event.to;
          if (isInteger(event.candidate)) data.candidate = event.candidate;
          break;
        case 'end':
          type = 'compose.end';
          if (event.data !== undefined) data.data = event.data;
          if (event.committed !== undefined) data.committed = event.committed;
          break;
        default:
          throw new Error('非法输入法组合事件');
      }
      await this.commitEvents([{ type, affects: 'meta', data }], { notify: null });
    });
  }

  async setSelection(selection: SelectionState, reason?: SelectionReason): Promise<void> {
    if (this.readonlyValue) throw new Error(`作品为只读模式：${this.readonlyReason}`);
    return this.enqueue(async () => {
      this.ensureWritable();
      const data: EventData = { from: selection.from, to: selection.to };
      if (selection.direction === 'forward' || selection.direction === 'backward' || selection.direction === 'none') {
        data.direction = selection.direction;
      }
      if (reason && isSelectionReason(reason)) data.reason = reason;
      // 规范允许 UI 去重/节流；引擎侧不去重（每次调用都记录）。
      await this.commitEvents([{ type: 'selection.set', affects: 'meta', data }], { notify: null });
    });
  }

  async setMode(mode: EditorMode): Promise<void> {
    if (mode !== 'typewriter' && mode !== 'centered') throw new Error(`非法排版模式：${String(mode)}`);
    return this.enqueue(async () => {
      this.ensureWritable();
      await this.commitEvents([{ type: 'editor.mode', affects: 'meta', data: { mode } }], { notify: { kind: 'meta' } });
    });
  }

  async setTitle(title: string): Promise<void> {
    if (typeof title !== 'string') throw new Error('标题必须是字符串');
    return this.enqueue(async () => {
      this.ensureWritable();
      await this.commitEvents([{ type: 'doc.title', affects: 'meta', data: { title } }], {
        title,
        notify: { kind: 'title', title },
      });
    });
  }

  // -------------------------------------------------------------------------
  // 快照 / 历史 / 恢复
  // -------------------------------------------------------------------------

  async snapshot(message?: string, reason?: SnapshotReason): Promise<SnapshotInfo> {
    if (this.readonlyValue) throw new Error(`作品为只读模式：${this.readonlyReason}`);
    return this.enqueue(async () => {
      this.ensureWritable();
      return this.appendSnapshotInternal(message, reason ?? 'manual');
    });
  }

  private async appendSnapshotInternal(message: string | undefined, reason: SnapshotReason): Promise<SnapshotInfo> {
    const text = this.textValue;
    const data: EventData = {
      reason,
      text,
      textHash: await hashText(text),
      chars: text.length,
      eventsSince: this.eventsSinceSnapshot,
    };
    if (message !== undefined) data.message = message;
    const committed = await this.commitEvents([{ type: 'snapshot', affects: 'meta', data }], { notify: null });
    const event = committed[0];
    const info = snapshotInfoFromEvent(event);
    if (!info) throw new Error('生成快照事件失败');
    this.snapshotsCache.push(info);
    this.lastSnapshotAtMs = Date.parse(info.ts);
    if (!Number.isFinite(this.lastSnapshotAtMs)) this.lastSnapshotAtMs = this.core.now().getTime();
    this.eventsSinceSnapshot = 0;
    this.textEventsSinceSnapshot = 0;
    this.textChangedSinceSnapshot = false;
    this.emit({ kind: 'saved', snapshot: info });
    // 快照已落盘：通知引擎调度自动备份（内部回调，异常不得影响快照）
    try {
      this.core.onSnapshot?.(this.docId);
    } catch {
      // 自动备份调度失败静默
    }
    return info;
  }

  async history(): Promise<SnapshotInfo[]> {
    return this.snapshotsCache.slice();
  }

  async previewSnapshot(seq: number): Promise<string> {
    // eventsList 的索引 == seq（连续前缀），O(1) 取快照事件
    const event = this.eventsList[seq];
    if (!event || event.seq !== seq || event.type !== 'snapshot') throw new Error(`快照不存在：seq=${seq}`);
    const text = snapshotTextFromEvent(event);
    if (text === null) throw new Error(`快照数据非法：seq=${seq}`);
    const expectedHash = event.data.textHash;
    if (typeof expectedHash === 'string') {
      const actual = await hashText(text);
      if (actual !== expectedHash) throw new Error(`快照已损坏：seq=${seq} 的 textHash 不一致`);
    }
    return text;
  }

  async restore(seq: number, message?: string): Promise<SnapshotInfo> {
    if (this.readonlyValue) throw new Error(`作品为只读模式：${this.readonlyReason}`);
    return this.enqueue(async () => {
      this.ensureWritable();
      const target = this.eventsList[seq];
      if (!target || target.seq !== seq || target.type !== 'snapshot') throw new Error(`快照不存在：seq=${seq}`);
      const text = snapshotTextFromEvent(target);
      if (text === null) throw new Error(`快照数据非法：seq=${seq}`);
      await this.commitEvents(
        [
          {
            type: 'text.reset',
            affects: 'text',
            data: { text, reason: 'restore', targetSeq: seq, source: 'restore' },
          },
        ],
        { finalText: text, notify: { kind: 'text', text } },
      );
      return this.appendSnapshotInternal(message ?? `恢复到版本 #${seq}`, 'restore');
    });
  }

  // -------------------------------------------------------------------------
  // 校验 / 导出 / flush / close
  // -------------------------------------------------------------------------

  async verify(): Promise<VerifyReport> {
    const rawEvents = await readDocEvents(this.core.db, this.docId);
    const result = await verifyLog(logSourceFromEvents(rawEvents));
    // 打开时检测到主存储事件被截断：日志前缀本身有效，但记录锚点显示还应有更多事件
    const truncatedAt = this.truncatedFromSeq;
    const truncated = truncatedAt !== null && result.ok;
    return {
      docId: this.docId,
      title: this.titleValue,
      ok: truncated ? false : result.ok,
      eventCount: result.events.length,
      source: 'idb',
      chainOk: result.chainOk,
      seqOk: result.seqOk,
      brokenAt: truncated ? truncatedAt : result.brokenAt,
      brokenReason: truncated
        ? `主存储事件缺失（记录锚点 lastSeq=${this.expectedAnchorSeq}，实际最后事件 seq=${result.lastValidSeq}），请用"扫描恢复"从冗余副本修复`
        : result.brokenReason,
      unknownTextEventSeqs: result.unknownTextEventSeqs,
      snapshotMismatchSeqs: result.snapshotMismatchSeqs,
      repaired: false,
      warnings: result.warnings,
    };
  }

  /**
   * 原始输入时间线（只读）：从内存事件流归一化 compose / text / session / mode 条目，按 seq 升序。
   * 默认最多返回最近 2000 条；`limit <= 0` 返回全部（测试用）；非法 limit 按默认。
   * 不写日志、不触发快照；只读句柄同样可调用。
   */
  async getInputTrace(options?: { limit?: number }): Promise<InputTraceEntry[]> {
    const limit = normalizeInputTraceLimit(options?.limit);
    const entries: InputTraceEntry[] = [];
    for (const event of this.eventsList) {
      const entry = inputTraceEntryFromEvent(event);
      if (entry) entries.push(entry);
    }
    if (limit === null || entries.length <= limit) return entries;
    return entries.slice(entries.length - limit);
  }

  async exportLog(): Promise<Blob> {
    // 若作品损坏（只读打开），导出的是已通过校验的最长有效前缀，便于抢救为新文件。
    return new Blob([serializeEvents(this.eventsList)], { type: LOG_FILE_MIME });
  }

  async exportText(): Promise<Blob> {
    return new Blob([this.textValue], { type: 'text/plain;charset=utf-8' });
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.flushMirror();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) {
      await this.queue;
      return;
    }
    this.closing = true;
    try {
      await this.queue;
      if (!this.readonlyValue) {
        await this.enqueue(async () => {
          if (this.textChangedSinceSnapshot) {
            try {
              await this.appendSnapshotInternal(undefined, 'session');
            } catch (error) {
              this.emit({ kind: 'error', error: toError(error) });
            }
          }
          try {
            await this.commitEvents(
              [
                {
                  type: 'session.end',
                  affects: 'meta',
                  data: { sessionId: this.sessionId, endedAt: isoNow(this.core.now) },
                },
              ],
              { notify: null },
            );
          } catch (error) {
            this.emit({ kind: 'error', error: toError(error) });
          }
        });
        await this.queue;
      }
      await this.flushMirror();
    } finally {
      this.closed = true;
      this.clearMirrorTimer();
      this.listeners.clear();
      if (this.lock.held) this.lock.release();
      this.core.onClosed(this.docId);
    }
  }

  // -------------------------------------------------------------------------
  // 引擎内部：回收站等元事件
  // -------------------------------------------------------------------------

  /** 引擎内部：追加 doc.trash / doc.untrash（遵守同一串行队列）。 */
  async appendEngineMeta(type: 'doc.trash' | 'doc.untrash', data: EventData): Promise<void> {
    if (this.readonlyValue) throw new Error(`作品为只读模式：${this.readonlyReason}`);
    return this.enqueue(async () => {
      this.ensureWritable();
      await this.commitEvents([{ type, affects: 'meta', data }], {
        trashed: type === 'doc.trash',
        notify: { kind: 'meta' },
      });
    });
  }

  // -------------------------------------------------------------------------
  // 内部：事件构造 + 落盘 + 内存状态提交
  // -------------------------------------------------------------------------

  private async buildEvents(pending: readonly PendingEvent[]): Promise<LogEvent[]> {
    const events: LogEvent[] = [];
    let seq = this.lastSeq;
    let prev = this.lastHash;
    for (const item of pending) {
      seq += 1;
      const event = await createEvent({
        seq,
        prev,
        type: item.type,
        affects: item.affects,
        data: item.data,
        id: this.core.uuid(),
        ts: isoNow(this.core.now),
      });
      prev = event.hash;
      events.push(event);
    }
    return events;
  }

  private async commitEvents(pending: readonly PendingEvent[], options: CommitOptions): Promise<LogEvent[]> {
    if (pending.length === 0) return [];
    const events = await this.buildEvents(pending);
    const lastEvent = events[events.length - 1];
    let snapshotCount = this.doc.snapshotCount;
    for (const event of events) if (event.type === 'snapshot') snapshotCount += 1;
    const record: DocRecord = {
      ...this.doc,
      title: options.title ?? this.doc.title,
      updatedAt: lastEvent.ts,
      chars: (options.finalText ?? this.textValue).length,
      // 事件数只按计数增量计算，不复制整个事件数组（长文档热路径 O(1)）
      eventCount: this.eventsList.length + events.length,
      snapshotCount,
      trashed: options.trashed ?? this.doc.trashed,
      lastSeq: lastEvent.seq,
      lastHash: lastEvent.hash,
      integrity: 'ok',
      ...options.docPatch,
    };
    // 主存储：同一事务内追加事件 + 更新摘要；事务 complete 后才算落盘。
    await writeDocSnapshot(this.core.db, record, events);

    // 只有写库成功后才修改内存状态（失败时内存与磁盘都保持原状）
    for (const event of events) this.eventsList.push(event);
    this.lastSeq = lastEvent.seq;
    this.lastHash = lastEvent.hash;
    if (options.finalText !== undefined) this.textValue = options.finalText;
    if (options.title !== undefined) this.titleValue = options.title;
    this.doc = record;
    for (const event of events) {
      if (event.affects === 'text') {
        this.textChangedSinceSnapshot = true;
        this.textEventsSinceSnapshot += 1;
      }
      if (event.type !== 'snapshot') this.eventsSinceSnapshot += 1;
    }
    if (this.core.opfs?.available) this.scheduleMirror();
    if (options.notify) this.emit(options.notify);
    return events;
  }

  private async maybeAutoSnapshot(): Promise<void> {
    if (this.readonlyValue || this.closing) return;
    if (!this.textChangedSinceSnapshot) return;
    const { maxEvents, maxIntervalMs } = this.core.autoSnapshot;
    const nowMs = this.core.now().getTime();
    // 阈值只统计正文编辑事件（选区/输入法/模式等 meta 事件不推高快照频率）
    const dueByCount = maxEvents > 0 && this.textEventsSinceSnapshot >= maxEvents;
    const dueByTime = maxIntervalMs > 0 && nowMs - this.lastSnapshotAtMs >= maxIntervalMs;
    if (!dueByCount && !dueByTime) return;
    try {
      await this.appendSnapshotInternal(undefined, 'auto');
    } catch (error) {
      this.emit({ kind: 'error', error: toError(error) });
    }
  }

  // -------------------------------------------------------------------------
  // OPFS 镜像（防抖写入；不可用/失败时静默降级）
  // -------------------------------------------------------------------------

  private scheduleMirror(): void {
    this.mirrorDirty = true;
    this.mirrorRevision += 1;
    if (this.mirrorTimer !== null) return;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      void this.flushMirror();
    }, MIRROR_DEBOUNCE_MS);
  }

  private clearMirrorTimer(): void {
    if (this.mirrorTimer !== null) {
      clearTimeout(this.mirrorTimer);
      this.mirrorTimer = null;
    }
  }

  private async flushMirror(): Promise<void> {
    this.clearMirrorTimer();
    // 只读句柄不写镜像：避免被其它标签页锁定的只读副本用旧内容覆盖新镜像，
    // 也避免损坏/截断的作品把不完整前缀写回冗余副本。
    if (this.readonlyValue) {
      this.mirrorDirty = false;
      return;
    }
    const opfs = this.core.opfs;
    if (!opfs?.available) {
      this.mirrorDirty = false;
      return;
    }
    const revision = this.mirrorRevision;
    if (!this.mirrorDirty && this.mirroredEventCount === this.eventsList.length) {
      if (this.lastMirrorText.length > 0 || this.eventsList.length === 0) return;
    }
    // 增量序列化：只序列化上次成功镜像之后的新事件（日志只增，前缀永不改变）
    const serializedCount = this.eventsList.length;
    let text: string;
    if (this.lastMirrorText.length > 0 && this.mirroredEventCount <= serializedCount) {
      const added = this.eventsList.slice(this.mirroredEventCount);
      text = added.length === 0 ? this.lastMirrorText : this.lastMirrorText + serializeEvents(added);
    } else {
      text = serializeEvents(this.eventsList);
    }
    try {
      await this.core.writeMirror(this.docId, text);
      // 只有写入成功才更新已镜像文本，失败时下一次 flush/close 会重试
      this.lastMirrorText = text;
      this.mirroredEventCount = serializedCount;
      // 写入期间若又有新事件（revision 变化 / 事件变多），保持 dirty，稍后再写
      this.mirrorDirty = this.mirrorRevision !== revision || this.eventsList.length !== serializedCount;
    } catch {
      // 镜像不可用或写入失败：降级，不影响主存储与用户操作；保留脏标记以便重试
      this.mirrorDirty = true;
      this.lastMirrorText = '';
      this.mirroredEventCount = 0;
    }
  }
}

function attachSelectionContext(data: EventData, context: EditContext | undefined): void {
  if (!context) return;
  if (isSelection(context.selectionBefore)) {
    const before: EventData = { from: context.selectionBefore.from, to: context.selectionBefore.to };
    if (context.selectionBefore.direction) before.direction = context.selectionBefore.direction;
    data.selectionBefore = before;
  }
  if (isSelection(context.selectionAfter)) {
    const after: EventData = { from: context.selectionAfter.from, to: context.selectionAfter.to };
    if (context.selectionAfter.direction) after.direction = context.selectionAfter.direction;
    data.selectionAfter = after;
  }
}

// ---------------------------------------------------------------------------
// 原始输入时间线（getInputTrace）
// ---------------------------------------------------------------------------

/** getInputTrace 默认最多返回的事件条数。 */
export const INPUT_TRACE_DEFAULT_LIMIT = 2000;

/** 归一化 limit：undefined/NaN/小数/Infinity → 默认；<=0 → null（不限制）；正整数 → 原值。 */
export function normalizeInputTraceLimit(limit: unknown): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    return INPUT_TRACE_DEFAULT_LIMIT;
  }
  if (limit <= 0) return null;
  return limit;
}

const COMPOSE_PHASES: Record<string, 'start' | 'update' | 'end'> = {
  'compose.start': 'start',
  'compose.update': 'update',
  'compose.end': 'end',
};

const TEXT_OPS: Record<string, 'insert' | 'delete' | 'replace' | 'reset'> = {
  'text.insert': 'insert',
  'text.delete': 'delete',
  'text.replace': 'replace',
  'text.reset': 'reset',
};

function traceInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function traceString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 把单个日志事件归一化为输入时间线条目；无关事件/非法数据返回 null（宽容，不抛错）。 */
function inputTraceEntryFromEvent(event: LogEvent): InputTraceEntry | null {
  const data = event.data;
  const seq = event.seq;
  const ts = event.ts;

  const composePhase = COMPOSE_PHASES[event.type];
  if (composePhase) {
    const entry: Extract<InputTraceEntry, { kind: 'compose' }> = {
      kind: 'compose',
      seq,
      ts,
      phase: composePhase,
      data: traceString(data.data) ?? '',
    };
    const from = traceInteger(data.from);
    if (from !== undefined) entry.from = from;
    const to = traceInteger(data.to);
    if (to !== undefined) entry.to = to;
    const committed = traceString(data.committed);
    if (committed !== undefined) entry.committed = committed;
    const candidate = traceInteger(data.candidate);
    if (candidate !== undefined) entry.candidate = candidate;
    return entry;
  }

  const textOp = TEXT_OPS[event.type];
  if (textOp) {
    const entry: Extract<InputTraceEntry, { kind: 'text' }> = { kind: 'text', seq, ts, op: textOp };
    const pos = traceInteger(data.pos);
    if (pos !== undefined) entry.pos = pos;
    const length = traceInteger(data.length);
    if (length !== undefined) entry.length = length;
    const text = traceString(data.text);
    if (text !== undefined) entry.text = text;
    const deleted = traceString(data.deleted);
    if (deleted !== undefined) entry.deleted = deleted;
    const source = traceString(data.source);
    if (source !== undefined) entry.source = source;
    const inputType = traceString(data.inputType);
    if (inputType !== undefined) entry.inputType = inputType;
    return entry;
  }

  if (event.type === 'session.start' || event.type === 'session.end') {
    const entry: Extract<InputTraceEntry, { kind: 'session' }> = {
      kind: 'session',
      seq,
      ts,
      phase: event.type === 'session.start' ? 'start' : 'end',
    };
    const sessionId = traceString(data.sessionId);
    if (sessionId !== undefined) entry.sessionId = sessionId;
    return entry;
  }

  if (event.type === 'editor.mode') {
    const mode = data.mode;
    if (mode !== 'typewriter' && mode !== 'centered') return null; // 非法 data：宽容忽略
    return { kind: 'mode', seq, ts, mode };
  }

  return null;
}
