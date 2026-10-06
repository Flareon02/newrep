// Main-thread side of the timeline worker: started on the first request, stopped after `idleMs` without requests,
// bounded queue (a burst of scrubber requests cannot pile up), per-request timeout, restart after a crash.
// The worker has its own heap limit; the main thread only passes small request/response objects.
import { Worker } from 'node:worker_threads';

export class TimelineClient {
  constructor({ dataDir, file = '', idleMs = 90000, timeoutMs = 15000, maxPending = 6, heapMb = 96, budgetOutcomes = 120000 } = {}) {
    Object.assign(this, { dataDir, file, idleMs, timeoutMs, maxPending, heapMb, budgetOutcomes });
    this.worker = null; this.pending = new Map(); this.seq = 0; this.idleTimer = null;
    this.stats = { started: 0, requests: 0, rejectedBusy: 0, timeouts: 0, crashes: 0, lastMs: 0, maxMs: 0, cache: null };
  }
  start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./timeline-worker.js', import.meta.url), { workerData: { dataDir: this.dataDir, file: this.file, budgetOutcomes: this.budgetOutcomes }, resourceLimits: { maxOldGenerationSizeMb: this.heapMb, maxYoungGenerationSizeMb: 16 } });
    worker.unref();
    worker.on('message', (m) => {
      if (m?.type) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      this.stats.lastMs = m.ms; this.stats.maxMs = Math.max(this.stats.maxMs, m.ms || 0); if (m.cache) this.stats.cache = m.cache;
      if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error(m.error?.message || 'timeline error'), { status: m.error?.status || 500 }));
      this.armIdle();
    });
    const fail = (error) => {
      if (this.worker !== worker) return;
      this.worker = null; this.stats.crashes++;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Обработчик истории перезапускается, повторите запрос'), { status: 503, retryAfterMs: 1000, cause: error })); this.pending.delete(id); }
    };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (this.worker === worker) { if (code) fail(new Error('exit ' + code)); else this.worker = null; } });
    this.worker = worker; this.stats.started++;
    return worker;
  }
  armIdle() {
    clearTimeout(this.idleTimer);
    if (this.pending.size) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }
  request(op, req) {
    if (this.pending.size >= this.maxPending) { this.stats.rejectedBusy++; return Promise.reject(Object.assign(new Error('История занята, повторите через секунду'), { status: 503, retryAfterMs: 1000 })); }
    const worker = this.start(), id = ++this.seq;
    this.stats.requests++;
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.timeouts++;
        this.pending.delete(id);
        reject(Object.assign(new Error('История отвечает слишком долго'), { status: 503, retryAfterMs: 2000 }));
        // A stuck query must not hold the worker: restart it (the next request starts a fresh one).
        if (this.worker === worker) { this.worker = null; worker.terminate().catch(() => {}); for (const [pid, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('История перезапускается'), { status: 503, retryAfterMs: 1000 })); this.pending.delete(pid); } }
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, op, req });
    });
  }
  async stop() {
    clearTimeout(this.idleTimer);
    const w = this.worker; this.worker = null;
    if (w) await w.terminate().catch(() => {});
  }
  status() { return { running: !!this.worker, pending: this.pending.size, ...this.stats }; }
}
