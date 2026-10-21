import { describe, expect, it } from 'vitest';
import { EditConflictError } from '../../src/engine';
import type { DocHandle } from '../../src/engine';
import { checkLogText, createHarness, eventsOfType, readRawEvents, replayText } from '../support/test-utils';

async function logOf(doc: DocHandle): Promise<string> {
  return (await doc.exportLog()).text();
}

describe('文本事件与重放（规范 5、6.2）', () => {
  it('insert / delete / replace / reset 后正文正确且可重放', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('重放测试');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '你好世界' });
    expect(doc.text).toBe('你好世界');

    await doc.appendEdit({ kind: 'delete', pos: 2, length: 2, deleted: '世界', direction: 'backward' });
    expect(doc.text).toBe('你好');

    await doc.appendEdit({ kind: 'replace', pos: 0, length: 2, deleted: '你好', text: '您好呀' });
    expect(doc.text).toBe('您好呀');

    await doc.appendEdit({ kind: 'reset', text: '全新正文', reason: 'recovery', source: 'recovery' });
    expect(doc.text).toBe('全新正文');

    const text = await logOf(doc);
    const events = await checkLogText(text, { docId: doc.docId });
    expect(replayText(events)).toBe('全新正文');

    const deletes = eventsOfType(events, 'text.delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].data).toMatchObject({ pos: 2, length: 2, deleted: '世界', direction: 'backward', source: 'typing' });
    const replaces = eventsOfType(events, 'text.replace');
    expect(replaces[0].data).toMatchObject({ pos: 0, length: 2, deleted: '你好', text: '您好呀' });
    const resets = eventsOfType(events, 'text.reset');
    expect(resets[0].data).toMatchObject({ text: '全新正文', reason: 'recovery' });
    expect(resets[0].affects).toBe('text');
    await doc.close();
  });

  it('UTF-16 代理对（emoji）的位置正确（规范 5.1）', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '😀' });
    expect(doc.text).toBe('😀');
    expect(doc.text.length).toBe(2);
    await doc.appendEdit({ kind: 'insert', pos: 2, text: 'a' });
    expect(doc.text).toBe('😀a');
    await doc.appendEdit({ kind: 'delete', pos: 2, length: 1, deleted: 'a' });
    expect(doc.text).toBe('😀');
    await doc.appendEdit({ kind: 'delete', pos: 0, length: 2, deleted: '😀', direction: 'backward' });
    expect(doc.text).toBe('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '😀🎉' });
    expect(doc.text).toBe('😀🎉');
    expect(doc.text.length).toBe(4);

    const events = await checkLogText(await logOf(doc));
    expect(replayText(events)).toBe('😀🎉');
    const firstInsert = eventsOfType(events, 'text.insert')[0];
    expect(firstInsert.data.text).toBe('😀');
    await doc.close();
  });

  it('坐标非法或 deleted 不一致时抛 EditConflictError（含 currentText）', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    const eventCountBefore = (await readRawEvents(harness.dbName, doc.docId)).length;

    const deletedMismatch = await doc
      .appendEdit({ kind: 'delete', pos: 0, length: 1, deleted: 'x' })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(deletedMismatch).toBeInstanceOf(EditConflictError);
    expect((deletedMismatch as EditConflictError).currentText).toBe('abc');

    const posOutOfRange = await doc
      .appendEdit({ kind: 'insert', pos: 10, text: 'z' })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(posOutOfRange).toBeInstanceOf(EditConflictError);
    expect((posOutOfRange as EditConflictError).currentText).toBe('abc');

    const replaceMismatch = await doc
      .appendEdit({ kind: 'replace', pos: 1, length: 1, deleted: 'x', text: 'y' })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(replaceMismatch).toBeInstanceOf(EditConflictError);

    const badNumber = await doc
      .appendEdit({ kind: 'delete', pos: 0.5, length: 1, deleted: 'a' })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(badNumber).toBeInstanceOf(EditConflictError);

    expect(doc.text).toBe('abc');
    expect((await readRawEvents(harness.dbName, doc.docId)).length).toBe(eventCountBefore);
    await doc.close();
  });

  it('空插入 / 空删除不得写事件', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    const before = doc.eventCount;
    await doc.appendEdit({ kind: 'insert', pos: 1, text: '' });
    await doc.appendEdit({ kind: 'delete', pos: 1, length: 0, deleted: '' });
    await doc.appendEdit({ kind: 'replace', pos: 1, length: 0, deleted: '', text: '' });
    expect(doc.eventCount).toBe(before);
    expect(doc.text).toBe('abc');
    await doc.close();
  });

  it('编辑上下文（inputType / 选区）写入事件 data', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit(
      { kind: 'insert', pos: 0, text: 'hi', source: 'typing', inputType: 'insertText' },
      { selectionBefore: { from: 0, to: 0 }, selectionAfter: { from: 2, to: 2, direction: 'none' }, inputType: 'insertText' },
    );
    const events = await checkLogText(await logOf(doc));
    const insert = eventsOfType(events, 'text.insert')[0];
    expect(insert.data.source).toBe('typing');
    expect(insert.data.inputType).toBe('insertText');
    expect(insert.data.selectionBefore).toEqual({ from: 0, to: 0 });
    expect(insert.data.selectionAfter).toEqual({ from: 2, to: 2, direction: 'none' });
    await doc.close();
  });
});
