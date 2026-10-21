/** 版本历史：快照列表（时间/说明/字数）、只读预览、二次确认恢复。 */
import { useCallback, useEffect, useState } from 'react';
import type { DocHandle, SnapshotInfo, SnapshotReason } from '../../engine/types';
import { errorMessage, formatDateTime } from '../util';
import { Modal, type ConfirmRequest } from './Modal';
import type { ToastKind } from './ToastHost';

const REASON_LABEL: Record<SnapshotReason, string> = {
  manual: '手动保存',
  auto: '自动保存',
  session: '会话结束',
  restore: '版本恢复',
  import: '导入',
};

export interface HistoryPanelProps {
  handle: DocHandle;
  onClose: () => void;
  showToast: (text: string, kind?: ToastKind) => void;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
}

function snapshotLabel(snapshot: SnapshotInfo): string {
  const message = snapshot.message.trim();
  const fallback = REASON_LABEL[snapshot.reason] ?? snapshot.reason;
  if (!message) return fallback;
  // "手动保存 15:42" 这类消息里的时间与左侧时间列重复，只显示原因标签。
  const timeOnly = new RegExp(`^${fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d{1,2}:\\d{2}$`);
  if (timeOnly.test(message)) return fallback;
  return message;
}

export function HistoryPanel({ handle, onClose, showToast, askConfirm }: HistoryPanelProps) {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const fetchSnapshots = useCallback(async (): Promise<SnapshotInfo[]> => {
    const list = await handle.history();
    return [...list].sort((a, b) => a.seq - b.seq);
  }, [handle]);

  useEffect(() => {
    let alive = true;
    fetchSnapshots()
      .then((list) => {
        if (!alive) return;
        setSnapshots(list);
        setLoadError(null);
        const latest = list[list.length - 1];
        setSelectedSeq((previous) => previous ?? (latest ? latest.seq : null));
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setSnapshots([]);
        setLoadError(errorMessage(error));
      });
    return () => {
      alive = false;
    };
  }, [fetchSnapshots]);

  useEffect(() => {
    if (selectedSeq === null) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    handle
      .previewSnapshot(selectedSeq)
      .then((text) => {
        if (alive) setPreview(text);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setPreview('');
        showToast(`预览失败：${errorMessage(error)}`, 'error');
      })
      .finally(() => {
        if (alive) setPreviewLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedSeq, handle, showToast]);

  const restore = useCallback(async () => {
    if (selectedSeq === null || handle.readonly) return;
    const snapshot = snapshots?.find((item) => item.seq === selectedSeq);
    const when = snapshot ? formatDateTime(snapshot.ts) : '所选时间点';
    const confirmed = await askConfirm({
      title: '恢复版本',
      message: `恢复到「${when}」的版本？当前正文会作为一次新的恢复记录追加到日志末尾，已有历史不会丢失。`,
      confirmLabel: '恢复',
    });
    if (!confirmed) return;
    setRestoring(true);
    try {
      await handle.restore(selectedSeq, `恢复到 ${when}`);
      showToast('已恢复');
      const list = await fetchSnapshots();
      setSnapshots(list);
      const latest = list[list.length - 1];
      if (latest) setSelectedSeq(latest.seq);
    } catch (error) {
      showToast(`恢复失败：${errorMessage(error)}`, 'error');
    } finally {
      setRestoring(false);
    }
  }, [askConfirm, fetchSnapshots, handle, selectedSeq, snapshots, showToast]);

  const ordered = snapshots ? [...snapshots].reverse() : [];

  return (
    <Modal
      title="版本历史"
      testId="history-panel"
      closeButtonTestId="history-close"
      onClose={onClose}
      className="modal-panel-wide"
      footer={
        <>
          <span className="modal-footer-hint">
            {snapshots && snapshots.length > 0 ? `共 ${snapshots.length} 个版本` : ''}
          </span>
          <button
            type="button"
            className="button primary"
            data-testid="history-restore-button"
            disabled={selectedSeq === null || restoring || snapshots === null || handle.readonly}
            onClick={() => void restore()}
          >
            {handle.readonly ? '只读模式下不可恢复' : restoring ? '正在恢复…' : '恢复此版本'}
          </button>
        </>
      }
    >
      {loadError ? (
        <p className="modal-message" role="alert">
          读取历史失败：{loadError}
        </p>
      ) : snapshots === null ? (
        <p className="modal-message muted">正在读取版本…</p>
      ) : snapshots.length === 0 ? (
        <p className="modal-message muted">还没有版本。按保存快捷键（默认 Ctrl+S）会立即生成一个版本快照。</p>
      ) : (
        <div className="history-layout">
          <ul className="history-list">
            {ordered.map((snapshot) => (
              <li key={snapshot.seq}>
                <button
                  type="button"
                  className={`history-item${snapshot.seq === selectedSeq ? ' is-selected' : ''}`}
                  data-testid="history-item"
                  data-seq={snapshot.seq}
                  onClick={() => setSelectedSeq(snapshot.seq)}
                >
                  <span className="history-time">{formatDateTime(snapshot.ts)}</span>
                  <span className="history-label">{snapshotLabel(snapshot)}</span>
                  <span className="history-chars">{snapshot.chars} 字</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="history-preview-wrap">
            <pre className="history-preview" data-testid="history-preview">
              {selectedSeq === null
                ? '选择左侧的版本查看正文'
                : previewLoading
                  ? '正在读取…'
                  : (preview ?? '')}
            </pre>
          </div>
        </div>
      )}
    </Modal>
  );
}
