import { describe, expect, it } from 'vitest';
import { checkLogText, createHarness, eventsOfType, readRawEvents, replayText, reopenHarness } from '../support/test-utils';

/** 单字符 append 次数（约等于一篇中篇小说的逐字敲击量级的事件数）。 */
const APPEND_COUNT = 3000;
/** 宽松上限：仅用于防止 O(n²)/指数级退化，正常实现应远低于此（CI 抖动容忍）。 */
const APPEND_TIME_BUDGET_MS = 120_000;
const TEST_TIMEOUT_MS = 240_000;

describe('规模与热路径（v0.1.1 加固）', () => {
  it(
    '3000 次单字符 append：正文/事件数正确，快照正常，重开后 verify 通过',
    async () => {
      // 关掉自动快照，让事件数/耗时断言稳定；快照能力在末尾单独验证
      const harness = await createHarness({
        autoSnapshot: { maxEvents: 1_000_000, maxIntervalMs: 1_000_000_000 },
      });
      const doc = await harness.engine.createDoc('规模测试');

      const started = performance.now();
      for (let index = 0; index < APPEND_COUNT; index += 1) {
        await doc.appendEdit({ kind: 'insert', pos: index, text: '字' });
      }
      const appendElapsed = performance.now() - started;

      const expectedText = '字'.repeat(APPEND_COUNT);
      expect(doc.text).toBe(expectedText);
      expect(doc.text.length).toBe(APPEND_COUNT);
      // header + session.start + 3000 条 text.insert
      expect(doc.eventCount).toBe(1 + 1 + APPEND_COUNT);
      expect(appendElapsed).toBeLessThan(APPEND_TIME_BUDGET_MS);

      // 大量事件之后：快照 / 历史 / 预览仍然正确
      const snapshotInfo = await doc.snapshot('规模快照', 'manual');
      expect(snapshotInfo.chars).toBe(APPEND_COUNT);
      expect((await doc.history()).length).toBe(1);
      expect(await doc.previewSnapshot(snapshotInfo.seq)).toBe(expectedText);

      await doc.close();

      // 重新创建引擎 + 打开：正文一致、哈希链/重放/快照校验通过
      const second = await reopenHarness(harness);
      const reopened = await second.engine.openDoc(doc.docId);
      expect(reopened.text).toBe(expectedText);
      // header + session.start + 3000 insert + snapshot + session.end + 重开 session.start
      expect(reopened.eventCount).toBe(1 + 1 + APPEND_COUNT + 1 + 1 + 1);

      const report = await reopened.verify();
      expect(report.ok).toBe(true);
      expect(report.eventCount).toBe(reopened.eventCount);
      expect(report.snapshotMismatchSeqs).toEqual([]);
      expect(report.unknownTextEventSeqs).toEqual([]);

      const rawEvents = await readRawEvents(harness.dbName, doc.docId);
      expect(rawEvents.filter((record) => record.event.type === 'text.insert')).toHaveLength(APPEND_COUNT);

      const events = await checkLogText(await (await reopened.exportLog()).text(), { docId: doc.docId });
      expect(eventsOfType(events, 'text.insert').length).toBe(APPEND_COUNT);
      expect(replayText(events)).toBe(expectedText);
      await reopened.close();
    },
    TEST_TIMEOUT_MS,
  );
});
