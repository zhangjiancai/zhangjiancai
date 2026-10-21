/**
 * 全量备份包 `.wtzip` 导出/导入（规范 docs/FILE-FORMAT.md §9、§9.1）。
 *
 * 包结构（标准 ZIP）：
 * - `writertools-manifest.json`：§9 清单（含 lastSeq / lastHash / fileHash 外部锚点）
 * - `<安全标题>-<docId 前 8 位>.wtlog`：每个作品一份完整日志原文（含回收站）
 *
 * 导入规则（§9.1，只增不删、不覆盖更新数据）：
 * - 本地不存在 → imported（写入全部事件 + 摘要，回收站状态按备份清单恢复）
 * - 链尾一致 → skipped；本地是备份严格前缀 → merged（只追加缺失事件）
 * - 备份是本地前缀（本地更新）→ skipped；相同 seq 分歧 → conflict（不写）
 * - 单条目损坏/fileHash 不匹配/被外部 Web Lock 锁定 → failed，不影响其它作品
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { canonicalJson, sha256BytesHex } from './canonical';
import { safeBackupFileName } from './backup';
import type { DocRecord } from './idb';
import type { LogEvent, VerifyResult } from './log';
import {
  APP_NAME,
  APP_VERSION,
  isNonNegativeInteger,
  isPlainObject,
  parseLogText,
  serializeEvents,
  verifyLog,
} from './log';
import { countSnapshots, recordFromVerify } from './records';
import type { ArchiveDocResult, ArchiveImportReport, IntegrityState } from './types';
import {
  ARCHIVE_FILE_MIME,
  ARCHIVE_MANIFEST_NAME,
  FORMAT_MAJOR,
  FORMAT_MINOR,
  FORMAT_VERSION,
} from './types';

const MANIFEST_MAGIC = 'writertools-backup-manifest';
const MANIFEST_FORMAT_RE = /^(\d+)\.(\d+)$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const LOG_ENTRY_SUFFIX = '.wtlog';

interface ArchiveManifestDoc {
  docId: string;
  title: string;
  file: string;
  lastSeq: number;
  lastHash: string;
  chars: number;
  backupAt: string;
  fileHash: string;
  trashed?: boolean;
}

interface ArchiveManifest {
  magic: string;
  format: string;
  createdAt: string;
  updatedAt: string;
  app: { name: string; version: string };
  docs: unknown[];
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface ArchiveExportDeps {
  listDocRecords(): Promise<DocRecord[]>;
  readDocEvents(docId: string): Promise<LogEvent[]>;
  /** 事件存储中出现过的 docId（摘要丢失时也保证事件被导出，避免静默漏备）。 */
  listDocIdsWithEvents?(): Promise<string[]>;
  now(): Date;
}

/** 同一批导出内保证条目名唯一（标题+docId 前 8 位理论上已唯一，这里兜底）。 */
function uniqueArchiveFileName(title: string, docId: string, used: Set<string>): string {
  const base = safeBackupFileName(title, docId);
  let candidate = base;
  let counter = 1;
  while (used.has(candidate.toLowerCase())) {
    counter += 1;
    const stem = base.endsWith(LOG_ENTRY_SUFFIX) ? base.slice(0, -LOG_ENTRY_SUFFIX.length) : base;
    candidate = `${stem}-${counter}${LOG_ENTRY_SUFFIX}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** 导出全部作品（含回收站）为 `.wtzip` Blob。manifest 与日志均为明文 UTF-8。 */
export async function exportArchiveFromStorage(deps: ArchiveExportDeps): Promise<Blob> {
  const records = await deps.listDocRecords();
  const recordById = new Map(records.map((record) => [record.docId, record]));
  // docs 摘要丢失但事件仍在时也要导出（备份不能静默漏作品）
  const eventDocIds = deps.listDocIdsWithEvents ? await deps.listDocIdsWithEvents() : [];
  const allDocIds = [...records.map((record) => record.docId)];
  for (const docId of eventDocIds) if (!recordById.has(docId)) allDocIds.push(docId);

  const backupAt = deps.now().toISOString();
  const manifestDocs: ArchiveManifestDoc[] = [];
  const fileEntries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>([ARCHIVE_MANIFEST_NAME.toLowerCase()]);

  for (const docId of allDocIds) {
    const events = await deps.readDocEvents(docId);
    if (events.length === 0) continue; // 无事件的空摘要没有可备份内容
    const record = recordById.get(docId);
    let title = record ? record.title : '';
    let chars = record ? record.chars : 0;
    let trashed = record ? record.trashed : false;
    if (!record) {
      // 摘要丢失：从日志临时推导，保证至少能把完整事件带走
      const verify = await verifyLog({ values: events, valueLines: [], warnings: [], lineCount: events.length });
      title = verify.headerOk ? verify.title : '';
      chars = verify.headerOk ? verify.text.length : 0;
      trashed = verify.headerOk ? verify.trashed : false;
    }
    const logText = serializeEvents(events);
    const fileName = uniqueArchiveFileName(title, docId, usedNames);
    fileEntries[fileName] = strToU8(logText);
    const lastEvent = events[events.length - 1];
    const fileHash = `sha256:${await sha256BytesHex(strToU8(logText))}`;
    const manifestDoc: ArchiveManifestDoc = {
      docId,
      title,
      file: fileName,
      lastSeq: lastEvent.seq,
      lastHash: lastEvent.hash,
      chars,
      backupAt,
      fileHash,
    };
    if (trashed) manifestDoc.trashed = true;
    manifestDocs.push(manifestDoc);
  }

  const manifest: ArchiveManifest = {
    magic: MANIFEST_MAGIC,
    format: FORMAT_VERSION,
    createdAt: backupAt,
    updatedAt: backupAt,
    app: { name: APP_NAME, version: APP_VERSION },
    docs: manifestDocs,
  };
  const entries: Record<string, Uint8Array> = {
    [ARCHIVE_MANIFEST_NAME]: strToU8(`${canonicalJson(manifest as unknown as Record<string, unknown>)}\n`),
  };
  for (const [name, bytes] of Object.entries(fileEntries)) entries[name] = bytes;

  const zipped = zipSync(entries, { level: 6 });
  return new Blob([zipped as unknown as BlobPart], { type: ARCHIVE_FILE_MIME });
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/**
 * 把备份目录中的 manifest 原文 + `.wtlog` 文本在内存打包为 `.wtzip` Blob。
 * 供 `restoreFromBackupDirectory()` 复用 importArchive 的校验/前缀合并/冲突逻辑。
 */
export function createArchiveBlobFromTexts(manifestText: string, files: Record<string, string>): Blob {
  const entries: Record<string, Uint8Array> = { [ARCHIVE_MANIFEST_NAME]: strToU8(manifestText) };
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text);
  const zipped = zipSync(entries, { level: 6 });
  return new Blob([zipped as unknown as BlobPart], { type: ARCHIVE_FILE_MIME });
}

export interface ArchiveImportDeps {
  readDocRecord(docId: string): Promise<DocRecord | null>;
  readDocEvents(docId: string): Promise<LogEvent[]>;
  writeDocSnapshot(record: DocRecord, events: readonly LogEvent[]): Promise<void>;
  writeMirror(docId: string, text: string): Promise<void>;
  /** 被其它标签页/窗口 Web Lock 独占持有的作品（不得写入）。 */
  queryExternallyLockedDocIds(): Promise<Set<string>>;
  /** 作品是否正在本标签页打开（打开时不能直接改库，避免句柄内存状态失同步）。 */
  isDocOpen(docId: string): boolean;
  setIntegrity(docId: string, integrity: IntegrityState): void;
}

function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (name !== name.trim()) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.includes('\\') || name.includes('..')) return false;
  return true;
}

/** 校验 manifest 信封（magic/format/docs）；信封非法直接抛错（整个包不可用）。 */
function parseArchiveManifest(bytes: Uint8Array, warnings: string[]): ArchiveManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(bytes));
  } catch (error) {
    throw new Error(`备份包 manifest 不是合法 JSON：${describeError(error)}`);
  }
  if (!isPlainObject(raw)) throw new Error('备份包 manifest 不是 JSON 对象');
  if (raw.magic !== MANIFEST_MAGIC) {
    throw new Error(`备份包 manifest magic 非法（期望 "${MANIFEST_MAGIC}"，实际 ${JSON.stringify(raw.magic)}）`);
  }
  if (typeof raw.format !== 'string') throw new Error('备份包 manifest 缺少 format');
  const formatMatch = MANIFEST_FORMAT_RE.exec(raw.format);
  if (!formatMatch) throw new Error(`备份包 manifest format 非法：${JSON.stringify(raw.format)}`);
  const major = Number(formatMatch[1]);
  const minor = Number(formatMatch[2]);
  if (major > FORMAT_MAJOR) {
    throw new Error(`备份包格式版本 ${raw.format} 高于当前支持的 ${FORMAT_VERSION}，请升级应用后再导入`);
  }
  if (major === FORMAT_MAJOR && minor > FORMAT_MINOR) {
    warnings.push(`备份包格式版本 ${raw.format} 高于当前实现的 ${FORMAT_VERSION}，按兼容规则尽力读取`);
  }
  if (!Array.isArray(raw.docs)) throw new Error('备份包 manifest 缺少 docs 数组');
  return raw as unknown as ArchiveManifest;
}

/** 两副本同 seq 事件是否完全一致（哈希与载荷都要一致，防止"哈希字段未改但载荷被改"）。 */
function sameArchiveEvent(left: LogEvent, right: LogEvent): boolean {
  if (left.seq !== right.seq || left.hash !== right.hash) return false;
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

async function writeMirrorForImport(
  deps: ArchiveImportDeps,
  docId: string,
  text: string,
  warnings: string[],
): Promise<void> {
  try {
    await deps.writeMirror(docId, text);
  } catch (error) {
    warnings.push(`作品 ${docId} 的 OPFS 镜像写入失败（不影响主存储）：${describeError(error)}`);
  }
}

function skipped(docId: string, title: string, message: string): ArchiveDocResult {
  return { docId, title, action: 'skipped', eventsAdded: 0, message };
}

/**
 * 处理 manifest 中的单个作品条目。
 * 返回 ArchiveDocResult；任何可归因于该条目的问题都记 failed/conflict，不抛出。
 */
async function importArchiveDoc(
  deps: ArchiveImportDeps,
  rawEntry: unknown,
  entries: Record<string, Uint8Array>,
  externallyLocked: Set<string>,
  seenDocIds: Set<string>,
  warnings: string[],
): Promise<ArchiveDocResult> {
  const fallbackDocId =
    isPlainObject(rawEntry) && typeof rawEntry.docId === 'string' ? rawEntry.docId : '';
  const fallbackTitle =
    isPlainObject(rawEntry) && typeof rawEntry.title === 'string' ? rawEntry.title : '';
  const fail = (message: string): ArchiveDocResult => ({
    docId: fallbackDocId,
    title: fallbackTitle,
    action: 'failed',
    eventsAdded: 0,
    message,
  });

  if (!isPlainObject(rawEntry)) return fail('manifest 条目不是对象');
  const docId = typeof rawEntry.docId === 'string' ? rawEntry.docId.trim() : '';
  if (docId.length === 0) return fail('manifest 条目的 docId 非法');
  const title = typeof rawEntry.title === 'string' ? rawEntry.title : '';
  const failDoc = (message: string): ArchiveDocResult => ({
    docId,
    title,
    action: 'failed',
    eventsAdded: 0,
    message,
  });

  // ---- manifest 条目锚点字段校验 ----
  if (!isNonNegativeInteger(rawEntry.lastSeq)) return failDoc('manifest 条目的 lastSeq 非法');
  if (typeof rawEntry.lastHash !== 'string') return failDoc('manifest 条目的 lastHash 非法');
  if (!isNonNegativeInteger(rawEntry.chars)) return failDoc('manifest 条目的 chars 非法');
  if (typeof rawEntry.backupAt !== 'string') return failDoc('manifest 条目的 backupAt 非法');
  if (typeof rawEntry.file !== 'string' || !isSafeEntryName(rawEntry.file)) {
    return failDoc('manifest 条目的 file 非法（禁止绝对路径 / ".." / 反斜杠）');
  }
  if (!rawEntry.file.endsWith(LOG_ENTRY_SUFFIX)) return failDoc(`清单条目的 file 必须是 *${LOG_ENTRY_SUFFIX}`);
  if (typeof rawEntry.fileHash !== 'string' || !HASH_RE.test(rawEntry.fileHash)) {
    return failDoc('manifest 条目缺少合法的 fileHash 锚点（§9.1 要求）');
  }
  if (rawEntry.trashed !== undefined && typeof rawEntry.trashed !== 'boolean') {
    return failDoc('manifest 条目的 trashed 非法');
  }
  if (seenDocIds.has(docId)) {
    warnings.push(`备份包 manifest 中 docId 重复（${docId}），仅处理首次出现的条目`);
    return failDoc('manifest 中 docId 重复，已跳过');
  }
  seenDocIds.add(docId);

  // ---- 并发安全：被其它标签页锁定 → 不得写入 ----
  if (externallyLocked.has(docId)) {
    return failDoc('作品正被其它标签页/窗口写入（Web Lock），已跳过以避免并发冲突');
  }

  // ---- 条目内容与锚点校验 ----
  const bytes = entries[rawEntry.file];
  if (!bytes) return failDoc(`备份包缺少作品条目：${rawEntry.file}`);
  const actualHash = `sha256:${await sha256BytesHex(bytes)}`;
  if (actualHash !== rawEntry.fileHash) {
    return failDoc(`fileHash 校验失败：条目 ${rawEntry.file} 被篡改或截断`);
  }
  const text = strFromU8(bytes);
  const verify: VerifyResult = await verifyLog(parseLogText(text));
  if (!verify.headerOk || !verify.ok) {
    const reason =
      verify.brokenReason ??
      (verify.readonlyRequired ? '包含当前版本无法安全重放的内容' : '数据损坏');
    return failDoc(`日志校验失败：${reason}`);
  }
  if (verify.docId !== docId) {
    return failDoc(`条目 header.docId（${verify.docId ?? '缺失'}）与清单 docId 不一致`);
  }
  const backupEvents = verify.events;
  const lastEvent = backupEvents[backupEvents.length - 1];
  if (!lastEvent) return failDoc('日志不包含任何事件');
  if (rawEntry.lastSeq !== lastEvent.seq || rawEntry.lastHash !== lastEvent.hash) {
    return failDoc('清单锚点 lastSeq/lastHash 与日志链尾不一致（备份文件可能被改写或截断）');
  }
  if (rawEntry.chars !== verify.text.length) {
    warnings.push(
      `作品 ${docId} 的清单 chars（${rawEntry.chars}）与日志派生长度（${verify.text.length}）不一致，按日志为准`,
    );
  }
  const backupTrashed = rawEntry.trashed === true;

  // ---- 与本地比较（§9.1 第 3 条） ----
  const localRecord = await deps.readDocRecord(docId);
  const localEvents = await deps.readDocEvents(docId);
  const localCount = localEvents.length;
  const backupCount = backupEvents.length;

  if (localCount === 0) {
    // 本地没有事件（新作品，或摘要存在但事件丢失）：导入全部备份事件
    if (deps.isDocOpen(docId)) return failDoc('作品正在本标签页打开，请先关闭后再导入此作品');
    const record = recordFromVerify(docId, verify);
    record.trashed = backupTrashed; // 回收站状态按备份包记录恢复（新导入，§9.1 第 4 条）
    await deps.writeDocSnapshot(record, backupEvents);
    deps.setIntegrity(docId, 'ok');
    await writeMirrorForImport(deps, docId, text, warnings);
    return { docId, title: record.title, action: 'imported', eventsAdded: backupCount };
  }

  const common = Math.min(localCount, backupCount);
  for (let index = 0; index < common; index += 1) {
    if (!sameArchiveEvent(localEvents[index], backupEvents[index])) {
      return {
        docId,
        title,
        action: 'conflict',
        eventsAdded: 0,
        message: `本地与备份在 seq=${index} 处不一致（哈希或事件内容分歧），未写入任何一份`,
      };
    }
  }
  if (localCount === backupCount) return skipped(docId, title, '本地与备份链尾一致，无需处理');
  if (localCount > backupCount) {
    return skipped(docId, title, '备份是本地日志的前缀（本地副本更新），未覆盖');
  }

  // 本地是备份的严格前缀 → 只追加缺失事件（不重写任何历史行）
  if (deps.isDocOpen(docId)) return failDoc('作品正在本标签页打开，请先关闭后再合并');
  const missing = backupEvents.slice(localCount);
  const baseRecord = localRecord ?? recordFromVerify(docId, verify);
  const mergedRecord: DocRecord = {
    ...baseRecord,
    title: verify.title,
    updatedAt: lastEvent.ts,
    chars: verify.text.length,
    eventCount: backupCount,
    snapshotCount: countSnapshots(backupEvents),
    trashed: verify.trashed,
    lastSeq: lastEvent.seq,
    lastHash: lastEvent.hash,
    integrity: 'ok',
  };
  await deps.writeDocSnapshot(mergedRecord, missing);
  deps.setIntegrity(docId, 'ok');
  await writeMirrorForImport(deps, docId, serializeEvents(backupEvents), warnings);
  return { docId, title: mergedRecord.title, action: 'merged', eventsAdded: missing.length };
}

/** 从 `.wtzip` 备份包恢复/合并（§9.1）。ZIP/manifest 信封非法时抛错，单作品失败隔离。 */
export async function importArchiveFromFile(
  deps: ArchiveImportDeps,
  file: Blob,
  fileName?: string,
): Promise<ArchiveImportReport> {
  const label = fileName ? `（${fileName}）` : '';
  const report: ArchiveImportReport = {
    docs: [],
    imported: 0,
    merged: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    warnings: [],
  };

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    throw new Error(`无法读取备份包${label}：${describeError(error)}`);
  }
  if (buffer.byteLength === 0) throw new Error(`备份包${label}为空`);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch (error) {
    throw new Error(`备份包${label}不是合法的 ZIP 文件：${describeError(error)}`);
  }
  const manifestBytes = entries[ARCHIVE_MANIFEST_NAME];
  if (!manifestBytes) throw new Error(`备份包${label}缺少 ${ARCHIVE_MANIFEST_NAME}`);
  const manifest = parseArchiveManifest(manifestBytes, report.warnings);

  const externallyLocked = await deps.queryExternallyLockedDocIds();
  const seenDocIds = new Set<string>();
  for (const rawEntry of manifest.docs) {
    let result: ArchiveDocResult;
    try {
      result = await importArchiveDoc(deps, rawEntry, entries, externallyLocked, seenDocIds, report.warnings);
    } catch (error) {
      const docId =
        isPlainObject(rawEntry) && typeof rawEntry.docId === 'string' ? rawEntry.docId : '';
      const title = isPlainObject(rawEntry) && typeof rawEntry.title === 'string' ? rawEntry.title : '';
      result = {
        docId,
        title,
        action: 'failed',
        eventsAdded: 0,
        message: `导入时发生异常：${describeError(error)}`,
      };
    }
    report.docs.push(result);
    if (result.action === 'imported') report.imported += 1;
    else if (result.action === 'merged') report.merged += 1;
    else if (result.action === 'skipped') report.skipped += 1;
    else if (result.action === 'conflict') report.conflicts += 1;
    else report.failed += 1;
  }
  if (report.docs.length === 0) report.warnings.push('备份包中没有作品条目');
  return report;
}
