/**
 * WriterTools 引擎入口（UI 只允许从 '../engine' 导入）。
 *
 * 契约见 ./types.ts；实现按模块拆分：
 * - canonical.ts：规范化 JSON / SHA-256
 * - log.ts：事件信封、JSON Lines 序列化、哈希链校验、文本重放、快照校验
 * - idb.ts：IndexedDB 主存储（docs / events / kv）
 * - opfs.ts：OPFS 镜像（docs/<docId>.wtlog）
 * - backup.ts：File System Access 备份目录 + manifest
 * - handle.ts：DocHandle（编辑/输入法/选区/快照/恢复/校验/导入导出）
 * - library.ts：LibraryEngine（书架/并发锁/恢复/flush）
 * - derive.ts：deriveEdit
 */

export { createEngine } from './library';
export { deriveEdit } from './derive';
export * from './types';
