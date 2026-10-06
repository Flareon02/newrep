// Timeline / history query worker: read-only SQLite access and journal decompression off the main event loop.
// Started on demand by timeline-client.js and stopped after an idle period; its thread runs at the lowest CPU priority
// (nice 19) on Linux, so on one CPU the LIVE event loop always wins.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timelineMeta, timelineRange, stateAt, createCache } from './timeline-core.js';
import { eventHistoryQuery } from './match-history-query.js';

try { const tid = Number(fs.readlinkSync('/proc/thread-self').split('/').pop()); if (tid) os.setPriority(tid, 19); } catch {}
const file = workerData.file || path.join(workerData.dataDir, 'monitor-v2.sqlite3');
let db = null;
const open = () => {
  if (db) return db;
  db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout=2000;PRAGMA cache_size=-8192;PRAGMA query_only=1;');
  return db;
};
const cache = createCache({ budgetOutcomes: workerData.budgetOutcomes || 120000 });
parentPort.on('message', (m) => {
  if (m?.type === 'stop') { try { db?.close(); } catch {} parentPort.postMessage({ type: 'stopped' }); parentPort.close(); return; }
  const started = performance.now();
  try {
    const req = { ...m.req, dataDir: workerData.dataDir };
    const result = m.op === 'meta' ? timelineMeta(open(), req)
      : m.op === 'range' ? timelineRange(open(), req)
        : m.op === 'stateAt' ? stateAt(open(), req, cache)
          : m.op === 'history' ? eventHistoryQuery(req.keys, req.options, open())
            : (() => { throw Object.assign(new Error('unknown op'), { status: 400 }); })();
    parentPort.postMessage({ id: m.id, ok: true, result, ms: Math.round(performance.now() - started), cache: { events: cache.events.size, outcomes: cache.used } });
  } catch (error) {
    parentPort.postMessage({ id: m.id, ok: false, error: { message: error.message, status: error.status || 500 }, ms: Math.round(performance.now() - started) });
  }
});
parentPort.postMessage({ type: 'ready' });
