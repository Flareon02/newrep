import { createApi } from '../../src/api.js';
import { SnapshotState } from '../../src/state.js';
import { stopMatcher } from '../../src/matcher-client.js';
import { HltvService } from '../../src/hltv-service.js';
import { OddsService } from '../../src/odds-service.js';

// Minimal in-process API on an ephemeral port, with no collectors and no disk
// writes, for contract tests between the extension and the server.
export async function startApi(options = {}) {
  const states = Array.from({ length: 4 }, (_, i) => new SnapshotState('harness-' + i, 60000));
  for (const s of states) s.persist = async () => {};
  const hltv = new HltvService({ read: async () => ({}), write: async () => {} });
  await hltv.ready;
  hltv.blockedUntil = Date.now() + 60000;
  const jobs = new OddsService(hltv);
  const server = createApi({
    hltvService: hltv, oddsService: jobs,
    liveState: states[0], prematchState: states[1], fonbetLiveState: states[2], fonbetPrematchState: states[3],
    prematchCollector: { status: () => ({}), catalog: [] }, fonbetCollector: { status: () => ({}) },
    resultsService: { status: () => ({}), days: new Map(), ...(options.resultsService || {}) },
    startedAt: Date.now(),
    ...options.api,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base, server,
    async close() { await jobs.stop(); await new Promise(resolve => server.close(resolve)); await stopMatcher(); },
  };
}

export const postJson = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
