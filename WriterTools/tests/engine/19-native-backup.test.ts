import { describe, expect, it } from 'vitest';
import { createFakeDirectoryHandle, withFakePicker } from '../support/fake-backup';
import { createFakeNativeBridge } from '../support/fake-native-backup';
import { createHarness, testSha256Hex, waitFor } from '../support/test-utils';

const MANIFEST = 'writertools-manifest.json';

interface ManifestShape {
  magic: string;
  format: string;
  docs: Array<{ docId: string; file: string; trashed?: boolean; fileHash?: string; lastHash: string }>;
}

function readManifest(bridge: ReturnType<typeof createFakeNativeBridge>): ManifestShape {
  const text = bridge.files.get(MANIFEST);
  if (!text) throw new Error('原生备份目录缺少 manifest');
  return JSON.parse(text) as ManifestShape;
}

describe('原生备份目录后端（NativeBackupDirectoryBridge）', () => {
  it('status / chooseDirectory：backend=native，未配置→配置，permission 视为 granted', async () => {
    const bridge = createFakeNativeBridge();
    const harness = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    const backup = harness.engine.backup();

    const before = await backup.status();
    expect(before.configured).toBe(false);
    expect(before.backend).toBe('native');
    expect(before.permission).toBeUndefined();

    const afterChoose = await backup.chooseDirectory();
    expect(bridge.chooseCalls).toBe(1);
    expect(afterChoose.configured).toBe(true);
    expect(afterChoose.backend).toBe('native');
    expect(afterChoose.directoryName).toBe('native-backup');
    expect(afterChoose.permission).toBe('granted');
    expect(afterChoose.needsPermission).toBe(false);

    // 原生后端 requestPermission 为 no-op（系统持久授权由平台层保证），状态保持已配置
    const afterRequest = await backup.requestPermission();
    expect(afterRequest.configured).toBe(true);
    expect(afterRequest.backend).toBe('native');
    expect(afterRequest.permission).toBe('granted');
  });

  it('backupNow 通过 bridge 写入真实 manifest + .wtlog 并更新 kv 状态', async () => {
    const bridge = createFakeNativeBridge();
    const harness = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    await harness.engine.backup().chooseDirectory();

    const docA = await harness.engine.createDoc('原生备份A');
    await docA.appendEdit({ kind: 'insert', pos: 0, text: '甲正文' });
    const docB = await harness.engine.createDoc('原生备份B');
    await docB.appendEdit({ kind: 'insert', pos: 0, text: '乙正文' });
    const docAId = docA.docId;
    const docBId = docB.docId;
    await docA.close();
    await docB.close();
    await harness.engine.trashDoc(docBId);

    const status = await harness.engine.backup().backupNow();
    expect(status.configured).toBe(true);
    expect(status.backend).toBe('native');
    expect(status.docCount).toBe(2); // 含回收站
    expect(status.lastBackupAt).toBe(harness.clock.current());
    expect(status.lastError).toBeUndefined();

    // 文件真实写入（含被删作品）
    expect(bridge.writeCalls).toBeGreaterThanOrEqual(3);
    const manifest = readManifest(bridge);
    expect(manifest.magic).toBe('writertools-backup-manifest');
    expect(manifest.format).toBe('1.0');
    expect(manifest.docs).toHaveLength(2);
    const trashedEntry = manifest.docs.find((entry) => entry.docId === docBId);
    expect(trashedEntry?.trashed).toBe(true);
    const activeEntry = manifest.docs.find((entry) => entry.docId === docAId);
    expect(activeEntry?.trashed).toBeUndefined();
    for (const entry of manifest.docs) {
      const logText = bridge.files.get(entry.file);
      expect(logText).toBeTruthy();
      // fileHash 锚点与文件内容一致
      expect(entry.fileHash).toBe(`sha256:${await testSha256Hex(logText!)}`);
    }
  });

  it('readDirectoryTexts / restoreFromBackupDirectory：从原生备份目录一键恢复并重复导入 skipped', async () => {
    const bridge = createFakeNativeBridge();
    const source = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    await source.engine.backup().chooseDirectory();
    const doc = await source.engine.createDoc('原生恢复');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '原生恢复正文' });
    await doc.snapshot('v1');
    const docId = doc.docId;
    const expectedText = doc.text;
    await doc.close();
    await source.engine.backup().backupNow();

    // 新的引擎实例（浏览器数据丢失后重新打开应用）使用同一原生目录
    const target = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    const status = await target.engine.backup().status();
    expect(status.configured).toBe(true);
    expect(status.backend).toBe('native');

    const report = await target.engine.restoreFromBackupDirectory();
    expect(report.imported).toBe(1);
    expect(report.failed).toBe(0);
    const reopened = await target.engine.openDoc(docId);
    expect(reopened.text).toBe(expectedText);
    expect((await reopened.history()).length).toBe(1);
    expect((await reopened.verify()).ok).toBe(true);
    await reopened.close();

    const again = await target.engine.restoreFromBackupDirectory();
    expect(again.skipped).toBe(1);
  });

  it('空库灾备保护：原生目录旧清单不被 trashed 污染，恢复后作品在默认书架', async () => {
    const bridge = createFakeNativeBridge();
    const source = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    await source.engine.backup().chooseDirectory();
    const doc = await source.engine.createDoc('旧清单作品');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '旧正文' });
    const docId = doc.docId;
    const expectedText = doc.text;
    await doc.close();
    await source.engine.backup().backupNow();
    const manifestBefore = bridge.files.get(MANIFEST);
    const writesBefore = bridge.writeCalls;

    // 空库 + 同一原生目录（数据丢失后重开）
    const target = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    const guardStatus = await target.engine.backup().backupNow();
    expect(guardStatus.configured).toBe(true);
    expect(guardStatus.docCount).toBe(0);
    expect(bridge.writeCalls).toBe(writesBefore); // 完全跳过写入
    expect(bridge.files.get(MANIFEST)).toBe(manifestBefore); // 清单字节不变
    const manifest = readManifest(bridge);
    expect(manifest.docs.some((entry) => entry.trashed === true)).toBe(false);

    const report = await target.engine.restoreFromBackupDirectory();
    expect(report.imported).toBe(1);
    const visible = await target.engine.listDocs();
    expect(visible.map((item) => item.docId)).toEqual([docId]);
    expect(visible[0].trashed).toBe(false);
    const reopened = await target.engine.openDoc(docId);
    expect(reopened.text).toBe(expectedText);
    await reopened.close();
  });

  it('disable 调 forgetDirectory，但目录里的备份文件保留；未配置时 backupNow 静默', async () => {
    const bridge = createFakeNativeBridge();
    const harness = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    await harness.engine.backup().chooseDirectory();
    const doc = await harness.engine.createDoc('禁用');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'x' });
    await doc.close();
    await harness.engine.backup().backupNow();
    expect(bridge.files.size).toBeGreaterThan(0);

    await harness.engine.backup().disable();
    expect(bridge.forgetCalls).toBe(1);
    const status = await harness.engine.backup().status();
    expect(status.configured).toBe(false);
    expect(status.backend).toBe('native'); // 桥仍可用，只是未配置目录
    expect(bridge.files.size).toBeGreaterThan(0); // 文件本身不删除

    const backupStatus = await harness.engine.backup().backupNow();
    expect(backupStatus.configured).toBe(false);
    expect(backupStatus.backend).toBe('native');
  });

  it('getDirectory 返回 null 时 configured=false；readFiles 不可读时恢复抛可读错误', async () => {
    const bridge = createFakeNativeBridge();
    const harness = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });
    expect((await harness.engine.backup().status()).configured).toBe(false);
    await expect(harness.engine.restoreFromBackupDirectory()).rejects.toThrow(/备份目录/);

    // 目录已配置但 readFiles 抛错（权限失效）：恢复给出可读错误，且不删除任何文件
    const brokenBridge = createFakeNativeBridge({
      directoryName: 'broken-native',
      files: { [MANIFEST]: '{"magic":"writertools-backup-manifest","format":"1.0","docs":[]}' },
      failReadFiles: true,
    });
    const broken = await createHarness({ backupNative: brokenBridge, autoBackup: { enabled: false } });
    expect((await broken.engine.backup().status()).configured).toBe(true);
    await expect(broken.engine.restoreFromBackupDirectory()).rejects.toThrow(/备份目录/);
    expect(brokenBridge.files.size).toBe(1);
  });

  it('fileSystemAccess:false 时原生后端仍可用；无 FSA 且无 native 时 backend=none', async () => {
    const bridge = createFakeNativeBridge();
    const nativeOnly = await createHarness({
      backupNative: bridge,
      fileSystemAccess: false,
      autoBackup: { enabled: false },
    });
    const chosen = await nativeOnly.engine.backup().chooseDirectory();
    expect(chosen.configured).toBe(true);
    expect(chosen.backend).toBe('native');
    const doc = await nativeOnly.engine.createDoc('原生可用');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: 'ok' });
    await doc.close();
    const status = await nativeOnly.engine.backup().backupNow();
    expect(status.configured).toBe(true);
    expect(status.docCount).toBe(1);
    expect(bridge.writeCalls).toBeGreaterThanOrEqual(2);

    // Node 无 FSA 且不注入 native：降级为 backend='none'
    const plain = await createHarness({ autoBackup: { enabled: false } });
    const plainStatus = await plain.engine.backup().status();
    expect(plainStatus.configured).toBe(false);
    expect(plainStatus.backend).toBe('none');
    expect((await plain.engine.backup().chooseDirectory()).configured).toBe(false);
    expect((await plain.engine.backup().backupNow()).configured).toBe(false);

    // 注入的 native 桥 available=false 时同样降级为 none
    const unavailableBridge = createFakeNativeBridge({ available: false });
    const unavailable = await createHarness({
      backupNative: unavailableBridge,
      fileSystemAccess: false,
      autoBackup: { enabled: false },
    });
    const unavailableStatus = await unavailable.engine.backup().status();
    expect(unavailableStatus.configured).toBe(false);
    expect(unavailableStatus.backend).toBe('none');
  });

  it('原生后端优先于 File System Access（同时可用时 backend=native）', async () => {
    const bridge = createFakeNativeBridge();
    const fsaDir = createFakeDirectoryHandle({ permission: 'granted' });
    const harness = await createHarness({ backupNative: bridge, autoBackup: { enabled: false } });

    const status = await withFakePicker(fsaDir, () => harness.engine.backup().status());
    expect(status.backend).toBe('native');
    const chosen = await withFakePicker(fsaDir, () => harness.engine.backup().chooseDirectory());
    expect(chosen.backend).toBe('native');
    expect(bridge.chooseCalls).toBe(1); // 走原生选择器
    expect(fsaDir.files.size).toBe(0); // FSA 目录未被写入
  });

  it('自动备份走原生驱动：配置目录后快照触发写入 manifest + 日志', async () => {
    const bridge = createFakeNativeBridge({ directoryName: 'auto-native' });
    const harness = await createHarness({
      backupNative: bridge,
      autoBackup: { debounceMs: 20, minIntervalMs: 0 },
    });
    const doc = await harness.engine.createDoc('自动原生备份');
    await doc.appendEdit({ kind: 'insert', pos: 0, text: '自动' });
    const docId = doc.docId;
    await doc.snapshot('手动');
    await waitFor(() => bridge.files.has(MANIFEST), 5000);
    await waitFor(
      () => [...bridge.files.keys()].some((name) => name.includes(docId.slice(0, 8))),
      5000,
    );
    expect(bridge.writeCalls).toBeGreaterThanOrEqual(2);
    const status = await harness.engine.backup().status();
    expect(status.backend).toBe('native');
    expect(status.lastBackupAt).toBeTruthy();
    await doc.close();
  });
});
