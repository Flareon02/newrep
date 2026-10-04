#!/usr/bin/env node
// Read-only, offline forensic CLI. No upstream/API request and no database mutation.
import {setPriority} from 'node:os';
try{setPriority(0,10);}catch{}
import { queryOptions, forensicReport, formatReport, queryIncidents } from '../server/src/collector-forensic-query.js';
const [command, ...args] = process.argv.slice(2);
try {
  const options = queryOptions(args);
  if (options.help || !command) console.log('esports-monitor forensic [--since 30m | --at "2026-10-04 13:34" --window 5m | --from ISO --to ISO] [--provider fonbet] [--timezone Europe/Amsterdam] [--json] [--dir PATH]\nesports-monitor incidents [--provider astek] [--json]');
  else if (command === 'forensic') { const report = await forensicReport(options); console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report)); }
  else if (command === 'incidents') { const list = await queryIncidents({ ...options, includeContext:false, from: args.some(a => ['--from', '--at', '--since'].includes(a)) ? options.from : -Infinity }); console.log(options.json ? JSON.stringify(list, null, 2) : list.map(i => `${i.incidentId} ${i.provider} ${i.state} ${i.startedAt} → ${i.recoveredAt || 'open'}, durationMs=${i.durationMs ?? '?'}, rootCause=${i.rootCause}`).join('\n') || 'No recorded incidents'); }
  else throw Error('Unknown command ' + command);
} catch (e) { console.error('forensic: ' + e.message); process.exitCode = 1; }
