import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/engine/log';
import {
  checkLogText,
  createHarness,
  deleteRawDocRecord,
  readMirror,
  replayText,
  testSha256Hex,
  withFakeWebLocks,
} from '../support/test-utils';
import type { Harness } from '../support/test-utils';
import {
  decodeUtf8,
  encodeUtf8,
  findManifestDoc,
  MANIFEST_FILE,
  readArchiveManifest,
  readLogText,
  unzipArchive,
  writeArchiveManifest,
  zipArchive,
} from '../support/archive-utils';
import type { TestArchiveManifest } from '../support/archive-utils';

/** 独立解压备份包并取出某作品日志原文。 */
async function logOfArchive(blob: Blob, docId: string): Promise<string> {
  const entries = await unzipArchive(blob);
  const manifest = readArchiveManifest(entries);
  return readLogText(entries, manifest, docId);
}

async function createTwoDocArchive(): Promise<{
  harness: Harness;
  archive: Blob;
  docAId: string;
  docBId: string;
  expectedA: string;
}> {
  const harness = await createHarness();
  const docA = await harness.engine.createDoc('作品A');
  await docA.appendEdit({ kind: 'insert', pos: 0, text: '甲的作品正文' });
  await docA.snapshot('A 快照');
  await docA.setTitle('作品A改');
  const docB = await harness.engine.createDoc('作品B');
  await docB.appendEdit({ kind: 'insert', pos: 0, text: '乙的作品' });
  const expectedA = docA.text;
  const docAId = docA.docId;
  const docBId = docB.docId;
  await docA.close();
  await docB.close();
  await harness.engine.trashDoc(docBId);
  const archive = await harness.engine.exportArchive();
  return { harness, archive, docAId, docBId, expectedA };
}

describe('.wtzip 全量备份包（规范 §9、§9.1）', () => {
  it('导出→新引擎导入：全部作品（含回收站）恢复，包可被独立校验器验证', async () => {
    const { archive, docAId, docBId, expectedA } = await createTwoDocArchive();
    expect(archive.type).toBe('application/zip');

    // ---- 独立校验：不经过被测 archive 模块，直接用 fflate + 独立 canonical/哈希工具 ----
    const entries = await unzipArchive(archive);
    const manifest = readArchiveManifest(entries);
    expect(manifest.magic).toBe('writertools-backup-manifest');
    expect(manifest.format).toBe('1.0');
    expect(typeof manifest.createdAt).toBe('string');
    expect(typeof manifest.updatedAt).toBe('string');
    expect(manifest.app).toEqual({ name: 'WriterTools', version: APP_VERSION });
    expect(manifest.docs).toHaveLength(2);
    expect(Object.keys(entries).filter((name) => name.endsWith('.wtlog'))).toHaveLength(2);
    for (const manifestDoc of manifest.docs) {
      const bytes = entries[manifestDoc.file];
      expect(bytes).toBeDefined();
      const logText = decodeUtf8(bytes);
      // fileHash 锚点：sha256 对整个条目字节（UTF-8 日志文本）
      expect(manifestDoc.fileHash).toBe(`sha256:${await testSha256Hex(logText)}`);
      // 独立静态校验日志（canonical/哈希链/重放/快照不变量）
      const events = await checkLogText(logText, { docId: manifestDoc.docId });
      const last = events[events.length - 1];
      expect(manifestDoc.lastSeq).toBe(last.seq);
      expect(manifestDoc.lastHash).toBe(last.hash);
      expect(manifestDoc.chars).toBe(replayText(events).length);
      expect(manifestDoc.file).toContain(manifestDoc.docId.slice(0, 8));
      expect(typeof manifestDoc.backupAt).toBe('string');
    }
    expect(findManifestDoc(manifest, docBId)?.trashed).toBe(true);
    expect(findManifestDoc(manifest, docAId)?.trashed).toBeUndefined();

    // ---- 新引擎导入 ----
    const target = await createHarness();
    const report = await target.engine.importArchive(archive, 'backup.wtzip');
    expect(report.imported).toBe(2);
    expect(report.merged).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.conflicts).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.docs.map((doc) => doc.action)).toEqual(['imported', 'imported']);

    const all = await target.engine.listDocs({ includeTrashed: true });
    expect(all.map((doc) => doc.docId).sort()).toEqual([docAId, docBId].sort());
    expect(all.find((doc) => doc.docId === docBId)?.trashed).toBe(true);
    // 回收站作品默认不出现在书架
    const visible = await target.engine.listDocs();
    expect(visible.map((doc) => doc.docId)).toEqual([docAId]);

    const reopened = await target.engine.openDoc(docAId);
    expect(reopened.text).toBe(expectedA);
    expect(reopened.title).toBe('作品A改');
    expect((await reopened.history()).length).toBe(1);
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();

    // 重复导入：全部 skipped，本地不被覆盖
    const again = await target.engine.importArchive(archive, 'backup.wtzip');
    expect(again.skipped).toBe(2);
    expect(again.imported + again.merged + again.conflicts + again.failed).toBe(0);
    expect(again.docs.every((doc) => doc.action === 'skipped')).toBe(true);
  });

  it('本地较短时 merged 只追加缺失事件（历史行字节不变）', async () => {
    const source = await createHarness();
    const doc = await source.engine.createDoc('前缀合并');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    const shortArchive = await source.engine.exportArchive();
    const docId = doc.docId;
    // §9.1：ZIP 条目内容必须逐字节等于对应 .wtlog 导出内容
    const directShortLog = await (await doc.exportLog()).text();
    await doc.appendEdit({ kind: 'insert', pos: 3, text: 'def' });
    const longArchive = await source.engine.exportArchive();
    await doc.close();

    const shortLog = await logOfArchive(shortArchive, docId);
    const longLog = await logOfArchive(longArchive, docId);
    expect(shortLog).toBe(directShortLog);
    expect(longLog.startsWith(shortLog)).toBe(true);
    expect(longLog.length).toBeGreaterThan(shortLog.length);

    const target = await createHarness();
    const firstReport = await target.engine.importArchive(shortArchive);
    expect(firstReport.imported).toBe(1);
    // 导入后的本地日志与备份条目逐字节一致
    expect(await logOfArchive(await target.engine.exportArchive(), docId)).toBe(shortLog);

    const mergeReport = await target.engine.importArchive(longArchive);
    expect(mergeReport.merged).toBe(1);
    expect(mergeReport.docs[0].action).toBe('merged');
    expect(mergeReport.docs[0].eventsAdded).toBeGreaterThan(0);
    // 只追加：本地导出日志 == 完整备份日志（前缀部分未变）
    const mergedLog = await logOfArchive(await target.engine.exportArchive(), docId);
    expect(mergedLog).toBe(longLog);
    expect(mergedLog.startsWith(shortLog)).toBe(true);
    // 合并后镜像立即更新为完整日志
    expect(readMirror(target.opfs!, docId)).toBe(longLog);

    const reopened = await target.engine.openDoc(docId);
    expect(reopened.text).toBe('abcdef');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('本地更新时 skipped，不覆盖本地副本', async () => {
    const source = await createHarness();
    const doc = await source.engine.createDoc('本地更新');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abcdef' });
    const archive = await source.engine.exportArchive();
    const docId = doc.docId;
    await doc.close();

    const target = await createHarness();
    await target.engine.importArchive(archive);
    const local = await target.engine.openDoc(docId);
    await local.appendEdit({ kind: 'insert', pos: 6, text: 'ghi' });
    await local.close();

    const beforeLog = await logOfArchive(await target.engine.exportArchive(), docId);
    const report = await target.engine.importArchive(archive);
    expect(report.skipped).toBe(1);
    expect(report.docs[0].action).toBe('skipped');
    expect(report.docs[0].message ?? '').toMatch(/本地/);
    const afterLog = await logOfArchive(await target.engine.exportArchive(), docId);
    expect(afterLog).toBe(beforeLog); // 本地更新未被覆盖

    const reopened = await target.engine.openDoc(docId);
    expect(reopened.text).toBe('abcdefghi');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('相同 seq 分歧时 conflict：只报告、两份都不写', async () => {
    const source = await createHarness();
    const doc = await source.engine.createDoc('分歧');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    const shortArchive = await source.engine.exportArchive();
    const docId = doc.docId;
    await doc.appendEdit({ kind: 'insert', pos: 3, text: 'def' });
    const longArchive = await source.engine.exportArchive();
    await doc.close();

    const target = await createHarness();
    await target.engine.importArchive(shortArchive);
    const local = await target.engine.openDoc(docId);
    await local.appendEdit({ kind: 'insert', pos: 3, text: 'X' }); // 与长备份 seq 分歧
    await local.close();

    const beforeLog = await logOfArchive(await target.engine.exportArchive(), docId);
    const report = await target.engine.importArchive(longArchive);
    expect(report.conflicts).toBe(1);
    expect(report.docs[0].action).toBe('conflict');
    expect(report.docs[0].eventsAdded).toBe(0);
    expect(report.docs[0].message ?? '').toMatch(/seq=\d+/);
    const afterLog = await logOfArchive(await target.engine.exportArchive(), docId);
    expect(afterLog).toBe(beforeLog); // 本地未被写入/覆盖

    const reopened = await target.engine.openDoc(docId);
    expect(reopened.text).toBe('abcX');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('单条目损坏只影响该作品（坏条目 failed，其它照常 imported）', async () => {
    const harness = await createHarness();
    const good = await harness.engine.createDoc('好作品');
    await good.appendEdit({ kind: 'insert', pos: 0, text: 'good' });
    const bad = await harness.engine.createDoc('坏作品');
    await bad.appendEdit({ kind: 'insert', pos: 0, text: 'bad' });
    const goodId = good.docId;
    const badId = bad.docId;
    await good.close();
    await bad.close();
    const archive = await harness.engine.exportArchive();

    const entries = await unzipArchive(archive);
    const manifest = readArchiveManifest(entries);
    const badDoc = findManifestDoc(manifest, badId);
    if (!badDoc) throw new Error('测试包缺少坏作品条目');
    entries[badDoc.file] = encodeUtf8('这不是合法日志');
    const brokenArchive = zipArchive(entries);

    const target = await createHarness();
    const report = await target.engine.importArchive(brokenArchive);
    expect(report.imported).toBe(1);
    expect(report.failed).toBe(1);
    const failedDoc = report.docs.find((doc) => doc.action === 'failed');
    expect(failedDoc?.docId).toBe(badId);
    expect(failedDoc?.message).toBeTruthy();
    expect((await target.engine.listDocs()).map((doc) => doc.docId)).toEqual([goodId]);
  });

  it('fileHash 篡改与日志篡改都被拒绝', async () => {
    const source = await createHarness();
    const doc = await source.engine.createDoc('篡改检测');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '原始正文' });
    const docId = doc.docId;
    await doc.close();
    const archive = await source.engine.exportArchive();

    // (a) 条目内容被改、fileHash 未同步 → fileHash 校验失败
    const entriesA = await unzipArchive(archive);
    const manifestA = readArchiveManifest(entriesA);
    const manifestDocA = findManifestDoc(manifestA, docId);
    if (!manifestDocA) throw new Error('缺少条目');
    entriesA[manifestDocA.file] = encodeUtf8('tampered-bytes');
    const reportA = await source.engine.importArchive(zipArchive(entriesA));
    expect(reportA.failed).toBe(1);
    expect(reportA.docs[0].message ?? '').toMatch(/fileHash/);

    // (b) 日志被改且 fileHash 同步更新 → 日志哈希链校验失败
    const entriesB = await unzipArchive(archive);
    const manifestB = readArchiveManifest(entriesB);
    const manifestDocB = findManifestDoc(manifestB, docId);
    if (!manifestDocB) throw new Error('缺少条目');
    const originalLog = decodeUtf8(entriesB[manifestDocB.file]);
    const lines = originalLog.trimEnd().split('\n');
    const tampered = JSON.parse(lines[lines.length - 1]) as { data: Record<string, unknown> };
    tampered.data.text = `${String(tampered.data.text)}X`;
    lines[lines.length - 1] = JSON.stringify(tampered);
    const tamperedLog = `${lines.join('\n')}\n`;
    entriesB[manifestDocB.file] = encodeUtf8(tamperedLog);
    manifestDocB.fileHash = `sha256:${await testSha256Hex(tamperedLog)}`;
    writeArchiveManifest(entriesB, manifestB as TestArchiveManifest);
    const reportB = await createHarness().then(async (harness) => harness.engine.importArchive(zipArchive(entriesB)));
    expect(reportB.failed).toBe(1);
    expect(reportB.docs[0].message ?? '').toMatch(/日志校验失败/);
  });

  it('被外部 Web Lock 持有的作品跳过（failed），不影响其它作品；解锁后可导入', async () => {
    const harness = await createHarness();
    const locked = await harness.engine.createDoc('锁定作品');
    await locked.appendEdit({ kind: 'insert', pos: 0, text: '锁定内容' });
    const free = await harness.engine.createDoc('自由作品');
    await free.appendEdit({ kind: 'insert', pos: 0, text: '自由内容' });
    const lockedId = locked.docId;
    const freeId = free.docId;
    await locked.close();
    await free.close();
    const archive = await harness.engine.exportArchive();

    const target = await createHarness();
    const report = await withFakeWebLocks([lockedId], () => target.engine.importArchive(archive));
    expect(report.failed).toBe(1);
    expect(report.imported).toBe(1);
    const lockedResult = report.docs.find((doc) => doc.docId === lockedId);
    expect(lockedResult?.action).toBe('failed');
    expect(lockedResult?.message ?? '').toMatch(/Web Lock/);
    expect((await target.engine.listDocs()).map((doc) => doc.docId)).toEqual([freeId]);

    // 解锁后再次导入：锁定作品 imported，自由作品 skipped
    const second = await target.engine.importArchive(archive);
    expect(second.imported).toBe(1);
    expect(second.skipped).toBe(1);
    expect((await target.engine.listDocs({ includeTrashed: true })).length).toBe(2);
  });

  it('ZIP/manifest 信封非法时抛清晰错误；空包与未知条目合理处理', async () => {
    const emptyEngine = await createHarness();
    const emptyArchive = await emptyEngine.engine.exportArchive();
    const entries = await unzipArchive(emptyArchive);
    expect(readArchiveManifest(entries).docs).toEqual([]);

    const target = await createHarness();
    const emptyReport = await target.engine.importArchive(emptyArchive);
    expect(emptyReport).toMatchObject({
      imported: 0,
      merged: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
    });
    expect(emptyReport.docs).toEqual([]);
    expect(emptyReport.warnings.length).toBeGreaterThanOrEqual(1);

    await expect(target.engine.importArchive(new Blob(['definitely not a zip']))).rejects.toThrow(/ZIP/);
    await expect(target.engine.importArchive(new Blob([]))).rejects.toThrow(/空/);
    await expect(
      target.engine.importArchive(zipArchive({ 'only.wtlog': encodeUtf8('x') })),
    ).rejects.toThrow(/writertools-manifest/);

    // manifest magic 非法
    const badManifestEntries = await unzipArchive(emptyArchive);
    badManifestEntries[MANIFEST_FILE] = encodeUtf8('{"magic":"bad","format":"1.0","docs":[]}');
    await expect(target.engine.importArchive(zipArchive(badManifestEntries))).rejects.toThrow(/magic/);

    // 未知 ZIP 条目必须被忽略
    const source = await createHarness();
    const doc = await source.engine.createDoc('未知条目');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '正文' });
    await doc.close();
    const normalEntries = await unzipArchive(await source.engine.exportArchive());
    normalEntries['README.txt'] = encodeUtf8('ignored');
    const withExtra = await target.engine.importArchive(zipArchive(normalEntries));
    expect(withExtra.imported).toBe(1);
    expect(withExtra.failed).toBe(0);
  });

  it('docs 摘要丢失但事件仍在时，导出仍包含该作品（不漏备份）', async () => {
    const source = await createHarness();
    const doc = await source.engine.createDoc('摘要丢失备份');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '不能漏' });
    const docId = doc.docId;
    const expectedText = doc.text;
    await doc.close();
    await deleteRawDocRecord(source.dbName, docId);

    const archive = await source.engine.exportArchive();
    const entries = await unzipArchive(archive);
    const manifest = readArchiveManifest(entries);
    expect(manifest.docs.map((item) => item.docId)).toContain(docId);
    const logText = readLogText(entries, manifest, docId);
    const events = await checkLogText(logText, { docId });
    expect(replayText(events)).toBe(expectedText);

    const target = await createHarness();
    const report = await target.engine.importArchive(archive);
    expect(report.imported).toBe(1);
    expect(report.failed).toBe(0);
    const reopened = await target.engine.openDoc(docId);
    expect(reopened.text).toBe(expectedText);
    expect(reopened.title).toBe('摘要丢失备份');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('manifest docId 与日志不一致、条目缺失等条目级异常记 failed', async () => {
    const source = await createHarness();
    const doc = await source.engine.createDoc('条目异常');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '正文' });
    const docId = doc.docId;
    await doc.close();
    const archive = await source.engine.exportArchive();

    // docId 不一致：manifest 声称另一个 docId
    const entriesA = await unzipArchive(archive);
    const manifestA = readArchiveManifest(entriesA);
    const docA = findManifestDoc(manifestA, docId);
    if (!docA) throw new Error('缺少条目');
    docA.docId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    writeArchiveManifest(entriesA, manifestA as TestArchiveManifest);
    const reportA = await (await createHarness()).engine.importArchive(zipArchive(entriesA));
    expect(reportA.failed).toBe(1);
    expect(reportA.docs[0].message ?? '').toMatch(/docId/);

    // 条目缺失：manifest 指向不存在的文件
    const entriesB = await unzipArchive(archive);
    const manifestB = readArchiveManifest(entriesB);
    const docB = findManifestDoc(manifestB, docId);
    if (!docB) throw new Error('缺少条目');
    delete entriesB[docB.file];
    const reportB = await (await createHarness()).engine.importArchive(zipArchive(entriesB));
    expect(reportB.failed).toBe(1);
    expect(reportB.docs[0].message ?? '').toMatch(/缺少作品条目/);

    // 清单锚点被篡改（日志本身仍有效）→ failed
    const entriesC = await unzipArchive(archive);
    const manifestC = readArchiveManifest(entriesC);
    const docC = findManifestDoc(manifestC, docId);
    if (!docC) throw new Error('缺少条目');
    docC.lastSeq = docC.lastSeq + 1;
    writeArchiveManifest(entriesC, manifestC as TestArchiveManifest);
    const reportC = await (await createHarness()).engine.importArchive(zipArchive(entriesC));
    expect(reportC.failed).toBe(1);
    expect(reportC.docs[0].message ?? '').toMatch(/锚点/);
  });
});
