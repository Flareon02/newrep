import v8 from "node:v8";
import { log } from "./logger.js";

// Measured with tools/bench-history-load.mjs: a persisted History row costs about
// 1.1 KB of V8 heap once loaded. All History lives in memory (seven snapshots), so on a
// 320 MiB heap roughly 250k rows in total is the crash point at startup.
export const HISTORY_ROW_BYTES = 1100;

export function historyCapacity(rows, heapLimitBytes = v8.getHeapStatistics().heap_size_limit) {
  const estimatedMiB = Math.round((rows * HISTORY_ROW_BYTES) / 1048576);
  const heapLimitMiB = Math.round(heapLimitBytes / 1048576);
  const share = heapLimitMiB ? estimatedMiB / heapLimitMiB : 0;
  const level = share >= 0.75 ? "critical" : share >= 0.5 ? "high" : "ok";
  return { rows, estimatedMiB, heapLimitMiB, level };
}

let lastWarnAt = 0;
export function warnHistoryCapacity(capacity, now = Date.now()) {
  if (capacity.level === "ok" || now - lastWarnAt < 3_600_000) return;
  lastWarnAt = now;
  log.warn(`[capacity] History holds ${capacity.rows} rows (~${capacity.estimatedMiB} MiB of a ${capacity.heapLimitMiB} MiB heap, ${capacity.level}). ` +
    "Lower HISTORY_MAX or HISTORY_TTL_MS before it no longer fits at startup (older rows beyond the limit are pruned on the next save).");
}
