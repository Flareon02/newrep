#!/usr/bin/env node
// Market coverage of the canonical registry on a journal: every market change in odds_entries_v3 is described with
// the same code the server uses (market-registry.js), per bookmaker: known/unknown by signature and by volume,
// families, and every unknown signature with real examples. Read-only; run it on a COPY of the database.
//
//   node tools/market-coverage.mjs <monitor-v2.sqlite3 copy> [--json out.json] [--md out.md]
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import { describeMarket, splitLegacyMarket, MARKET_SEMANTICS_VERSION } from '../server/src/market-registry.js';

const file = process.argv[2];
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : ''; };
if (!file) { console.error('usage: market-coverage.mjs <db copy> [--json out] [--md out]'); process.exit(2); }
const db = new DatabaseSync(file, { readOnly: true });
const per = {}, families = {}, unknown = new Map();
let rows = 0, legacy = 0;
const shape = (c) => ({ marketId: c.marketId ?? c.key, typeId: c.typeId ?? c.rawType ?? c.type, rawType: c.rawType ?? c.typeId, rawGroup: c.rawGroup ?? c.typeId, type: c.typeId ?? c.type, marketName: c.marketName ?? c.rawTitle ?? c.title, rawTitle: c.rawTitle ?? c.marketName, period: c.period, specifiers: c.specifiers || {}, outcomes: (c.outcomes?.length ? c.outcomes : c.prices || []).map((o, i) => ({ outcomeId: String(o.outcomeId ?? o.rawType ?? o.designation ?? i), outcomeName: o.outcomeName ?? o.label ?? o.designation, line: o.line ?? o.points ?? null, designation: o.designation })) });
for (const r of db.prepare('SELECT source, payload, publication_source FROM odds_entries_v3').iterate()) {
  rows++;
  let e; try { e = JSON.parse(inflateRawSync(r.payload).toString()); } catch { continue; }
  if (!r.publication_source) legacy++;
  const ctx = { sport: e.sport || '', team1: e.team1, team2: e.team2, bestOf: e.bestOf, units: e.units };
  for (const c of e.changes || []) {
    const m = shape(c);
    const parts = r.source === 'fonbet' ? splitLegacyMarket('fonbet', m) : [m];
    for (const part of parts) {
      const d = describeMarket(r.source, part, ctx, { record: false });
      const p = (per[r.source] ||= { changes: 0, known: 0, unknown: 0, signatures: new Set(), knownSignatures: new Set(), current: { changes: 0, known: 0 }, legacy: { changes: 0, known: 0 } });
      const era = r.publication_source ? p.current : p.legacy; era.changes++; if (!d.unknown) era.known++;
      const sig = `${r.source}|${part.typeId}|${Object.keys(part.specifiers || {}).sort().join(',')}|${[...new Set(part.outcomes.map((o) => o.outcomeId))].sort().join(',')}|${(Number(part.period) || 0) > 0 ? 'map' : 'match'}`;
      p.changes++; p.signatures.add(sig);
      if (d.unknown) {
        p.unknown++;
        const k = `${r.source}|${part.typeId}|${Object.keys(part.specifiers || {}).sort().join(',')}`;
        const u = unknown.get(k) || { provider: r.source, rawType: String(part.typeId), specKeys: Object.keys(part.specifiers || {}).sort(), changes: 0, sports: new Set(), titles: new Map(), examples: [] };
        u.changes++; if (e.sport) u.sports.add(e.sport);
        const title = String(part.marketName || '');
        u.titles.set(title, (u.titles.get(title) || 0) + 1);
        if (u.examples.length < 3 && !u.examples.some((x) => x.title === title)) u.examples.push({ title, period: part.period ?? null, specifiers: part.specifiers, outcomes: part.outcomes.slice(0, 6).map((o) => ({ id: o.outcomeId, name: o.outcomeName, line: o.line })), teams: [e.team1, e.team2], sport: e.sport || '' });
        unknown.set(k, u);
      } else {
        p.known++; p.knownSignatures.add(sig);
        const f = (families[r.source] ||= {}); f[d.family] = (f[d.family] || 0) + 1;
      }
    }
  }
}
const providers = Object.fromEntries(Object.entries(per).map(([k, p]) => [k, { marketChanges: p.changes, known: p.known, unknown: p.unknown, coverageByVolume: +(100 * p.known / Math.max(1, p.changes)).toFixed(2), currentRows: { changes: p.current.changes, coverage: +(100 * p.current.known / Math.max(1, p.current.changes)).toFixed(2) }, legacyRows: { changes: p.legacy.changes, coverage: +(100 * p.legacy.known / Math.max(1, p.legacy.changes)).toFixed(2) }, signatures: p.signatures.size, knownSignatures: p.knownSignatures.size, coverageBySignature: +(100 * p.knownSignatures.size / Math.max(1, p.signatures.size)).toFixed(1), families: Object.entries(families[k] || {}).sort((a, b) => b[1] - a[1]) }]));
const unknownList = [...unknown.values()].sort((a, b) => a.provider.localeCompare(b.provider) || b.changes - a.changes).map((u) => ({ ...u, sports: [...u.sports], titles: [...u.titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t) }));
const report = { semanticsVersion: MARKET_SEMANTICS_VERSION, generatedAt: new Date().toISOString(), journalRows: rows, legacyRows: legacy, providers, unknown: unknownList };
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(report, null, 1));
if (arg('md')) {
  const NAME = { astek: 'AstekBet', fonbet: 'Fonbet', pinnacle: 'Pinnacle', ggbet: 'GGBET' };
  let md = `# Market coverage (semantics v${MARKET_SEMANTICS_VERSION})\n\nGenerated ${report.generatedAt} by \`tools/market-coverage.mjs\` from a read-only copy of the production journal (${rows} journal rows, ${legacy} of them written before 4.15).\nEvery market change was described with the server's own registry. **Unknown = not classified on purpose**: the structured ids do not prove what the bet is.\n\n| Bookmaker | market changes | coverage by volume — all rows | — rows written by 4.15+ | — legacy rows (≤4.14) | signatures known / total |\n|---|---:|---:|---:|---:|---:|\n`;
  for (const [k, p] of Object.entries(providers)) md += `| ${NAME[k] || k} | ${p.marketChanges} | ${p.coverageByVolume} % | ${p.currentRows.coverage} % of ${p.currentRows.changes} | ${p.legacyRows.coverage} % of ${p.legacyRows.changes} | ${p.knownSignatures} / ${p.signatures} |\n`;
  for (const [k, p] of Object.entries(providers)) md += `\n## ${NAME[k] || k}\n\nKnown families (market changes): ${p.families.map(([f, n]) => `\`${f}\` ${n}`).join(', ') || '—'}\n\nUnknown types:\n\n` + (unknownList.filter((u) => u.provider === k).map((u) => `- \`${u.rawType}\`${u.specKeys.length ? ` (${u.specKeys.join(', ')})` : ''} — ${u.changes} changes · ${u.sports.join(', ') || 'sport n/a'} · e.g. «${u.titles.join('», «')}»${u.examples[0] ? ` · outcomes: ${u.examples[0].outcomes.map((o) => `${o.id}=${o.name ?? ''}${o.line != null ? ' ' + o.line : ''}`).join('; ')}` : ''}`).join('\n') || '- none') + '\n';
  fs.writeFileSync(arg('md'), md);
}
console.log(JSON.stringify(providers, (k, v) => (k === 'families' ? undefined : v), 1));
