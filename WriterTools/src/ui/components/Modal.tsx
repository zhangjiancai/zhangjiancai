/** 极简弹层：Modal（通用面板）+ ConfirmDialog（二次确认）。全部键盘可用。 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { IconClose } from '../icons';

export interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  /** 面板根节点 data-testid */
  testId?: string;
  /** 右上角关闭按钮 data-testid */
  closeButtonTestId?: string;
  className?: string;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, children, onClose, footer, testId, closeButtonTestId, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });
    return () => {
      const previous = previousFocusRef.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`modal-panel${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={trapTab}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            title="关闭（Esc）"
            data-testid={closeButtonTestId}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface ConfirmRequest {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function ConfirmDialog({ state, onResult }: { state: ConfirmRequest; onResult: (confirmed: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <Modal
      title={state.title ?? '请确认'}
      onClose={() => onResult(false)}
      testId="confirm-dialog"
      className="modal-panel-small"
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="button ghost"
            data-testid="confirm-cancel"
            onClick={() => onResult(false)}
          >
            {state.cancelLabel ?? '取消'}
          </button>
          <button type="button" className="button primary" data-testid="confirm-ok" onClick={() => onResult(true)}>
            {state.confirmLabel ?? '确定'}
          </button>
        </>
      }
    >
      <p className="confirm-message">{state.message}</p>
    </Modal>
  );
}
