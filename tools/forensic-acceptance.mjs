#!/usr/bin/env node
// Isolated synthetic timeline. NEVER registers with the production logger/collector or contacts an upstream.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CollectorForensics, PROVIDERS } from '../server/src/collector-forensics.js';
const i = process.argv.indexOf('--dir'), dir = i >= 0 && process.argv[i + 1];
if (!dir || !path.resolve(dir).includes('collector-forensics-acceptance/')) throw Error('--dir must be inside a separate collector-forensics-acceptance/ directory');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const logger = new CollectorForensics({ dir, heartbeatMs: 5000 }), states = new Map(PROVIDERS.map(p => [p, 'HEALTHY_ACTIVE']));
for (const provider of PROVIDERS) logger.register(provider, () => ({ collectorState: states.get(provider), transportState: states.get(provider) === 'DISCONNECTED' ? 'DISCONNECTED' : 'SYNTHETIC_CONNECTED', eventCount: 1, marketCount: 1, outcomeCount: 2, synthetic: true }));
await logger.ready; logger.start(); const at = new Date().toISOString();
await fs.writeFile(path.join(dir, 'acceptance-manifest.json'), JSON.stringify({ at, synthetic: true, noUpstreamConnections: true, noProductionStateChanges: true, expectedProviders: PROVIDERS }), { mode: 0o600 }); console.log(JSON.stringify({ at, dir, synthetic: true }));
for (const provider of PROVIDERS) {
  logger.record(provider, 'upstream_request_start', { operation: 'synthetic-request', synthetic: true }); await sleep(20); logger.record(provider, 'upstream_response_received', { operation: 'synthetic-request', synthetic: true, httpStatus: 200, durationMs: 20 }); logger.record(provider, 'payload_received', { operation: 'synthetic-request', synthetic: true, payloadBytes: 64 });
  logger.record(provider, 'parse_start', { operation: 'synthetic-decode', synthetic: true }); await sleep(50); logger.record(provider, 'parse_complete', { operation: 'synthetic-decode', synthetic: true, durationMs: 50 }); logger.record(provider, 'state_update', { operation: 'synthetic-state', synthetic: true, eventCount: 1 }); logger.record(provider, 'publish_start', { operation: 'synthetic-enqueue', synthetic: true }); logger.record(provider, 'publish_complete', { operation: 'synthetic-enqueue', synthetic: true, durationMs: 1 });
}
await sleep(15000); states.set('fonbet', 'DISCONNECTED'); logger.record('fonbet', 'disconnect', { synthetic: true, operation: 'synthetic-disconnect' }); await logger.sample();
states.set('astek', 'DEGRADED'); await logger.sample(); await sleep(15000);
logger.record('fonbet', 'retry', { synthetic: true, backoffMs: 1000 }); logger.record('fonbet', 'full_resync', { synthetic: true, reason: 'synthetic recovery' }); states.set('fonbet', 'HEALTHY_QUIET'); states.set('astek', 'HEALTHY_ACTIVE'); await logger.sample();
await sleep(90000); await logger.stop(); console.log(JSON.stringify({ completedAt: new Date().toISOString(), stats: logger.status(), synthetic: true }));
