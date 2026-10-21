import { describe, expect, it } from 'vitest';
import type { OpfsAdapter } from '../../src/engine/types';
import {
  checkLogText,
  clearRawStores,
  createHarness,
  createMemoryOpfs,
  deleteRawEvent,
  mutateRawEvent,
  replayText,
  readMirror,
  readRawEvents,
  reopenHarness,
  withFakeWebLocks,
} from '../support/test-utils';

type FlakyOpfs = OpfsAdapter & { files: Map<string, string>; failNext: number };

/** 记录型内存 OPFS：可按需让接下来 N 次写入失败，用于验证镜像失败重试。 */
function createFlakyOpfs(): FlakyOpfs {
  const base = createMemoryOpfs();
  const flaky: FlakyOpfs = {
    available: true,
    files: base.files,
    failNext: 0,
    read: (path) => base.read(path),
    list: (dir) => base.list(dir),
    remove: (path) => base.remove(path),
    write: async (path, data) => {
      if (flaky.failNext > 0) {
        flaky.failNext -= 1;
        throw new Error('模拟 OPFS 写入失败');
      }
      return base.write(path, data);
    },
  };
  return flaky;
}

describe('OPFS 镜像与 recover()（规范 7.2、8.4）', () => {
  it('清空 IDB 后 recover 能从镜像恢复作品与正文', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('镜像恢复');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '镜像里的正文' });
    await doc.snapshot('镜像快照');
    await doc.flush();
    await doc.close();
    const expectedText = doc.text;
    const mirror = readMirror(first.opfs!, doc.docId);
    expect(mirror).not.toBeNull();
    await checkLogText(mirror!, { docId: doc.docId });

    await clearRawStores(first.dbName);
    const second = await reopenHarness(first);
    expect(await second.engine.listDocs()).toHaveLength(0);

    const report = await second.engine.recover();
    expect(report.scannedCopies).toBeGreaterThanOrEqual(1);
    expect(report.recoveredDocs).toBe(1);
    expect(report.conflicts).toEqual([]);

    const list = await second.engine.listDocs();
    expect(list.map((item) => item.docId)).toContain(doc.docId);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe(expectedText);
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('IDB 事件比镜像短时 recover 补写缺失事件（纯追加，不重写历史）', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('补写');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '第一段' });
    await doc.appendEdit({ kind: 'insert', pos: 3, text: '第二段' });
    await doc.snapshot('v1');
    await doc.flush();
    await doc.close();
    const expectedText = doc.text;
    const records = await readRawEvents(first.dbName, doc.docId);
    const removed = records.slice(-2);
    for (const record of removed) {
      await deleteRawEvent(first.dbName, doc.docId, record.seq);
    }

    const second = await reopenHarness(first);
    const report = await second.engine.recover();
    expect(report.recoveredDocs).toBe(1);
    expect(report.conflicts).toEqual([]);
    // 恢复后事件数 = 镜像事件数（此时尚未重新打开句柄，没有新增 session.start）
    const mirrorRecords = await readRawEvents(second.dbName, doc.docId);
    const mirrorEvents = (await checkLogText(readMirror(first.opfs!, doc.docId)!)).length;
    expect(mirrorRecords.length).toBe(mirrorEvents);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe(expectedText);
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('IDB 有作品但镜像缺失时 recover 用主存储补写镜像', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('补镜像');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '正文' });
    await doc.flush();
    await doc.close();
    first.opfs!.files.delete(`docs/${doc.docId}.wtlog`);
    expect(readMirror(first.opfs!, doc.docId)).toBeNull();

    const second = await reopenHarness(first);
    const report = await second.engine.recover();
    expect(report.recoveredDocs).toBe(0);
    expect(report.conflicts).toEqual([]);
    const mirror = readMirror(first.opfs!, doc.docId);
    expect(mirror).not.toBeNull();
    const events = await checkLogText(mirror!);
    expect(events.length).toBeGreaterThan(0);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe('正文');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('合法但较短的镜像会被 recover 用完整主存储重写为最新', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('镜像补全');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '第一段' });
    await doc.appendEdit({ kind: 'insert', pos: 3, text: '第二段' });
    await doc.snapshot('v1');
    await doc.flush();
    await doc.close();
    const fullMirror = readMirror(first.opfs!, doc.docId)!;
    const allLines = fullMirror.trimEnd().split('\n');
    expect(allLines.length).toBeGreaterThan(3);
    // 造一个"合法但较短"的镜像（只保留前 3 条事件的完整前缀）
    await first.opfs!.write(`docs/${doc.docId}.wtlog`, `${allLines.slice(0, 3).join('\n')}\n`);
    const idbEvents = await readRawEvents(first.dbName, doc.docId);

    const second = await reopenHarness(first);
    const report = await second.engine.recover();
    expect(report.conflicts).toEqual([]);
    expect(report.recoveredDocs).toBe(0); // 主存储更完整，不需要从镜像恢复作品

    const repairedMirror = readMirror(first.opfs!, doc.docId)!;
    const repairedEvents = await checkLogText(repairedMirror, { docId: doc.docId });
    expect(repairedEvents.length).toBe(idbEvents.length);
    expect(repairedEvents.map((event) => event.hash)).toEqual(idbEvents.map((record) => record.event.hash));
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe('第一段第二段');
    await reopened.close();
  });

  it('镜像写入失败后 flush 会重试成功（失败不更新已镜像文本）', async () => {
    const flaky = createFlakyOpfs();
    const harness = await createHarness({ opfs: flaky });
    const doc = await harness.engine.createDoc('镜像重试');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'A' });
    await doc.flush();
    const afterFirst = flaky.files.get(`docs/${doc.docId}.wtlog`);
    expect(afterFirst).toBeDefined();
    expect(replayText(await checkLogText(afterFirst!))).toBe('A');

    // 下一次镜像写入失败：主存储照常成功，镜像保持旧内容
    flaky.failNext = 1;
    await doc.appendEdit({ kind: 'insert', pos: 1, text: 'B' });
    expect(doc.text).toBe('AB');
    await doc.flush();
    const afterFailure = flaky.files.get(`docs/${doc.docId}.wtlog`);
    expect(afterFailure).toBe(afterFirst);

    // 再次 flush 重试成功，镜像包含完整最新日志
    await doc.flush();
    const afterRetry = flaky.files.get(`docs/${doc.docId}.wtlog`);
    expect(afterRetry).not.toBe(afterFirst);
    const events = await checkLogText(afterRetry!);
    expect(replayText(events)).toBe('AB');
    expect(events.length).toBe(doc.eventCount);
    await doc.close();
  });

  it('副本哈希分歧时 recover 记录 conflicts 且不静默覆盖', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('分歧');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    await doc.flush();
    await doc.close();
    const records = await readRawEvents(first.dbName, doc.docId);
    const target = records.find((record) => record.event.type === 'text.insert');
    if (!target) throw new Error('测试数据缺少 text.insert');
    await mutateRawEvent(first.dbName, doc.docId, target.seq, (event) => {
      const data = event.data as Record<string, unknown>;
      data.text = 'XYZ';
    });

    const second = await reopenHarness(first);
    const report = await second.engine.recover();
    expect(report.recoveredDocs).toBe(0);
    expect(report.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(report.conflicts[0]).toMatch(/分歧/);

    // 主存储仍是被篡改状态：只读打开并报告损坏，未被镜像覆盖
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.readonly).toBe(true);
    expect((await reopened.verify()).ok).toBe(false);
    await reopened.close();
  });

  it('主存储尾部事件丢失时只读打开（保留锚点、不写镜像），recover 修复后恢复完整', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('截断检测');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '第一段' });
    await doc.appendEdit({ kind: 'insert', pos: 3, text: '第二段' });
    await doc.flush();
    await doc.close();
    const expectedText = doc.text;
    const fullMirror = readMirror(first.opfs!, doc.docId);
    expect(fullMirror).not.toBeNull();
    const records = await readRawEvents(first.dbName, doc.docId);
    for (const record of records.slice(-2)) {
      await deleteRawEvent(first.dbName, doc.docId, record.seq);
    }

    const second = await reopenHarness(first);
    const truncated = await second.engine.openDoc(doc.docId);
    expect(truncated.readonly).toBe(true);
    expect(expectedText.startsWith(truncated.text)).toBe(true); // 只读的是有效前缀
    const report = await truncated.verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt).not.toBeNull();
    expect(report.brokenReason ?? '').toMatch(/事件缺失|截断/);
    // 只读句柄不写镜像：完整镜像不被不完整前缀覆盖
    await truncated.flush();
    expect(readMirror(first.opfs!, doc.docId)).toBe(fullMirror);
    await truncated.close();

    const recovery = await second.engine.recover();
    expect(recovery.recoveredDocs).toBe(1);
    expect(recovery.conflicts).toEqual([]);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.readonly).toBe(false);
    expect(reopened.text).toBe(expectedText);
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('recover 跳过被外部 Web Lock 持有的作品（不并发写，解锁后照常恢复）', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('锁保护');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '锁定中的正文' });
    await doc.flush();
    await doc.close();
    expect(readMirror(first.opfs!, doc.docId)).not.toBeNull();
    await clearRawStores(first.dbName);

    const second = await reopenHarness(first);
    const lockedReport = await withFakeWebLocks([doc.docId], () => second.engine.recover());
    expect(lockedReport.recoveredDocs).toBe(0);
    expect(lockedReport.warnings.some((warning) => warning.includes(doc.docId) && /Web Lock/.test(warning))).toBe(true);
    // 主存储未被写入：被锁作品跳过自动恢复
    expect(await second.engine.listDocs()).toHaveLength(0);

    // 解除外部锁后 recover 照常恢复
    const freeReport = await second.engine.recover();
    expect(freeReport.recoveredDocs).toBe(1);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe('锁定中的正文');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('recover 第三步补写镜像同样跳过被外部 Web Lock 持有的作品', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('锁保护镜像');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '正文' });
    await doc.flush();
    await doc.close();
    first.opfs!.files.delete(`docs/${doc.docId}.wtlog`);
    expect(readMirror(first.opfs!, doc.docId)).toBeNull();

    const second = await reopenHarness(first);
    const lockedReport = await withFakeWebLocks([doc.docId], () => second.engine.recover());
    expect(lockedReport.warnings.some((warning) => warning.includes(doc.docId) && /Web Lock/.test(warning))).toBe(true);
    // 第 3 步补写镜像也跳过：镜像仍缺失
    expect(readMirror(first.opfs!, doc.docId)).toBeNull();

    const freeReport = await second.engine.recover();
    expect(freeReport.conflicts).toEqual([]);
    const repaired = readMirror(first.opfs!, doc.docId);
    expect(repaired).not.toBeNull();
    expect(replayText(await checkLogText(repaired!))).toBe('正文');
  });
});
