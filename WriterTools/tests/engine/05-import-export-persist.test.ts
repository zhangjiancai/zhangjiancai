import { describe, expect, it } from 'vitest';
import { LOG_FILE_MIME } from '../../src/engine';
import { checkLogText, createHarness, readMirror, reopenHarness } from '../support/test-utils';

describe('导入 / 导出（规范 8.4、9）', () => {
  it('exportLog → importFile 往返：docId 与正文一致，可继续编辑', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('导出作品');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '第一段。' });
    await doc.appendEdit({ kind: 'insert', pos: 4, text: '第二段。' });
    await doc.snapshot('节点一', 'manual');
    const blob = await doc.exportLog();
    expect(blob.type).toBe(LOG_FILE_MIME);
    const text = await blob.text();
    await checkLogText(text, { docId: doc.docId });
    const expectedText = doc.text;
    const expectedTitles = doc.title;
    await doc.close();

    const second = await createHarness();
    const summary = await second.engine.importFile(new Blob([text], { type: LOG_FILE_MIME }), '导出作品-00000000.wtlog');
    expect(summary.docId).toBe(doc.docId);
    expect(summary.title).toBe(expectedTitles);
    expect(summary.chars).toBe(expectedText.length);
    expect(summary.integrity).toBe('ok');
    expect(summary.trashed).toBe(false);

    const imported = await second.engine.openDoc(summary.docId);
    expect(imported.text).toBe(expectedText);
    expect((await imported.verify()).ok).toBe(true);
    await imported.appendEdit({ kind: 'insert', pos: expectedText.length, text: '续写。' });
    expect(imported.text).toBe(`${expectedText}续写。`);
    await imported.close();
  });

  it('重复 docId 导入必须抛错且不覆盖现有作品', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('冲突');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '原始正文' });
    const log = await (await doc.exportLog()).text();
    await doc.close();

    const second = await createHarness();
    await second.engine.importFile(new Blob([log]), 'a.wtlog');
    const before = await second.engine.listDocs();
    expect(before).toHaveLength(1);
    await expect(second.engine.importFile(new Blob([log]), 'a-again.wtlog')).rejects.toThrow(/已存在/);
    const after = await second.engine.listDocs();
    expect(after).toHaveLength(1);
    expect(after[0].chars).toBe(4);
  });

  it('exportText 返回纯文本', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '纯文本内容' });
    const blob = await doc.exportText();
    expect(blob.type).toContain('text/plain');
    expect(await blob.text()).toBe('纯文本内容');
    await doc.close();
  });

  it('导入损坏文件抛错且不写入任何数据', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('损坏导入');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    const log = await (await doc.exportLog()).text();
    await doc.close();

    const lines = log.trimEnd().split('\n');
    const tampered = JSON.parse(lines[1]) as { data: { text: string } };
    tampered.data.text = 'HACK';
    lines[1] = JSON.stringify(tampered);
    const brokenLog = `${lines.join('\n')}\n`;

    const second = await createHarness();
    await expect(second.engine.importFile(new Blob([brokenLog]))).rejects.toThrow(/校验失败|损坏/);
    expect(await second.engine.listDocs()).toHaveLength(0);
    await expect(second.engine.importFile(new Blob(['']))).rejects.toThrow(/空/);
  });
});

describe('持久化（同一 dbName 重新创建引擎）', () => {
  it('作品、正文、标题与事件数跨引擎实例持久化', async () => {
    const first = await createHarness();
    const doc = await first.engine.createDoc('持久化作品');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '跨实例保存的正文' });
    await doc.snapshot('v1');
    const expectedText = doc.text;
    await doc.close();

    const second = await reopenHarness(first);
    const list = await second.engine.listDocs();
    const summary = list.find((item) => item.docId === doc.docId);
    expect(summary).toBeDefined();
    expect(summary?.title).toBe('持久化作品');
    expect(summary?.chars).toBe(expectedText.length);
    expect(summary?.eventCount).toBeGreaterThan(0);
    expect(summary?.integrity).toBe('ok');
    expect(summary?.readonly).toBe(false);

    const reopened = await second.engine.openDoc(doc.docId);
    expect(reopened.text).toBe(expectedText);
    expect((await reopened.verify()).ok).toBe(true);
    expect((await reopened.history()).length).toBe(1);
    await reopened.close();
  });

  it('flush 后 OPFS 镜像包含完整日志且可独立校验', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('镜像');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '镜像内容' });
    await doc.snapshot('v1');
    await doc.flush();
    const eventsBefore = doc.eventCount;
    const mirror = readMirror(harness.opfs!, doc.docId);
    expect(mirror).not.toBeNull();
    const events = await checkLogText(mirror!, { docId: doc.docId });
    expect(events.length).toBe(eventsBefore);
    await doc.close();
  });
});
