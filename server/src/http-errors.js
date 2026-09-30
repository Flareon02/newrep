// One error contract for every API response with status >= 400:
//   { ok:false, error:"<message>", code:"<machine code>", requestId:"<id>", ...legacy fields }
// `error` stays a plain string and every legacy field (matched, retryable,
// retryAfterMs, ...) is preserved, so the extension keeps working unchanged.
const CODES = {
  400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
  409: "conflict", 410: "gone", 413: "payload_too_large", 429: "rate_limited",
  500: "internal_error", 502: "upstream_error", 503: "unavailable", 504: "timeout"
};

export function errorCode(status) {
  return CODES[status] || (status >= 500 ? "internal_error" : "bad_request");
}

// Messages produced by JavaScript/Node/SQLite internals describe our code, not
// the user's request. They are logged server-side and replaced for the client.
const INTERNAL = /Cannot (?:read|set|destructure) propert|is not a function|is not defined|is not iterable|is not a constructor|Unexpected (?:token|end of JSON)|in JSON at position|Invalid (?:array|string|typed array) length|Maximum call stack|\bSQLITE|\bERR_[A-Z_]+\b|\bE(?:NOENT|ACCES|PERM|EXIST|CONNRESET|CONNREFUSED|PIPE|ADDRINUSE|MFILE|NOTFOUND|AI_AGAIN)\b|node_modules|\/(?:app|home|root)\/\S*\.[cm]?js\b|\.[cm]?js:\d+/;
// Upstream/transport failures are only recognised on 5xx (a 4xx is the client's own mistake and its text is
// ours) and only in English: our own user-facing messages are Russian and must never be rewritten.
const UNREACHABLE = /fetch failed|ETIMEDOUT|socket hang up/i;
const TIMEOUT = /operation was aborted|timed? ?out/i;
const russian = (text) => /[А-Яа-яЁё]/.test(text);

export function publicMessage(message, status = 500) {
  const text = String(message ?? "").slice(0, 500);
  if (!text) return { message: status >= 500 ? "Внутренняя ошибка сервера" : "Некорректный запрос", internal: status >= 500 };
  if (INTERNAL.test(text)) return { message: "Внутренняя ошибка сервера", internal: true };
  if (status >= 500 && !russian(text)) {
    if (UNREACHABLE.test(text)) return { message: "Источник данных временно недоступен", internal: true };
    if (TIMEOUT.test(text)) return { message: "Превышено время ожидания", internal: true };
  }
  return { message: text, internal: false };
}

export function normalizeErrorBody(data, status, requestId = "") {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : { error: data };
  const { message, internal } = publicMessage(source.error, status);
  const body = { ...source, ok: false, error: message, code: source.code || errorCode(status) };
  if (requestId) body.requestId = requestId;
  return { body, internal, original: String(source.error ?? "") };
}
