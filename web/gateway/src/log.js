// Logger with a last line of defence: anything shaped like an Access Key, a session token or a Bearer header is
// masked before it is written, even if a caller passes one by mistake. Callers already never log them.
import { format } from 'node:util';

const PATTERNS = [
  [/\bemu_[0-9a-f]{8,}\b/gi, 'emu_[redacted]'],
  [/\beds_[A-Za-z0-9_-]{8,}/g, 'eds_[redacted]'],
  [/(bearer\s+)[^\s"',]+/gi, '$1[redacted]'],
  [/((?:__Host-)?eds_session=)[^;\s"]+/gi, '$1[redacted]'],
];
export const redact = (text) => PATTERNS.reduce((t, [re, to]) => t.replace(re, to), String(text));

export function createLogger({ write = (line, level) => (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n'), quiet = false } = {}) {
  const emit = (level) => (...args) => { if (!quiet || level === 'error') write(redact(`${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}`), level); };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
