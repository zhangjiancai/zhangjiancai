/** 编辑器：打字机/居中两种排版、光标行垂直居中、逐字符录制、标题改名。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { DocChange, DocHandle, EditorMode } from '../../engine/types';
import type { AppSettings } from '../settings';
import { CaretCentering } from '../editor/centering';
import { EditRecorder } from '../editor/recorder';
import { IconAlignLeft, IconAlignRight, IconBack, IconHistory, IconSettings, IconTrace } from '../icons';
import { errorMessage } from '../util';
import type { ToastKind } from './ToastHost';

type EditorCssVars = CSSProperties & Record<`--${string}`, string | number>;

export interface EditorViewProps {
  handle: DocHandle;
  settings: AppSettings;
  onBack: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenTrace: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  showToast: (text: string, kind?: ToastKind) => void;
  showSavedToast: () => void;
  /**
   * 把录制器的 flush() 注册给 App：关闭作品前必须先等待录制器写队列清空，
   * 否则尚未真正调用 handle.appendEdit 的排队编辑会在 handle.close() 后丢失。
   */
  registerFlush?: (flush: (() => Promise<void>) | null) => void;
}

export function EditorView({
  handle,
  settings,
  onBack,
  onOpenHistory,
  onOpenSettings,
  onOpenTrace,
  onUpdateSettings,
  showToast,
  showSavedToast,
  registerFlush,
}: EditorViewProps) {
  const viewRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const centeringRef = useRef<CaretCentering | null>(null);
  const recorderRef = useRef<EditRecorder | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const showSavedToastRef = useRef(showSavedToast);
  showSavedToastRef.current = showSavedToast;

  const [title, setTitle] = useState(() => handle.title.trim() || '无题');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const skipBlurCommitRef = useRef(false);
  const recordedModeRef = useRef<EditorMode>(settings.mode);

  // 初始化：写入正文、把光标放到末尾、建立录制器与居中控制器。
  useEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;

    textarea.value = handle.text;
    const end = textarea.value.length;
    try {
      textarea.setSelectionRange(end, end);
    } catch {
      /* 忽略：某些环境不支持 setSelectionRange */
    }

    const centering = new CaretCentering({ textarea, mirror });
    centeringRef.current = centering;

    // 只读句柄（作品正被其它标签页/窗口打开）：不绑定录制器，
    // 避免选区/输入法/编辑写入被引擎拒绝后弹出无关错误提示。
    const recorder = handle.readonly
      ? null
      : new EditRecorder({
          handle,
          textarea,
          getSettings: () => ({ recordComposition: settingsRef.current.recordComposition }),
          callbacks: {
            onAfterChange: () => centering.schedule(),
            onConflict: () => {
              showToastRef.current('检测到正文冲突，已用本地日志重新同步', 'error');
              centering.schedule();
            },
            onError: (error) => {
              showToastRef.current(`写入失败：${errorMessage(error)}`, 'error');
            },
          },
        });
    recorderRef.current = recorder;
    registerFlush?.(recorder ? () => recorder.flush() : null);

    centering.schedule();
    const frame = window.requestAnimationFrame(() => centering.schedule());
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(() => centering.schedule()).catch(() => undefined);

    textarea.focus({ preventScroll: true });

    return () => {
      window.cancelAnimationFrame(frame);
      registerFlush?.(null);
      void recorder?.dispose();
      centering.dispose();
      recorderRef.current = null;
      centeringRef.current = null;
    };
  }, [handle, registerFlush]);

  // 订阅引擎变更：外部正文同步（忽略自身编辑回声）、标题、手动保存提示、错误。
  useEffect(() => {
    const unsubscribe = handle.on((change: DocChange) => {
      switch (change.kind) {
        case 'text': {
          const recorder = recorderRef.current;
          if (recorder) {
            // 引擎对每次 appendEdit 恰好回放一次 text 变化：计数匹配即本地编辑回声，
            // 静默消费，绝不碰 textarea（避免快速输入时回滚正文/光标）。
            if (recorder.hasPendingLocalTextEvents()) {
              recorder.consumeLocalTextEvent();
              return;
            }
            if (change.text === recorder.currentValue()) return;
            recorder.syncExternalText(change.text);
            centeringRef.current?.schedule();
          } else {
            // 只读模式：没有录制器，也把外部正文变化同步到界面（例如别处恢复）。
            const textarea = textareaRef.current;
            if (textarea && textarea.value !== change.text) {
              textarea.value = change.text;
              try {
                textarea.setSelectionRange(change.text.length, change.text.length);
              } catch {
                /* 元素不在文档中时忽略 */
              }
              centeringRef.current?.schedule();
            }
          }
          showToastRef.current('正文已同步', 'info');
          return;
        }
        case 'title':
          setTitle(change.title.trim() || '无题');
          return;
        case 'saved':
          if (change.snapshot.reason === 'manual') showSavedToastRef.current();
          return;
        case 'error':
          showToastRef.current(`存储错误：${errorMessage(change.error)}`, 'error');
          return;
        default:
          return;
      }
    });
    return unsubscribe;
  }, [handle]);

  // 外部设置变化（设置面板改默认排版模式）时记录 editor.mode 事件（只读句柄不写）。
  useEffect(() => {
    if (recordedModeRef.current === settings.mode) return;
    recordedModeRef.current = settings.mode;
    if (handle.readonly) return;
    void handle.setMode(settings.mode).catch((error: unknown) => {
      showToastRef.current(`记录排版模式失败：${errorMessage(error)}`, 'error');
    });
  }, [settings.mode, handle]);

  // 字号/行宽/排版模式变化后重新居中。
  useEffect(() => {
    centeringRef.current?.schedule();
  }, [settings.fontSize, settings.lineWidth, settings.mode]);

  // 切后台/关页面前 flush：先等录制器写队列（未提交的编辑），再等引擎落盘。
  useEffect(() => {
    const flush = () => {
      void (async () => {
        try {
          await recorderRef.current?.flush();
        } catch {
          /* 尽力而为 */
        }
        try {
          await handle.flush();
        } catch {
          /* 尽力而为 */
        }
      })();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [handle]);

  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.focus({ preventScroll: true });
    renameInputRef.current?.select();
  }, [renaming]);

  const toggleMode = useCallback(() => {
    const next: EditorMode = settingsRef.current.mode === 'typewriter' ? 'centered' : 'typewriter';
    onUpdateSettings({ mode: next });
    window.requestAnimationFrame(() => centeringRef.current?.schedule());
  }, [onUpdateSettings]);

  const beginRename = () => {
    skipBlurCommitRef.current = false;
    setRenameValue(title);
    setRenaming(true);
  };

  const commitRename = useCallback(async () => {
    setRenaming(false);
    const next = renameValue.trim() || '无题';
    if (next === title) return;
    setTitle(next);
    try {
      await handle.setTitle(next);
    } catch (error) {
      showToastRef.current(`改名失败：${errorMessage(error)}`, 'error');
    }
  }, [handle, renameValue, title]);

  const cancelRename = () => {
    skipBlurCommitRef.current = true;
    setRenaming(false);
  };

  const onRenameBlur = () => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    void commitRename();
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void commitRename();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    }
  };

  const editorStyle: EditorCssVars = {
    '--editor-font-size': `${settings.fontSize}px`,
    '--editor-line-width': settings.lineWidth,
  };

  const modeLabel = settings.mode === 'typewriter' ? '打字机模式' : '居中模式';
  const nextModeLabel = settings.mode === 'typewriter' ? '居中模式' : '打字机模式';

  return (
    <div
      ref={viewRef}
      className="editor-view"
      data-testid="editor-view"
      data-mode={settings.mode}
      style={editorStyle}
    >
      <header className="editor-header">
        <button
          type="button"
          className="icon-button"
          data-testid="editor-library-button"
          aria-label="返回书架"
          title="返回书架（Esc）"
          onClick={onBack}
        >
          <IconBack />
        </button>

        {handle.readonly ? (
          <span className="editor-title is-readonly" title="只读模式，无法改名">
            {title}
          </span>
        ) : renaming ? (
          <input
            ref={renameInputRef}
            className="editor-title-input"
            data-testid="title-input"
            aria-label="作品标题"
            value={renameValue}
            maxLength={120}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={onRenameBlur}
            onKeyDown={onRenameKeyDown}
          />
        ) : (
          <button
            type="button"
            className="editor-title"
            data-testid="editor-title-button"
            title="点击改名"
            onClick={beginRename}
          >
            {title}
          </button>
        )}

        <div className="editor-header-spacer" />

        <button
          type="button"
          className="icon-button"
          data-testid="mode-toggle"
          aria-label={`当前：${modeLabel}，点击切换为${nextModeLabel}`}
          title={`当前：${modeLabel}，点击切换为${nextModeLabel}`}
          onClick={toggleMode}
        >
          {settings.mode === 'typewriter' ? <IconAlignRight /> : <IconAlignLeft />}
        </button>
        <button
          type="button"
          className="icon-button"
          data-testid="editor-trace-button"
          aria-label="原始输入"
          title="原始输入（查看/回放输入过程）"
          onClick={onOpenTrace}
        >
          <IconTrace />
        </button>
        <button
          type="button"
          className="icon-button"
          data-testid="editor-history-button"
          aria-label="版本历史"
          title="版本历史"
          onClick={onOpenHistory}
        >
          <IconHistory />
        </button>
        <button
          type="button"
          className="icon-button"
          data-testid="editor-settings-button"
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
      </header>

      {handle.readonly ? (
        <div className="readonly-banner" role="status" data-testid="readonly-banner">
          此作品已在其它窗口打开，本窗口为只读
        </div>
      ) : null}

      <main className="editor-main">
        <div className="editor-column">
          <div className="editor-inner">
            <div ref={mirrorRef} className="editor-mirror" aria-hidden="true" />
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              data-testid="editor-textarea"
              aria-label="正文"
              defaultValue={handle.text}
              readOnly={handle.readonly}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              wrap="soft"
            />
          </div>
        </div>
      </main>
    </div>
  );
}
