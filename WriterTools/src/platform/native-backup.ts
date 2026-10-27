/**
 * Capacitor 原生备份目录桥（Android Storage Access Framework）。
 *
 * 只在 Android 原生平台（Capacitor WebView + BackupFolder 插件）返回 bridge；
 * Web / 其它平台返回 null，由引擎退回 File System Access（桌面浏览器）或显示为不可用。
 *
 * 原生插件方法（android/app/src/main/java/com/writertools/app/BackupFolderPlugin.java）：
 * - chooseDirectory() -> { name: string | null }
 * - getDirectory() -> { name: string | null }
 * - writeFile({ name, data }) -> void
 * - readFile({ name }) -> { text: string | null }
 * - readFiles() -> { files: Array<{ name, text }> }
 * - forgetDirectory() -> void
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { NativeBackupDirectoryBridge } from '../engine/types';

interface NameResult {
  name?: string | null;
}

interface FileText {
  name?: string;
  text?: string;
}

/**
 * 与原生插件约定的 JS 侧接口。
 * writeFile 同时带 data/text 两个字段：原生实现当前读取 data，保留 text 以兼容后续改名。
 */
interface BackupFolderPlugin {
  chooseDirectory(): Promise<NameResult>;
  getDirectory(): Promise<NameResult>;
  writeFile(options: { name: string; data: string; text?: string }): Promise<void>;
  readFile(options: { name: string }): Promise<{ text?: string | null }>;
  readFiles(): Promise<{ files?: FileText[] }>;
  forgetDirectory(): Promise<void>;
}

const BackupFolder = registerPlugin<BackupFolderPlugin>('BackupFolder');

/** 把插件调用异常包装成可读中文错误（引擎会把 message 显示给用户）。 */
function readableNativeError(action: string, error: unknown): Error {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误';
  return new Error(`${action}：${message}`);
}

async function callPlugin<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw readableNativeError(action, error);
  }
}

function normalizeDirectory(result: unknown): { name: string } | null {
  if (!result || typeof result !== 'object') return null;
  const name = (result as NameResult).name;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? { name: trimmed } : null;
}

/** 当前是否运行在 Android 原生 App（Capacitor WebView）里。 */
export function isNativeAndroidPlatform(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

/**
 * 创建 Android 原生备份目录桥；Web / 非 Android 返回 null。
 * 所有调用失败都会抛中文可读错误，交由引擎记录 lastError 并在设置面板展示。
 */
export function createNativeBackupBridge(): NativeBackupDirectoryBridge | null {
  if (!isNativeAndroidPlatform()) return null;

  return {
    available: true,
    chooseDirectory: () =>
      callPlugin('选择手机备份文件夹失败', async () =>
        normalizeDirectory(await BackupFolder.chooseDirectory()),
      ),
    getDirectory: () =>
      callPlugin('读取手机备份文件夹失败', async () =>
        normalizeDirectory(await BackupFolder.getDirectory()),
      ),
    writeFile: (name: string, text: string) =>
      callPlugin('写入手机备份文件失败', () => BackupFolder.writeFile({ name, data: text, text })),
    readFile: (name: string) =>
      callPlugin('读取手机备份文件失败', async () => {
        const result = await BackupFolder.readFile({ name });
        const text = result?.text;
        return typeof text === 'string' ? text : null;
      }),
    readFiles: () =>
      callPlugin('读取手机备份目录失败', async () => {
        const result = await BackupFolder.readFiles();
        const files = result?.files ?? [];
        return files.filter(
          (file): file is { name: string; text: string } =>
            typeof file?.name === 'string' && typeof file?.text === 'string',
        );
      }),
    forgetDirectory: () =>
      callPlugin('清除手机备份目录设置失败', () => BackupFolder.forgetDirectory()),
  };
}
