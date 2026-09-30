import v8 from "node:v8";
import { log } from "./logger.js";

// Measured with tools/bench-history-load.mjs: a History row costs about 1.1-1.4 KB of V8 heap while resident.
// Only the hot window (HISTORY_HOT_DAYS) is resident; older rows stay in SQLite. With HISTORY_HOT_DAYS=0 the whole
// History is resident and roughly 250k rows in total exhaust a 320 MiB heap.
export const HISTORY_ROW_BYTES = 1100;

// `rows` = rows resident in memory; `persisted` = rows stored in SQLite (informational).
export function historyCapacity(rows, heapLimitBytes = v8.getHeapStatistics().heap_size_limit, persisted = rows) {
  const estimatedMiB = Math.round((rows * HISTORY_ROW_BYTES) / 1048576);
  const heapLimitMiB = Math.round(heapLimitBytes / 1048576);
  const share = heapLimitMiB ? estimatedMiB / heapLimitMiB : 0;
  const level = share >= 0.75 ? "critical" : share >= 0.5 ? "high" : "ok";
  return { rows, persistedRows: persisted, estimatedMiB, heapLimitMiB, level };
}

let lastWarnAt = 0;
export function warnHistoryCapacity(capacity, now = Date.now()) {
  if (capacity.level === "ok" || now - lastWarnAt < 3_600_000) return;
  lastWarnAt = now;
  log.warn(`[capacity] ${capacity.rows} History rows are resident (~${capacity.estimatedMiB} MiB of a ${capacity.heapLimitMiB} MiB heap, ${capacity.level}). ` +
    "Lower HISTORY_HOT_DAYS so that fewer recent rows are kept in memory.");
}
