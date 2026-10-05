import { loadConfig } from './config.js';
import { createGateway, GATEWAY_VERSION } from './server.js';
import { createLogger } from './log.js';

const log = createLogger();
const config = loadConfig(process.env, { logRequests: /^(1|true)$/i.test(process.env.LOG_REQUESTS || '') });
const gateway = createGateway(config, { log });
const address = await gateway.start();
log.info(`[gateway] ${GATEWAY_VERSION} listening on ${address.address}:${address.port}; upstream ${config.upstreamBase}; public origin ${config.publicOrigin}`);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log.info(`[gateway] ${signal}: stopping`);
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    try { await gateway.stop(); } catch (error) { log.error('[gateway] stop failed', error.message); }
    process.exit(0);
  });
}
