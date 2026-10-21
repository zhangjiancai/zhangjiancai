/** WriterTools 根组件：路由（书架/编辑器）、全局弹层、快捷键、主题与引擎初始化。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import './styles.css';
import type { DocHandle } from '../engine/types';
import { EditorView } from './components/EditorView';
import { HistoryPanel } from './components/HistoryPanel';
import { InputTracePanel } from './components/InputTracePanel';
import { LibraryView } from './components/LibraryView';
import { ConfirmDialog, type ConfirmRequest } from './components/Modal';
import { SettingsPanel } from './components/SettingsPanel';
import { ToastHost, useToasts } from './components/ToastHost';
import { TrashPanel } from './components/TrashPanel';
import {
  APP_VERSION,
  INITIAL_SETTINGS,
  applyTheme,
  matchesShortcut,
  normalizeSettings,
  saveSettings,
} from './settings';
import type { AppSettings } from './settings';
import { useEngine, isDemoMode } from './useEngine';
import { errorMessage, formatClock } from './util';

type View = 'library' | 'editor';
type Panel = 'settings' | 'history' | 'trash' | 'trace' | null;

/**
 * 启动自动扫描恢复每次页面加载只执行一次。
 * 放在模块作用域：即使 React 重复挂载（未来的 StrictMode）也不会重复扫描。
 */
let autoRecoveryAttempted = false;

/** 启动备份健康提示每次页面加载最多一次。 */
let backupHealthNotified = false;

function BootError({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  return (
    <div className="boot-screen">
      <div className="boot-card" data-testid="boot-error" role="alert">
        <h1 className="boot-title">无法启动 WriterTools</h1>
        <p className="boot-message">{error ? errorMessage(error) : '未知错误'}</p>
        <ul className="boot-hints muted">
          <li>需要支持 IndexedDB 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版）。</li>
          <li>无痕 / 隐私模式可能禁用本地存储。</li>
          <li>存储空间不足时初始化也会失败，清理可回收空间后重试。</li>
        </ul>
        <button type="button" className="button primary" onClick={onRetry}>
          重试
        </button>
        <p className="boot-version muted">版本 {APP_VERSION}</p>
      </div>
    </div>
  );
}

export default function App() {
  const { status, engine, error, retry } = useEngine();
  const [settings, setSettings] = useState<AppSettings>(INITIAL_SETTINGS);
  const [view, setView] = useState<View>('library');
  const [handle, setHandle] = useState<DocHandle | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [confirmState, setConfirmState] = useState<ConfirmRequest | null>(null);
  const { toasts, show } = useToasts();

  // 全局键盘处理读取 ref，避免频繁重绑监听。
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const panelRef = useRef<Panel>(panel);
  panelRef.current = panel;
  const handleRef = useRef<DocHandle | null>(handle);
  handleRef.current = handle;
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  const confirmOpenRef = useRef(false);
  confirmOpenRef.current = confirmState !== null;
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const lastSavedToastAtRef = useRef(0);
  /** 编辑器注册进来的录制器 flush：关闭作品前必须等它把排队写入提交给引擎。 */
  const editorFlushRef = useRef<(() => Promise<void>) | null>(null);
  const registerEditorFlush = useCallback((flush: (() => Promise<void>) | null) => {
    editorFlushRef.current = flush;
  }, []);

  // 主题：CSS 变量全部由 styles.css 根据 dataset 决定。
  useEffect(() => {
    applyTheme(settings);
  }, [settings]);

  // 移动端可视视口（软键盘弹出时缩小的高度）→ --app-height。
  useEffect(() => {
    const applyViewportHeight = () => {
      const viewport = window.visualViewport;
      const height = viewport ? viewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    };
    applyViewportHeight();
    window.addEventListener('resize', applyViewportHeight);
    window.addEventListener('orientationchange', applyViewportHeight);
    window.visualViewport?.addEventListener('resize', applyViewportHeight);
    return () => {
      window.removeEventListener('resize', applyViewportHeight);
      window.removeEventListener('orientationchange', applyViewportHeight);
      window.visualViewport?.removeEventListener('resize', applyViewportHeight);
    };
  }, []);

  // 启动后台自动扫描本地镜像副本：不阻塞首屏、失败静默、每次页面加载只跑一次。
  // 用户不需要知道「扫描恢复」这个功能，但它必须让丢失的写入自动回来。
  useEffect(() => {
    if (!engine || autoRecoveryAttempted || isDemoMode()) return;
    const timer = window.setTimeout(() => {
      if (autoRecoveryAttempted) return;
      autoRecoveryAttempted = true;
      void (async () => {
        try {
          const report = await engine.recover();
          const conflictCount = report.conflicts.length;
          const hasConflict =
            conflictCount > 0 || report.warnings.some((warning) => warning.includes('冲突') || warning.includes('分歧'));
          if (report.recoveredDocs > 0) {
            const suffix = hasConflict
              ? `；有 ${conflictCount > 0 ? conflictCount : '若干'} 个作品的副本存在分歧，未自动覆盖`
              : '';
            show(`已从镜像恢复 ${report.recoveredDocs} 个作品${suffix}`, 'info', 'auto-recover-toast');
            setLibraryRefresh((value) => value + 1);
          } else if (hasConflict) {
            show(
              `有 ${conflictCount > 0 ? conflictCount : '若干'} 个作品的副本存在分歧，未自动覆盖，请在「设置 · 校验全部」中查看`,
              'info',
              'auto-recover-toast',
            );
            setLibraryRefresh((value) => value + 1);
          }
        } catch (error) {
          // 自动恢复属于增强能力：失败静默降级，绝不能导致启动失败或白屏。
          console.debug('[WriterTools] 启动自动扫描恢复失败（已忽略）：', error);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [engine, show]);

  // 启动备份健康检查：已配置备份目录但权限被浏览器撤销 / 最近一次备份出错时，
  // 一次性提醒用户去设置里处理（不阻塞首屏、失败静默）。
  useEffect(() => {
    if (!engine || backupHealthNotified || isDemoMode()) return;
    const timer = window.setTimeout(() => {
      if (backupHealthNotified) return;
      backupHealthNotified = true;
      void (async () => {
        try {
          const status = await engine.backup().status();
          if (!status.configured) return;
          if (!status.needsPermission && !status.lastError) return;
          const message = status.needsPermission
            ? '备份目录需要重新授权，自动备份已暂停。请到「设置 · 数据安全」点「重新授权备份目录」。'
            : `备份需要处理：${(status.lastError ?? '最近一次备份未成功').replace(/[。.!！]+$/, '')}。请到「设置 · 数据安全」查看。`;
          show(message, 'error', 'backup-health-toast');
        } catch (error) {
          // 健康检查是增强能力：失败静默降级，不影响首屏与正常编辑。
          console.debug('[WriterTools] 启动备份健康检查失败（已忽略）：', error);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [engine, show]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((previous) => {
      const next = normalizeSettings({ ...previous, ...patch });
      saveSettings(next);
      return next;
    });
  }, []);

  const showSavedToast = useCallback(() => {
    const now = Date.now();
    if (now - lastSavedToastAtRef.current < 800) return;
    lastSavedToastAtRef.current = now;
    show('已保存', 'save');
  }, [show]);

  const askConfirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        confirmResolverRef.current = resolve;
        setConfirmState(request);
      }),
    [],
  );

  const resolveConfirm = useCallback((confirmed: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    resolver?.(confirmed);
  }, []);

  const closeDoc = useCallback(() => {
    const current = handleRef.current;
    // 必须在卸载编辑器之前捕获录制器 flush：它会等待尚未真正调用 appendEdit 的排队编辑，
    // 否则 handle.close() 后这些写入会打到已关闭句柄而丢字（v0.1.6 严重数据丢失 bug）。
    const flushEditor = editorFlushRef.current;
    handleRef.current = null;
    setHandle(null);
    setView('library');
    setPanel(null);
    setLibraryRefresh((value) => value + 1);
    if (!current) return;
    void (async () => {
      try {
        await flushEditor?.();
        await current.flush();
        await current.close();
      } catch (error) {
        show(`关闭作品时出错：${errorMessage(error)}`, 'error');
      }
    })();
  }, [show]);

  const openDoc = useCallback(
    async (docId: string) => {
      if (!engine) return;
      try {
        const next = await engine.openDoc(docId);
        setHandle(next);
        setView('editor');
        setPanel(null);
      } catch (error) {
        show(`打开失败：${errorMessage(error)}`, 'error');
      }
    },
    [engine, show],
  );

  const createDoc = useCallback(async () => {
    if (!engine) return;
    try {
      const next = await engine.createDoc();
      setHandle(next);
      setView('editor');
      setPanel(null);
    } catch (error) {
      show(`新建作品失败：${errorMessage(error)}`, 'error');
    }
  }, [engine, show]);

  const manualSave = useCallback(async () => {
    const current = handleRef.current;
    if (!current) return;
    if (current.readonly) {
      show('当前作品为只读模式，无法保存版本', 'info');
      return;
    }
    try {
      await current.snapshot(`手动保存 ${formatClock(new Date())}`, 'manual');
      showSavedToast();
    } catch (error) {
      show(`保存失败：${errorMessage(error)}`, 'error');
    }
  }, [show, showSavedToast]);

  // 全局快捷键：Esc（关弹层 → 返回书架）与可自定义的保存快捷键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (confirmOpenRef.current) {
          event.preventDefault();
          resolveConfirm(false);
          return;
        }
        if (panelRef.current !== null) {
          event.preventDefault();
          setPanel(null);
          return;
        }
        if (viewRef.current === 'editor') {
          event.preventDefault();
          closeDoc();
        }
        return;
      }
      if (confirmOpenRef.current) return;
      if (viewRef.current !== 'editor') return;
      if (matchesShortcut(event, settingsRef.current.saveShortcut)) {
        event.preventDefault();
        if (!event.repeat) void manualSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDoc, manualSave, resolveConfirm]);

  // 关页/切后台兜底 flush：先等录制器写队列（未提交的编辑），再等引擎落盘。
  useEffect(() => {
    if (!engine) return;
    const flush = () => {
      void (async () => {
        try {
          await editorFlushRef.current?.();
        } catch {
          /* 尽力而为 */
        }
        try {
          await engine.flush();
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
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flush);
    };
  }, [engine]);

  if (status === 'loading') {
    return (
      <div className="app" data-testid="app">
        <div className="boot-screen">
          <p className="muted">正在打开本地存储…</p>
        </div>
      </div>
    );
  }

  if (status === 'error' || !engine) {
    return (
      <div className="app" data-testid="app">
        <BootError error={error} onRetry={retry} />
      </div>
    );
  }

  return (
    <div className="app" data-testid="app">
      {view === 'editor' && handle ? (
        <EditorView
          key={handle.docId}
          handle={handle}
          settings={settings}
          onBack={closeDoc}
          onOpenHistory={() => setPanel('history')}
          onOpenSettings={() => setPanel('settings')}
          onOpenTrace={() => setPanel('trace')}
          onUpdateSettings={updateSettings}
          showToast={show}
          showSavedToast={showSavedToast}
          registerFlush={registerEditorFlush}
        />
      ) : (
        <LibraryView
          engine={engine}
          refreshToken={libraryRefresh}
          onOpenDoc={(docId) => void openDoc(docId)}
          onNewDoc={() => void createDoc()}
          onOpenSettings={() => setPanel('settings')}
          onOpenTrash={() => setPanel('trash')}
          showToast={show}
          askConfirm={askConfirm}
        />
      )}

      {panel === 'settings' ? (
        <SettingsPanel
          engine={engine}
          settings={settings}
          onChange={updateSettings}
          onClose={() => setPanel(null)}
          showToast={show}
          onDataChanged={() => setLibraryRefresh((value) => value + 1)}
        />
      ) : null}

      {panel === 'history' && handle ? (
        <HistoryPanel handle={handle} onClose={() => setPanel(null)} showToast={show} askConfirm={askConfirm} />
      ) : null}

      {panel === 'trace' && handle ? (
        <InputTracePanel handle={handle} onClose={() => setPanel(null)} />
      ) : null}

      {panel === 'trash' ? (
        <TrashPanel
          engine={engine}
          onClose={() => setPanel(null)}
          showToast={show}
          askConfirm={askConfirm}
          onChanged={() => setLibraryRefresh((value) => value + 1)}
        />
      ) : null}

      {confirmState ? <ConfirmDialog state={confirmState} onResult={resolveConfirm} /> : null}

      <ToastHost toasts={toasts} />
    </div>
  );
}
