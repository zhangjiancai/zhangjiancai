/** 计算 prev → next 的最小单段差异（公共前后缀法），供 UI 记录器把 textarea 变化转成 TextEdit。 */

import type { DeriveEdit } from './types';

/**
 * 注：坐标按 UTF-16 码元；极端情况下（两个不同 emoji 共享高位代理）会拆到代理单元，
 * 但得到的差异仍能精确复原 next，符合格式规范 5.1。
 */
export const deriveEdit: DeriveEdit = (prev, next) => {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev -= 1;
    endNext -= 1;
  }
  const deleted = prev.slice(start, endPrev);
  const text = next.slice(start, endNext);
  const kind: 'insert' | 'delete' | 'replace' =
    deleted.length === 0 ? 'insert' : text.length === 0 ? 'delete' : 'replace';
  return { kind, pos: start, length: deleted.length, deleted, text };
};
