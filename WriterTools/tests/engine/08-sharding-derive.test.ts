import { describe, expect, it } from 'vitest';
import { deriveEdit } from '../../src/engine';
import { checkLogText, createHarness, eventsOfType, replayText } from '../support/test-utils';

const MAX_LINE_BYTES = 256 * 1024;

function lineBytes(text: string): number[] {
  const encoder = new TextEncoder();
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => encoder.encode(line).length);
}

describe('大编辑分片（规范 2、6.2）', () => {
  it('5000 字符插入拆成多个连续 insert 事件且正文正确', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    const big = 'a'.repeat(5000);
    await doc.appendEdit({ kind: 'insert', pos: 0, text: big });
    expect(doc.text).toBe(big);

    const log = await (await doc.exportLog()).text();
    const events = await checkLogText(log, { docId: doc.docId });
    const inserts = eventsOfType(events, 'text.insert');
    expect(inserts.length).toBeGreaterThanOrEqual(3);
    for (const event of inserts) {
      const chunk = event.data.text as string;
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(inserts.map((event) => event.data.text).join('')).toBe(big);
    // 语义等价：最后一个 insert 的 pos 递增正确
    let expectedPos = 0;
    for (const event of inserts) {
      expect(event.data.pos).toBe(expectedPos);
      expectedPos += (event.data.text as string).length;
    }
    expect(replayText(events)).toBe(big);
    for (const bytes of lineBytes(log)) expect(bytes).toBeLessThanOrEqual(MAX_LINE_BYTES);
    await doc.close();
  });

  it('分片不会拆开代理对（emoji）', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    const emoji = '😀'.repeat(3000); // 6000 UTF-16 码元
    await doc.appendEdit({ kind: 'insert', pos: 0, text: emoji });
    expect(doc.text).toBe(emoji);

    const events = await checkLogText(await (await doc.exportLog()).text());
    const inserts = eventsOfType(events, 'text.insert');
    expect(inserts.length).toBeGreaterThanOrEqual(3);
    for (const event of inserts) {
      const chunk = event.data.text as string;
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(inserts.map((event) => event.data.text).join('')).toBe(emoji);
    expect(replayText(events)).toBe(emoji);
    await doc.close();
  });

  it('5000 字符删除拆成多个 delete 事件，完整保留被删原文', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    const big = 'b'.repeat(5000);
    await doc.appendEdit({ kind: 'insert', pos: 0, text: big });
    await doc.appendEdit({ kind: 'delete', pos: 0, length: 5000, deleted: big, direction: 'forward' });
    expect(doc.text).toBe('');

    const events = await checkLogText(await (await doc.exportLog()).text());
    const deletes = eventsOfType(events, 'text.delete');
    expect(deletes.length).toBeGreaterThanOrEqual(3);
    for (const event of deletes) {
      const chunk = event.data.deleted as string;
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(event.data.pos).toBe(0);
      expect(event.data.length).toBe(chunk.length);
    }
    expect(deletes.map((event) => event.data.deleted).join('')).toBe(big);
    expect(replayText(events)).toBe('');
    await doc.close();
  });

  it('大替换（被替换文本与替换文本都很大）语义等价且日志可校验', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    const before = 'x'.repeat(5000);
    const after = 'y'.repeat(4500);
    await doc.appendEdit({ kind: 'insert', pos: 0, text: before });
    await doc.appendEdit({ kind: 'replace', pos: 0, length: 5000, deleted: before, text: after });
    expect(doc.text).toBe(after);

    const log = await (await doc.exportLog()).text();
    const events = await checkLogText(log);
    expect(replayText(events)).toBe(after);
    for (const bytes of lineBytes(log)) expect(bytes).toBeLessThanOrEqual(MAX_LINE_BYTES);
    await doc.close();
  });
});

describe('deriveEdit（契约）', () => {
  it('相同文本返回 null', () => {
    expect(deriveEdit('abc', 'abc')).toBeNull();
    expect(deriveEdit('', '')).toBeNull();
  });

  it('插入 / 删除 / 替换的最小差异', () => {
    expect(deriveEdit('abc', 'abXc')).toEqual({ kind: 'insert', pos: 2, length: 0, deleted: '', text: 'X' });
    expect(deriveEdit('abc', 'ac')).toEqual({ kind: 'delete', pos: 1, length: 1, deleted: 'b', text: '' });
    expect(deriveEdit('abc', 'aXc')).toEqual({ kind: 'replace', pos: 1, length: 1, deleted: 'b', text: 'X' });
    expect(deriveEdit('abc', '')).toEqual({ kind: 'delete', pos: 0, length: 3, deleted: 'abc', text: '' });
    expect(deriveEdit('', 'xyz')).toEqual({ kind: 'insert', pos: 0, length: 0, deleted: '', text: 'xyz' });
  });

  it('emoji / 代理对坐标按 UTF-16 码元', () => {
    expect(deriveEdit('a😀b', 'a😀c')).toEqual({ kind: 'replace', pos: 3, length: 1, deleted: 'b', text: 'c' });
    const diff = deriveEdit('😀', '😀😀');
    expect(diff).not.toBeNull();
    expect(diff?.pos).toBe(2);
    expect(diff?.text).toBe('😀');
  });

  it('任意差异都能精确复原 next', () => {
    const cases: Array<[string, string]> = [
      ['', 'hello'],
      ['hello', ''],
      ['hello', 'hallo'],
      ['同一个世界', '同一个 世界'],
      ['abc😀def', 'abc🎉def'],
      ['line1\nline2', 'line1\nline2\nline3'],
      ['重复重复重复', '重复'],
    ];
    for (const [prev, next] of cases) {
      const edit = deriveEdit(prev, next);
      if (edit === null) {
        expect(prev).toBe(next);
        continue;
      }
      const rebuilt = `${prev.slice(0, edit.pos)}${edit.text}${prev.slice(edit.pos + edit.length)}`;
      expect(rebuilt).toBe(next);
      expect(prev.slice(edit.pos, edit.pos + edit.length)).toBe(edit.deleted);
    }
  });
});
