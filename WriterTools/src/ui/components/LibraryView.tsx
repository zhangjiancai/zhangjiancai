/** 书架：新建 / 打开 / 导入（.wtlog / .wtzip）/ 导出 / 回收站 / 空态。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react';
import type { ArchiveImportReport, DocHandle, DocSummary, LibraryEngine } from '../../engine/types';
import { IconDownload, IconPlus, IconSettings, IconTrash, IconUpload } from '../icons';
import {
  archiveIssueLines,
  archiveSummaryText,
  downloadBlob,
  errorMessage,
  formatRelativeTime,
  safeFileName,
} from '../util';
import type { ToastKind } from './ToastHost';
import { Modal, type ConfirmRequest } from './Modal';

export interface LibraryViewProps {
  engine: LibraryEngine;
  refreshToken: number;
  onOpenDoc: (docId: string) => void;
  onNewDoc: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  showToast: (text: string, kind?: ToastKind) => void;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
}

export function LibraryView({
  engine,
  refreshToken,
  onOpenDoc,
  onNewDoc,
  onOpenSettings,
  onOpenTrash,
  showToast,
  askConfirm,
}: LibraryViewProps) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [archiveReport, setArchiveReport] = useState<ArchiveImportReport | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await engine.listDocs();
      const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setDocs(sorted);
      setLoadError(null);
    } catch (error) {
      setDocs([]);
      setLoadError(errorMessage(error));
    }
  }, [engine]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const handleImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = '';
      if (!file || importing) return;
      const isArchive = /\.wtzip$/i.test(file.name);
      setImporting(true);
      try {
        if (isArchive) {
          if (typeof engine.importArchive !== 'function') {
            throw new Error('当前版本引擎暂不支持备份包导入，请更新到最新版本');
          }
          const report = await engine.importArchive(file, file.name);
          await load();
          const summary = archiveSummaryText(report);
          if (report.conflicts > 0 || report.failed > 0) {
            setArchiveReport(report);
            showToast(`备份包导入完成（注意冲突/失败）：${summary}`, 'error');
          } else {
            showToast(`备份包导入完成：${summary}`);
          }
        } else {
          const summary = await engine.importFile(file, file.name);
          showToast(`已导入「${summary.title.trim() || '无题'}」`);
          await load();
        }
      } catch (error) {
        showToast(`${isArchive ? '导入备份包失败' : '导入失败'}：${errorMessage(error)}`, 'error');
      } finally {
        setImporting(false);
      }
    },
    [engine, importing, load, showToast],
  );

  const handleExport = useCallback(
    async (event: MouseEvent<HTMLButtonElement>, doc: DocSummary) => {
      event.stopPropagation();
      let handle: DocHandle | null = null;
      try {
        handle = await engine.openDoc(doc.docId);
        const blob = await handle.exportLog();
        downloadBlob(blob, `${safeFileName(doc.title.trim() || '无题')}-${doc.docId.slice(0, 8)}.wtlog`);
        showToast('已导出 .wtlog');
      } catch (error) {
        showToast(`导出失败：${errorMessage(error)}`, 'error');
      } finally {
        if (handle) await handle.close().catch(() => undefined);
      }
    },
    [engine, showToast],
  );

  const handleTrash = useCallback(
    async (event: MouseEvent<HTMLButtonElement>, doc: DocSummary) => {
      event.stopPropagation();
      const title = doc.title.trim() || '无题';
      const confirmed = await askConfirm({
        title: '移入回收站',
        message: `将「${title}」移入回收站？所有内容与版本历史都会保留，可随时恢复。`,
        confirmLabel: '移入回收站',
      });
      if (!confirmed) return;
      try {
        await engine.trashDoc(doc.docId);
        showToast('已移入回收站');
        await load();
      } catch (error) {
        showToast(`删除失败：${errorMessage(error)}`, 'error');
      }
    },
    [askConfirm, engine, load, showToast],
  );

  const openDocByKey = (event: KeyboardEvent<HTMLDivElement>, docId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenDoc(docId);
    }
  };

  return (
    <div className="library-view" data-testid="library-view">
      <header className="library-header">
        <span className="brand" aria-label="WriterTools">
          WRITERTOOLS
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="设置"
          title="设置"
          data-testid="library-settings-button"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
      </header>

      <main className="library-main">
        <div className="library-toolbar">
          <button type="button" className="button primary" data-testid="new-doc-button" onClick={onNewDoc}>
            <IconPlus />
            <span>新建作品</span>
          </button>
          <label
            className={`button ghost${importing ? ' is-disabled' : ''}`}
            data-testid="import-button"
            title="导入 .wtlog 作品日志或 .wtzip 全量备份包"
            aria-disabled={importing}
            onClick={(event) => {
              if (importing) event.preventDefault();
            }}
          >
            <IconUpload />
            <span>{importing ? '正在导入…' : '导入 .wtlog / .wtzip'}</span>
            <input
              ref={importInputRef}
              type="file"
              className="visually-hidden-input"
              data-testid="import-file-input"
              accept=".wtlog,.jsonl,.wtlog.jsonl,.wtzip,application/x-writertools-log,application/json,application/zip"
              disabled={importing}
              onChange={handleImport}
            />
          </label>
          <button type="button" className="button ghost" data-testid="open-trash-button" onClick={onOpenTrash}>
            <IconTrash />
            <span>回收站</span>
          </button>
        </div>

        {loadError ? (
          <div className="library-message" role="alert">
            <p>书架读取失败：{loadError}</p>
            <button type="button" className="button ghost" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : docs === null ? (
          <div className="library-message">
            <p className="muted">正在打开书架…</p>
          </div>
        ) : docs.length === 0 ? (
          <div className="library-empty" data-testid="library-empty">
            <p className="library-empty-title">还没有作品</p>
            <p className="muted">点击「新建作品」写下第一行字；也可以导入已有的 .wtlog 文件。</p>
          </div>
        ) : (
          <ul className="doc-list" data-testid="doc-list">
            {docs.map((doc) => {
              const title = doc.title.trim() || '无题';
              return (
                <li key={doc.docId}>
                  <div
                    className="doc-item"
                    data-testid="doc-item"
                    data-doc-id={doc.docId}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenDoc(doc.docId)}
                    onKeyDown={(event) => openDocByKey(event, doc.docId)}
                    aria-label={`打开「${title}」`}
                  >
                    <div className="doc-main">
                      <div className="doc-title">
                        <span className="doc-title-text">{title}</span>
                        {doc.readonly ? <span className="doc-tag">只读</span> : null}
                        {doc.integrity === 'broken' ? <span className="doc-tag">校验异常</span> : null}
                        {doc.trashed ? <span className="doc-tag">回收站</span> : null}
                      </div>
                      <div className="doc-meta">
                        {doc.chars} 字 · {formatRelativeTime(doc.updatedAt)}
                        {doc.snapshotCount > 0 ? ` · ${doc.snapshotCount} 个版本` : ''}
                      </div>
                    </div>
                    <div className="doc-actions">
                      <button
                        type="button"
                        className="icon-button"
                        data-testid="doc-export-button"
                        aria-label={`导出「${title}」为 .wtlog`}
                        title="导出 .wtlog"
                        onClick={(event) => void handleExport(event, doc)}
                      >
                        <IconDownload />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        data-testid="doc-trash-button"
                        aria-label={`将「${title}」移入回收站`}
                        title="移入回收站"
                        onClick={(event) => void handleTrash(event, doc)}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <footer className="library-footer">
        <span>逐字符记录 · 自动保存 · 数据只保存在本机浏览器</span>
      </footer>

      {archiveReport ? (
        <Modal
          title="备份包导入结果"
          testId="archive-import-modal"
          onClose={() => setArchiveReport(null)}
          className="modal-panel-small"
          footer={
            <button type="button" className="button primary" onClick={() => setArchiveReport(null)}>
              知道了
            </button>
          }
        >
          <p className="modal-message">{archiveSummaryText(archiveReport)}</p>
          {archiveIssueLines(archiveReport.docs, 8).length > 0 ? (
            <ul className="archive-issue-list">
              {archiveIssueLines(archiveReport.docs, 8).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {archiveReport.warnings.length > 0 ? (
            <p className="modal-message muted">提示：{archiveReport.warnings.slice(0, 3).join('；')}</p>
          ) : null}
          <p className="modal-message muted">本地已有作品不会被覆盖；冲突副本会保留并可在「设置 · 校验全部」中查看。</p>
        </Modal>
      ) : null}
    </div>
  );
}
