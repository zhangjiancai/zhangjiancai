/** 回收站：软删除的作品列表与恢复。删除永不物理清除日志。 */
import { useCallback, useEffect, useState } from 'react';
import type { DocSummary, LibraryEngine } from '../../engine/types';
import { IconRestore } from '../icons';
import { errorMessage, formatRelativeTime } from '../util';
import { Modal, type ConfirmRequest } from './Modal';
import type { ToastKind } from './ToastHost';

export interface TrashPanelProps {
  engine: LibraryEngine;
  onClose: () => void;
  showToast: (text: string, kind?: ToastKind) => void;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  onChanged: () => void;
}

export function TrashPanel({ engine, onClose, showToast, askConfirm, onChanged }: TrashPanelProps) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await engine.listDocs({ includeTrashed: true });
      setDocs(list.filter((doc) => doc.trashed));
      setLoadError(null);
    } catch (error) {
      setDocs([]);
      setLoadError(errorMessage(error));
    }
  }, [engine]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = useCallback(
    async (doc: DocSummary) => {
      const title = doc.title.trim() || '无题';
      const confirmed = await askConfirm({
        title: '恢复作品',
        message: `从回收站恢复「${title}」？所有内容与版本历史都会保留。`,
        confirmLabel: '恢复',
      });
      if (!confirmed) return;
      setRestoringId(doc.docId);
      try {
        await engine.restoreDoc(doc.docId);
        showToast('已恢复');
        await load();
        onChanged();
      } catch (error) {
        showToast(`恢复失败：${errorMessage(error)}`, 'error');
      } finally {
        setRestoringId(null);
      }
    },
    [askConfirm, engine, load, onChanged, showToast],
  );

  return (
    <Modal
      title="回收站"
      testId="trash-view"
      closeButtonTestId="close-trash-button"
      onClose={onClose}
      className="modal-panel-wide"
    >
      <p className="modal-message muted">移入回收站的作品会保留全部正文与版本历史，可随时恢复。</p>
      {loadError ? (
        <p className="modal-message" role="alert">
          读取回收站失败：{loadError}
        </p>
      ) : docs === null ? (
        <p className="modal-message muted">正在读取…</p>
      ) : docs.length === 0 ? (
        <p className="modal-message muted">回收站是空的。</p>
      ) : (
        <ul className="doc-list trash-list">
          {docs.map((doc) => {
            const title = doc.title.trim() || '无题';
            return (
              <li key={doc.docId}>
                <div className="doc-item" data-testid="trash-item" data-doc-id={doc.docId}>
                  <div className="doc-main">
                    <div className="doc-title">
                      <span className="doc-title-text">{title}</span>
                      <span className="doc-tag">回收站</span>
                    </div>
                    <div className="doc-meta">
                      {doc.chars} 字 · {formatRelativeTime(doc.updatedAt)}
                    </div>
                  </div>
                  <div className="doc-actions">
                    <button
                      type="button"
                      className="button ghost button-small"
                      data-testid="doc-restore-button"
                      disabled={restoringId === doc.docId}
                      onClick={() => void restore(doc)}
                    >
                      <IconRestore />
                      <span>{restoringId === doc.docId ? '恢复中…' : '恢复'}</span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
