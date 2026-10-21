import { describe, expect, it } from 'vitest';
import { BACKUP_KV_KEYS, createBackupService } from '../../src/engine/backup';
import type { InternalBackupService } from '../../src/engine/backup';
import type { BackupStatus, LibraryEngine } from '../../src/engine/types';
import { createFakeDirectoryHandle, createFakeKvDatabase, withFakePicker } from '../support/fake-backup';
import type { FakeDirectoryHandle } from '../support/fake-backup';
import { createHarness, waitFor } from '../support/test-utils';

/** 最小假 IDB + 已存目录句柄，返回真实 backup 服务。 */
function createPermissionService(dir: FakeDirectoryHandle): {
  service: InternalBackupService;
  store: Record<string, unknown>;
} {
  const { db, store } = createFakeKvDatabase({
    [BACKUP_KV_KEYS.dirHandle]: dir,
    [BACKUP_KV_KEYS.lastBackupAt]: '2026-01-01T00:00:00.000Z',
    [BACKUP_KV_KEYS.docCount]: 2,
  });
  const service = createBackupService(
    {
      db,
      now: () => new Date('2026-02-01T00:00:00.000Z'),
      listDocRecords: async () => [],
      readDocEvents: async () => [],
      flushAll: async () => undefined,
    },
    true,
  );
  return { service, store };
}

describe('备份目录权限健康检查（BackupStatus.permission / needsPermission）', () => {
  it('queryPermission=prompt：status 报告 prompt + needsPermission=true；requestPermission 后 granted', async () => {
    const dir = createFakeDirectoryHandle({ permission: 'prompt' });
    const { service } = createPermissionService(dir);

    const before = await withFakePicker(dir, () => service.status());
    expect(before.configured).toBe(true);
    expect(before.permission).toBe('prompt');
    expect(before.needsPermission).toBe(true);

    const after = await withFakePicker(dir, () => service.requestPermission());
    expect(dir.permission).toBe('granted');
    expect(after.permission).toBe('granted');
    expect(after.needsPermission).toBe(false);
  });

  it('queryPermission=denied 且用户拒绝重新授权：保持 denied / needsPermission=true', async () => {
    const dir = createFakeDirectoryHandle({ permission: 'denied', grantOnRequest: false });
    const { service } = createPermissionService(dir);
    const before = await withFakePicker(dir, () => service.status());
    expect(before.permission).toBe('denied');
    expect(before.needsPermission).toBe(true);
    const after = await withFakePicker(dir, () => service.requestPermission());
    expect(after.permission).toBe('denied');
    expect(after.needsPermission).toBe(true);
  });

  it('句柄/浏览器不支持 queryPermission：permission=unknown 且不误报 needsPermission', async () => {
    const dir = createFakeDirectoryHandle({ supportQueryPermission: false });
    const { service } = createPermissionService(dir);
    const status = await withFakePicker(dir, () => service.status());
    expect(status.configured).toBe(true);
    expect(status.permission).toBe('unknown');
    expect(status.needsPermission ?? false).toBe(false);
    // requestPermission 可正常调用，但查询能力缺失时状态仍是 unknown（不误报）
    const after = await withFakePicker(dir, () => service.requestPermission());
    expect(after.permission).toBe('unknown');
    expect(after.needsPermission ?? false).toBe(false);
  });

  it('queryPermission 抛异常：降级 unknown，不误报', async () => {
    const dir = createFakeDirectoryHandle({ permission: 'prompt' });
    dir.queryPermission = async () => {
      throw new Error('SecurityError');
    };
    const { service } = createPermissionService(dir);
    const status = await withFakePicker(dir, () => service.status());
    expect(status.permission).toBe('unknown');
    expect(status.needsPermission ?? false).toBe(false);
  });

  it('权限不足时手动 backupNow 不抛错、记录可读 lastError（不丢数据）', async () => {
    const dir = createFakeDirectoryHandle({ permission: 'prompt', grantOnRequest: false });
    const { service, store } = createPermissionService(dir);
    const status = await withFakePicker(dir, () => service.backupNow());
    expect(status.configured).toBe(true);
    expect(status.lastError ?? '').toMatch(/权限|授权/);
    expect(String(store[BACKUP_KV_KEYS.lastError])).toMatch(/权限|授权/);
    // 保护性行为：没有写任何文件
    expect(dir.writes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 引擎集成：权限不足时暂停自动备份；授权成功后自动补一次备份
// ---------------------------------------------------------------------------

interface EngineInternals {
  backupConfigured: boolean;
  autoBackupScheduler: { schedule(): void; isPending(): boolean; cancel(): void };
  backupServiceInternal: InternalBackupService;
}

interface FakeServiceState {
  status: BackupStatus;
  backups: number;
}

function createFakeInternalService(state: FakeServiceState): InternalBackupService {
  return {
    status: async () => ({ ...state.status }),
    chooseDirectory: async () => ({ ...state.status }),
    requestPermission: async () => ({ ...state.status }),
    backupNow: async () => {
      state.backups += 1;
      return { ...state.status };
    },
    disable: async () => undefined,
    readDirectoryTexts: async () => null,
  };
}

async function createEngineWithFakeBackup(): Promise<{
  engine: LibraryEngine;
  internals: EngineInternals;
  state: FakeServiceState;
}> {
  const harness = await createHarness({ autoBackup: { debounceMs: 20, minIntervalMs: 0 } });
  const internals = harness.engine as unknown as EngineInternals;
  const state: FakeServiceState = {
    status: { configured: true, permission: 'prompt', needsPermission: true },
    backups: 0,
  };
  internals.backupServiceInternal = createFakeInternalService(state);
  internals.backupConfigured = true;
  return { engine: harness.engine, internals, state };
}

describe('引擎集成：权限门控自动备份', () => {
  it('needsPermission 时自动备份暂停（不执行 backupNow），授权 granted 后恢复', async () => {
    const { engine, internals, state } = await createEngineWithFakeBackup();
    const doc = await engine.createDoc('权限门控');

    await doc.snapshot('权限不足时手动快照');
    await new Promise((resolve) => setTimeout(resolve, 120)); // 等防抖 + 调度器执行
    expect(state.backups).toBe(0); // 权限不足：自动备份被跳过

    // 模拟用户点击「重新授权」，权限恢复 granted
    state.status = { configured: true, permission: 'granted', needsPermission: false };
    await doc.snapshot('授权后快照');
    await waitFor(() => state.backups >= 1, 2000);
    expect(state.backups).toBeGreaterThanOrEqual(1);

    internals.autoBackupScheduler.cancel();
    await doc.close();
  });

  it('引擎备份服务 requestPermission 透传，授权成功后自动调度一次备份', async () => {
    const { engine, internals, state } = await createEngineWithFakeBackup();
    internals.backupServiceInternal.requestPermission = async () => {
      state.status = { configured: true, permission: 'granted', needsPermission: false };
      return { ...state.status };
    };
    const status = await engine.backup().requestPermission();
    expect(status.permission).toBe('granted');
    expect(status.needsPermission).toBe(false);
    await waitFor(() => state.backups >= 1, 2000);
    expect(state.backups).toBeGreaterThanOrEqual(1);
    internals.autoBackupScheduler.cancel();
  });
});
