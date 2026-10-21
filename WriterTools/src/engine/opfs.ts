/**
 * OPFS（Origin Private File System）镜像：每个作品镜像为 docs/<docId>.wtlog（完整日志文本）。
 * 不支持 OPFS 的环境自动降级为 null（不报错）；测试可通过 EngineOptions.opfs 注入内存适配器。
 */

import type { OpfsAdapter } from './types';

export const MIRROR_DIR = 'docs';

/** 某作品的 OPFS 镜像路径。 */
export function mirrorPath(docId: string): string {
  return `${MIRROR_DIR}/${docId}.wtlog`;
}

const MIRROR_FILE_SUFFIX = '.wtlog';

/** 从镜像文件名解析 docId；不是镜像文件返回 null。 */
export function docIdFromMirrorFile(fileName: string): string | null {
  if (!fileName.endsWith(MIRROR_FILE_SUFFIX)) return null;
  const docId = fileName.slice(0, -MIRROR_FILE_SUFFIX.length);
  if (docId.length === 0 || docId.includes('/') || docId.includes('\\') || docId.includes('..')) return null;
  return docId;
}

interface DirectoryEntriesCapable {
  entries(): AsyncIterableIterator<[string, unknown]>;
}

function splitPath(path: string): string[] {
  const parts = path.split('/').filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`非法的 OPFS 路径：${path}`);
  }
  if (parts.length === 0) throw new Error('OPFS 路径不能为空');
  return parts;
}

class BrowserOpfsAdapter implements OpfsAdapter {
  readonly available = true;

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async resolveDirectory(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let current = this.root;
    for (const part of parts) {
      try {
        current = await current.getDirectoryHandle(part, { create });
      } catch (error) {
        if (!create) return null;
        throw error;
      }
    }
    return current;
  }

  async read(path: string): Promise<string | null> {
    try {
      const parts = splitPath(path);
      const directory = await this.resolveDirectory(parts.slice(0, -1), false);
      if (!directory) return null;
      const fileHandle = await directory.getFileHandle(parts[parts.length - 1]);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }

  async write(path: string, data: string): Promise<void> {
    const parts = splitPath(path);
    const directory = await this.resolveDirectory(parts.slice(0, -1), true);
    if (!directory) throw new Error('无法创建 OPFS 目录');
    const fileHandle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async list(dir: string): Promise<string[]> {
    try {
      const parts = dir.length > 0 ? splitPath(dir) : [];
      const directory = await this.resolveDirectory(parts, false);
      if (!directory) return [];
      const names: string[] = [];
      const iterable = directory as unknown as DirectoryEntriesCapable;
      for await (const [name] of iterable.entries()) {
        names.push(name);
      }
      return names;
    } catch {
      return [];
    }
  }

  async remove(path: string): Promise<void> {
    try {
      const parts = splitPath(path);
      const directory = await this.resolveDirectory(parts.slice(0, -1), false);
      if (!directory) return;
      await directory.removeEntry(parts[parts.length - 1]);
    } catch {
      // 不存在或不可删除：降级忽略
    }
  }
}

/** 自动探测浏览器 OPFS；不可用返回 null（绝不抛错）。 */
export async function createAutoOpfsAdapter(): Promise<OpfsAdapter | null> {
  try {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const storage = nav?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') return null;
    const root = await storage.getDirectory();
    return new BrowserOpfsAdapter(root);
  } catch {
    return null;
  }
}
