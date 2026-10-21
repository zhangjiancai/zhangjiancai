/**
 * 逐字符录制器
 * =============
 * 把 textarea 的原生事件翻译成引擎事件：
 *   - beforeinput 记录 inputType 与变化前的选区；
 *   - input 用引擎导出的 deriveEdit(prev, next) 做最小差异，追加 text.insert / text.delete /
 *     text.replace 事件（删除事件一定带 pos、length 与 deleted 原文）；
 *   - compositionstart/update/end 记录输入法原始过程（受"记录输入法原始过程"开关控制），
 *     组合结束后用"组合开始前的正文 → 最终正文"计算差异，写一条 source='ime' 的正文事件；
 *   - selectionchange 节流 300ms + 去重后调用 setSelection。
 *
 * 关键约束（见 docs/FILE-FORMAT.md 5.3）：
 *   - 组合期间绝不写正文事件；正文事件只在组合结束、正文确定后写一条。
 *   - 浏览器事件顺序差异（compositionend 前后是否还有 input、是否异步提交）用
 *     "同步对账 + setTimeout 兜底 + 输入事件接管"三条路径保证不重复、不遗漏。
 *   - 所有引擎写入串行排队，保证事件顺序与用户操作顺序一致。
 *   - EditConflictError 不吞：用 currentText 重新同步 textarea 并交给上层提示。
 */
import { deriveEdit } from '../../engine';
import { EditConflictError } from '../../engine/types';
import type {
  ComposeEvent,
  DeleteDirection,
  DerivedEdit,
  DocHandle,
  EditContext,
  EditSource,
  SelectionReason,
  SelectionState,
  TextEdit,
} from '../../engine/types';

export interface RecorderSettings {
  recordComposition: boolean;
}

export interface RecorderCallbacks {
  /** 正文或选区变化后（用于重新垂直居中） */
  onAfterChange: () => void;
  onConflict: (error: EditConflictError) => void;
  onError: (error: Error) => void;
}

export interface RecorderOptions {
  handle: DocHandle;
  textarea: HTMLTextAreaElement;
  getSettings: () => RecorderSettings;
  callbacks: RecorderCallbacks;
}

const SELECTION_THROTTLE_MS = 300;

function readSelection(textarea: HTMLTextAreaElement): SelectionState {
  const direction =
    textarea.selectionDirection === 'backward'
      ? 'backward'
      : textarea.selectionDirection === 'forward'
        ? 'forward'
        : 'none';
  return { from: textarea.selectionStart, to: textarea.selectionEnd, direction };
}

function deleteDirectionFor(inputType: string | null): DeleteDirection | undefined {
  if (!inputType) return undefined;
  if (/Backward$/.test(inputType)) return 'backward';
  if (/Forward$/.test(inputType)) return 'forward';
  return undefined;
}

/** 把 DOM InputEvent.inputType 映射为格式规范的 source（未知值按合理默认降级）。 */
export function sourceForInputType(inputType: string | null | undefined): EditSource {
  if (!inputType) return 'typing';
  switch (inputType) {
    case 'insertText':
    case 'insertLineBreak':
    case 'insertParagraph':
    case 'deleteContentBackward':
    case 'deleteContentForward':
    case 'deleteWordBackward':
    case 'deleteWordForward':
    case 'deleteSoftLineBackward':
    case 'deleteSoftLineForward':
    case 'deleteHardLineBackward':
    case 'deleteHardLineForward':
      return 'typing';
    case 'insertFromPaste':
    case 'insertFromPasteAsQuotation':
    case 'insertFromYank':
      return 'paste';
    case 'deleteByCut':
      return 'cut';
    case 'insertFromDrop':
    case 'deleteByDrag':
    case 'insertReplacementText':
      return 'drop';
    case 'historyUndo':
      return 'undo';
    case 'historyRedo':
      return 'redo';
    case 'insertCompositionText':
    case 'deleteCompositionText':
      return 'ime';
    default:
      if (inputType.startsWith('insert') || inputType.startsWith('delete')) return 'typing';
      return 'programmatic';
  }
}

function inferSelectionBefore(derived: DerivedEdit, inputType: string | null): SelectionState {
  if (derived.kind === 'insert') return { from: derived.pos, to: derived.pos, direction: 'none' };
  if (derived.kind === 'delete') {
    const caret = deleteDirectionFor(inputType) === 'forward' ? derived.pos : derived.pos + derived.length;
    return { from: caret, to: caret, direction: 'none' };
  }
  return { from: derived.pos, to: derived.pos + derived.length, direction: 'none' };
}

function toTextEdit(derived: DerivedEdit, source: EditSource, inputType: string | null): TextEdit {
  const common = inputType ? { source, inputType } : { source };
  if (derived.kind === 'insert') {
    return { kind: 'insert', pos: derived.pos, text: derived.text, ...common };
  }
  if (derived.kind === 'delete') {
    const direction = deleteDirectionFor(inputType);
    return {
      kind: 'delete',
      pos: derived.pos,
      length: derived.length,
      deleted: derived.deleted,
      ...common,
      ...(direction ? { direction } : {}),
    };
  }
  return {
    kind: 'replace',
    pos: derived.pos,
    length: derived.length,
    deleted: derived.deleted,
    text: derived.text,
    ...common,
  };
}

function compositionData(event: Event): string {
  const compositionEvent = event as CompositionEvent;
  return typeof compositionEvent.data === 'string' ? compositionEvent.data : '';
}

export class EditRecorder {
  private readonly handle: DocHandle;
  private readonly textarea: HTMLTextAreaElement;
  private readonly getSettings: () => RecorderSettings;
  private readonly callbacks: RecorderCallbacks;

  private previousValue: string;
  private disposed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private inputType: string | null = null;
  private pendingSelectionBefore: SelectionState | null = null;

  private lastLoggedSelectionKey: string | null = null;
  private selectionTimer: number | null = null;
  private pendingSelectionReason: SelectionReason = 'caret';

  private composing = false;
  private compositionBaseText = '';
  private compositionStartSelection: SelectionState | null = null;
  private compositionEndData: string | undefined;
  private compositionEndLogged = false;
  private compositionPendingReconcile = false;
  private compositionReconcileTimer: number | null = null;
  private lastCompositionInputType: string | null = null;
  private pendingExternalText: string | null = null;
  /**
   * 已提交给引擎、但尚未收到对应 DocChange.text 的本地编辑数。
   * 引擎对每次 appendEdit 恰好通知一次 text 变化（分片也只通知一次），
   * 因此用 1:1 计数即可可靠区分"本地编辑回声"与"真正的外部正文变化"，
   * 不依赖文本相等/时间窗/容量，快速输入不会误判。
   */
  private pendingLocalTextEvents = 0;

  private readonly listeners: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];

  constructor(options: RecorderOptions) {
    this.handle = options.handle;
    this.textarea = options.textarea;
    this.getSettings = options.getSettings;
    this.callbacks = options.callbacks;
    this.previousValue = options.textarea.value;
    this.bind();
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  private bind(): void {
    const textarea = this.textarea;
    this.listen(textarea, 'beforeinput', this.onBeforeInput);
    this.listen(textarea, 'input', this.onInput);
    this.listen(textarea, 'compositionstart', this.onCompositionStart);
    this.listen(textarea, 'compositionupdate', this.onCompositionUpdate);
    this.listen(textarea, 'compositionend', this.onCompositionEnd);
    this.listen(textarea, 'select', this.onSelectLike);
    this.listen(textarea, 'keyup', this.onKeyUp);
    this.listen(textarea, 'mouseup', this.onPointerLike);
    this.listen(textarea, 'touchend', this.onPointerLike);
    this.listen(textarea, 'focus', this.onFocus);
    this.listen(document, 'selectionchange', this.onDocumentSelectionChange);
  }

  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.listeners.push({ target, type, listener });
  }

  /** 把尚未入队的待处理事件（选区计时器、组合对账）转成写操作。 */
  private prepareFlush(): void {
    if (this.selectionTimer !== null) {
      window.clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
      this.logSelection(this.pendingSelectionReason);
    }
    if (this.compositionPendingReconcile) {
      this.compositionPendingReconcile = false;
      if (this.compositionReconcileTimer !== null) {
        window.clearTimeout(this.compositionReconcileTimer);
        this.compositionReconcileTimer = null;
      }
      this.commitCompositionText();
    }
  }

  private async waitForWrites(): Promise<void> {
    // 写入队列可能在等待期间继续追加（例如准备 flush 时又记录了选区），
    // 这里循环直到队列不再变化，保证所有 appendEdit/appendCompose 都已真正调用并完成。
    let waited: Promise<void>;
    do {
      waited = this.writeQueue;
      await waited;
    } while (waited !== this.writeQueue);
  }

  /**
   * 等待所有已排队的引擎写入完成（含尚未真正调用 handle.appendEdit 的操作）。
   * 关闭作品/切后台前必须先调用它，否则引擎 flush() 等不到尚未提交的编辑，会丢字。
   * 可重复调用；dispose 后仍安全（只等队列，不再产生新事件）。
   */
  async flush(): Promise<void> {
    if (!this.disposed) this.prepareFlush();
    await this.waitForWrites();
  }

  /** 解绑事件并等待已排队的写入。之后不再产生新事件。 */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.flush();
      return;
    }
    this.prepareFlush();
    this.disposed = true;
    for (const { target, type, listener } of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
    await this.waitForWrites();
  }

  /** 当前正文（与 textarea 一致）。 */
  currentValue(): string {
    return this.textarea.value;
  }

  /**
   * 是否还有本地编辑的 text 变化通知未到达。
   * 为 true 时收到的 DocChange.text 一定是自己编辑的回声，应静默消费。
   */
  hasPendingLocalTextEvents(): boolean {
    return this.pendingLocalTextEvents > 0;
  }

  /** 消费一条本地编辑的 text 变化通知（1:1 计数，不碰 textarea）。 */
  consumeLocalTextEvent(): void {
    if (this.pendingLocalTextEvents > 0) this.pendingLocalTextEvents -= 1;
  }

  /**
   * 外部正文变化（历史恢复等）：重置 textarea 与基准值，不产生编辑事件。
   * 组合输入期间先挂起，组合结束后再应用。
   */
  syncExternalText(text: string): void {
    if (this.composing) {
      this.pendingExternalText = text;
      return;
    }
    this.applyExternalText(text);
  }

  private applyExternalText(text: string): void {
    const textarea = this.textarea;
    if (textarea.value !== text) {
      const caret = Math.min(textarea.selectionStart ?? text.length, text.length);
      textarea.value = text;
      try {
        textarea.setSelectionRange(caret, caret);
      } catch {
        /* 元素不在文档中时忽略 */
      }
    }
    this.previousValue = text;
    this.lastLoggedSelectionKey = null;
    this.callbacks.onAfterChange();
  }

  // -------------------------------------------------------------------------
  // 写队列
  // -------------------------------------------------------------------------

  private enqueueWrite(operation: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(operation).catch((error: unknown) => {
      this.handleWriteError(error);
    });
  }

  /**
   * 正文写入：入队时把"待回声"计数 +1，引擎为这次 appendEdit 恰好回放一次
   * DocChange.text（成功落盘时），由 EditorView 通过 consumeLocalTextEvent 消费；
   * 若写入失败（如 EditConflictError）则不会有回声，这里把计数扣回。
   */
  private enqueueEdit(operation: () => Promise<void>): void {
    this.pendingLocalTextEvents += 1;
    this.writeQueue = this.writeQueue
      .then(operation)
      .catch((error: unknown) => {
        this.pendingLocalTextEvents = Math.max(0, this.pendingLocalTextEvents - 1);
        this.handleWriteError(error);
      });
  }

  private handleWriteError(error: unknown): void {
    if (error instanceof EditConflictError) {
      this.resyncAfterConflict(error.currentText);
      this.callbacks.onConflict(error);
      return;
    }
    this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
  }

  private resyncAfterConflict(currentText: string): void {
    const textarea = this.textarea;
    const start = Math.min(textarea.selectionStart, currentText.length);
    const end = Math.min(textarea.selectionEnd, currentText.length);
    if (textarea.value !== currentText) textarea.value = currentText;
    this.previousValue = currentText;
    try {
      textarea.setSelectionRange(start, Math.max(start, end));
    } catch {
      /* 元素不在文档中时忽略 */
    }
    this.lastLoggedSelectionKey = null;
    this.callbacks.onAfterChange();
  }

  // -------------------------------------------------------------------------
  // 普通输入
  // -------------------------------------------------------------------------

  private onBeforeInput = (event: Event): void => {
    if (this.disposed) return;
    const inputEvent = event as InputEvent;
    this.inputType = inputEvent.inputType || null;
    if (this.composing || inputEvent.isComposing) {
      this.lastCompositionInputType = this.inputType ?? this.lastCompositionInputType;
    } else {
      this.pendingSelectionBefore = readSelection(this.textarea);
    }
  };

  private onInput = (event: Event): void => {
    if (this.disposed) return;
    const inputEvent = event as InputEvent;
    // 组合期间正文尚未确定：不写正文事件，等 compositionend 统一对账。
    if (this.composing || inputEvent.isComposing) {
      this.lastCompositionInputType = inputEvent.inputType || this.lastCompositionInputType;
      return;
    }
    // compositionend 之后的提交 input（部分浏览器异步提交）。
    if (this.compositionPendingReconcile) {
      this.lastCompositionInputType = inputEvent.inputType || this.lastCompositionInputType;
      this.compositionPendingReconcile = false;
      this.clearCompositionReconcileTimer();
      this.commitCompositionText();
      return;
    }
    this.recordTextChange(this.inputType, undefined, this.pendingSelectionBefore);
  };

  /**
   * 计算 prev → next 的最小差异并追加正文事件。
   * 返回 null 表示没有变化（或无法表示差异）。
   */
  private recordTextChange(
    inputType: string | null,
    sourceOverride?: EditSource,
    selectionBeforeOverride?: SelectionState | null,
  ): DerivedEdit | null {
    const textarea = this.textarea;
    const nextValue = textarea.value;
    const selectionBefore = selectionBeforeOverride ?? this.pendingSelectionBefore;
    this.inputType = null;
    this.pendingSelectionBefore = null;

    if (nextValue === this.previousValue) return null;
    const derived = deriveEdit(this.previousValue, nextValue);
    if (!derived) {
      this.previousValue = nextValue;
      return null;
    }

    const source = sourceOverride ?? sourceForInputType(inputType);
    const selectionAfter = readSelection(textarea);
    const edit = toTextEdit(derived, source, inputType);
    const context: EditContext = {
      selectionBefore:
        selectionBefore ?? inferSelectionBefore(derived, inputType),
      selectionAfter,
      ...(inputType ? { inputType } : {}),
    };
    this.previousValue = nextValue;
    this.enqueueEdit(() => this.handle.appendEdit(edit, context));
    this.callbacks.onAfterChange();
    return derived;
  }

  // -------------------------------------------------------------------------
  // 输入法（IME）
  // -------------------------------------------------------------------------

  private onCompositionStart = (event: Event): void => {
    if (this.disposed) return;
    // 上一个组合还没对账完：先把它的正文提交掉。
    if (this.compositionPendingReconcile) {
      this.compositionPendingReconcile = false;
      this.clearCompositionReconcileTimer();
      this.commitCompositionText();
    }
    this.composing = true;
    this.compositionBaseText = this.textarea.value;
    this.previousValue = this.textarea.value;
    this.compositionStartSelection = readSelection(this.textarea);
    this.compositionEndData = undefined;
    this.compositionEndLogged = false;
    this.lastCompositionInputType = null;
    const selection = this.compositionStartSelection;
    this.logCompose({
      phase: 'start',
      data: compositionData(event),
      from: selection.from,
      to: selection.to,
    });
  };

  private onCompositionUpdate = (event: Event): void => {
    if (this.disposed) return;
    if (!this.composing) {
      // 极少数浏览器只发 update 不发 start：按组合开始处理。
      this.composing = true;
      this.compositionBaseText = this.previousValue;
      this.compositionStartSelection = readSelection(this.textarea);
      this.compositionEndLogged = false;
      this.lastCompositionInputType = null;
    }
    const range = this.compositionRange();
    this.logCompose({
      phase: 'update',
      data: compositionData(event),
      from: range.from,
      to: range.to,
    });
  };

  private onCompositionEnd = (event: Event): void => {
    if (this.disposed) return;
    this.composing = false;
    this.compositionEndData = compositionData(event) || undefined;
    this.compositionEndLogged = false;
    this.lastCompositionInputType = this.lastCompositionInputType ?? 'insertCompositionText';
    // 多数浏览器在 compositionend 时 textarea.value 已包含最终文本，直接同步对账。
    if (this.textarea.value !== this.previousValue) {
      this.commitCompositionText();
      return;
    }
    // 异步提交：等一个宏任务，或由随后的 input 事件接管（两条路径互斥）。
    this.compositionPendingReconcile = true;
    this.clearCompositionReconcileTimer();
    this.compositionReconcileTimer = window.setTimeout(() => {
      this.compositionReconcileTimer = null;
      if (!this.compositionPendingReconcile || this.disposed) return;
      this.compositionPendingReconcile = false;
      this.commitCompositionText();
    }, 0);
  };

  /** 组合结束后的正文对账：写一条 source='ime' 的正文事件 + compose.end。 */
  private commitCompositionText(): void {
    const textarea = this.textarea;
    if (textarea.value === this.previousValue) {
      // 组合没有产生正文变化（取消/候选空）：只记 compose.end。
      if (!this.compositionEndLogged) {
        this.logCompositionEnd(undefined);
        this.compositionEndLogged = true;
      }
      this.callbacks.onAfterChange();
      return;
    }
    const derived = deriveEdit(this.previousValue, textarea.value);
    if (!this.compositionEndLogged) {
      this.logCompositionEnd(derived?.text);
      this.compositionEndLogged = true;
    }
    this.recordTextChange(this.lastCompositionInputType, 'ime', this.compositionStartSelection);
    this.callbacks.onAfterChange();
    if (this.pendingExternalText !== null) {
      const pending = this.pendingExternalText;
      this.pendingExternalText = null;
      this.applyExternalText(pending);
    }
  }

  /** 当前预编辑串在正文中的区间（组合过程坐标）。 */
  private compositionRange(): { from: number; to: number } {
    const derived = deriveEdit(this.compositionBaseText, this.textarea.value);
    if (derived) {
      return { from: derived.pos, to: derived.pos + derived.text.length };
    }
    const selection = readSelection(this.textarea);
    return { from: selection.from, to: selection.to };
  }

  private logCompose(event: ComposeEvent): void {
    if (!this.getSettings().recordComposition) return;
    this.enqueueWrite(() => this.handle.appendCompose(event));
  }

  private logCompositionEnd(committed: string | undefined): void {
    this.logCompose({
      phase: 'end',
      data: this.compositionEndData,
      committed: committed || undefined,
    });
  }

  private clearCompositionReconcileTimer(): void {
    if (this.compositionReconcileTimer !== null) {
      window.clearTimeout(this.compositionReconcileTimer);
      this.compositionReconcileTimer = null;
    }
  }

  /** 组合输入是否进行中（外部可查询）。 */
  isComposing(): boolean {
    return this.composing;
  }

  // -------------------------------------------------------------------------
  // 选区
  // -------------------------------------------------------------------------

  private onSelectLike = (): void => {
    this.scheduleSelection('caret');
  };

  private onKeyUp = (): void => {
    this.scheduleSelection('key');
  };

  private onPointerLike = (): void => {
    this.scheduleSelection('click');
  };

  private onFocus = (): void => {
    this.scheduleSelection('focus');
  };

  private onDocumentSelectionChange = (): void => {
    if (document.activeElement !== this.textarea) return;
    this.scheduleSelection('caret');
  };

  private scheduleSelection(reason: SelectionReason): void {
    if (this.disposed || this.composing) return;
    this.pendingSelectionReason = reason;
    if (this.selectionTimer !== null) return;
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = null;
      this.logSelection(this.pendingSelectionReason);
    }, SELECTION_THROTTLE_MS);
  }

  private logSelection(reason: SelectionReason): void {
    if (this.disposed) return;
    const selection = readSelection(this.textarea);
    const key = `${selection.from}:${selection.to}:${selection.direction ?? 'none'}`;
    if (key === this.lastLoggedSelectionKey) return;
    this.lastLoggedSelectionKey = key;
    this.enqueueWrite(() => this.handle.setSelection(selection, reason));
  }
}
