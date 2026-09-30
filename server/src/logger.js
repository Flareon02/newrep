import { format } from "node:util";

// Compact leveled logger. Docker already timestamps and rotates stdout
// (docker-compose.yml: json-file `local` driver, 10m x 3), so lines carry only a
// level and the existing "[tag] message" text. Routine per-poll chatter is
// logged at `debug`, which is off unless LOG_LEVEL=debug is set explicitly.
const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };
const MAX_LINE = 4000;
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 200;

let threshold = levelFrom(process.env.LOG_LEVEL);
let sink = (level, line) => (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
const recent = new Map();

function levelFrom(value) {
  const key = String(value || "info").trim().toLowerCase();
  return Object.hasOwn(LEVELS, key) ? LEVELS[key] : LEVELS.info;
}

const SECRET_PAIR = /\b(token|api[_-]?key|secret|passw(?:or)?d|authorization|cookie|x-api-token)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^\s"',;&]+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function redact(text) {
  return String(text).replace(BEARER, "Bearer [redacted]").replace(SECRET_PAIR, (_, key, sep) => `${key}${sep}[redacted]`);
}

function render(args) {
  const parts = args.map((arg) => (arg instanceof Error ? arg.stack || arg.message : arg));
  const line = redact(format(...parts)).replace(/\r?\n(?=\S)/g, " | ");
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}... [truncated ${line.length - MAX_LINE}]` : line;
}

function emit(level, args) {
  if (LEVELS[level] > threshold) return;
  let line = render(args);
  if (level !== "debug") {
    // Identical lines (typically an upstream outage repeating every backoff
    // step) are collapsed so a long outage cannot flood the disk.
    const key = `${level}:${line}`, now = Date.now(), entry = recent.get(key);
    if (entry && now - entry.at < DEDUPE_WINDOW_MS) { entry.suppressed++; return; }
    if (entry?.suppressed) line += ` (+${entry.suppressed} identical suppressed)`;
    recent.delete(key);
    recent.set(key, { at: now, level, line: render(args), suppressed: 0 });
    while (recent.size > DEDUPE_MAX_KEYS) recent.delete(recent.keys().next().value);
  }
  sink(level, `${level.padEnd(5)} ${line}`);
}

// A burst that stops is never followed by another identical line, so its suppressed count would be lost.
// Report it once the window has passed.
export function flushSuppressed(now = Date.now()) {
  for (const [key, entry] of recent) {
    if (!entry.suppressed || now - entry.at < DEDUPE_WINDOW_MS) continue;
    sink(entry.level, `${entry.level.padEnd(5)} ${entry.line} (+${entry.suppressed} identical suppressed, last seen ${Math.round((now - entry.at) / 1000)}s ago)`);
    entry.suppressed = 0;
    recent.delete(key);
  }
}
setInterval(() => flushSuppressed(), DEDUPE_WINDOW_MS).unref();

export const log = {
  error: (...args) => emit("error", args),
  warn: (...args) => emit("warn", args),
  info: (...args) => emit("info", args),
  debug: (...args) => emit("debug", args),
  enabled: (level) => (LEVELS[level] ?? 9) <= threshold,
};

// Test hooks.
export function setLogLevel(level) { threshold = levelFrom(level); }
export function setLogSink(fn) { sink = fn || sink; recent.clear(); }
