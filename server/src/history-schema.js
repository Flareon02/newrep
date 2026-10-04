// Additive migration; legacy compressed odds and score JSON remain readable.
export function historySchema(db) {
  for (const table of ['odds_entries_v3','score_entries']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='publication_source'))
      db.exec(`ALTER TABLE ${table} ADD COLUMN publication_source TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_time ON ${table}(at,seq)`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS odds_entries_v3_context ON odds_entries_v3(source,event_id,publication_source,at DESC,seq DESC);
    CREATE INDEX IF NOT EXISTS score_entries_context ON score_entries(identity,publication_source,at DESC,seq DESC);
    CREATE TABLE IF NOT EXISTS odds_history_market_refs(
      entry_seq INTEGER NOT NULL REFERENCES odds_entries_v3(seq) ON DELETE CASCADE,
      market_id TEXT NOT NULL,
      type_id TEXT,
      source TEXT,
      event_id TEXT,
      at INTEGER,
      PRIMARY KEY(entry_seq,market_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS odds_history_market_lookup ON odds_history_market_refs(market_id,entry_seq);
  `);
  for(const [name,type] of [['source','TEXT'],['event_id','TEXT'],['at','INTEGER']])if(!db.prepare('PRAGMA table_info(odds_history_market_refs)').all().some(c=>c.name===name))db.exec(`ALTER TABLE odds_history_market_refs ADD COLUMN ${name} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS odds_history_market_event_time ON odds_history_market_refs(source,event_id,market_id,at DESC,entry_seq DESC)');
}
