// Default server URL of the staging tools: STAGING_URL, else PORT from the service environment file
// (ESPORTS_MONITOR_ENV_FILE, default /etc/esports-monitor/server.env), else 8080. An explicit --url always wins (callers).
import { readFileSync } from 'node:fs';

export function defaultUrl(env = process.env, readFile = (f) => readFileSync(f, 'utf8')) {
  if (env.STAGING_URL) return env.STAGING_URL;
  let port = '';
  try { port = (/^PORT=(\d+)\s*$/m.exec(readFile(env.ESPORTS_MONITOR_ENV_FILE || '/etc/esports-monitor/server.env')) || [])[1] || ''; } catch { /* not on the server: fall back */ }
  return `http://127.0.0.1${port === '80' ? '' : ':' + (port || '8080')}`;
}
