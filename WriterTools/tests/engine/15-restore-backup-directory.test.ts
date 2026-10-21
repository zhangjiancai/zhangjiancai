import { describe, expect, it } from 'vitest';
import type { BackupDirectorySnapshot } from '../../src/engine/backup';
import type { LibraryEngine } from '../../src/engine/types';
import { archiveToDirectorySnapshot } from '../support/archive-utils';
import { createHarness } from '../support/test-utils';

interface EngineInternals {
  backupServiceInternal: {
    readDirectoryTexts(): Promise<BackupDirectorySnapshot | null>;
  };
}

/** Node 无 File System Access：注入"从备份目录读到的内容"来覆盖目录读取之后的所有逻辑。 */
function injectDirectorySnapshot(engine: LibraryEngine, snapshot: BackupDirectorySnapshot | null): void {
  (engine as unknown as EngineInternals).backupServiceInternal.readDirectoryTexts = async () => snapshot;
}

async function createSourceArchive(): Promise<{
  archive: Blob;
  docAId: string;
  docBId: string;
  expectedA: string;
}> {
  const source = await createHarness();
  const docA = await source.engine.createDoc('目录备份A');
  await docA.appendEdit({ kind: 'insert', pos: 0, text: '甲正文' });
  await docA.snapshot('A 快照');
  const docB = await source.engine.createDoc('目录备份B');
  await docB.appendEdit({ kind: 'insert', pos: 0, text: '乙正文' });
  const expectedA = docA.text;
  const docAId = docA.docId;
  const docBId = docB.docId;
  await docA.close();
  await docB.close();
  await source.engine.trashDoc(docBId);
  const archive = await source.engine.exportArchive();
  return { archive, docAId, docBId, expectedA };
}

describe('从备份目录一键恢复（restoreFromBackupDirectory）', () => {
  it('未配置备份目录（Node 无 FSA）时抛中文可读错误，且不破坏现有数据', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('本地数据');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '本地正文' });
    const beforeLog = await (await doc.exportLog()).text();

    const error = await harness.engine.restoreFromBackupDirectory().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/备份目录/);

    // 数据未被破坏：正文/日志/校验/列表均不变，且引擎仍可写入
    expect(doc.text).toBe('本地正文');
    expect((await doc.verify()).ok).toBe(true);
    expect(await (await doc.exportLog()).text()).toBe(beforeLog);
    expect((await harness.engine.listDocs()).map((item) => item.docId)).toEqual([doc.docId]);
    await doc.appendEdit({ kind: 'insert', pos: 4, text: '继续' });
    expect(doc.text).toBe('本地正文继续');
    await doc.close();
  });

  it('环境不支持 File System Access（fileSystemAccess=false）时同样抛可读错误', async () => {
    const harness = await createHarness({ fileSystemAccess: false });
    await expect(harness.engine.restoreFromBackupDirectory()).rejects.toThrow(/备份目录/);
    expect(await harness.engine.listDocs()).toEqual([]);
  });

  it('目录读取结果为 null / 空目录 / 缺 manifest 时给出可读错误', async () => {
    const harness = await createHarness();

    injectDirectorySnapshot(harness.engine, null);
    await expect(harness.engine.restoreFromBackupDirectory()).rejects.toThrow(/未配置备份目录/);

    injectDirectorySnapshot(harness.engine, {
      manifestText: null,
      files: { 'x.wtlog': 'whatever' },
      warnings: [],
    });
    await expect(harness.engine.restoreFromBackupDirectory()).rejects.toThrow(/manifest/);

    injectDirectorySnapshot(harness.engine, {
      manifestText: '{"magic":"writertools-backup-manifest","format":"1.0","docs":[]}',
      files: {},
      warnings: [],
    });
    await expect(harness.engine.restoreFromBackupDirectory()).rejects.toThrow(/没有可恢复/);

    // 失败不破坏引擎：仍可正常新建作品
    const doc = await harness.engine.createDoc('失败后仍可用');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'ok' });
    expect(doc.text).toBe('ok');
    await doc.close();
  });

  it('正常入口：从备份目录内容恢复全部作品（含回收站），重复恢复 skipped', async () => {
    const { archive, docAId, docBId, expectedA } = await createSourceArchive();
    const snapshot = await archiveToDirectorySnapshot(archive);
    expect(Object.keys(snapshot.files).length).toBeGreaterThanOrEqual(2);

    const target = await createHarness();
    injectDirectorySnapshot(target.engine, { ...snapshot, warnings: [] });
    const report = await target.engine.restoreFromBackupDirectory();
    expect(report.imported).toBe(2);
    expect(report.merged + report.skipped + report.conflicts + report.failed).toBe(0);

    const all = await target.engine.listDocs({ includeTrashed: true });
    expect(all.map((item) => item.docId).sort()).toEqual([docAId, docBId].sort());
    expect(all.find((item) => item.docId === docBId)?.trashed).toBe(true);
    const reopened = await target.engine.openDoc(docAId);
    expect(reopened.text).toBe(expectedA);
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();

    // 重复从同一份目录内容恢复：全部 skipped，不重复写入
    const again = await target.engine.restoreFromBackupDirectory();
    expect(again.skipped).toBe(2);
    expect(again.imported + again.merged + again.conflicts + again.failed).toBe(0);
  });

  it('已有更新的本地副本时不被覆盖（skipped），正文保持本地最新', async () => {
    const source = await createHarness();
    const doc = await source.engine.createDoc('本地更新');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    const archive = await source.engine.exportArchive();
    const docId = doc.docId;
    await doc.close();
    const snapshot = await archiveToDirectorySnapshot(archive);

    const target = await createHarness();
    injectDirectorySnapshot(target.engine, { ...snapshot, warnings: [] });
    const first = await target.engine.restoreFromBackupDirectory();
    expect(first.imported).toBe(1);

    const local = await target.engine.openDoc(docId);
    await local.appendEdit({ kind: 'insert', pos: 3, text: 'def' });
    await local.close();

    const report = await target.engine.restoreFromBackupDirectory();
    expect(report.skipped).toBe(1);
    expect(report.imported).toBe(0);
    const reopened = await target.engine.openDoc(docId);
    expect(reopened.text).toBe('abcdef');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('目录读取 warnings 透传到导入报告', async () => {
    const { archive } = await createSourceArchive();
    const snapshot = await archiveToDirectorySnapshot(archive);
    const target = await createHarness();
    injectDirectorySnapshot(target.engine, {
      ...snapshot,
      warnings: ['无法读取备份文件 broken.wtlog：NotReadableError'],
    });
    const report = await target.engine.restoreFromBackupDirectory();
    expect(report.imported).toBe(2);
    expect(report.warnings).toContain('无法读取备份文件 broken.wtlog：NotReadableError');
  });
});
