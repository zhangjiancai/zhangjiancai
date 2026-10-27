/** 设置面板：外观、写作、记录、快捷键、数据安全、关于。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type {
  ArchiveImportReport,
  BackupStatus,
  LibraryEngine,
  RecoveryReport,
  StorageStatus,
  VerifyReport,
} from '../../engine/types';
import {
  APP_VERSION,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_WIDTH_MAX,
  LINE_WIDTH_MIN,
  captureShortcut,
  clampNumber,
  defaultSaveShortcut,
  formatShortcut,
} from '../settings';
import type { AppSettings, LightBackground, ThemeMode } from '../settings';
import type { EditorMode } from '../../engine/types';
import {
  archiveIssueLines,
  archiveSummaryText,
  downloadBlob,
  errorMessage,
  formatArchiveFileName,
  formatBytes,
  formatDateTime,
} from '../util';
import { isNativeAndroidPlatform } from '../../platform/native-backup';
import { Modal } from './Modal';
import type { ToastKind } from './ToastHost';

export interface SettingsPanelProps {
  engine: LibraryEngine;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  showToast: (text: string, kind?: ToastKind) => void;
  onDataChanged: () => void;
}

type BusyAction = 'choose' | 'backup' | 'verify' | 'recover' | 'restore' | 'grant' | null;
type ArchiveSource = 'archive' | 'backup-dir' | null;
type ArchiveBusy = 'export' | 'import' | null;

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  unit: string;
  label: string;
  testId: string;
  onCommit: (value: number) => void;
}

function NumberField({ value, min, max, unit, label, testId, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(parsed)) {
      onCommit(Math.round(clampNumber(parsed, min, max)));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <span className="number-field">
      <input
        type="number"
        data-testid={testId}
        aria-label={label}
        min={min}
        max={max}
        step={1}
        inputMode="numeric"
        value={draft}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const parsed = Number(raw);
          if (raw.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            onCommit(Math.round(parsed));
          }
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(draft);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="number-unit">{unit}</span>
    </span>
  );
}

export function SettingsPanel({ engine, settings, onChange, onClose, showToast, onDataChanged }: SettingsPanelProps) {
  const backupService = useMemo(() => engine.backup(), [engine]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [recoverResult, setRecoverResult] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureHint, setCaptureHint] = useState('');
  const [archiveBusy, setArchiveBusy] = useState<ArchiveBusy>(null);
  const [archiveReport, setArchiveReport] = useState<ArchiveImportReport | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveSource, setArchiveSource] = useState<ArchiveSource>(null);
  const shortcutInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const refreshStatus = useCallback(async () => {
    try {
      const [nextStorage, nextBackup] = await Promise.all([engine.storageStatus(), backupService.status()]);
      setStorage(nextStorage);
      setBackup(nextBackup);
      setStatusError(null);
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, [backupService, engine]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const runVerify = useCallback(async () => {
    setBusy('verify');
    try {
      const reports: VerifyReport[] = await engine.verifyAll();
      const failed = reports.filter((report) => !report.ok);
      setVerifyResult(
        failed.length === 0
          ? `校验通过：${reports.length} 个作品，哈希链与快照一致。`
          : `发现 ${failed.length} 个异常作品（共 ${reports.length} 个）：${failed
              .slice(0, 5)
              .map((report) => report.title.trim() || '无题')
              .join('、')}`,
      );
      showToast(failed.length === 0 ? '校验通过' : '校验发现异常', failed.length === 0 ? 'info' : 'error');
    } catch (error) {
      const message = `校验失败：${errorMessage(error)}`;
      setVerifyResult(message);
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  }, [engine, showToast]);

  const runRecover = useCallback(async () => {
    setBusy('recover');
    try {
      const report: RecoveryReport = await engine.recover();
      const conflicts = report.conflicts.length > 0 ? `，冲突 ${report.conflicts.length} 处` : '';
      const warnings = report.warnings.length > 0 ? `。提示：${report.warnings.join('；')}` : '';
      setRecoverResult(`扫描 ${report.scannedCopies} 个副本，恢复 ${report.recoveredDocs} 个作品${conflicts}${warnings}`);
      showToast(report.recoveredDocs > 0 ? `已恢复 ${report.recoveredDocs} 个作品` : '没有需要恢复的作品');
      onDataChanged();
      await refreshStatus();
    } catch (error) {
      const message = `扫描恢复失败：${errorMessage(error)}`;
      setRecoverResult(message);
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  }, [engine, onDataChanged, refreshStatus, showToast]);

  const chooseBackupDirectory = useCallback(async () => {
    setBusy('choose');
    try {
      const chosen = await backupService.chooseDirectory();
      setBackup(chosen);
      if (!chosen.configured) {
        if (chosen.lastError) {
          showToast(`无法使用备份目录：${chosen.lastError}`, 'error');
        } else {
          showToast('未选择备份目录');
        }
        return;
      }
      // 灾难恢复场景：本地库为空时绝不能先做"首次备份"（否则会把备份清单里的
      // 历史条目全部标记为 trashed，甚至覆盖备份目录里的既有副本）。
      // 此时直接提示用户可以「从备份目录恢复」。
      const localDocs = await engine.listDocs({ includeTrashed: true }).catch(() => []);
      if (localDocs.length === 0) {
        showToast('已设置备份目录；本地暂无作品，可直接点「从备份目录恢复」', 'info');
        return;
      }
      // 选好目录后立即做一次首次备份：自动备份只在保存版本/关闭作品时触发，
      // 首次配置时由这里保证目录里马上有完整副本。
      setBusy('backup');
      const status = await backupService.backupNow();
      setBackup(status);
      if (status.lastError) {
        showToast(`已设置备份目录，但首次备份失败：${status.lastError}`, 'error');
      } else {
        showToast(`已设置备份目录并完成首次备份（${status.docCount ?? 0} 个作品）`);
      }
    } catch (error) {
      showToast(`无法选择备份目录：${errorMessage(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [backupService, engine, showToast]);

  const backupNow = useCallback(async () => {
    setBusy('backup');
    try {
      const status = await backupService.backupNow();
      setBackup(status);
      if (status.lastError) {
        showToast(`备份失败：${status.lastError}`, 'error');
      } else {
        showToast(`已备份 ${status.docCount ?? 0} 个作品`);
      }
    } catch (error) {
      showToast(`备份失败：${errorMessage(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [backupService, showToast]);

  /** 备份目录权限被浏览器撤销后，在用户手势中重新申请授权，并立即补一次备份。 */
  const requestBackupPermission = useCallback(async () => {
    if (busy !== null || archiveBusy !== null) return;
    if (!backup?.configured) return;
    setBusy('grant');
    try {
      if (typeof backupService.requestPermission !== 'function') {
        showToast('当前版本引擎暂不支持重新授权，请更新到最新版本', 'error');
        return;
      }
      const status = await backupService.requestPermission();
      setBackup(status);
      const granted = status.permission === 'granted' || status.needsPermission === false;
      if (!granted) {
        showToast('备份目录授权未通过，请在浏览器权限弹窗中允许访问该目录', 'error');
        return;
      }
      showToast('备份目录已重新授权，正在补备份…');
      const afterBackup = await backupService.backupNow();
      setBackup(afterBackup);
      if (afterBackup.lastError) {
        showToast(`备份目录已重新授权，但补备份失败：${afterBackup.lastError}`, 'error');
      } else {
        showToast(`备份目录已重新授权，已补备份 ${afterBackup.docCount ?? 0} 个作品`);
      }
    } catch (error) {
      showToast(`重新授权备份目录失败：${errorMessage(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [archiveBusy, backup?.configured, backupService, busy, showToast]);

  /** 导出全部作品（含回收站）为单个 .wtzip 备份包并下载。 */
  const exportArchive = useCallback(async () => {
    if (archiveBusy !== null) return;
    setArchiveBusy('export');
    try {
      if (typeof engine.exportArchive !== 'function') {
        throw new Error('当前版本引擎暂不支持备份包导出，请更新到最新版本');
      }
      const [docs, blob] = await Promise.all([engine.listDocs({ includeTrashed: true }), engine.exportArchive()]);
      downloadBlob(blob, formatArchiveFileName());
      showToast(`已导出 ${docs.length} 个作品的备份包（${formatBytes(blob.size)}）`);
    } catch (error) {
      showToast(`导出备份包失败：${errorMessage(error)}`, 'error');
    } finally {
      setArchiveBusy(null);
    }
  }, [archiveBusy, engine, showToast]);

  /** 从 .wtzip 备份包恢复/合并；结果常驻显示在数据安全区，直到关闭设置。 */
  const handleArchiveImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = '';
      if (!file || archiveBusy !== null) return;
      setArchiveBusy('import');
      setArchiveError(null);
      setArchiveReport(null);
      setArchiveSource('archive');
      try {
        if (typeof engine.importArchive !== 'function') {
          throw new Error('当前版本引擎暂不支持备份包导入，请更新到最新版本');
        }
        const report = await engine.importArchive(file, file.name);
        setArchiveReport(report);
        const summary = archiveSummaryText(report);
        if (report.conflicts > 0 || report.failed > 0) {
          showToast(`备份包导入完成（注意冲突/失败）：${summary}`, 'error');
        } else {
          showToast(`备份包导入完成：${summary}`);
        }
        onDataChanged();
      } catch (error) {
        const message = errorMessage(error);
        setArchiveError(`备份包「${file.name}」导入失败：${message}`);
        showToast(`导入备份包失败：${message}`, 'error');
      } finally {
        setArchiveBusy(null);
      }
    },
    [archiveBusy, engine, onDataChanged, showToast],
  );

  /** 从已配置的备份目录恢复全部作品（灾备闭环）：浏览器数据丢失后重新选目录 → 一键恢复。 */
  const restoreFromBackupDirectory = useCallback(async () => {
    if (busy !== null || archiveBusy !== null) return;
    if (!backup?.configured) {
      setArchiveSource('backup-dir');
      setArchiveError('从备份目录恢复失败：尚未配置备份目录，请先点「选择备份目录」');
      showToast('尚未配置备份目录，无法从备份目录恢复', 'error');
      return;
    }
    setBusy('restore');
    setArchiveError(null);
    setArchiveReport(null);
    setArchiveSource('backup-dir');
    try {
      if (typeof engine.restoreFromBackupDirectory !== 'function') {
        throw new Error('当前版本引擎暂不支持从备份目录恢复，请更新到最新版本');
      }
      const report = await engine.restoreFromBackupDirectory();
      setArchiveReport(report);
      const summary = archiveSummaryText(report);
      if (report.conflicts > 0 || report.failed > 0) {
        showToast(`从备份目录恢复完成（注意冲突/失败）：${summary}`, 'error');
      } else {
        showToast(`从备份目录恢复完成：${summary}`);
      }
      onDataChanged();
      await refreshStatus();
    } catch (error) {
      const message = errorMessage(error);
      setArchiveError(`从备份目录恢复失败：${message}`);
      showToast(`从备份目录恢复失败：${message}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [archiveBusy, backup?.configured, busy, engine, onDataChanged, refreshStatus, showToast]);

  const archiveIssueList = archiveReport ? archiveIssueLines(archiveReport.docs, 5) : [];
  const archiveWarnings = archiveReport?.warnings.slice(0, 3) ?? [];

  const onShortcutFocus = () => {
    setCapturing(true);
    setCaptureHint('按下新的保存快捷键（需包含 Ctrl / Alt / ⌘），Esc 取消');
  };

  const onShortcutBlur = () => {
    setCapturing(false);
    setCaptureHint('');
  };

  const onShortcutKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setCapturing(false);
      setCaptureHint('');
      event.currentTarget.blur();
      return;
    }
    const binding = captureShortcut(event.nativeEvent);
    if (!binding) {
      setCaptureHint('这个按键不能作为保存快捷键：需要同时包含 Ctrl / Alt / ⌘ 等修饰键');
      return;
    }
    onChange({ saveShortcut: binding });
    setCapturing(false);
    setCaptureHint('');
    event.currentTarget.blur();
  };

  const nativeAndroid = isNativeAndroidPlatform();
  const canChooseDirectory =
    nativeAndroid || (typeof window !== 'undefined' && 'showDirectoryPicker' in window);
  const archiveDisabled = busy !== null || archiveBusy !== null;

  return (
    <Modal
      title="设置"
      testId="settings-panel"
      closeButtonTestId="settings-close"
      onClose={onClose}
      className="modal-panel-wide"
      footer={
        <button type="button" className="button ghost" onClick={onClose}>
          完成
        </button>
      }
    >
      <section className="settings-section">
        <h3 className="settings-heading">外观</h3>
        <label className="field-row">
          <span className="field-label">主题</span>
          <select
            className="field-select"
            data-testid="theme-select"
            value={settings.theme}
            onChange={(event) => onChange({ theme: event.target.value as ThemeMode })}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label className="field-row">
          <span className="field-label">
            浅色背景
            <small className="field-hint">仅在浅色主题下生效</small>
          </span>
          <select
            className="field-select"
            data-testid="light-bg-select"
            value={settings.lightBackground}
            onChange={(event) => onChange({ lightBackground: event.target.value as LightBackground })}
          >
            <option value="white">纯白</option>
            <option value="cream">奶白</option>
          </select>
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">写作</h3>
        <label className="field-row">
          <span className="field-label">默认排版模式</span>
          <select
            className="field-select"
            data-testid="mode-select"
            value={settings.mode}
            onChange={(event) => onChange({ mode: event.target.value as EditorMode })}
          >
            <option value="typewriter">打字机（行右端对齐、向左生长）</option>
            <option value="centered">居中（常规排版、光标居中）</option>
          </select>
        </label>
        <div className="field-row">
          <span className="field-label">字号</span>
          <NumberField
            value={settings.fontSize}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            unit="px"
            label="正文字号"
            testId="font-size-input"
            onCommit={(fontSize) => onChange({ fontSize })}
          />
        </div>
        <div className="field-row">
          <span className="field-label">行宽</span>
          <NumberField
            value={settings.lineWidth}
            min={LINE_WIDTH_MIN}
            max={LINE_WIDTH_MAX}
            unit="em"
            label="写作列行宽"
            testId="line-width-input"
            onCommit={(lineWidth) => onChange({ lineWidth })}
          />
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">记录</h3>
        <label className="field-row field-row-checkbox">
          <span className="field-label">
            记录输入法原始过程
            <small className="field-hint">
              记录拼音、候选等未上屏内容（属于敏感数据，只保存在本机日志）。关闭后仍完整记录最终上屏的正文。
            </small>
          </span>
          <input
            type="checkbox"
            className="field-checkbox"
            data-testid="record-composition-toggle"
            checked={settings.recordComposition}
            onChange={(event) => onChange({ recordComposition: event.target.checked })}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">快捷键</h3>
        <div className="field-row">
          <span className="field-label">
            保存快捷键
            <small className="field-hint">立即生成一个版本快照；点击输入框后按下新组合键</small>
          </span>
          <span className="shortcut-field">
            <input
              ref={shortcutInputRef}
              type="text"
              className="field-input shortcut-input"
              data-testid="save-shortcut-input"
              aria-label="保存快捷键"
              readOnly
              value={capturing ? '按下组合键…' : formatShortcut(settings.saveShortcut)}
              onFocus={onShortcutFocus}
              onBlur={onShortcutBlur}
              onKeyDown={onShortcutKeyDown}
            />
            <button
              type="button"
              className="button ghost button-small"
              data-testid="shortcut-reset-button"
              onClick={() => onChange({ saveShortcut: defaultSaveShortcut() })}
            >
              默认
            </button>
          </span>
        </div>
        {captureHint ? <p className="field-hint settings-inline-hint">{captureHint}</p> : null}
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">数据安全</h3>
        <div className="status-block" data-testid="storage-status">
          {statusError ? (
            <div className="status-line status-line-error">存储状态读取失败：{statusError}</div>
          ) : (
            <>
              <div className="status-line">
                持久化存储：
                {storage
                  ? storage.persistent === null
                    ? '浏览器不支持探测'
                    : storage.persistent
                      ? '已授权（浏览器不会自动清理）'
                      : '未授权（空间紧张时浏览器可能清理数据，建议定期备份）'
                  : '读取中…'}
              </div>
              <div className="status-line">
                本地用量：{storage ? formatBytes(storage.usage) : '读取中…'} / 配额：
                {storage ? formatBytes(storage.quota) : '读取中…'}
              </div>
              <div className="status-line">
                OPFS 镜像：{storage ? (storage.opfs ? '可用' : '不可用') : '读取中…'}
              </div>
              <div className="status-line" data-testid="backup-status">
                备份目录：
                {backup
                  ? backup.configured
                    ? `已配置${backup.directoryName ? `（${backup.directoryName}）` : ''}${
                        backup.backend === 'native' ? ' · 手机目录' : ''
                      }`
                    : '未配置'
                  : '读取中…'}
                {backup?.lastBackupAt ? ` · 上次备份 ${formatDateTime(backup.lastBackupAt)}` : ''}
                {backup?.needsPermission
                  ? backup.permission === 'denied'
                    ? ' · 权限被拒绝（自动备份已暂停）'
                    : ' · 需要重新授权（自动备份已暂停）'
                  : backup?.permission === 'denied'
                    ? ' · 权限被拒绝'
                    : ''}
                {backup?.lastError ? ` · 备份错误：${backup.lastError}` : ''}
              </div>
              <div className="status-line muted">
                配置后会在每次保存版本 / 关闭作品时自动备份到该目录（约 3 秒防抖），不需要再点立即备份。
              </div>
              <div className="status-line muted">
                如果浏览器数据丢失，重新选择备份目录后点「从备份目录恢复」，即可从磁盘上的 .wtlog 副本恢复。
              </div>
            </>
          )}
          {verifyResult ? (
            <div className="status-line" data-testid="verify-result">
              {verifyResult}
            </div>
          ) : null}
          {recoverResult ? (
            <div className="status-line" data-testid="recover-result">
              {recoverResult}
            </div>
          ) : null}
          {nativeAndroid ? (
            <div className="status-line muted">
              {backup?.configured
                ? '已使用手机上的文件夹作为备份目录，自动备份受 Android 系统持久授权保护。'
                : '选择手机上的文件夹用于自动备份（Android 系统文件选择器）。'}
            </div>
          ) : !canChooseDirectory ? (
            <div className="status-line muted">当前浏览器不支持选择备份目录（需要 Chrome / Edge 桌面版）。</div>
          ) : null}
          <div className="status-line muted">
            全量备份包（.wtzip）包含全部作品（含回收站），可导出后在其它设备/浏览器一键恢复。
          </div>
          {archiveError ? (
            <div className="status-line status-line-error" data-testid="archive-import-result" role="alert">
              {archiveError}
            </div>
          ) : busy === 'restore' ? (
            <div className="status-line" data-testid="archive-import-result">
              正在从备份目录恢复作品…
            </div>
          ) : archiveBusy === 'import' ? (
            <div className="status-line" data-testid="archive-import-result">
              正在导入备份包并合并副本…
            </div>
          ) : archiveReport ? (
            <div className="status-line" data-testid="archive-import-result">
              <div>
                {archiveSource === 'backup-dir' ? '从备份目录恢复结果' : '备份包导入结果'}：
                {archiveSummaryText(archiveReport)}
              </div>
              {archiveIssueList.length > 0 ? (
                <ul className="archive-issue-list">
                  {archiveIssueList.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {archiveReport.warnings.length > 0 ? (
                <div className="muted">
                  提示：{archiveWarnings.join('；')}
                  {archiveReport.warnings.length > archiveWarnings.length ? '…' : ''}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="button ghost"
            data-testid="backup-choose-button"
            disabled={archiveDisabled}
            onClick={() => void chooseBackupDirectory()}
          >
            {busy === 'choose' ? '正在选择…' : '选择备份目录'}
          </button>
          <button
            type="button"
            className="button ghost"
            data-testid="backup-now-button"
            disabled={archiveDisabled || !backup?.configured}
            onClick={() => void backupNow()}
          >
            {busy === 'backup' ? '正在备份…' : '立即备份'}
          </button>
          {backup?.configured && backup?.needsPermission ? (
            <button
              type="button"
              className="button ghost"
              data-testid="backup-grant-button"
              disabled={archiveDisabled}
              title="浏览器已暂停对该备份目录的访问权限，点击重新授权"
              onClick={() => void requestBackupPermission()}
            >
              {busy === 'grant' ? '正在请求授权…' : '重新授权备份目录'}
            </button>
          ) : null}
          <button
            type="button"
            className="button ghost"
            data-testid="restore-from-backup-button"
            disabled={archiveDisabled || !backup?.configured}
            title="从已配置的备份目录恢复全部作品（浏览器数据丢失后的灾备入口）"
            onClick={() => void restoreFromBackupDirectory()}
          >
            {busy === 'restore' ? '正在恢复…' : '从备份目录恢复'}
          </button>
          <button
            type="button"
            className="button ghost"
            data-testid="verify-all-button"
            disabled={archiveDisabled}
            onClick={() => void runVerify()}
          >
            {busy === 'verify' ? '正在校验…' : '校验全部'}
          </button>
          <button
            type="button"
            className="button ghost"
            data-testid="recover-button"
            disabled={archiveDisabled}
            onClick={() => void runRecover()}
          >
            {busy === 'recover' ? '正在扫描…' : '扫描恢复'}
          </button>
          <button
            type="button"
            className="button ghost"
            data-testid="export-archive-button"
            disabled={archiveDisabled}
            title="把全部作品（含回收站）导出为一个 .wtzip 备份包"
            onClick={() => void exportArchive()}
          >
            {archiveBusy === 'export' ? '正在导出…' : '导出全部备份包（.wtzip）'}
          </button>
          <label
            className={`button ghost${archiveDisabled ? ' is-disabled' : ''}`}
            data-testid="import-archive-button"
            title="从 .wtzip 备份包恢复/合并作品"
            aria-disabled={archiveDisabled}
            onClick={(event) => {
              if (archiveDisabled) event.preventDefault();
            }}
          >
            {archiveBusy === 'import' ? '正在导入…' : '从备份包恢复（.wtzip）'}
            <input
              ref={archiveInputRef}
              type="file"
              className="visually-hidden-input"
              data-testid="import-archive-input"
              accept=".wtzip,application/zip"
              disabled={archiveDisabled}
              onChange={(event) => void handleArchiveImport(event)}
            />
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">关于</h3>
        <div className="status-block">
          <div className="status-line">WriterTools 版本 {APP_VERSION}</div>
          <div className="status-line">文件格式 v1.0（WTL，追加式 JSON Lines，带哈希链校验）</div>
          <div className="status-line muted">
            所有正文与版本历史都以追加方式写入本机日志，删除的内容与位置会完整留档；数据不上传任何服务器。
          </div>
        </div>
      </section>
    </Modal>
  );
}
