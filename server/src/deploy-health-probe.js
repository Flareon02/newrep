import {fileURLToPath} from 'node:url';

// Exit codes consumed by upgrade.sh: 75 is a retryable response/transport
// failure; 76 is a rolling event-loop peak that may include startup work.
export const RETRY = 75;
export const LAG = 76;

export function assessHealth(data, elapsed) {
  const runtime = data?.runtime;
  const loop = runtime?.eventLoopMaxMs;
  const rss = runtime?.rssMiB;
  const heap = runtime?.heapUsedMiB;
  const metrics = {elapsed, loop, rss, heap};
  if (data?.ok !== true || data?.version !== '4.3.5' ||
      runtime?.storage?.engine !== 'sqlite' || runtime?.storage?.schemaVersion !== 3 ||
      runtime?.storage?.integrity !== 'ok' ||
      ![loop, rss, heap].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    return {code: 1, message: 'Invalid health identity, storage status or metrics', ...metrics};
  }
  if (rss > 600 || heap > 360) return {code: 1, message: 'Memory guardrail exceeded', ...metrics};
  if (elapsed > 4500) return {code: RETRY, message: 'Slow health response', ...metrics};
  if (loop > 3000) return {code: LAG, message: 'Rolling 60-second event-loop peak exceeds 3000ms', ...metrics};
  return {code: 0, message: 'Healthy', ...metrics};
}

export async function probeHealth({url = 'http://127.0.0.1:8080/health', timeoutMs = 5000} = {}) {
  const started = performance.now();
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
    if (!response.ok) return {code: 1, message: `Health HTTP ${response.status}`};
    const data = await response.json();
    return assessHealth(data, Math.round(performance.now() - started));
  } catch (error) {
    return {
      code: error instanceof SyntaxError ? 1 : RETRY,
      message: `Health probe failed: ${error?.name || 'Error'}: ${error?.message || error}`,
      elapsed: Math.round(performance.now() - started)
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await probeHealth();
  if (result.code === 0) console.log(`stability ${result.elapsed}ms loop=${result.loop}ms rss=${result.rss}MiB heap=${result.heap}MiB`);
  else console.error(JSON.stringify(result));
  process.exitCode = result.code;
}
