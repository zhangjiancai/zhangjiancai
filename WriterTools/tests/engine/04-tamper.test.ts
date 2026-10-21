import { describe, expect, it } from 'vitest';
import { appendRawEvent, createHarness, deleteRawEvent, mutateRawEvent, readRawEvents, reopenHarness, rewriteRawEventAndChain } from '../support/test-utils';
import type { Harness } from '../support/test-utils';

async function setupDoc(harness: Harness): Promise<string> {
  const doc = await harness.engine.createDoc('篡改检测');
  await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
  await doc.appendEdit({ kind: 'insert', pos: 3, text: 'def' });
  await doc.snapshot('v1', 'manual');
  await doc.appendEdit({ kind: 'insert', pos: 6, text: 'ghi' });
  await doc.close();
  return doc.docId;
}

describe('篡改 / 损坏检测（规范 7.1）', () => {
  it('修改事件对象后重开可发现：报告 brokenAt、chainOk=false，只读打开', async () => {
    const harness = await createHarness();
    const docId = await setupDoc(harness);
    const records = await readRawEvents(harness.dbName, docId);
    const target = records.find((record) => record.event.type === 'text.insert' && record.seq > 0);
    if (!target) throw new Error('测试数据缺少 text.insert');
    await mutateRawEvent(harness.dbName, docId, target.seq, (event) => {
      const data = event.data as Record<string, unknown>;
      data.text = 'TAMPERED';
    });

    const second = await reopenHarness(harness);
    const doc = await second.engine.openDoc(docId);
    expect(doc.readonly).toBe(true);
    const report = await doc.verify();
    expect(report.ok).toBe(false);
    expect(report.chainOk).toBe(false);
    expect(report.brokenAt).toBe(target.seq);
    expect(report.eventCount).toBe(target.seq);
    expect(report.brokenReason).toBeTruthy();
    await expect(doc.appendEdit({ kind: 'insert', pos: 0, text: 'no' })).rejects.toThrow(/只读/);
    await doc.close();

    const allReports = await second.engine.verifyAll();
    const report2 = allReports.find((item) => item.docId === docId);
    expect(report2?.ok).toBe(false);
    expect(report2?.brokenAt).toBe(target.seq);
  });

  it('删除中间事件后重开可发现 seq 链断裂', async () => {
    const harness = await createHarness();
    const docId = await setupDoc(harness);
    const records = await readRawEvents(harness.dbName, docId);
    const target = records.find((record) => record.event.type === 'text.insert' && record.seq > 0);
    if (!target) throw new Error('测试数据缺少 text.insert');
    await deleteRawEvent(harness.dbName, docId, target.seq);

    const second = await reopenHarness(harness);
    const doc = await second.engine.openDoc(docId);
    expect(doc.readonly).toBe(true);
    const report = await doc.verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(target.seq);
    expect(report.seqOk).toBe(false);
    expect(report.brokenReason ?? '').toMatch(/seq/);
    await doc.close();
  });

  it('快照不变量被破坏（textHash 被改）时报告 snapshotMismatchSeqs 且只读', async () => {
    const harness = await createHarness();
    const docId = await setupDoc(harness);
    const records = await readRawEvents(harness.dbName, docId);
    const snapshot = records.find(
      (record) =>
        record.event.type === 'snapshot' &&
        (record.event.data as Record<string, unknown>).reason === 'manual',
    );
    if (!snapshot) throw new Error('测试数据缺少手动快照');
    await rewriteRawEventAndChain(harness.dbName, docId, snapshot.seq, (event) => {
      const data = event.data as Record<string, unknown>;
      data.textHash = `sha256:${'0'.repeat(64)}`;
    });

    const second = await reopenHarness(harness);
    const doc = await second.engine.openDoc(docId);
    expect(doc.readonly).toBe(true);
    const report = await doc.verify();
    expect(report.ok).toBe(false);
    expect(report.snapshotMismatchSeqs).toContain(snapshot.seq);
    await doc.close();
  });

  it('核心文本事件声明 affects=meta 的畸形日志：按损坏处理而非静默忽略', async () => {
    const harness = await createHarness();
    const docId = await setupDoc(harness);
    const records = await readRawEvents(harness.dbName, docId);
    const target = records.find((record) => record.event.type === 'text.insert' && record.seq > 0);
    if (!target) throw new Error('测试数据缺少 text.insert');
    // 哈希链保持合法，只把核心文本事件的 affects 改成 meta
    await rewriteRawEventAndChain(harness.dbName, docId, target.seq, (event) => {
      event.affects = 'meta';
    });

    const second = await reopenHarness(harness);
    const doc = await second.engine.openDoc(docId);
    expect(doc.readonly).toBe(true);
    const report = await doc.verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(target.seq);
    expect(report.chainOk).toBe(true); // 链本身仍有效，坏在事件语义
    expect(report.warnings.some((warning) => /affects|核心文本事件/.test(warning))).toBe(true);
    await doc.close();
  });

  it('未知 meta 事件向前兼容：正常可写、校验通过、正文不变', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('向前兼容');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '原文' });
    await doc.close();
    const raw = await appendRawEvent(harness.dbName, doc.docId, {
      type: 'x.test.meta',
      affects: 'meta',
      data: { foo: 'bar' },
    });

    const second = await reopenHarness(harness);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.readonly).toBe(false);
    expect(reopened.text).toBe('原文');
    const report = await reopened.verify();
    expect(report.ok).toBe(true);
    expect(report.unknownTextEventSeqs).toEqual([]);
    await reopened.appendEdit({ kind: 'insert', pos: 2, text: '！' });
    expect(reopened.text).toBe('原文！');
    const events = await (await reopened.exportLog()).text();
    expect(events).toContain('x.test.meta');
    expect(events).toContain(String(raw.hash));
    await reopened.close();
  });

  it('未知 text 事件按规范 8.3 只读打开并提示升级', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('未知文本事件');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    await doc.close();
    const raw = await appendRawEvent(harness.dbName, doc.docId, {
      type: 'x.test.text',
      affects: 'text',
      data: { anything: 1 },
    });

    const second = await reopenHarness(harness);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.readonly).toBe(true);
    const report = await reopened.verify();
    expect(report.ok).toBe(false);
    expect(report.unknownTextEventSeqs).toEqual([raw.seq]);
    expect(reopened.text).toBe('abc');
    await reopened.close();
  });
});
