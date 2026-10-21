import { describe, expect, it } from 'vitest';
import type { DocChange } from '../../src/engine';
import { checkLogText, createHarness, eventsOfType, readRawEvents, reopenHarness } from '../support/test-utils';

describe('快照 / 历史 / 恢复（规范 6.7、7）', () => {
  it('手动快照 → 历史 → 预览 → 恢复：正文正确、历史不丢、校验通过', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('版本历史');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '第一版正文' });
    const first = await doc.snapshot('版本一', 'manual');
    expect(first.reason).toBe('manual');
    expect(first.message).toBe('版本一');
    expect(first.chars).toBe(5);
    expect(first.seq).toBeGreaterThan(0);

    await doc.appendEdit({ kind: 'insert', pos: 5, text: '，又写了点' });
    const second = await doc.snapshot('版本二', 'manual');
    expect(second.chars).toBe(10);

    const history = await doc.history();
    expect(history.map((item) => item.seq)).toEqual([first.seq, second.seq]);
    expect(history.map((item) => item.reason)).toEqual(['manual', 'manual']);
    expect(await doc.previewSnapshot(first.seq)).toBe('第一版正文');
    expect(await doc.previewSnapshot(second.seq)).toBe('第一版正文，又写了点');

    const restored = await doc.restore(first.seq, '回到版本一');
    expect(restored.reason).toBe('restore');
    expect(restored.chars).toBe(5);
    expect(doc.text).toBe('第一版正文');

    const historyAfter = await doc.history();
    expect(historyAfter.length).toBe(3);
    expect(historyAfter[0].seq).toBe(first.seq);
    expect(historyAfter[2].seq).toBe(restored.seq);

    const report = await doc.verify();
    expect(report.ok).toBe(true);
    expect(report.brokenAt).toBeNull();
    expect(report.unknownTextEventSeqs).toEqual([]);
    expect(report.snapshotMismatchSeqs).toEqual([]);
    expect(doc.readonly).toBe(false);

    const events = await checkLogText(await (await doc.exportLog()).text(), { docId: doc.docId });
    expect(eventsOfType(events, 'snapshot')).toHaveLength(3);
    const resets = eventsOfType(events, 'text.reset');
    expect(resets).toHaveLength(1);
    expect(resets[0].data).toMatchObject({ text: '第一版正文', reason: 'restore', targetSeq: first.seq });
    await doc.close();
  });

  it('快照触发 saved 监听，reason / eventCount 语义正确', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('');
    const saved: DocChange[] = [];
    doc.on((change) => {
      if (change.kind === 'saved') saved.push(change);
    });
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'x' });
    await doc.snapshot();
    expect(saved).toHaveLength(1);
    const change = saved[0];
    if (change.kind !== 'saved') throw new Error('unreachable');
    expect(change.snapshot.reason).toBe('manual');
    expect(change.snapshot.eventCount).toBe(change.snapshot.seq + 1);
    await doc.close();
  });

  it('自动快照：事件数达到 maxEvents 后自动生成 reason=auto 的快照', async () => {
    const harness = await createHarness({ autoSnapshot: { maxEvents: 2, maxIntervalMs: 3_600_000 } });
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    expect((await doc.history()).length).toBe(0);
    await doc.appendEdit({ kind: 'insert', pos: 1, text: 'b' });
    const history = await doc.history();
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[history.length - 1].reason).toBe('auto');
    expect(history[history.length - 1].message).toBe('');
    await checkLogText(await (await doc.exportLog()).text());
    await doc.close();
  });

  it('自动快照：时间间隔达到 maxIntervalMs 且正文有变化时生成', async () => {
    const harness = await createHarness({ autoSnapshot: { maxEvents: 100_000, maxIntervalMs: 60_000 } });
    const doc = await harness.engine.createDoc('');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    expect((await doc.history()).length).toBe(0);
    harness.clock.advance(61_000);
    await doc.appendEdit({ kind: 'insert', pos: 1, text: 'b' });
    const history = await doc.history();
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe('auto');
    await doc.close();
  });

  it('close 时对未快照的改动生成 reason=session 快照，并写 session.start / session.end', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('会话');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '会话内容' });
    await doc.close();

    const eventsBeforeReopen = await checkLogText(await (await doc.exportLog()).text(), { docId: doc.docId });
    expect(eventsBeforeReopen.some((event) => event.type === 'session.start')).toBe(true);
    expect(eventsBeforeReopen.some((event) => event.type === 'session.end')).toBe(true);
    const sessionSnapshot = eventsOfType(eventsBeforeReopen, 'snapshot').find(
      (event) => event.data.reason === 'session',
    );
    expect(sessionSnapshot).toBeDefined();

    const second = await reopenHarness(harness);
    const reopened = await second.engine.openDoc(doc.docId);
    const history = await reopened.history();
    expect(history.some((item) => item.reason === 'session')).toBe(true);
    expect(reopened.text).toBe('会话内容');
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();
  });

  it('自动快照阈值只统计文本编辑事件（选区/输入法事件不推高频率）', async () => {
    const harness = await createHarness({ autoSnapshot: { maxEvents: 2, maxIntervalMs: 3_600_000 } });
    const doc = await harness.engine.createDoc('');
    // 5 条选区 + 1 条输入法 meta 事件不应触发自动快照
    for (let index = 0; index < 5; index += 1) {
      await doc.setSelection({ from: 0, to: 0 }, 'caret');
    }
    await doc.appendCompose({ phase: 'start', data: 'ni', from: 0, to: 0 });
    expect((await doc.history()).length).toBe(0);

    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' }); // 文本事件 1
    expect((await doc.history()).length).toBe(0);
    await doc.appendEdit({ kind: 'insert', pos: 1, text: 'b' }); // 文本事件 2 → 触发
    const history = await doc.history();
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe('auto');
    await doc.close();
  });
});
