/** 通用格式化与小工具（UI 层专用，不依赖引擎）。 */

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '未知错误';
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 本地时间 → HH:mm。 */
export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** ISO UTC → 本地 HH:mm:ss。 */
export function formatClockSeconds(iso: string | undefined | null): string {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** ISO UTC → 本地 HH:mm:ss.SSS（原始输入时间线用）。 */
export function formatClockMilliseconds(iso: string | undefined | null): string {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${formatClockSeconds(iso)}.${millis}`;
}

/** ISO UTC → 本地 MM-DD HH:mm。 */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** ISO UTC → 相对时间（刚刚 / N 分钟前 / MM-DD HH:mm）。 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) return '未知时间';
  const diff = Math.max(0, now - time);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return formatDateTime(iso);
}

/** 把标题变成安全的文件名（去掉 Windows/macOS 非法字符）。 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '无题';
}

/** 全量备份包默认文件名：writertools-backup-YYYYMMDD-HHmm.wtzip */
export function formatArchiveFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `writertools-backup-${date}-${time}.wtzip`;
}

/** 备份包导入结果的一句话汇总（toast / 常驻结果区共用）。 */
export function archiveSummaryText(report: {
  imported: number;
  merged: number;
  skipped: number;
  conflicts: number;
  failed: number;
}): string {
  return `导入 ${report.imported} · 合并 ${report.merged} · 跳过 ${report.skipped} · 冲突 ${report.conflicts} · 失败 ${report.failed}`;
}

/** 备份包导入里需要用户注意的条目（冲突/失败），最多 limit 条。 */
export function archiveIssueLines(
  docs: Array<{ docId: string; title: string; action: string; message?: string }>,
  limit = 5,
): string[] {
  return docs
    .filter((doc) => doc.action === 'conflict' || doc.action === 'failed')
    .slice(0, limit)
    .map((doc) => {
      const title = doc.title.trim() || '无题';
      const shortId = doc.docId.slice(0, 8);
      const reason = doc.message?.trim() || (doc.action === 'conflict' ? '副本存在分歧，未覆盖本地数据' : '写入失败');
      return `${title}（${shortId}）：${reason}`;
    });
}

/** 触发浏览器下载（先挂到 DOM 再点，兼容 Firefox）。 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
