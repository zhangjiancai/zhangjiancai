import { describe, expect, it } from 'vitest';
import { createAutoBackupScheduler } from '../../src/engine/auto-backup';
import type { AutoBackupScheduler, AutoBackupSchedulerDeps } from '../../src/engine/auto-backup';
import { createHarness } from '../support/test-utils';

// ---------------------------------------------------------------------------
// 确定性假定时器：让防抖/最小间隔/进行中重试的测试不依赖真实时间
// ---------------------------------------------------------------------------

interface FakeClock {
  deps: Pick<AutoBackupSchedulerDeps, 'now' | 'setTimeout' | 'clearTimeout'>;
  advance(ms: number): Promise<void>;
  pendingCount(): number;
}

function createFakeClock(startMs = 0): FakeClock {
  let current = startMs;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();

  const deps: Pick<AutoBackupSchedulerDeps, 'now' | 'setTimeout' | 'clearTimeout'> = {
    now: () => current,
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { at: current + Math.max(0, ms), fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      tasks.delete(handle as unknown as number);
    },
  };

  async function drainMicrotasks(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  return {
    deps,
    async advance(ms: number): Promise<void> {
      const target = current + ms;
      await drainMicrotasks();
      for (;;) {
        let nextIdToRun: number | null = null;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, task] of tasks) {
          if (task.at <= target && task.at < nextAt) {
            nextIdToRun = id;
            nextAt = task.at;
          }
        }
        if (nextIdToRun === null) break;
        const task = tasks.get(nextIdToRun);
        tasks.delete(nextIdToRun);
        current = nextAt;
        task?.fn();
        await drainMicrotasks();
      }
      current = target;
      await drainMicrotasks();
    },
    pendingCount: () => tasks.size,
  };
}

interface HarnessState {
  clock: FakeClock;
  scheduler: AutoBackupScheduler;
  calls: number;
  callTimes: number[];
  configured: boolean;
  rejectNext: boolean;
  /** 允许测试阻塞第一次 backupNow。 */
  gate: { promise: Promise<void>; resolve: () => void } | null;
}

function createSchedulerHarness(options?: {
  enabled?: boolean;
  debounceMs?: number;
  minIntervalMs?: number;
  configured?: boolean;
}): HarnessState {
  const clock = createFakeClock();
  const state: HarnessState = {
    clock,
    scheduler: null as unknown as AutoBackupScheduler,
    calls: 0,
    callTimes: [],
    configured: options?.configured ?? true,
    rejectNext: false,
    gate: null,
  };
  state.scheduler = createAutoBackupScheduler(
    {
      enabled: options?.enabled ?? true,
      debounceMs: options?.debounceMs ?? 100,
      minIntervalMs: options?.minIntervalMs ?? 0,
    },
    {
      ...clock.deps,
      isConfigured: async () => state.configured,
      backupNow: async () => {
        state.calls += 1;
        state.callTimes.push(clock.deps.now!());
        if (state.gate) await state.gate.promise;
        if (state.rejectNext) {
          state.rejectNext = false;
          throw new Error('模拟备份失败');
        }
      },
    },
  );
  return state;
}

describe('自动备份调度器（防抖 + 最小间隔 + 静默失败）', () => {
  it('enabled=false 时完全不调度', async () => {
    const harness = createSchedulerHarness({ enabled: false });
    harness.scheduler.schedule();
    expect(harness.clock.pendingCount()).toBe(0);
    expect(harness.scheduler.isPending()).toBe(false);
    await harness.clock.advance(10_000);
    expect(harness.calls).toBe(0);
  });

  it('未配置备份目录时静默跳过（不调用 backupNow、不抛错）', async () => {
    const harness = createSchedulerHarness({ configured: false });
    harness.scheduler.schedule();
    expect(harness.clock.pendingCount()).toBe(1);
    await harness.clock.advance(100);
    expect(harness.calls).toBe(0);
    expect(harness.scheduler.isPending()).toBe(false);
  });

  it('防抖：连续多次触发只备份一次，且会顺延', async () => {
    const harness = createSchedulerHarness({ debounceMs: 100 });
    harness.scheduler.schedule();
    await harness.clock.advance(60);
    harness.scheduler.schedule();
    await harness.clock.advance(60);
    expect(harness.calls).toBe(0); // 被第二次触发顺延
    await harness.clock.advance(40);
    expect(harness.calls).toBe(1);
    expect(harness.callTimes[0]).toBe(160);
  });

  it('最小间隔：两次实际备份开始时间至少相距 minIntervalMs', async () => {
    const harness = createSchedulerHarness({ debounceMs: 100, minIntervalMs: 500 });
    harness.scheduler.schedule();
    await harness.clock.advance(100);
    expect(harness.calls).toBe(1);
    harness.scheduler.schedule(); // 立刻再次触发
    await harness.clock.advance(300);
    expect(harness.calls).toBe(1); // 距上次开始不足 500ms，继续等待
    await harness.clock.advance(200);
    expect(harness.calls).toBe(2);
    expect(harness.callTimes[1]! - harness.callTimes[0]!).toBeGreaterThanOrEqual(500);
  });

  it('手动备份后 noteBackupStarted 会推迟自动备份', async () => {
    const harness = createSchedulerHarness({ debounceMs: 100, minIntervalMs: 500 });
    harness.scheduler.noteBackupStarted();
    harness.scheduler.schedule();
    await harness.clock.advance(100);
    expect(harness.calls).toBe(0);
    await harness.clock.advance(400);
    expect(harness.calls).toBe(1);
  });

  it('备份进行中又有新触发：结束后补跑一次', async () => {
    const harness = createSchedulerHarness({ debounceMs: 100, minIntervalMs: 0 });
    let releaseGate: () => void = () => undefined;
    harness.gate = { promise: new Promise<void>((resolve) => (releaseGate = resolve)), resolve: () => releaseGate() };
    harness.scheduler.schedule();
    await harness.clock.advance(100);
    expect(harness.calls).toBe(1); // 第一次备份进行中
    harness.scheduler.schedule(); // 备份期间产生新快照
    await harness.clock.advance(100); // 定时器触发时发现仍在进行 → 安排补跑
    expect(harness.calls).toBe(1);
    harness.gate = null;
    releaseGate();
    await harness.clock.advance(Math.max(50, 100));
    expect(harness.calls).toBe(2);
  });

  it('备份失败静默，之后仍可再次调度成功', async () => {
    const harness = createSchedulerHarness({ debounceMs: 100 });
    harness.rejectNext = true;
    harness.scheduler.schedule();
    await harness.clock.advance(100);
    expect(harness.calls).toBe(1); // 失败了但未抛错
    harness.scheduler.schedule();
    await harness.clock.advance(100);
    expect(harness.calls).toBe(2);
  });

  it('cancel / dispose 清除待执行任务，dispose 后不再调度', async () => {
    const harness = createSchedulerHarness({ debounceMs: 100 });
    harness.scheduler.schedule();
    harness.scheduler.cancel();
    await harness.clock.advance(500);
    expect(harness.calls).toBe(0);

    harness.scheduler.schedule();
    harness.scheduler.dispose();
    await harness.clock.advance(500);
    expect(harness.calls).toBe(0);
    harness.scheduler.schedule();
    expect(harness.scheduler.isPending()).toBe(false);
  });

  it('isConfigured 抛错时静默跳过', async () => {
    const clock = createFakeClock();
    const scheduler = createAutoBackupScheduler(
      { enabled: true, debounceMs: 50, minIntervalMs: 0 },
      {
        ...clock.deps,
        isConfigured: async () => {
          throw new Error('状态读取失败');
        },
        backupNow: async () => {
          throw new Error('不应被调用');
        },
      },
    );
    scheduler.schedule();
    await clock.advance(50);
    expect(scheduler.isPending()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 引擎集成：快照 → 自动备份调度接线（Node 无 FSA，用内部状态模拟"已配置目录"）
// ---------------------------------------------------------------------------

interface EngineInternals {
  backupConfigured: boolean;
  autoBackupEnabled: boolean;
  autoBackupScheduler: { schedule(): void; isPending(): boolean };
}

describe('引擎集成：快照触发自动备份调度', () => {
  it('手动快照 / 自动快照 / restore 快照 / close 会话快照都会触发调度', async () => {
    const harness = await createHarness({
      autoSnapshot: { maxEvents: 2, maxIntervalMs: 1_000_000 },
      autoBackup: { enabled: true, debounceMs: 60_000, minIntervalMs: 0 },
    });
    const doc = await harness.engine.createDoc('自动备份集成');
    const internals = harness.engine as unknown as EngineInternals;
    // Node 无 File System Access：把内部"已配置目录"状态置为 true，并统计调度调用（不真正写目录）
    internals.backupConfigured = true;
    let scheduled = 0;
    internals.autoBackupScheduler.schedule = () => {
      scheduled += 1;
    };

    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    await doc.appendEdit({ kind: 'insert', pos: 1, text: 'b' }); // 触发 auto snapshot
    expect(scheduled).toBe(1);
    const autoSnapshot = (await doc.history())[0];
    expect(autoSnapshot.reason).toBe('auto');

    await doc.snapshot('手动', 'manual');
    expect(scheduled).toBe(2);

    await doc.restore(autoSnapshot.seq);
    expect(scheduled).toBe(3); // restore 追加的新快照

    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'x' }); // 制造未快照变化
    await doc.close();
    expect(scheduled).toBe(4); // close 时 reason=session 的快照
  });

  it('autoBackup.enabled=false 时快照完全不触发调度', async () => {
    const harness = await createHarness({ autoBackup: { enabled: false, debounceMs: 10 } });
    const doc = await harness.engine.createDoc('');
    const internals = harness.engine as unknown as EngineInternals;
    internals.backupConfigured = true;
    let scheduled = 0;
    internals.autoBackupScheduler.schedule = () => {
      scheduled += 1;
    };
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    await doc.snapshot('手动');
    await doc.close();
    expect(scheduled).toBe(0);
    expect(internals.autoBackupEnabled).toBe(false);
  });

  it('未配置备份目录（Node 默认）时快照不产生定时器、不抛错、不拖慢 close', async () => {
    const harness = await createHarness({ autoSnapshot: { maxEvents: 2, maxIntervalMs: 1_000_000 } });
    const doc = await harness.engine.createDoc('');
    const errors: Error[] = [];
    doc.on((change) => {
      if (change.kind === 'error') errors.push(change.error);
    });
    const internals = harness.engine as unknown as EngineInternals;
    expect(internals.backupConfigured).toBe(false);
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'a' });
    await doc.appendEdit({ kind: 'insert', pos: 1, text: 'b' });
    await doc.snapshot('手动');
    expect(internals.autoBackupScheduler.isPending()).toBe(false);
    const startedAt = Date.now();
    await doc.close();
    await harness.engine.flush();
    expect(errors).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('手动 backupNow 行为不变（未配置环境返回 configured=false，不抛错）', async () => {
    const harness = await createHarness();
    const backup = harness.engine.backup();
    const status = await backup.backupNow();
    expect(status.configured).toBe(false);
    const after = await backup.status();
    expect(after.configured).toBe(false);
  });
});
