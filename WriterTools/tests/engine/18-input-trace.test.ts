import { describe, expect, it } from 'vitest';
import type { InputTraceEntry } from '../../src/engine';
import { INPUT_TRACE_DEFAULT_LIMIT, normalizeInputTraceLimit } from '../../src/engine/handle';
import { createHarness, mutateRawEvent, readRawEvents, reopenHarness } from '../support/test-utils';

type ComposeEntry = Extract<InputTraceEntry, { kind: 'compose' }>;
type TextEntry = Extract<InputTraceEntry, { kind: 'text' }>;
type SessionEntry = Extract<InputTraceEntry, { kind: 'session' }>;
type ModeEntry = Extract<InputTraceEntry, { kind: 'mode' }>;

const traceFilter = {
  compose: (trace: InputTraceEntry[]): ComposeEntry[] => trace.filter((entry): entry is ComposeEntry => entry.kind === 'compose'),
  text: (trace: InputTraceEntry[]): TextEntry[] => trace.filter((entry): entry is TextEntry => entry.kind === 'text'),
  session: (trace: InputTraceEntry[]): SessionEntry[] => trace.filter((entry): entry is SessionEntry => entry.kind === 'session'),
  mode: (trace: InputTraceEntry[]): ModeEntry[] => trace.filter((entry): entry is ModeEntry => entry.kind === 'mode'),
};

describe('getInputTrace 原始输入时间线', () => {
  it('归一化 compose / text / session / mode：字段、原始拼音与顺序正确', async () => {
    const harness = await createHarness({
      autoSnapshot: { maxEvents: 1_000_000, maxIntervalMs: 1_000_000_000 },
    });
    const doc = await harness.engine.createDoc('输入回放');
    await doc.setMode('typewriter');
    await doc.appendCompose({ phase: 'start', data: 'ni', from: 0, to: 0 });
    await doc.appendCompose({ phase: 'update', data: 'nihao', from: 0, to: 0, candidate: 1 });
    await doc.appendCompose({ phase: 'end', data: '', committed: '你' });
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    await doc.appendEdit({
      kind: 'replace',
      pos: 1,
      length: 0,
      deleted: '',
      text: '你',
      source: 'ime',
      inputType: 'insertCompositionText',
    });
    await doc.appendEdit({ kind: 'delete', pos: 0, length: 1, deleted: 'a', direction: 'backward' });
    // 无关事件（selection / snapshot / title 等）不得出现在时间线里
    await doc.setSelection({ from: 0, to: 1 }, 'caret');
    await doc.snapshot('无关快照');
    await doc.setTitle('输入回放改名');

    const trace = await doc.getInputTrace();
    expect(trace.length).toBe(8); // session.start + mode + compose ×3 + text ×3
    for (let index = 1; index < trace.length; index += 1) {
      expect(trace[index].seq).toBeGreaterThan(trace[index - 1].seq);
    }
    for (const entry of trace) expect(typeof entry.ts).toBe('string');
    for (const entry of trace) {
      expect(['compose', 'text', 'session', 'mode']).toContain(entry.kind);
    }

    const sessions = traceFilter.session(trace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: 'session', phase: 'start' });
    expect(typeof sessions[0].sessionId).toBe('string');
    expect(trace[0].kind).toBe('session');

    const modes = traceFilter.mode(trace);
    expect(modes).toHaveLength(1);
    expect(modes[0]).toMatchObject({ kind: 'mode', mode: 'typewriter' });

    const compose = traceFilter.compose(trace);
    expect(compose.map((entry) => entry.phase)).toEqual(['start', 'update', 'end']);
    expect(compose[0]).toMatchObject({ kind: 'compose', phase: 'start', data: 'ni', from: 0, to: 0 });
    expect(compose[1]).toMatchObject({ kind: 'compose', phase: 'update', data: 'nihao', candidate: 1 });
    expect(compose[2]).toMatchObject({ kind: 'compose', phase: 'end', committed: '你' });
    // 原始预编辑串（拼音）必须原样保留
    expect(compose.map((entry) => entry.data)).toEqual(['ni', 'nihao', '']);

    const texts = traceFilter.text(trace);
    expect(texts.map((entry) => entry.op)).toEqual(['insert', 'replace', 'delete']);
    expect(texts[0]).toMatchObject({ op: 'insert', pos: 0, text: 'a', source: 'typing' });
    expect(texts[1]).toMatchObject({
      op: 'replace',
      pos: 1,
      length: 0,
      deleted: '',
      text: '你',
      source: 'ime',
      inputType: 'insertCompositionText',
    });
    expect(texts[2]).toMatchObject({ op: 'delete', pos: 0, length: 1, deleted: 'a' });
    // delete 的 direction 不属于时间线契约字段：不应出现
    expect(texts[2]).not.toHaveProperty('direction');

    await doc.close();
    // 关闭后（只读查询）session.end 边界出现在时间线末尾
    const afterClose = await doc.getInputTrace({ limit: 0 });
    const sessionsAfterClose = traceFilter.session(afterClose);
    expect(sessionsAfterClose.map((entry) => entry.phase)).toEqual(['start', 'end']);
    expect(typeof sessionsAfterClose[1].sessionId).toBe('string');
    expect(afterClose[afterClose.length - 1].kind).toBe('session');
  });

  it('limit：默认最近 2000；limit=3 取最近 3 条且升序；0/负数返回全部；非法按默认', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('limit 测试');
    await doc.setMode('centered');
    await doc.appendCompose({ phase: 'start', data: 'a', from: 0, to: 0 });
    await doc.appendCompose({ phase: 'end', data: '', committed: '啊' });
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '啊' });
    await doc.appendEdit({ kind: 'delete', pos: 0, length: 1, deleted: '啊' });

    const all = await doc.getInputTrace({ limit: 0 });
    expect(all.length).toBe(6); // session.start + mode + compose ×2 + text ×2
    expect(await doc.getInputTrace({ limit: -5 })).toEqual(all);
    expect(await doc.getInputTrace({ limit: 0 })).toEqual(all);
    expect(await doc.getInputTrace()).toEqual(all); // 默认 2000 > 6
    expect(await doc.getInputTrace({ limit: Number.NaN })).toEqual(all);
    expect(await doc.getInputTrace({ limit: 2.5 })).toEqual(all);

    const lastThree = await doc.getInputTrace({ limit: 3 });
    expect(lastThree).toEqual(all.slice(-3));
    expect(lastThree.map((entry) => entry.seq)).toEqual(
      [...lastThree.map((entry) => entry.seq)].sort((a, b) => a - b),
    );
    const lastOne = await doc.getInputTrace({ limit: 1 });
    expect(lastOne).toHaveLength(1);
    expect(lastOne[0]).toEqual(all[all.length - 1]);

    // limit 归一化纯函数语义（含 >2000 的默认裁剪语义）
    expect(INPUT_TRACE_DEFAULT_LIMIT).toBe(2000);
    expect(normalizeInputTraceLimit(undefined)).toBe(INPUT_TRACE_DEFAULT_LIMIT);
    expect(normalizeInputTraceLimit(null)).toBe(INPUT_TRACE_DEFAULT_LIMIT);
    expect(normalizeInputTraceLimit(Number.NaN)).toBe(INPUT_TRACE_DEFAULT_LIMIT);
    expect(normalizeInputTraceLimit(1.5)).toBe(INPUT_TRACE_DEFAULT_LIMIT);
    expect(normalizeInputTraceLimit(Number.POSITIVE_INFINITY)).toBe(INPUT_TRACE_DEFAULT_LIMIT);
    expect(normalizeInputTraceLimit(0)).toBeNull();
    expect(normalizeInputTraceLimit(-1)).toBeNull();
    expect(normalizeInputTraceLimit(3)).toBe(3);

    await doc.close();
  });

  it('只读操作：调用前后事件数/快照数/正文不变；只读（损坏）句柄也可调用', async () => {
    const harness = await createHarness();
    const doc = await harness.engine.createDoc('只读时间线');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'abc' });
    await doc.setMode('typewriter');

    const beforeEvents = (await readRawEvents(harness.dbName, doc.docId)).length;
    const beforeHistory = (await doc.history()).length;
    const beforeText = doc.text;
    const trace = await doc.getInputTrace({ limit: 0 });
    expect(trace.length).toBeGreaterThan(0);
    expect(traceFilter.text(trace)).toHaveLength(1);
    // 调用前后完全无写入：事件数 / 快照数 / 正文 / 可写状态不变
    expect((await readRawEvents(harness.dbName, doc.docId)).length).toBe(beforeEvents);
    expect((await doc.history()).length).toBe(beforeHistory);
    expect(doc.text).toBe(beforeText);
    expect(doc.readonly).toBe(false);
    await doc.close();

    // 破坏 text.insert 的哈希链 → 重开得到只读句柄
    const records = await readRawEvents(harness.dbName, doc.docId);
    const insertRecord = records.find((record) => record.event.type === 'text.insert');
    if (!insertRecord) throw new Error('测试数据缺少 text.insert');
    await mutateRawEvent(harness.dbName, doc.docId, insertRecord.seq, (event) => {
      const data = event.data as Record<string, unknown>;
      data.text = 'TAMPERED';
    });

    const second = await reopenHarness(harness);
    const readonlyDoc = await second.engine.openDoc(doc.docId);
    expect(readonlyDoc.readonly).toBe(true);
    const readonlyEventsBefore = (await readRawEvents(second.dbName, readonlyDoc.docId)).length;
    const readonlyHistoryBefore = (await readonlyDoc.history()).length;
    const readonlyTextBefore = readonlyDoc.text;

    const readonlyTrace = await readonlyDoc.getInputTrace({ limit: 0 });
    expect(Array.isArray(readonlyTrace)).toBe(true);
    expect(readonlyTrace.length).toBeGreaterThanOrEqual(1); // 有效前缀至少包含 session.start
    expect(traceFilter.session(readonlyTrace).length).toBeGreaterThanOrEqual(1);
    // 只读句柄调用不写日志、不产生快照、不改变正文/可写状态
    expect((await readRawEvents(second.dbName, readonlyDoc.docId)).length).toBe(readonlyEventsBefore);
    expect((await readonlyDoc.history()).length).toBe(readonlyHistoryBefore);
    expect(readonlyDoc.text).toBe(readonlyTextBefore);
    expect(readonlyDoc.readonly).toBe(true);
    expect((await readonlyDoc.verify()).ok).toBe(false);
    await expect(readonlyDoc.appendEdit({ kind: 'insert', pos: 0, text: 'x' })).rejects.toThrow();
    await readonlyDoc.close();
  });
});
