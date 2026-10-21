/**
 * 原始输入回放/查看面板
 * ======================
 * 把 `compose.*`（拼音/预编辑串变化）、正文编辑、场次/排版边界归一化成一条时间线，
 * 支持查看原始 JSON 详情与约 350ms 间隔的播放/单步。只读，不修改任何日志内容。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocHandle, InputTraceEntry } from '../../engine/types';
import { errorMessage, formatClockMilliseconds, formatClockSeconds } from '../util';
import { Modal } from './Modal';

const DEFAULT_LIMIT = 2000;
const PLAY_INTERVAL_MS = 350;
const SUMMARY_TEXT_MAX = 40;

const SOURCE_LABELS: Record<string, string> = {
  typing: '键盘输入',
  ime: 'IME 上屏',
  paste: '粘贴',
  cut: '剪切',
  drop: '拖放',
  undo: '撤销',
  redo: '重做',
  programmatic: '程序写入',
  restore: '版本恢复',
  recovery: '恢复',
  unknown: '未知来源',
};

function truncateSummary(text: string | undefined, max = SUMMARY_TEXT_MAX): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function sourceLabel(source: string | undefined): string {
  if (!source) return '';
  return SOURCE_LABELS[source] ?? source;
}

type ComposeEntry = Extract<InputTraceEntry, { kind: 'compose' }>;
type TextEntry = Extract<InputTraceEntry, { kind: 'text' }>;
type SessionEntry = Extract<InputTraceEntry, { kind: 'session' }>;
type ModeEntry = Extract<InputTraceEntry, { kind: 'mode' }>;

function entryKindLabel(entry: InputTraceEntry): string {
  switch (entry.kind) {
    case 'compose':
      return '输入法';
    case 'text':
      return '正文';
    case 'session':
      return '场次';
    case 'mode':
      return '模式';
    default:
      return '事件';
  }
}

function composeSummary(entry: ComposeEntry): string {
  if (entry.phase === 'start') {
    return entry.data ? `组合开始「${entry.data}」` : '组合开始';
  }
  if (entry.phase === 'update') {
    const range =
      entry.from !== undefined && entry.to !== undefined ? ` · ${entry.from}→${entry.to}` : '';
    const candidate = typeof entry.candidate === 'number' ? ` · 候选 #${entry.candidate}` : '';
    return `预编辑「${entry.data}」${range}${candidate}`;
  }
  return entry.committed ? `组合结束 → 上屏「${truncateSummary(entry.committed)}」` : '组合结束';
}

function textSummary(entry: TextEntry): string {
  const source = sourceLabel(entry.source);
  const suffix = entry.source && entry.source !== 'ime' ? ` · ${source}` : '';
  switch (entry.op) {
    case 'insert': {
      const label = entry.source === 'ime' ? '上屏' : '输入';
      return `${label} +${entry.text?.length ?? 0} 字「${truncateSummary(entry.text)}」${suffix}`;
    }
    case 'delete':
      return `删除 ${entry.length ?? 0} 字「${truncateSummary(entry.deleted)}」${suffix}`;
    case 'replace':
      return `替换「${truncateSummary(entry.deleted)}」→「${truncateSummary(entry.text)}」${suffix}`;
    case 'reset':
      return `重置正文（${entry.text?.length ?? 0} 字）${suffix}`;
    default:
      return '正文变更';
  }
}

function sessionSummary(entry: SessionEntry): string {
  return entry.phase === 'start' ? '写作开始' : '写作结束';
}

function modeSummary(entry: ModeEntry): string {
  return `切换到${entry.mode === 'typewriter' ? '打字机模式' : '居中模式'}`;
}

function entrySummary(entry: InputTraceEntry): string {
  switch (entry.kind) {
    case 'compose':
      return composeSummary(entry);
    case 'text':
      return textSummary(entry);
    case 'session':
      return sessionSummary(entry);
    case 'mode':
      return modeSummary(entry);
    default:
      return '';
  }
}

export interface InputTracePanelProps {
  handle: DocHandle;
  onClose: () => void;
}

export function InputTracePanel({ handle, onClose }: InputTracePanelProps) {
  const [entries, setEntries] = useState<InputTraceEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (all: boolean) => {
      try {
        if (typeof handle.getInputTrace !== 'function') {
          throw new Error('当前版本引擎暂不支持原始输入记录，请更新到最新版本');
        }
        const list = await handle.getInputTrace(all ? { limit: 0 } : { limit: DEFAULT_LIMIT });
        setEntries(list);
        setLoadError(null);
        setTruncated(all ? false : list.length >= DEFAULT_LIMIT);
        setSelectedIndex(list.length > 0 ? 0 : null);
      } catch (error) {
        setEntries([]);
        setLoadError(errorMessage(error));
      }
    },
    [handle],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // 播放：约 350ms 推进一行，到末尾自动停止。
  useEffect(() => {
    if (!playing || entries === null || entries.length === 0) return;
    const timer = window.setInterval(() => {
      setSelectedIndex((previous) => {
        if (previous === null) return 0;
        return Math.min(previous + 1, entries.length - 1);
      });
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, entries]);

  useEffect(() => {
    if (!playing || entries === null) return;
    if (selectedIndex !== null && selectedIndex >= entries.length - 1) setPlaying(false);
  }, [playing, entries, selectedIndex]);

  // 选中行自动滚动到可见区域。
  useEffect(() => {
    if (selectedIndex === null) return;
    const container = listRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const summary = useMemo(() => {
    const list = entries ?? [];
    const composeCount = list.filter((entry) => entry.kind === 'compose').length;
    const imeCount = list.filter((entry) => entry.kind === 'text' && entry.source === 'ime').length;
    const textCount = list.filter((entry) => entry.kind === 'text').length;
    const first = list[0];
    const last = list[list.length - 1];
    return {
      composeCount,
      imeCount,
      textCount,
      range:
        first && last
          ? `${formatClockSeconds(first.ts)}–${formatClockSeconds(last.ts)}`
          : '—',
    };
  }, [entries]);

  const selectedEntry = entries && selectedIndex !== null ? (entries[selectedIndex] ?? null) : null;
  const detailJson = selectedEntry ? JSON.stringify(selectedEntry, null, 2) : '';

  const step = (delta: number) => {
    if (!entries || entries.length === 0) return;
    setPlaying(false);
    setSelectedIndex((previous) => {
      const base = previous ?? 0;
      return Math.min(Math.max(base + delta, 0), entries.length - 1);
    });
  };

  const togglePlay = () => {
    if (!entries || entries.length === 0) return;
    if (!playing && selectedIndex !== null && selectedIndex >= entries.length - 1) {
      setSelectedIndex(0);
    }
    setPlaying((value) => !value);
  };

  const loadAll = async () => {
    setLoadingAll(true);
    try {
      await load(true);
    } finally {
      setLoadingAll(false);
    }
  };

  const busy = entries === null || entries.length === 0;

  return (
    <Modal
      title="原始输入"
      testId="trace-panel"
      closeButtonTestId="trace-close"
      onClose={onClose}
      className="modal-panel-trace"
      footer={
        <>
          <span className="modal-footer-hint">
            {entries ? `共 ${entries.length} 条${truncated ? '（最近 2000 条）' : ''}` : ''}
          </span>
          <button
            type="button"
            className="button ghost button-small"
            data-testid="trace-prev-button"
            disabled={busy}
            onClick={() => step(-1)}
          >
            上一条
          </button>
          <button
            type="button"
            className="button primary button-small"
            data-testid="trace-play-button"
            disabled={busy}
            aria-pressed={playing}
            onClick={togglePlay}
          >
            {playing ? '暂停' : '播放'}
          </button>
          <button
            type="button"
            className="button ghost button-small"
            data-testid="trace-next-button"
            disabled={busy}
            onClick={() => step(1)}
          >
            下一条
          </button>
        </>
      }
    >
      {loadError ? (
        <p className="modal-message" role="alert">
          读取原始输入记录失败：{loadError}
        </p>
      ) : entries === null ? (
        <p className="modal-message muted">正在读取原始输入记录…</p>
      ) : entries.length === 0 ? (
        <p className="modal-message muted">
          这篇作品还没有可展示的输入记录。开始输入（尤其是使用输入法）后再来看看。
        </p>
      ) : (
        <>
          <div className="trace-summary" data-testid="trace-summary">
            <span className="trace-summary-item">
              组合事件 <span className="trace-summary-value">{summary.composeCount}</span>
            </span>
            <span className="trace-summary-item">
              IME 上屏 <span className="trace-summary-value">{summary.imeCount}</span>
            </span>
            <span className="trace-summary-item">
              正文编辑 <span className="trace-summary-value">{summary.textCount}</span>
            </span>
            <span className="trace-summary-item">
              时间范围 <span className="trace-summary-value">{summary.range}</span>
            </span>
          </div>
          {summary.composeCount === 0 ? (
            <p className="trace-hint">
              没有输入法组合记录：可能关闭了「记录输入法原始过程」，或一直使用键盘直接输入。
            </p>
          ) : null}
          {truncated ? (
            <p className="trace-hint">
              只显示最近 {DEFAULT_LIMIT} 条。
              <button
                type="button"
                className="button ghost button-small"
                data-testid="trace-load-all-button"
                disabled={loadingAll}
                onClick={() => void loadAll()}
              >
                {loadingAll ? '正在加载…' : '加载全部'}
              </button>
            </p>
          ) : null}
          <div className="trace-layout">
            <div className="trace-list" ref={listRef} role="listbox" aria-label="原始输入时间线">
              {entries.map((entry, index) => (
                <button
                  key={`${entry.seq}-${index}`}
                  type="button"
                  className={`trace-row${index === selectedIndex ? ' is-selected' : ''}`}
                  data-testid="trace-row"
                  data-index={index}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onClick={() => {
                    setPlaying(false);
                    setSelectedIndex(index);
                  }}
                >
                  <span className="trace-time">{formatClockMilliseconds(entry.ts)}</span>
                  <span className="trace-kind">{entryKindLabel(entry)}</span>
                  <span className="trace-content">{entrySummary(entry)}</span>
                </button>
              ))}
            </div>
            <pre className="trace-detail" data-testid="trace-detail">
              {detailJson || '选择左侧任意一条记录查看详情'}
            </pre>
          </div>
        </>
      )}
    </Modal>
  );
}
