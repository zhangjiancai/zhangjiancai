/**
 * v1.0 格式金标准 fixture 测试。
 *
 * 「只增不删」回归护栏：tests/fixtures/v1.0-golden.wtlog 是 v1.0 定稿时固定下来的
 * 真实日志（含全部文本事件、快照、输入法过程与未知字段/未知 meta 事件）。
 * **未来任何格式演进后，这个文件都必须仍然可读、可校验、可导入**；
 * 如果这里失败，说明破坏了对旧文件的兼容承诺（docs/FILE-FORMAT.md 第 8 节）。
 */
import { describe, expect, it } from 'vitest';
import { parseLogText, verifyLog } from '../../src/engine/log';
import {
  checkLogText,
  createHarness,
  eventsOfType,
  readRawEvents,
  replayText,
} from '../support/test-utils';
// 由 tests/fixtures/generate-v1.0-golden.mjs 生成并固定提交
import goldenLog from '../fixtures/v1.0-golden.wtlog?raw';

const EXPECTED_DOC_ID = '0f4c9a2e-6b1d-4c8a-9f0e-2a7b3c5d8e11';
const EXPECTED_TITLE = '金标准作品';
const EXPECTED_TEXT = '全新正文';
const EXPECTED_EVENT_COUNT = 18;

describe('v1.0 金标准 fixture（只增不删回归护栏）', () => {
  it('parseLogText + verifyLog 通过：docId/标题/正文/快照均符合 v1.0 语义', async () => {
    const source = parseLogText(goldenLog);
    expect(source.parseError).toBeUndefined();
    expect(source.warnings).toEqual([]);
    expect(source.values.length).toBe(EXPECTED_EVENT_COUNT);

    const result = await verifyLog(source);
    expect(result.ok).toBe(true);
    expect(result.brokenAt).toBeNull();
    expect(result.chainOk).toBe(true);
    expect(result.seqOk).toBe(true);
    expect(result.docId).toBe(EXPECTED_DOC_ID);
    expect(result.title).toBe(EXPECTED_TITLE);
    expect(result.text).toBe(EXPECTED_TEXT);
    expect(result.snapshotMismatchSeqs).toEqual([]);
    expect(result.unknownTextEventSeqs).toEqual([]);
    expect(result.eventCount).toBe(EXPECTED_EVENT_COUNT);

    // 覆盖 v1.0 所有文本事件与关键 meta 事件
    const types = result.events.map((event) => event.type);
    for (const type of [
      'doc.init',
      'session.start',
      'session.end',
      'text.insert',
      'text.delete',
      'text.replace',
      'text.reset',
      'snapshot',
      'compose.start',
      'compose.update',
      'compose.end',
      'selection.set',
      'editor.mode',
      'doc.title',
    ]) {
      expect(types).toContain(type);
    }
  });

  it('独立校验器（独立 canonical/哈希）可验证；未知字段与未知 meta 事件被忽略且不破坏链', async () => {
    const events = await checkLogText(goldenLog, { docId: EXPECTED_DOC_ID });
    expect(events.length).toBe(EXPECTED_EVENT_COUNT);
    expect(replayText(events)).toBe(EXPECTED_TEXT);

    // 未知 meta 事件：保留在流中、affects=meta、不改变正文
    const unknownMeta = eventsOfType(events, 'x.test.meta');
    expect(unknownMeta).toHaveLength(1);
    expect(unknownMeta[0].affects).toBe('meta');
    expect(unknownMeta[0].data).toMatchObject({ foo: 'bar', nested: { a: 1 } });

    // 未知信封字段与未知 data 字段都被原样保留，且不影响解析/哈希链
    const insertWithExtra = eventsOfType(events, 'text.insert').find(
      (event) => event.x_note === 'unknown-envelope-field-must-be-preserved',
    );
    expect(insertWithExtra).toBeDefined();
    const selection = eventsOfType(events, 'selection.set')[0];
    expect(selection.data.x_extra).toBe('preserved');
    expect(selection.x_future).toEqual({ version: 2 });

    // 快照不变量
    const snapshots = eventsOfType(events, 'snapshot');
    expect(snapshots.map((snapshot) => snapshot.data.text)).toEqual(['你🌍', EXPECTED_TEXT]);
    expect(snapshots.map((snapshot) => snapshot.data.reason)).toEqual(['manual', 'auto']);
  });

  it('引擎 importFile 旧文件后正文/标题/历史一致，未知字段保留且可继续追加', async () => {
    const harness = await createHarness();
    const summary = await harness.engine.importFile(new Blob([goldenLog]), 'v1.0-golden.wtlog');
    expect(summary.docId).toBe(EXPECTED_DOC_ID);
    expect(summary.title).toBe(EXPECTED_TITLE);
    expect(summary.chars).toBe(EXPECTED_TEXT.length);
    expect(summary.trashed).toBe(false);
    expect(summary.integrity).toBe('ok');

    const doc = await harness.engine.openDoc(summary.docId);
    expect(doc.text).toBe(EXPECTED_TEXT);
    const history = await doc.history();
    expect(history.map((item) => item.reason)).toEqual(['manual', 'auto']);
    expect(await doc.previewSnapshot(history[0].seq)).toBe('你🌍');
    expect((await doc.verify()).ok).toBe(true);

    // 未知字段经过 IDB 落盘后仍然保留（只增不删、原样保留义务）
    const rawEvents = await readRawEvents(harness.dbName, summary.docId);
    const rawInsert = rawEvents.find((record) => record.event.type === 'text.insert');
    expect(rawInsert?.event.x_note).toBe('unknown-envelope-field-must-be-preserved');
    const rawUnknown = rawEvents.find((record) => record.event.type === 'x.test.meta');
    expect(rawUnknown?.event.affects).toBe('meta');

    // 旧文件可继续按 v1.0 追加事件（不修改任何历史行）
    await doc.appendEdit({ kind: 'insert', pos: EXPECTED_TEXT.length, text: '！' });
    expect(doc.text).toBe(`${EXPECTED_TEXT}！`);
    expect((await doc.verify()).ok).toBe(true);
    const appended = await (await doc.exportLog()).text();
    // 历史行保持字节级不变：新日志以 fixture 的全部行作为前缀
    expect(appended.startsWith(goldenLog)).toBe(true);
    await doc.close();
  });
});
