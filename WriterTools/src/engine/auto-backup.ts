/**
 * 备份目录自动备份调度器。
 *
 * 任何快照（手动 / 自动 / 会话结束 / restore）成功后由 LibraryEngine 调用 schedule()：
 * - 防抖：debounceMs 内的多次触发合并为一次（并顺延）；
 * - 最小间隔：两次实际备份开始时间至少相距 minIntervalMs；
 * - 未配置备份目录 / 备份失败 / 正在备份：静默处理（错误由 BackupService 记录 lastError），
 *   绝不把错误抛到用户编辑路径；
 * - 同一调度器只保留一个待执行 timer；
 * - 备份进行中又有新触发时，会在当前备份结束后再补一次（确保最新快照也落盘）。
 */

export interface AutoBackupOptions {
  enabled: boolean;
  debounceMs: number;
  minIntervalMs: number;
}

export interface AutoBackupSchedulerDeps {
  /** 是否已配置备份目录（运行时复查，未配置则静默跳过）。 */
  isConfigured(): Promise<boolean>;
  backupNow(): Promise<unknown>;
  /** 时间源（测试注入；默认 Date.now）。 */
  now?(): number;
  /** 定时器（测试注入；默认全局 setTimeout）。 */
  setTimeout?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout?(handle: ReturnType<typeof setTimeout>): void;
}

export interface AutoBackupScheduler {
  /** 请求一次自动备份（防抖 + 最小间隔合并）。 */
  schedule(): void;
  /** 记录一次备份开始时间（手动备份后调用，避免立刻重复自动备份）。 */
  noteBackupStarted(): void;
  /** 取消尚未执行的自动备份。 */
  cancel(): void;
  /** 释放调度器（之后不再调度）。 */
  dispose(): void;
  /** 是否有待执行的自动备份（测试/诊断用）。 */
  isPending(): boolean;
}

/** 进行中备份结束后补跑的最短延迟。 */
const RETRY_AFTER_RUNNING_MS = 50;

export function createAutoBackupScheduler(
  options: AutoBackupOptions,
  deps: AutoBackupSchedulerDeps,
): AutoBackupScheduler {
  const now = deps.now ?? ((): number => Date.now());
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastStartedAt: number | null = null;
  let disposed = false;

  function clearPendingTimer(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  async function run(): Promise<void> {
    timer = null;
    if (disposed || !options.enabled) return;
    if (running) {
      // 正在备份：稍后再检查一次，确保期间产生的新快照也会被备份
      if (timer === null) {
        timer = setTimer(() => {
          timer = null;
          void run();
        }, Math.max(RETRY_AFTER_RUNNING_MS, options.debounceMs));
      }
      return;
    }
    let configured = false;
    try {
      configured = await deps.isConfigured();
    } catch {
      configured = false;
    }
    if (!configured) return;
    running = true;
    lastStartedAt = now();
    try {
      await deps.backupNow();
    } catch {
      // 自动备份失败静默：BackupService 已记录 lastError，下次快照会再次尝试
    } finally {
      running = false;
    }
  }

  return {
    schedule(): void {
      if (disposed || !options.enabled) return;
      clearPendingTimer();
      const nowMs = now();
      const earliestByInterval =
        lastStartedAt !== null ? lastStartedAt + options.minIntervalMs : 0;
      const delay = Math.max(0, options.debounceMs, earliestByInterval - nowMs);
      timer = setTimer(() => {
        timer = null;
        void run();
      }, delay);
    },
    noteBackupStarted(): void {
      lastStartedAt = now();
    },
    cancel(): void {
      clearPendingTimer();
    },
    dispose(): void {
      disposed = true;
      clearPendingTimer();
    },
    isPending(): boolean {
      return timer !== null;
    },
  };
}
