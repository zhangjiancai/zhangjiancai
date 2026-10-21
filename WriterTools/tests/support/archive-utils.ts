/**
 * .wtzip 备份包测试工具：用 fflate 独立解压/重打包，不经过被测引擎的 archive 实现。
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export interface TestManifestDoc {
  docId: string;
  title: string;
  file: string;
  lastSeq: number;
  lastHash: string;
  chars: number;
  backupAt: string;
  fileHash: string;
  trashed?: boolean;
  [key: string]: unknown;
}

export interface TestArchiveManifest {
  magic: string;
  format: string;
  createdAt: string;
  updatedAt: string;
  app: { name: string; version: string };
  docs: TestManifestDoc[];
  [key: string]: unknown;
}

export const MANIFEST_FILE = 'writertools-manifest.json';

/** 解压 Blob 为 { 条目名: 字节 }。 */
export async function unzipArchive(blob: Blob): Promise<Record<string, Uint8Array>> {
  const buffer = await blob.arrayBuffer();
  return unzipSync(new Uint8Array(buffer));
}

/** 用给定条目重新打包为 Blob（用于构造篡改包 / 附加未知条目）。 */
export function zipArchive(entries: Record<string, Uint8Array>): Blob {
  return new Blob([zipSync(entries) as unknown as BlobPart], { type: 'application/zip' });
}

export function decodeUtf8(bytes: Uint8Array): string {
  return strFromU8(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
  return strToU8(text);
}

/** 读取并解析 manifest（测试独立解析，不做漂移容错）。 */
export function readArchiveManifest(entries: Record<string, Uint8Array>): TestArchiveManifest {
  const bytes = entries[MANIFEST_FILE];
  if (!bytes) throw new Error(`测试包缺少 ${MANIFEST_FILE}`);
  return JSON.parse(strFromU8(bytes)) as TestArchiveManifest;
}

/** 取 manifest 中某 docId 的条目信息。 */
export function findManifestDoc(manifest: TestArchiveManifest, docId: string): TestManifestDoc | undefined {
  return manifest.docs.find((doc) => doc.docId === docId);
}

/** 读取 manifest 中某 docId 对应的日志原文。 */
export function readLogText(entries: Record<string, Uint8Array>, manifest: TestArchiveManifest, docId: string): string {
  const doc = findManifestDoc(manifest, docId);
  if (!doc) throw new Error(`manifest 中没有 docId=${docId}`);
  const bytes = entries[doc.file];
  if (!bytes) throw new Error(`ZIP 中缺少条目 ${doc.file}`);
  return strFromU8(bytes);
}

/** 写回 manifest（测试篡改用）。 */
export function writeArchiveManifest(entries: Record<string, Uint8Array>, manifest: TestArchiveManifest): void {
  entries[MANIFEST_FILE] = strToU8(`${JSON.stringify(manifest)}\n`);
}

/**
 * 把 .wtzip 解包成"备份目录内容快照"（manifest 原文 + 全部 .wtlog 文本），
 * 用于在 Node 中模拟已配置备份目录的读取结果（真实 FSA 由浏览器 e2e 覆盖）。
 */
export async function archiveToDirectorySnapshot(
  blob: Blob,
): Promise<{ manifestText: string; files: Record<string, string> }> {
  const entries = await unzipArchive(blob);
  const manifestBytes = entries[MANIFEST_FILE];
  if (!manifestBytes) throw new Error(`备份包缺少 ${MANIFEST_FILE}`);
  const files: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('.wtlog')) files[name] = decodeUtf8(bytes);
  }
  return { manifestText: decodeUtf8(manifestBytes), files };
}
