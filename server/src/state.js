import { log } from "./logger.js";
import {teamLogos} from './team-logos.js';
import {coalesce} from './identity.js';
import {scoreLog} from './score-log.js';
import {oddsLog} from './odds-log.js';
import { config } from "./config.js";
import { pruneHistory, readJson, stableEventSignature, stableMatchEventSignature } from "./utils.js";
import {snapshotImport,snapshotLoad,snapshotSave,snapshotHistoryGet,snapshotHistoryHas,snapshotHistoryActive,snapshotHistoryByStart} from "./sqlite-storage.js";

// Historical fixture identity/score data is kept in SnapshotState, while odds
// have their own append-only journal under /data/odds. Keeping complete market
// trees on every historical fixture duplicates the heaviest payload in RAM and
// made long-lived installations grow until V8/cgroup OOM. Strip only the
// duplicated odds tree; all fields needed by matching/results remain intact.
export function compactHistoryEvent(event) {
  if (!event || typeof event !== "object") return event;
  if (Object.prototype.hasOwnProperty.call(event, "odds")) delete event.odds;
  return event;
}

const activityOf = (event) => Math.max(Number(event?.firstSeenAt || 0), Number(event?.lastSeenAt || 0), Number(event?.removedAt || 0));
const byFirstSeen = (a, b) => Number(a.firstSeenAt || 0) - Number(b.firstSeenAt || 0) || String(a.id).localeCompare(String(b.id));

// History model: SQLite (snapshot_history) is the source of truth for every fixture ever seen. RAM holds only the
// "hot" window - rows with recent activity, plus anything not yet saved - so memory no longer grows with the
// length of the retained history. Queries that reach back past `coldBefore` read SQLite and overlay the hot rows.
export class SnapshotState {
  constructor(name, staleAfterMs) {
    this.name = name;
    this.staleAfterMs = staleAfterMs;
    this.revision = 0;
    this.generatedAt = 0;
    this.lastSuccessfulUpdateAt = 0;
    this.lastProgressAt = 0;
    this.lastAttemptAt = 0;
    this.updating = false;
    this.partial = false;
    this.lastError = "";
    this.lastHttpStatus = 0;
    this.lastElapsedMs = 0;
    this.events = [];
    this.history = [];
    // Keep an indexed view of history so a 5s LIVE poll does not rebuild and
    // compact thousands of year-long history rows on every collector tick.
    this.historyIndex = new Map();
    this.lastHistoryPruneAt = 0;
    this.latestHistoryEvent = null;
    this.seen = {};
    this.signature = "";
    this.matchSignature = "";
    this.matchRevision = 0;
    this.lastPersistAt = 0;
    this.listeners = new Set();
    this.dirtyHistoryIds = new Set();
    this.historyPruneBefore = 0;
    // Rows with activity older than `coldBefore` may exist only in SQLite. 0 = everything is resident.
    this.coldBefore = 0;
    this.historyTotal = 0;
    this.hotDays = config.historyHotDays;
  }

  hotCutoff(now = Date.now()) {
    return this.hotDays > 0 ? now - this.hotDays * 86400000 : 0;
  }

  onChange(fn){if(typeof fn==='function')this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  emitChange(change){for(const fn of this.listeners)try{fn(change);}catch(error){log.error('[state-listener]',error.message);}}

  async load() {
    const hotSince = this.hotCutoff();
    let saved = snapshotLoad(this.name, { hotSince });
    if (!saved) {
      const legacy = await readJson(`${this.name}.json`, null);
      if (legacy) { snapshotImport(this.name, legacy); saved = snapshotLoad(this.name, { hotSince }); }
    }
    if (!saved) return;
    Object.assign(this, saved);
    this.updating = false;
    this.events = Array.isArray(saved.events) ? saved.events : [];
    // Strip duplicate odds before coalescing. Doing it afterwards temporarily
    // kept both the deserialized old history and a copied coalesced history with
    // full market trees alive at once, which is exactly the worst case on a
    // 768 MiB container during startup.
    const loadedHistory = Array.isArray(saved.history) ? saved.history : [];
    for (const event of loadedHistory) compactHistoryEvent(event);
    this.history = coalesce(loadedHistory);
    this.historyIndex = new Map(this.history.map(event => [String(event?.id || ""), event]).filter(([id]) => id));
    this.lastHistoryPruneAt = Date.now();
    this.latestHistoryEvent = this.computeLatestNewEvent();
    this.seen = saved.seen && typeof saved.seen === "object" ? saved.seen : {};
    // Cold fixtures resolve their first-seen time from their SQLite row, so their `seen` entries are redundant.
    this.coldBefore = hotSince;
    this.historyTotal = Number(saved.historyTotal) || this.history.length;
    if (hotSince) for (const id of Object.keys(this.seen)) if (!this.historyIndex.has(id)) delete this.seen[id];
    this.signature = stableEventSignature(this.events);
    this.matchSignature = stableMatchEventSignature(this.events);
    this.matchRevision = Number(saved.matchRevision || 0);
    this.lastPersistAt = Date.now();
  }

  async save() {
    const result = snapshotSave(this.name, {
      revision: this.revision,
      matchRevision: this.matchRevision,
      generatedAt: this.generatedAt,
      lastSuccessfulUpdateAt: this.lastSuccessfulUpdateAt,
      lastProgressAt: this.lastProgressAt,
      lastAttemptAt: this.lastAttemptAt,
      partial: this.partial,
      lastError: this.lastError,
      lastHttpStatus: this.lastHttpStatus,
      lastElapsedMs: this.lastElapsedMs,
      events: this.events,
      history: this.history,
      seen: this.seen
    }, {dirtyIds:this.dirtyHistoryIds,pruneBefore:this.historyPruneBefore});
    if (result?.pruned) this.historyTotal = Math.max(0, this.historyTotal - result.pruned);
    this.dirtyHistoryIds.clear();
    this.historyPruneBefore = 0;
    this.lastPersistAt = Date.now();
  }

  async persist(force = false) {
    if (!force && Date.now() - Number(this.lastPersistAt || 0) < 60000) return;
    await this.save();
  }


  begin() {
    this.updating = true;
    this.lastAttemptAt = Date.now();
  }

  progress(meta = {}) {
    const now = Date.now();
    this.lastProgressAt = now;
    this.lastAttemptAt = now;
    if (meta.status != null) this.lastHttpStatus = Number(meta.status || 0);
    if (meta.elapsedMs != null) this.lastElapsedMs = Number(meta.elapsedMs || 0);
  }

  async partialFailure(error) {
    this.updating = false;
    this.partial = true;
    this.lastAttemptAt = Date.now();
    this.lastError = error?.message || String(error);
    this.lastHttpStatus = Number(error?.status || this.lastHttpStatus || 0);
    this.lastElapsedMs = Number(error?.elapsedMs || this.lastElapsedMs || 0);
    await this.persist(false);
    this.emitChange({type:'status',name:this.name,error:this.lastError,at:this.lastAttemptAt});
  }

  async unchanged(meta = {}) {
    const now = Date.now();
    this.lastAttemptAt = now;
    this.lastSuccessfulUpdateAt = now;
    this.lastProgressAt = now;
    this.generatedAt = now;
    this.updating = false;
    this.partial = false;
    this.lastError = "";
    this.lastHttpStatus = Number(meta.status || 200);
    this.lastElapsedMs = Number(meta.elapsedMs || 0);
    await this.persist(false);
    this.emitChange({type:'status',name:this.name,at:now});
  }

  async success(events, meta = {}) {
    const now = Date.now();
    this.lastAttemptAt = now;
    this.lastSuccessfulUpdateAt = now;
    this.lastProgressAt = now;
    this.generatedAt = now;
    this.updating = false;
    this.partial = false;
    this.lastError = "";
    this.lastHttpStatus = Number(meta.status || 200);
    this.lastElapsedMs = Number(meta.elapsedMs || 0);

    const previousCurrent = new Map(this.events.map((event) => [String(event?.id || ""), event]));
    // historyIndex contains the same compact objects as this.history. Reusing it
    // removes a large O(history) allocation/copy from every LIVE update.
    if (!(this.historyIndex instanceof Map)) this.historyIndex = new Map();
    if (!this.historyIndex.size && this.history.length) {
      for (const event of this.history) { const id=String(event?.id||""); if(id) this.historyIndex.set(id,compactHistoryEvent(event)); }
    }
    const historyMap = this.historyIndex;
    let created = 0;
    const incoming = [];
    const incomingIds = new Set();

    for (const raw of Array.isArray(events) ? events : []) {
      const id = String(raw?.id || "");
      if (!id) continue;
      incomingIds.add(id);
      const previousSeen = this.seen[id];
      const old = this.historyRow(id);
      if (!old) created++;
      const firstSeenAt = Number(previousSeen?.firstSeenAt || old?.firstSeenAt || 0) || now;
      const lifecycle=[...(old?.lifecycle||[])];
      if(!lifecycle.length&&old?.firstSeenAt){lifecycle.push({type:'entered',at:old.firstSeenAt});if(old.removedAt)lifecycle.push({type:'removed',at:old.removedAt});}
      if(!previousCurrent.has(id))lifecycle.push({type:'entered',at:now});
      const event = { ...teamLogos.decorate(raw), firstSeenAt, enteredLiveAt:firstSeenAt, lifecycle, lastSeenAt: now, removedAt: 0 };
      this.seen[id] = { firstSeenAt, lastSeenAt: now };
      historyMap.set(id, compactHistoryEvent({ ...(old || {}), ...event }));
      this.dirtyHistoryIds.add(id);
      incoming.push(event);
    }

    for (const [id, previous] of previousCurrent) {
      if (!id || incomingIds.has(id)) continue;
      const old = this.historyRow(id) || previous;
      historyMap.set(id, compactHistoryEvent({
        ...old,
        lifecycle:[...(old.lifecycle||[{type:'entered',at:old.firstSeenAt}]),{type:'removed',at:now}],
        lastSeenAt: Number(old?.lastSeenAt || previous?.lastSeenAt || now),
        // removedAt is the most recent disappearance from this live snapshot.
        // A match may re-enter LIVE and disappear again; results must show the
        // last removal rather than the first one ever observed.
        removedAt: now
      }));
      this.dirtyHistoryIds.add(id);
    }

    // TTL pruning only needs to run periodically; the old implementation
    // filtered the complete year-long history on every 5s/15s collector poll.
    if (!this.lastHistoryPruneAt || now - this.lastHistoryPruneAt >= 300000) {
      const pruned = pruneHistory([...historyMap.values()], now);
      historyMap.clear();
      for (const event of pruned) { const id=String(event?.id||""); if(id) historyMap.set(id,event); }
      // The cached newest-history row may have just expired. Clear it before
      // assigning the pruned array; the incoming loop below will repopulate it
      // when a current fixture exists, otherwise latestNewEvent() recomputes it.
      this.latestHistoryEvent = null;
      this.lastHistoryPruneAt = now;
      const cutoff = now - config.historyTtlMs;
      this.historyPruneBefore = cutoff;
      for (const [id, item] of Object.entries(this.seen)) {
        if (Number(item?.lastSeenAt || 0) < cutoff) delete this.seen[id];
      }
      this.evictCold(now, incomingIds);
    }
    this.historyTotal += created;
    this.history = [...historyMap.values()];
    // firstSeenAt never moves backwards for an existing fixture, so the newest
    // history item can be maintained incrementally instead of rescanning history
    // for every /health or feed metadata request.
    for (const event of incoming) {
      if (!this.latestHistoryEvent || Number(event.firstSeenAt||0) > Number(this.latestHistoryEvent.firstSeenAt||0))
        this.latestHistoryEvent = this.toLatestNewEvent(event);
    }

    const nextSignature = stableEventSignature(incoming);
    const changed = nextSignature !== this.signature;
    if (changed) {
      this.revision += 1;
      this.signature = nextSignature;
    }
    const nextMatchSignature = stableMatchEventSignature(incoming);
    const structuralChanged = nextMatchSignature !== this.matchSignature;
    if (structuralChanged) {
      this.matchRevision += 1;
      this.matchSignature = nextMatchSignature;
    }
    const patches=[];
    if(changed&&!structuralChanged){
      const volatileFields=['scoreText','seriesScore','mapScores','activeMap','updatedAt','broadcast','team1Logo','team2Logo','tournamentStage','odds'];
      for(const event of incoming){
        const previous=previousCurrent.get(String(event.id||''));if(!previous)continue;
        const patch={source:event.source||this.name,id:String(event.sourceEventId||event.id),fields:[]};
        for(const field of volatileFields){
          const before=field==='activeMap'||field==='updatedAt'?Number(previous[field]||0):previous[field]??(field.endsWith('Logo')||field==='scoreText'||field==='tournamentStage'?'':field==='mapScores'?[]:null);
          const after=field==='activeMap'||field==='updatedAt'?Number(event[field]||0):event[field]??(field.endsWith('Logo')||field==='scoreText'||field==='tournamentStage'?'':field==='mapScores'?[]:null);
          if(JSON.stringify(before)===JSON.stringify(after))continue;patch.fields.push(field);patch[field]=after;
        }
        if(patch.fields.length)patches.push(patch);
      }
    }
    this.events = incoming;
    // Feed listeners are latency-sensitive. Publish the already-normalized in-
    // memory change before durable odds/score journals are flushed. Persistence
    // still completes in-order below, but an open extension receives score and
    // market changes without waiting for disk I/O.
    if(changed||structuralChanged)this.emitChange({type:'snapshot',name:this.name,revision:this.revision,matchRevision:this.matchRevision,structuralChanged,patches,at:now});
    else this.emitChange({type:'status',name:this.name,at:now});
    try{await Promise.all(incoming.filter(e=>e.odds?.markets?.length).map(e=>oddsLog.record(e)));}catch(error){log.error('[odds-log]',error.message);}
    if(!this.name.includes('prematch'))try{
      await scoreLog.record(incoming.filter(e=>!previousCurrent.has(e.id)),{phase:'live',at:now,event:'entered'});
      await scoreLog.record(incoming,{phase:'live',at:now});
      await scoreLog.record([...previousCurrent.values()].filter(e=>!incomingIds.has(e.id)),{phase:'live',at:now,event:'removed'});
    }catch(error){log.error('[score-log]',error.message);}
    await this.persist(false);
  }

  async failure(error) {
    this.updating = false;
    this.partial = false;
    this.lastAttemptAt = Date.now();
    this.lastError = error?.message || String(error);
    this.lastHttpStatus = Number(error?.status || 0);
    this.lastElapsedMs = Number(error?.elapsedMs || 0);
    await this.persist(false);
    this.emitChange({type:'failure',name:this.name,error:this.lastError,at:this.lastAttemptAt});
  }

  publicSnapshot() {
    const now = Date.now();
    const latest = this.latestNewEvent();
    return {
      revision: this.revision,
      matchRevision: this.matchRevision,
      generatedAt: this.generatedAt ? new Date(this.generatedAt).toISOString() : null,
      stale: !Math.max(this.lastSuccessfulUpdateAt || 0, this.updating ? this.lastProgressAt || 0 : 0) || now - Math.max(this.lastSuccessfulUpdateAt || 0, this.updating ? this.lastProgressAt || 0 : 0) > this.staleAfterMs,
      updating: this.updating,
      partial: this.partial,
      lastProgressAt: this.lastProgressAt ? new Date(this.lastProgressAt).toISOString() : null,
      lastSuccessfulUpdateAt: this.lastSuccessfulUpdateAt ? new Date(this.lastSuccessfulUpdateAt).toISOString() : null,
      lastAttemptAt: this.lastAttemptAt ? new Date(this.lastAttemptAt).toISOString() : null,
      lastNewEventAt: latest?.firstSeenAt ? new Date(latest.firstSeenAt).toISOString() : null,
      lastNewEvent: latest,
      count: this.events.length,
      events: this.events
    };
  }

  // A new event is an event first observed by this collector, not a changed
  // score or a repeated poll. Keeping this in the state makes it possible to
  // tell "the feed is fresh" apart from "a new match has appeared recently".
  toLatestNewEvent(event) {
    if (!event || !Number(event.firstSeenAt || 0)) return null;
    return {
      id: String(event.id || ""),
      source: event.source || this.name,
      category: event.category || "",
      league: event.league || "",
      team1: event.team1 || "",
      team2: event.team2 || "",
      startAt: Number(event.startAt || 0),
      firstSeenAt: Number(event.firstSeenAt || 0)
    };
  }

  // One History row by id: resident, or read once from SQLite (and kept hot because it is about to be updated).
  historyRow(id) {
    const hot = this.historyIndex.get(id);
    if (hot || !this.coldBefore) return hot;
    const stored = snapshotHistoryGet(this.name, id);
    if (!stored) return undefined;
    compactHistoryEvent(stored);
    this.historyIndex.set(id, stored);
    return stored;
  }

  hasHistoryId(id) {
    return this.historyIndex.has(id) || (this.coldBefore > 0 && snapshotHistoryHas(this.name, id));
  }

  // Drops rows that are old, saved and not currently listed. They remain in SQLite.
  evictCold(now, keepIds = new Set()) {
    const cutoff = this.hotCutoff(now);
    if (!cutoff) return 0;
    let evicted = 0;
    for (const [id, row] of this.historyIndex) {
      if (keepIds.has(id) || this.dirtyHistoryIds.has(id) || activityOf(row) >= cutoff) continue;
      this.historyIndex.delete(id);
      delete this.seen[id];
      evicted++;
    }
    this.coldBefore = Math.max(this.coldBefore, cutoff);
    return evicted;
  }

  // Stored rows (already filtered by SQL) + resident rows: a resident row is newer than its stored copy and decides
  // whether the id matches; resident rows that are not stored yet are added.
  mergeHistory(stored, matches) {
    const rows = new Map(stored.map((row) => [String(row.id), row]));
    for (const [id, row] of this.historyIndex) {
      if (matches(row)) rows.set(id, row); else rows.delete(id);
    }
    return [...rows.values()];
  }

  computeLatestNewEvent() {
    let newest = null;
    for (const event of this.history) {
      if (!Number(event?.firstSeenAt || 0)) continue;
      if (!newest || Number(event.firstSeenAt) > Number(newest.firstSeenAt)) newest = event;
    }
    return this.toLatestNewEvent(newest);
  }

  latestNewEvent() {
    if (!this.latestHistoryEvent) this.latestHistoryEvent = this.computeLatestNewEvent();
    return this.latestHistoryEvent;
  }

  publicHistory(since = 0) {
    const cursor = Number(since || 0), matches = (event) => activityOf(event) >= cursor;
    const stored = cursor < this.coldBefore ? snapshotHistoryActive(this.name, cursor) : [];
    return this.mergeHistory(stored, matches).sort(byFirstSeen);
  }

  // The newest `limit` rows (by first-seen time, returned oldest to newest) with activity at or after `since`.
  recentHistory(since = 0, limit = 2000) {
    const cursor = Number(since || 0), take = Math.max(1, Math.min(Number(limit) || 2000, this.historyTotal || this.historyIndex.size || 1));
    const matches = (event) => activityOf(event) >= cursor;
    const stored = cursor < this.coldBefore ? snapshotHistoryActive(this.name, cursor, take + 1) : [];
    const newestFirst = this.mergeHistory(stored, matches).sort((a, b) => byFirstSeen(b, a));
    const exhausted = newestFirst.length <= take;
    const rows = newestFirst.slice(0, take).reverse();
    return { events: rows, total: this.historyTotal, exhausted };
  }

  // Removed fixtures that were scheduled to start in [from, to) (Results archive).
  historyByStart(from, to) {
    const matches = (event) => Number(event.startAt) >= from && Number(event.startAt) < to && Number(event.removedAt) > 0;
    const stored = this.coldBefore > 0 ? snapshotHistoryByStart(this.name, from, to) : [];
    return this.mergeHistory(stored, matches).sort(byFirstSeen);
  }

  status() {
    const now = Date.now();
    const latest = this.latestNewEvent();
    return {
      revision: this.revision,
      matchRevision: this.matchRevision,
      count: this.events.length,
      historyCount: this.historyTotal || this.history.length,
      historyResident: this.historyIndex.size || this.history.length,
      stale: !Math.max(this.lastSuccessfulUpdateAt || 0, this.updating ? this.lastProgressAt || 0 : 0) || now - Math.max(this.lastSuccessfulUpdateAt || 0, this.updating ? this.lastProgressAt || 0 : 0) > this.staleAfterMs,
      updating: this.updating,
      partial: this.partial,
      lastProgressAt: this.lastProgressAt ? new Date(this.lastProgressAt).toISOString() : null,
      lastAttemptAt: this.lastAttemptAt ? new Date(this.lastAttemptAt).toISOString() : null,
      lastSuccessfulUpdateAt: this.lastSuccessfulUpdateAt ? new Date(this.lastSuccessfulUpdateAt).toISOString() : null,
      lastNewEventAt: latest?.firstSeenAt ? new Date(latest.firstSeenAt).toISOString() : null,
      lastNewEvent: latest,
      lastError: this.lastError,
      lastHttpStatus: this.lastHttpStatus,
      lastElapsedMs: this.lastElapsedMs
    };
  }
}
