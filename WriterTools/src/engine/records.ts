/**
 * 作品摘要（IDB docs）构造辅助：从校验结果/事件流生成 DocRecord。
 * 供 library.ts（导入/恢复）与 archive.ts（备份包导入）共用。
 */

import type { DocRecord } from './idb';
import type { LogEvent, VerifyResult } from './log';

/** 事件流中的快照事件数。 */
export function countSnapshots(events: readonly LogEvent[]): number {
  let count = 0;
  for (const event of events) if (event.type === 'snapshot') count += 1;
  return count;
}

/** 由完整校验结果构造作品摘要（用于导入/副本恢复）。 */
export function recordFromVerify(docId: string, result: VerifyResult): DocRecord {
  const events = result.events;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const headerTs = events.length > 0 ? events[0].ts : new Date(0).toISOString();
  return {
    docId,
    title: result.title,
    createdAt: result.createdAt ?? headerTs,
    updatedAt: lastEvent ? lastEvent.ts : headerTs,
    chars: result.text.length,
    eventCount: events.length,
    snapshotCount: countSnapshots(events),
    trashed: result.trashed,
    lastSeq: lastEvent ? lastEvent.seq : 0,
    lastHash: lastEvent ? lastEvent.hash : '',
    integrity: result.ok ? 'ok' : 'broken',
  };
}
