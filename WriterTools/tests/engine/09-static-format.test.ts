import { describe, expect, it } from 'vitest';
import { LOG_FILE_MIME } from '../../src/engine';
import { checkLogText, createHarness, eventsOfType, readRawDocRecord, readRawEvents } from '../support/test-utils';

const MAX_LINE_BYTES = 256 * 1024;

describe('导出文件静态格式检查（独立校验，规范 2–4、7.1）', () => {
  it('完整写作生命周期导出的 .wtlog 满足全部静态约束', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('静态检查作品');

    // 真实写作场景：标题、模式、输入、删除、输入法、选区、快照、恢复
    await doc.setTitle('深夜写作');
    await doc.setMode('typewriter');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '第一章\n' }, { inputType: 'insertText' });
    await doc.appendEdit({ kind: 'insert', pos: 4, text: '你好，世界。' });
    await doc.appendCompose({ phase: 'start', data: 'shijie', from: 7, to: 7 });
    await doc.appendCompose({ phase: 'update', data: '世界', from: 7, to: 7, candidate: 2 });
    await doc.appendCompose({ phase: 'end', data: '世界', committed: '世界' });
    await doc.appendEdit({ kind: 'replace', pos: 7, length: 2, deleted: '世界', text: '世界！', source: 'ime' });
    await doc.setSelection({ from: 0, to: 0 }, 'caret');
    await doc.appendEdit({ kind: 'delete', pos: 9, length: 1, deleted: '！', direction: 'backward' });
    const snapshot = await doc.snapshot('第一次保存', 'manual');
    await doc.appendEdit({ kind: 'insert', pos: 10, text: '尾声' });
    await doc.restore(snapshot.seq, '回到第一次保存');
    await doc.close();

    const blob = await doc.exportLog();
    expect(blob.type).toBe(LOG_FILE_MIME);
    const text = await blob.text();
    const expectedText = doc.text;
    expect(expectedText).toBe('第一章\n你好，世界。');

    // 1) 每行合法 JSON、规范化、哈希链/seq/prev 完整、文本重放正确、快照不变量成立
    const events = await checkLogText(text, { docId: doc.docId });
    expect(events.length).toBeGreaterThanOrEqual(15);

    // 2) header 字段
    const header = events[0];
    expect(header.type).toBe('doc.init');
    expect(header.seq).toBe(0);
    expect(header.magic).toBe('writertools-log');
    expect(header.format).toBe('1.0');
    expect(header.affects).toBe('meta');
    expect(header.prev).toBe('');
    expect(header.data.docId).toBe(doc.docId);
    expect(header.data.title).toBe('静态检查作品');
    expect(header.data.app).toEqual({ name: 'WriterTools', version: '0.2.1' });
    expect(typeof header.data.createdAt).toBe('string');

    // 3) 写出的就是规范化 JSON（键排序、无空白），且无 BOM、LF 结尾
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);

    // 4) 行长度建议值 ≤ 256 KiB
    const encoder = new TextEncoder();
    for (const line of text.split('\n').filter((item) => item.length > 0)) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(MAX_LINE_BYTES);
    }

    // 5) 关键事件类型齐全且 affects 正确
    const textTypes = new Set(['text.insert', 'text.delete', 'text.replace', 'text.reset']);
    for (const event of events) {
      if (textTypes.has(event.type)) expect(event.affects).toBe('text');
      else expect(event.affects).toBe('meta');
    }
    for (const type of ['doc.title', 'editor.mode', 'session.start', 'session.end', 'snapshot', 'text.reset']) {
      expect(eventsOfType(events, type).length).toBeGreaterThanOrEqual(1);
    }
    expect(eventsOfType(events, 'compose.start').length).toBe(1);
    expect(eventsOfType(events, 'selection.set').length).toBeGreaterThanOrEqual(1);
    expect(eventsOfType(events, 'text.reset')[0].data.reason).toBe('restore');

    // 6) IDB 主存储结构与日志一致：value = { docId, seq, event }
    const records = await readRawEvents(harness.dbName, doc.docId);
    expect(records.length).toBe(events.length);
    expect(records[0]).toMatchObject({ docId: doc.docId, seq: 0 });
    expect(records[0].event.magic).toBe('writertools-log');
    expect(records[1].seq).toBe(1);
    const docRecord = await readRawDocRecord(harness.dbName, doc.docId);
    expect(docRecord).not.toBeNull();
    expect(docRecord?.docId).toBe(doc.docId);
    expect(docRecord?.lastSeq).toBe(events.length - 1);
    expect(docRecord?.lastHash).toBe(events[events.length - 1].hash);
    expect(docRecord?.chars).toBe(expectedText.length);
    expect(docRecord?.eventCount).toBe(events.length);
  });

  it('导出的纯文本与引擎正文一致', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '纯文本导出\n第二行' });
    await doc.close();
    const blob = await doc.exportText();
    expect(blob.type).toContain('text/plain');
    expect(await blob.text()).toBe('纯文本导出\n第二行');
  });
});
