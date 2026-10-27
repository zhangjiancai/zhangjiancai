/**
 * 假原生备份目录桥（模拟 Android SAF / Capacitor bridge），用于 Node 单测。
 * 内存目录：可预置已持久化目录与文件，记录 choose/forget/write 调用。
 */

import type { NativeBackupDirectoryBridge } from '../../src/engine/types';

export interface FakeNativeBridgeOptions {
  available?: boolean;
  /** 预置的"已持久化目录"（name 为 null 表示未选择/权限失效）。 */
  directoryName?: string | null;
  /** 预置目录内的文件（manifest/.wtlog 等）。 */
  files?: Record<string, string>;
  /** chooseDirectory 返回的目录名（默认 'native-backup'）。 */
  chooseName?: string;
  /** chooseDirectory 模拟用户取消（返回 null）。 */
  chooseCancel?: boolean;
  /** chooseDirectory 抛错（模拟系统选择器失败）。 */
  chooseError?: boolean;
  /** readFiles 抛错（模拟目录不可读/权限失效）。 */
  failReadFiles?: boolean;
}

export interface FakeNativeBridge extends NativeBackupDirectoryBridge {
  files: Map<string, string>;
  /** 当前已持久化目录名；null = 未选择/权限失效。 */
  directoryName: string | null;
  chooseCalls: number;
  forgetCalls: number;
  writeCalls: number;
  setDirectory(name: string | null): void;
}

export function createFakeNativeBridge(options: FakeNativeBridgeOptions = {}): FakeNativeBridge {
  const available = options.available !== false;
  const files = new Map(Object.entries(options.files ?? {}));
  const state = {
    directoryName: options.directoryName ?? null,
    chooseCalls: 0,
    forgetCalls: 0,
    writeCalls: 0,
  };

  const bridge = {
    get available(): boolean {
      return available;
    },
    files,
    get directoryName(): string | null {
      return state.directoryName;
    },
    get chooseCalls(): number {
      return state.chooseCalls;
    },
    get forgetCalls(): number {
      return state.forgetCalls;
    },
    get writeCalls(): number {
      return state.writeCalls;
    },
    setDirectory(name: string | null): void {
      state.directoryName = name;
    },
    async chooseDirectory(): Promise<{ name: string } | null> {
      state.chooseCalls += 1;
      if (options.chooseCancel) return null;
      if (options.chooseError) throw new Error('原生目录选择器失败');
      if (!available) return null;
      state.directoryName = options.chooseName ?? 'native-backup';
      return { name: state.directoryName };
    },
    async getDirectory(): Promise<{ name: string } | null> {
      if (!available || state.directoryName === null) return null;
      return { name: state.directoryName };
    },
    async writeFile(name: string, text: string): Promise<void> {
      if (state.directoryName === null) throw new Error('未配置原生备份目录');
      state.writeCalls += 1;
      files.set(name, text);
    },
    async readFile(name: string): Promise<string | null> {
      return files.get(name) ?? null;
    },
    async readFiles(): Promise<Array<{ name: string; text: string }>> {
      if (options.failReadFiles) throw new Error('原生备份目录不可读');
      return [...files.entries()].map(([name, text]) => ({ name, text }));
    },
    async forgetDirectory(): Promise<void> {
      state.forgetCalls += 1;
      state.directoryName = null;
    },
  };

  return bridge as unknown as FakeNativeBridge;
}
