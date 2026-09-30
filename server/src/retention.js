import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { sqlite } from "./sqlite-storage.js";
import { writeJson } from "./utils.js";

// Opt-in retention for the append-only tables that otherwise grow for the
// lifetime of the installation (odds journal, score journal, statistics files).
// Everything is OFF unless the matching *_RETENTION_DAYS variable is > 0, so
// upgrading never deletes user data by surprise.
//
// Rules that keep this safe on one CPU core:
//   - only whole events whose *newest* record is older than the cutoff are removed
//     (a match that is still being updated never loses its early history);
//   - deletes run in small batches with a yield between batches and a per-run
//     time budget; a run that hits the budget asks to be scheduled again soon.
const DAY = 86_400_000;
const BATCH_ROWS = 2000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function pruneOdds({ cutoff, budgetMs, startedAt = Date.now() }) {
  const { db } = sqlite();
  let events = 0, rows = 0;
  const candidates = db.prepare("SELECT source, event_id FROM odds_state WHERE updated_at < ? ORDER BY updated_at LIMIT 50").all(cutoff);
  const delBatch = db.prepare("DELETE FROM odds_entries_v3 WHERE seq IN (SELECT seq FROM odds_entries_v3 WHERE source = ? AND event_id = ? LIMIT ?)");
  const delState = db.prepare("DELETE FROM odds_state WHERE source = ? AND event_id = ? AND updated_at < ?");
  for (const { source, event_id: id } of candidates) {
    for (;;) {
      const changes = Number(delBatch.run(source, id, BATCH_ROWS).changes);
      rows += changes;
      if (changes < BATCH_ROWS) break;
      await tick();
      if (Date.now() - startedAt > budgetMs) return { events, rows, more: true };
    }
    delState.run(source, id, cutoff);
    events++;
    if (Date.now() - startedAt > budgetMs) return { events, rows, more: candidates.length > events };
    await tick();
  }
  return { events, rows, more: candidates.length === 50 };
}

export async function pruneScores({ cutoff, budgetMs, startedAt = Date.now() }) {
  const { db } = sqlite();
  let events = 0, rows = 0, after = "";
  const page = db.prepare("SELECT identity FROM score_meta WHERE identity > ? ORDER BY identity LIMIT 200");
  const newest = db.prepare("SELECT MAX(at) AS at FROM score_entries WHERE identity = ?");
  const delBatch = db.prepare("DELETE FROM score_entries WHERE seq IN (SELECT seq FROM score_entries WHERE identity = ? LIMIT ?)");
  const delMeta = db.prepare("DELETE FROM score_meta WHERE identity = ?");
  for (;;) {
    const identities = page.all(after).map((row) => row.identity);
    if (!identities.length) return { events, rows, more: false };
    for (const identity of identities) {
      after = identity;
      const last = Number(newest.get(identity)?.at) || 0;
      if (last && last >= cutoff) continue;
      for (;;) {
        const changes = Number(delBatch.run(identity, BATCH_ROWS).changes);
        rows += changes;
        if (changes < BATCH_ROWS) break;
        await tick();
      }
      delMeta.run(identity);
      events++;
    }
    await tick();
    if (Date.now() - startedAt > budgetMs) return { events, rows, more: true };
  }
}

export async function pruneStatistics(store, { cutoff }) {
  await store.ready;
  const safeId = /^(?:crossbet|hawk)-[\w-]{1,80}$/;
  const old = Object.values(store.index).filter((row) => Number(row?.at) > 0 && row.at < cutoff && safeId.test(String(row.id)) && !store.dirty.has(row.id));
  for (const row of old) {
    delete store.index[row.id];
    store.cache.delete(row.id);
    const file = path.join(config.dataDir, "statistics", `${row.id}.json`);
    for (const target of [file, `${file}.bak`]) await fs.rm(target, { force: true });
  }
  if (old.length) await writeJson("statistics/index.json", store.index);
  return { events: old.length };
}

export function retentionEnabled(settings = config) {
  return [settings.oddsRetentionDays, settings.scoreRetentionDays, settings.statisticsRetentionDays].some((days) => days > 0);
}

// Scheduler used by index.js. Runs shortly after start, then every 6 hours,
// re-running sooner while a pass reports that more work remains.
export function startRetention({ statistics, settings = config, now = Date.now } = {}) {
  if (!retentionEnabled(settings)) return { stop() {} };
  let timer = null, stopped = false, running = false;
  const schedule = (ms) => { if (stopped) return; clearTimeout(timer); timer = setTimeout(run, ms); timer.unref?.(); };
  async function run() {
    if (running || stopped) return;
    running = true;
    let more = false;
    try {
      const startedAt = Date.now(), budgetMs = 2000, summary = {};
      if (settings.oddsRetentionDays > 0) { const r = await pruneOdds({ cutoff: now() - settings.oddsRetentionDays * DAY, budgetMs, startedAt }); summary.odds = r; more ||= r.more; }
      if (settings.scoreRetentionDays > 0 && Date.now() - startedAt < budgetMs) { const r = await pruneScores({ cutoff: now() - settings.scoreRetentionDays * DAY, budgetMs, startedAt }); summary.scores = r; more ||= r.more; }
      if (settings.statisticsRetentionDays > 0 && statistics?.store) summary.statistics = await pruneStatistics(statistics.store, { cutoff: now() - settings.statisticsRetentionDays * DAY });
      const removed = Object.values(summary).reduce((n, r) => n + (r.events || 0), 0);
      if (removed) log.info(`[retention] removed ${removed} old events ${JSON.stringify(summary)}`);
      else log.debug("[retention] nothing to remove");
    } catch (error) {
      log.error(`[retention] ${error.message}`);
    } finally {
      running = false;
      schedule(more ? 30_000 : 6 * 3_600_000);
    }
  }
  schedule(60_000);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
