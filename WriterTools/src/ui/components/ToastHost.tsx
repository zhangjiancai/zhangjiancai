/**
 * 轻提示（toast）：顶部居中的中性色短提示，自动消失、不打断书写。
 * 同一文案同时只保留一条；最多同时 2 条，避免叠出一串噪声。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'info' | 'save' | 'error';

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  /** 可选的额外 data-testid，便于 e2e 精确定位特定提示（如启动自动恢复）。 */
  testId?: string;
}

export interface ToastApi {
  show: (text: string, kind?: ToastKind, testId?: string) => void;
}

const DISMISS_MS: Record<ToastKind, number> = { info: 2200, save: 1800, error: 4200 };
const MAX_TOASTS = 2;

export function useToasts(): ToastApi & { toasts: ToastItem[] } {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastsRef = useRef<ToastItem[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef(new Map<number, number>());

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const remove = useCallback(
    (id: number) => {
      clearTimer(id);
      const next = toastsRef.current.filter((item) => item.id !== id);
      toastsRef.current = next;
      setToasts(next);
    },
    [clearTimer],
  );

  const show = useCallback(
    (text: string, kind: ToastKind = 'info', testId?: string) => {
      // 相同文案已可见：只重置该条的计时，不再新增（去重）。
      const existing = toastsRef.current.find((item) => item.text === text);
      if (existing) {
        clearTimer(existing.id);
        timersRef.current.set(
          existing.id,
          window.setTimeout(() => remove(existing.id), DISMISS_MS[kind]),
        );
        return;
      }

      idRef.current += 1;
      const id = idRef.current;
      const next: ToastItem[] = [...toastsRef.current, { id, text, kind, ...(testId ? { testId } : {}) }];
      while (next.length > MAX_TOASTS) {
        const dropped = next.shift();
        if (dropped) clearTimer(dropped.id);
      }
      toastsRef.current = next;
      setToasts(next);
      timersRef.current.set(
        id,
        window.setTimeout(() => remove(id), DISMISS_MS[kind]),
      );
    },
    [clearTimer, remove],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, show };
}

export function ToastHost({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} data-testid="toast" role="status">
          {toast.kind === 'save' ? (
            <span data-testid="save-toast">{toast.text}</span>
          ) : toast.testId ? (
            <span data-testid={toast.testId}>{toast.text}</span>
          ) : (
            <span>{toast.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}
