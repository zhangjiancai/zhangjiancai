import { describe, expect, it } from 'vitest';
import { createHarness, deleteRawDocRecord, readRawEvents, reopenHarness } from '../support/test-utils';

describe('生命周期与并发安全（规范 2、引擎契约）', () => {
  it('createDoc 写入 header（seq=0、magic/format 正确），打开即记录 session.start', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('生命周期');
    expect(doc.docId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(doc.readonly).toBe(false);
    const records = await readRawEvents(harness.dbName, doc.docId);
    expect(records[0].seq).toBe(0);
    expect(records[0].event.type).toBe('doc.init');
    expect(records[0].event.magic).toBe('writertools-log');
    expect(records[0].event.format).toBe('1.0');
    expect(records[0].event.prev).toBe('');
    const types = records.map((record) => record.event.type);
    expect(types).toContain('session.start');
    await doc.close();
    const afterClose = await readRawEvents(harness.dbName, doc.docId);
    const typesAfter = afterClose.map((record) => record.event.type);
    expect(typesAfter).toContain('session.end');
  });

  it('同一引擎内多次 open 同一作品返回同一句柄', async () => {
    const harness = await createHarness();
    const created = await harness.engine.createDoc('共享句柄');
    await created.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    const first = await harness.engine.openDoc(created.docId);
    const second = await harness.engine.openDoc(created.docId);
    expect(first).toBe(created);
    expect(second).toBe(created);
    expect(first.text).toBe('abc');
    await created.close();
  });

  it('打开不存在的作品抛错；关闭后写操作抛错；close 幂等', async () => {
    const harness = await createHarness();
    await expect(harness.engine.openDoc('not-exists')).rejects.toThrow(/不存在/);
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'x' });
    await doc.flush();
    await doc.close();
    await expect(doc.close()).resolves.toBeUndefined();
    await expect(doc.appendEdit({ kind: 'insert', pos: 0, text: 'y' })).rejects.toThrow();
    await expect(doc.flush()).resolves.toBeUndefined();
    await expect(harness.engine.flush()).resolves.toBeUndefined();
  });

  it('listDocs 过滤回收站、排序稳定、integrity 可读', async () => {
    const harness = await createHarness();
    const one = await harness.engine.createDoc('作品一');
    await one.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    const two = await harness.engine.createDoc('作品二');
    await two.appendEdit({ kind: 'insert', pos: 0, text: 'bb' });
    await harness.engine.trashDoc(two.docId);

    const visible = await harness.engine.listDocs();
    expect(visible.map((item) => item.docId)).toEqual([one.docId]);
    expect(visible[0].title).toBe('作品一');
    expect(visible[0].chars).toBe(1);
    expect(visible[0].integrity).toBe('ok');
    expect(visible[0].trashed).toBe(false);
    expect(visible[0].readonly).toBe(false);

    const all = await harness.engine.listDocs({ includeTrashed: true });
    expect(all).toHaveLength(2);
    const trashed = all.find((item) => item.docId === two.docId);
    expect(trashed?.trashed).toBe(true);
    expect(trashed?.chars).toBe(2);
    await one.close();
    await two.close();
  });

  it('回收站作品仍可验证（verifyAll 含回收站）', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('验证全部');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    await doc.close();
    await harness.engine.trashDoc(doc.docId);
    const reports = await harness.engine.verifyAll();
    expect(reports).toHaveLength(1);
    expect(reports[0].docId).toBe(doc.docId);
    expect(reports[0].ok).toBe(true);
    expect(reports[0].source).toBe('idb');
  });

  it('docs 摘要丢失但事件完整时 openDoc 自动重建摘要（不丢数据）', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('摘要丢失');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '事件仍在' });
    await doc.close();
    await deleteRawDocRecord(first.dbName, doc.docId);

    const second = await reopenHarness(first);
    expect(await second.engine.listDocs()).toHaveLength(0);
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe('事件仍在');
    const list = await second.engine.listDocs();
    expect(list.map((item) => item.docId)).toContain(doc.docId);
    expect(list[0].chars).toBe(4);
    await reopened.close();
  });

  it('两个引擎实例共享同一 dbName 时数据一致（多标签页读）', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('多实例');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '共享数据' });
    await doc.snapshot('v1');
    await doc.close();
    const second = await reopenHarness(first);
    const list = await second.engine.listDocs();
    expect(list.find((item) => item.docId === doc.docId)?.title).toBe('多实例');
    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe('共享数据');
    await reopened.close();
  });
});
