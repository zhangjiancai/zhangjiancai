import { describe, expect, it } from 'vitest';
import type { DocChange } from '../../src/engine';
import { checkLogText, createHarness, eventsOfType, readRawEvents } from '../support/test-utils';

describe('录制事件：compose / selection / mode / title（规范 6.3–6.9）', () => {
  it('输入法过程、选区、模式、标题事件均写入且 affects=meta', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('事件记录');
    await doc.appendCompose({ phase: 'start', data: 'ni', from: 0, to: 0 });
    await doc.appendCompose({ phase: 'update', data: 'nihao', from: 0, to: 0, candidate: 1 });
    await doc.appendCompose({ phase: 'end', data: '', committed: '你好' });
    await doc.setSelection({ from: 0, to: 0 }, 'caret');
    await doc.setSelection({ from: 0, to: 0 }, 'caret'); // 引擎不去重，UI 负责节流
    await doc.setMode('centered');
    await doc.setTitle('新标题');
    expect(doc.title).toBe('新标题');
    await doc.close();

    const events = await checkLogText(await (await doc.exportLog()).text(), { docId: doc.docId });
    const composeStart = eventsOfType(events, 'compose.start');
    expect(composeStart).toHaveLength(1);
    expect(composeStart[0].data).toMatchObject({ data: 'ni', from: 0, to: 0 });
    const composeUpdate = eventsOfType(events, 'compose.update');
    expect(composeUpdate[0].data).toMatchObject({ data: 'nihao', from: 0, to: 0, candidate: 1 });
    const composeEnd = eventsOfType(events, 'compose.end');
    expect(composeEnd[0].data).toMatchObject({ data: '', committed: '你好' });
    const selections = eventsOfType(events, 'selection.set');
    expect(selections).toHaveLength(2);
    expect(selections[0].data).toMatchObject({ from: 0, to: 0, reason: 'caret' });
    const modes = eventsOfType(events, 'editor.mode');
    expect(modes).toHaveLength(1);
    expect(modes[0].data).toMatchObject({ mode: 'centered' });
    const titles = eventsOfType(events, 'doc.title');
    expect(titles).toHaveLength(1);
    expect(titles[0].data).toMatchObject({ title: '新标题' });
    for (const event of [...composeStart, ...composeUpdate, ...composeEnd, ...selections, ...modes, ...titles]) {
      expect(event.affects).toBe('meta');
    }

    const list = await harness.engine.listDocs();
    expect(list[0].title).toBe('新标题');
  });

  it('监听器收到 text / title / meta / saved 变更', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    const kinds: DocChange['kind'][] = [];
    doc.on((change) => kinds.push(change.kind));
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    await doc.setTitle('标题');
    await doc.setMode('typewriter');
    await doc.snapshot();
    expect(kinds).toContain('text');
    expect(kinds).toContain('title');
    expect(kinds).toContain('meta');
    expect(kinds).toContain('saved');
    await doc.close();
  });
});

describe('回收站（软删除，规范 6.10）', () => {
  it('trashDoc / restoreDoc 只追加事件，日志完整保留', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('要删除的作品');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '不应丢失的正文' });
    await doc.close();
    const eventCountBefore = (await readRawEvents(harness.dbName, doc.docId)).length;

    await harness.engine.trashDoc(doc.docId);
    const visible = await harness.engine.listDocs();
    expect(visible.map((item) => item.docId)).not.toContain(doc.docId);
    const all = await harness.engine.listDocs({ includeTrashed: true });
    const trashed = all.find((item) => item.docId === doc.docId);
    expect(trashed?.trashed).toBe(true);
    expect(trashed?.chars).toBe(7);

    const records = await readRawEvents(harness.dbName, doc.docId);
    expect(records.length).toBe(eventCountBefore + 1);
    expect(records[records.length - 1].event.type).toBe('doc.trash');

    await harness.engine.restoreDoc(doc.docId);
    const visibleAgain = await harness.engine.listDocs();
    expect(visibleAgain.map((item) => item.docId)).toContain(doc.docId);
    const reopened = await harness.engine.openDoc(doc.docId);
    expect(reopened.text).toBe('不应丢失的正文');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();

    // 日志里仍有被删作品的完整正文事件与 doc.trash / doc.untrash
    const allEvents = await checkLogText(await (await reopened.exportLog()).text());
    expect(allEvents.some((event) => event.type === 'doc.trash')).toBe(true);
    expect(allEvents.some((event) => event.type === 'doc.untrash')).toBe(true);
    expect(allEvents.some((event) => event.type === 'text.insert')).toBe(true);
  });
});

describe('存储状态与备份服务降级', () => {
  it('storageStatus 返回 opfs 状态；不支持环境中的字段为 null', async () => {
    const harness = await createHarness();
    const status = await harness.engine.storageStatus();
    expect(status.opfs).toBe(true);
    expect(status.backupConfigured).toBe(false);
    expect(status.persistent).toBeNull();
    expect(status.usage).toBeNull();
    expect(status.quota).toBeNull();
  });

  it('不支持 File System Access 时备份服务不抛异常', async () => {
    const harness = await createHarness();
    const backup = harness.engine.backup();
    expect((await backup.status()).configured).toBe(false);
    const chosen = await backup.chooseDirectory();
    expect(chosen.configured).toBe(false);
    const afterBackup = await backup.backupNow();
    expect(afterBackup.configured).toBe(false);
    await expect(backup.disable()).resolves.toBeUndefined();
    expect((await backup.status()).configured).toBe(false);
  });

  it('OPFS 被禁用时引擎仍可正常读写，镜像降级不报错', async () => {
    const harness = await createHarness({ opfs: null });
    const doc = await harness.engine.createDoc('无镜像');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '照常工作' });
    await doc.flush();
    expect(doc.text).toBe('照常工作');
    expect((await harness.engine.storageStatus()).opfs).toBe(false);
    await doc.close();
    const report = await harness.engine.recover();
    expect(report.recoveredDocs).toBe(0);
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
