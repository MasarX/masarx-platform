export type OutboxDisplay = {
  actionLabel?: string | null;
  targetLabel?: string | null;
};

export function normalizeOutboxDisplay(value: unknown): OutboxDisplay | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const display: OutboxDisplay = {};
  for (const key of ["actionLabel", "targetLabel"] as const) {
    const label = source[key];
    if (typeof label === "string" && label.trim()) display[key] = label.trim();
  }
  return Object.keys(display).length ? display : undefined;
}

export type OutboxEntryStatus =
  | "queued"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "dead";

export type OutboxEntry = {
  id: string;
  rpc: string;
  transport?: "rpc" | "edge";
  display?: OutboxDisplay;
  args: Record<string, unknown>;
  status: OutboxEntryStatus;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
};

export type OutboxEnqueueInput = {
  rpc: string;
  transport?: "rpc" | "edge";
  display?: OutboxDisplay;
  args: Record<string, unknown>;
  id?: string;
};

export type RpcExecutor = (
  rpc: string,
  args: Record<string, unknown>,
  transport?: "rpc" | "edge"
) => Promise<unknown>;

export type OutboxStore = {
  init: () => Promise<void>;
  enqueue: (input: OutboxEnqueueInput) => Promise<OutboxEntry>;
  get: (id: string) => Promise<OutboxEntry | null>;
  list: (params?: {
    status?: OutboxEntryStatus[];
    limit?: number;
  }) => Promise<OutboxEntry[]>;
  listPending: (params?: { limit?: number; force?: boolean }) => Promise<OutboxEntry[]>;
  claimPending?: (params: { limit?: number; force?: boolean }) => Promise<OutboxEntry[]>;
  countPending: () => Promise<number>;
  update: (id: string, patch: Partial<OutboxEntry>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: (params?: { status?: OutboxEntryStatus[] }) => Promise<number>;
  recoverStaleInFlight?: (params: { olderThanMs: number }) => Promise<number>;
};

export const DEFAULT_OUTBOX_BACKOFF_MS = {
  base: 1_000,
  max: 60_000,
};

export const DEFAULT_OUTBOX_STALE_IN_FLIGHT_MS = 5 * 60_000;
export const MAX_OUTBOX_QUERY_LIMIT = 500;

export function normalizeOutboxLimit(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_OUTBOX_QUERY_LIMIT, Math.max(0, Math.floor(value))) : fallback;
}

export function normalizeOutboxDuration(value: unknown, fallback: number) {
  // Match the platform timer range; larger values can also break ISO-date ordering.
  return typeof value === "number" && Number.isFinite(value) && value <= 2_147_483_647
    ? Math.max(0, Math.floor(value)) : fallback;
}

export function createOutboxNow() {
  return new Date().toISOString();
}

export function createOutboxId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `outbox_${Date.now()}_${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
  }
  return `outbox_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function computeBackoffMs(attempt: number, config = DEFAULT_OUTBOX_BACKOFF_MS) {
  const safeAttempt = clampNumber(attempt, 0, 30);
  const exp = Math.pow(2, safeAttempt);
  const jitter = 0.85 + Math.random() * 0.3; // 0.85..1.15
  return clampNumber(Math.round(config.base * exp * jitter), config.base, config.max);
}

function serializeError(error: unknown) {
  let value: string;
  if (!error) value = "Unknown error";
  else if (typeof error === "string") value = error;
  else if (error instanceof Error) value = error.stack || error.message;
  else {
    try { value = JSON.stringify(error) ?? String(error); }
    catch { value = String(error); }
  }
  return redactOutboxErrorText(value);
}

const MAX_ERROR_TEXT_LENGTH = 8 * 1024;
const WITHHELD_MESSAGE = "[REDACTED: message withheld]";
const KEY_JOIN = String.raw`(?:[_-]|%2d)`;
const KEY_CHAR = String.raw`(?:[a-z0-9]|${KEY_JOIN})`;
const KEY_SPACE = String.raw`(?: |%(?:25)?20)`;
const SPACED_KEY = String.raw`(?:api${KEY_SPACE}key|session${KEY_SPACE}ids?)`;
const LEGACY_KEYWORD = String.raw`(?:api${KEY_JOIN}?key|token|authorization|password|secret|jwt)`;
const JSON_BACKSLASH = String.raw`(?:\\|%(?:25)?5c)`;
const HORIZONTAL_SPACE_ESCAPE = String.raw`(?:t|u(?:0009|00[2a]0|1680|200[0-9a]|202f|205f|3000|feff))`;
const COOKIE_KEY = String.raw`(?:set${KEY_JOIN})?cookies?`;
const COOKIE_HEADER_KEY = String.raw`(?=(?:${KEY_CHAR}*${KEY_JOIN})?cookie(?:s(?!${KEY_CHAR})|(?![a-z0-9])))${KEY_CHAR}+`;
const COOKIE_SPACE = String.raw`(?:[^\S\r\n\u2028\u2029]|%(?:25)?(?:09|20)|${JSON_BACKSLASH}+${HORIZONTAL_SPACE_ESCAPE})*`;
const COOKIE_SEPARATOR = String.raw`${COOKIE_SPACE}(?:[:=]|%(?:25)?3[ad])`;
const NOT_COOKIE_HEADER = String.raw`(?!${COOKIE_HEADER_KEY}${COOKIE_SEPARATOR})`;
const EXTRA_KEYWORD = String.raw`(?:passwd|pwd|${COOKIE_KEY}|session${KEY_JOIN}?ids?|private${KEY_JOIN}?key)`;
const KEYWORD = String.raw`(?:${LEGACY_KEYWORD}|${EXTRA_KEYWORD}|credentials?|${SPACED_KEY})`;
// Short names like cookie and pwd must cover a whole key segment.
const SENSITIVE_KEY_NAME = String.raw`(?:${KEY_CHAR}*${SPACED_KEY}${KEY_CHAR}*|(?=${KEY_CHAR}*${LEGACY_KEYWORD}|(?:${KEY_CHAR}*credentials?|(?:${KEY_CHAR}*${KEY_JOIN})?${EXTRA_KEYWORD})(?![a-z0-9]))${KEY_CHAR}+)`;
const SENSITIVE_KEY = String.raw`${SENSITIVE_KEY_NAME}(?:["']|%22)*`;
const ENCODED_SEPARATOR = String.raw`(?:\s|%20)*%(?:25)?3[ad](?:\s|%20)*`;
const NOT_ENCODED_COOKIE_FIELD = String.raw`(?!${COOKIE_HEADER_KEY}(?:["']|%22)+${ENCODED_SEPARATOR}%22)`;
const KEY_SEPARATOR = String.raw`(?:\s*[:=]|${ENCODED_SEPARATOR})`;
const NEXT_SENSITIVE_KEY = String.raw`${SENSITIVE_KEY}${KEY_SEPARATOR}`;
const LINE_ESCAPE_CODE = String.raw`(?:[nr]|u(?:000[ad]|202[89]))`;
const SPACE_ESCAPE_CODE = String.raw`(?:${LINE_ESCAPE_CODE}|${HORIZONTAL_SPACE_ESCAPE}|[fb]|u000[8bc])`;
const ENCODED_CONTROL_SPACE = String.raw`%(?:25)*0[89abcd]`;
const ODD_BACKSLASHES = String.raw`${JSON_BACKSLASH}(?:${JSON_BACKSLASH}${JSON_BACKSLASH})*`;
const ESCAPED_SPACE = String.raw`(?:${ODD_BACKSLASHES}(?!token)${SPACE_ESCAPE_CODE}|${ENCODED_CONTROL_SPACE})`;
// A key can follow whitespace escaped by an enclosing JSON layer, or a literal path separator.
const ESCAPED_KEY_BOUNDARY = String.raw`${JSON_BACKSLASH}+(?:(?!token)${SPACE_ESCAPE_CODE})?`;
const ENCODED_KEY_BOUNDARY = String.raw`%(?:25)*(?:c2%(?:25)*a0|[012][0-9a-f]|3[a-f]|40|5[b-e]|60|7[b-f])`;
const KEY_BOUNDARY = String.raw`(?:${ESCAPED_KEY_BOUNDARY}|${ENCODED_CONTROL_SPACE}|${ENCODED_KEY_BOUNDARY}|\b|(?=-|%2d))`;
const MARKER_OR_KEY_RUN = String.raw`\[(?:JWT_)?REDACTED\]|${ESCAPED_KEY_BOUNDARY}|${ENCODED_CONTROL_SPACE}|${KEY_CHAR}+`;
// Serialized log lines can carry a newline from an inner JSON layer.
const VALUE_SPACE = String.raw`(?:${ESCAPED_SPACE}|${JSON_BACKSLASH}+${LINE_ESCAPE_CODE})`;
const VALUE_DELIMITER = String.raw`%26|%7d|[&\s,}]|${VALUE_SPACE}|$`;
const JSON_QUOTE = String.raw`(?:"|%(?:25)?22)`;
const ESCAPED_JSON_QUOTE = String.raw`${JSON_BACKSLASH}+(?:${JSON_QUOTE}|u0022)`;
const ANY_JSON_QUOTE = String.raw`(?:${ESCAPED_JSON_QUOTE}|${JSON_QUOTE})`;
const JSON_COLLECTION_OPEN = String.raw`(?:[\[{]|%(?:25)?(?:7b|5b))`;
const SCANNED_JSON_VALUE = String.raw`(?:${ESCAPED_JSON_QUOTE}|%2522|${JSON_COLLECTION_OPEN})`;
const JSON_SPACE = String.raw`(?:\s|%(?:25)?20)*`;
const JSON_FIELD_END = String.raw`(?:[,}\]]|%(?:25)?(?:2c|7d|5d))`;
const BARE_VALUE_PART = String.raw`(?!${VALUE_SPACE}|${ANY_JSON_QUOTE}${JSON_SPACE}${JSON_FIELD_END})(?:${JSON_BACKSLASH}+|[^\s\x08&,}])`;
const ESCAPED_KEY_PREFIX = new RegExp(String.raw`^(?:${JSON_BACKSLASH}+(?!token)${SPACE_ESCAPE_CODE}|${ENCODED_CONTROL_SPACE})`, "i");
const EVEN_LINE_ESCAPE = new RegExp(String.raw`(?:${JSON_BACKSLASH}${JSON_BACKSLASH})+${LINE_ESCAPE_CODE}`, "iy");
const PLAIN_QUOTE_TAIL = String.raw`(?:(?!${VALUE_DELIMITER})(?:${JSON_BACKSLASH}+|[\s\S]))*`;
const PLAIN_VALUE = String.raw`(?!${SCANNED_JSON_VALUE})(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)${PLAIN_QUOTE_TAIL}|'(?:\\[\s\S]|[^'\\])*(?:'|$)${PLAIN_QUOTE_TAIL}|(?:${BARE_VALUE_PART})+)`;
// A closed quote can contain %26. Fall back to the parameter boundary for an
// unclosed quote, and let a following quoted credential match independently.
const ENCODED_QUOTE_DELIMITER = String.raw`${VALUE_DELIMITER}|%2c|%5d|[)/"]`;
const CLOSED_ENCODED_QUOTE = String.raw`(?:(?!%7d|&|%26(?=${NEXT_SENSITIVE_KEY}%22)|%22(?=${ENCODED_QUOTE_DELIMITER}))[\s\S])*%22(?=${ENCODED_QUOTE_DELIMITER})`;
const ENCODED_UNQUOTED_VALUE = String.raw`(?:(?!%26|%7d|%20(?=${NEXT_SENSITIVE_KEY}))${BARE_VALUE_PART})+`;
// Older encoded values can include a prefixed key. Preserve only bare key syntax at a
// recognized separator, and still collect the following value with its own matcher.
const LEGACY_ENCODED_VALUE = String.raw`(?:(?!%26|%7d|%20(?=${KEYWORD}${KEY_SEPARATOR}))${BARE_VALUE_PART})+`;

function credentialPattern(prefix: string, value: string, skip = MARKER_OR_KEY_RUN) {
  // Consume only the prefix so a separate credential can start inside a matched value.
  return new RegExp(String.raw`(?=(${prefix})(${value}))\1|${skip}`, "gi");
}

function encodedCredentialPattern(unclosedQuote: string) {
  return credentialPattern(
    String.raw`${KEY_BOUNDARY}${NOT_COOKIE_HEADER}${SENSITIVE_KEY}${ENCODED_SEPARATOR}`,
    String.raw`(?!${SCANNED_JSON_VALUE})(?:%22(?:${CLOSED_ENCODED_QUOTE}|${unclosedQuote})|${ENCODED_UNQUOTED_VALUE})`,
  );
}

const ENCODED_CREDENTIAL = encodedCredentialPattern(String.raw`(?:(?!%26|%7d|&)[\s\S])*`);
const TRUNCATED_ENCODED_CREDENTIAL = encodedCredentialPattern(String.raw`[\s\S]*$`);
const CREDENTIAL_PATTERNS = [
  credentialPattern(
    String.raw`${KEY_BOUNDARY}(?=[a-z0-9_]*(?:api_?key|token|authorization|password|secret|jwt))[a-z0-9_]+["']?\s*[:=]\s*`,
    PLAIN_VALUE,
    String.raw`\[(?:JWT_)?REDACTED\]|${ESCAPED_KEY_BOUNDARY}|${ENCODED_CONTROL_SPACE}|[a-z0-9_]+`,
  ),
  credentialPattern(String.raw`${KEY_BOUNDARY}${NOT_COOKIE_HEADER}${SENSITIVE_KEY}\s*[:=]\s*`, PLAIN_VALUE),
  credentialPattern(
    String.raw`${KEY_BOUNDARY}${NOT_COOKIE_HEADER}${NOT_ENCODED_COOKIE_FIELD}${SENSITIVE_KEY}%3[ad]\s*`,
    String.raw`(?!${SCANNED_JSON_VALUE})${LEGACY_ENCODED_VALUE}`,
  ),
];
const JSON_SEPARATOR = String.raw`${JSON_SPACE}(?:[:=]|%(?:25)?3[ad])${JSON_SPACE}`;
const JSON_KEY = String.raw`(?:${ESCAPED_JSON_QUOTE}|${KEY_BOUNDARY})${NOT_COOKIE_HEADER}${SENSITIVE_KEY_NAME}(?:["']|%(?:25)?22)*`;
const JSON_FIELD = new RegExp(
  String.raw`(${JSON_KEY}(?:${ESCAPED_JSON_QUOTE}${ANY_JSON_QUOTE}*${JSON_SEPARATOR}`
    + String.raw`|${JSON_SEPARATOR}(?=${SCANNED_JSON_VALUE})))|${MARKER_OR_KEY_RUN}`,
  "gi",
);
// Consume runs of the same backslash spelling even when no quote follows.
const QUOTE_RUN = String.raw`((${JSON_BACKSLASH})\2*)`;
const QUOTE_BODY = String.raw`${JSON_QUOTE}|u0022`;
const QUOTE_TOKEN = String.raw`${QUOTE_RUN}(${QUOTE_BODY})?|(${JSON_QUOTE})`;
const JSON_QUOTE_TOKEN = new RegExp(QUOTE_TOKEN, "gi");
const COOKIE_KEY_QUOTE = String.raw`(?:${ANY_JSON_QUOTE}|')`;
const COOKIE_TOKEN = new RegExp(
  String.raw`${QUOTE_RUN}(?:(${QUOTE_BODY})|(${SPACE_ESCAPE_CODE}))?|(${JSON_QUOTE})`
    + String.raw`|${COOKIE_HEADER_KEY}(${COOKIE_KEY_QUOTE})?(${COOKIE_SEPARATOR})(${COOKIE_SPACE})`
    + String.raw`|([\r\n\u2028\u2029]|%(?:25)*0[ad])|(&)|(')|${ENCODED_CONTROL_SPACE}|%(?:25)?[a-f0-9]{2}|${MARKER_OR_KEY_RUN}`,
  "gi",
);
const LINE_ESCAPE = new RegExp(String.raw`^${LINE_ESCAPE_CODE}$`, "i");
const JSON_SCALAR = new RegExp(
  String.raw`(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e(?:[+-]|%(?:25)?2b)?\d+)?|true|false|null)(?=${JSON_SPACE}${JSON_FIELD_END})`,
  "iy",
);
const JSON_SYNTAX_TOKEN = new RegExp(String.raw`${QUOTE_TOKEN}|([\[\]{}]|%(?:25)?(?:[57][bd]))`, "gi");
const JSON_VALUE_QUOTE = new RegExp(ANY_JSON_QUOTE, "iy");
const JSON_VALUE_COLLECTION = new RegExp(JSON_COLLECTION_OPEN, "iy");
const JSON_BARE_END = new RegExp(String.raw`([\s,}\]&]|%(?:25)?(?:20|2c|7d|5d|26)|${VALUE_SPACE})|${JSON_BACKSLASH}+`, "gi");
const JSON_VALUE_END = new RegExp(String.raw`[\s;,}\]&)/"]|%(?:25)?(?:20|2c|7d|5d|26|22)|${VALUE_SPACE}|$`, "iy");
const COLLECTION_CLOSERS: Record<string, string> = { "[": "]", "{": "}", "5b": "5d", "7b": "7d" };
const AUTHORIZATION_SCHEME = new RegExp(
  String.raw`(${KEY_BOUNDARY}(?:proxy(?:-|%2d))?authorization(?:["']|%22)?${KEY_SEPARATOR}(?:\s|%20)*(?:["']|%22)?)(?=Basic(?:\s|%20))|${JSON_BACKSLASH}+`, "gi",
);
const SCHEME = new RegExp(
  String.raw`(?=(Bearer\s+|Bearer(?:%20|:\s*)(?!${NEXT_SENSITIVE_KEY})|Basic(?:\s+|%20))([A-Za-z0-9._~+/=-]+))\1`, "gi",
);
const BASIC_CREDENTIAL = /^[A-Za-z0-9+/]{8,}={0,2}/;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

type RedactionSpan = { start: number; end: number; prefix?: string; cookie?: true };

function hasAmbiguousLineTail(text: string, end: number, key: string) {
  // An escaped key boundary establishes the layered log format for this field.
  EVEN_LINE_ESCAPE.lastIndex = end;
  return EVEN_LINE_ESCAPE.test(text) && !ESCAPED_KEY_PREFIX.test(key);
}

function quoteKey(match: RegExpExecArray, quote: string, closing = false) {
  const slash = match[2] ?? "";
  const backslashes = slash ? (match[1]?.length ?? 0) / slash.length : 0;
  const spelling = quote.toLowerCase();
  // Paired backslashes are content at each escape layer.
  const depth = !closing ? backslashes
    : spelling === "u0022" ? backslashes & -backslashes
    : backslashes & ~(backslashes + 1);
  return `${depth}:${depth ? slash.toLowerCase() : ""}${spelling}`;
}

function collectCookieSpans(text: string, spans: RedactionSpan[]) {
  if (!/cookie/i.test(text)) return;

  // Track enclosing quotes before a header starts so quoted cookie pairs stay inside it.
  const quotes: { key: string; token: string; lineDepth: number }[] = [];
  let header: { start: number; space: string; encoding: number } | undefined;
  const finish = (end: number) => {
    if (header && header.start + header.space.length < end) {
      spans.push({ start: header.start, end, prefix: header.space, cookie: true });
    }
    header = undefined;
  };

  for (const match of text.matchAll(COOKIE_TOKEN)) {
    const end = match.index + match[0].length;
    const [, slashRun = "", slash = "", escapedQuote, spaceEscape, rawQuote, keyQuote, separator,
      space = "", line, ampersand, apostrophe] = match;
    const quote = escapedQuote ?? rawQuote ?? apostrophe;
    const depth = slash ? slashRun.length / slash.length : 0;
    if (separator) {
      if (keyQuote) {
        const keyEnd = quotes[quotes.length - 1];
        if (keyEnd?.token === keyQuote.toLowerCase()) {
          quotes.pop();
          if (header) {
            finish(end - keyQuote.length - separator.length - space.length);
            continue;
          }
        }
        JSON_VALUE_QUOTE.lastIndex = end;
        JSON_VALUE_COLLECTION.lastIndex = end;
        if (JSON_VALUE_QUOTE.test(text) || JSON_VALUE_COLLECTION.test(text) || text[end] === "'") continue;
        JSON_SCALAR.lastIndex = end;
        if (JSON_SCALAR.test(text)) {
          spans.push({ start: end, end: JSON_SCALAR.lastIndex, cookie: true });
          continue;
        }
      }
      header ??= {
        start: end - space.length,
        space,
        encoding: /%(?:25)?3[ad]$/i.exec(separator)?.[0].length ?? 0,
      };
    } else if (line) {
      if (line.length === 1 || line.length === header?.encoding) finish(match.index);
    } else if (ampersand) {
      if (header?.encoding) finish(match.index);
    } else if (quote) {
      if (quote === "'" && /[a-z0-9]/i.test(text[match.index - 1] ?? "") && /[a-z0-9]/i.test(text[end] ?? "")) continue;
      const key = quote === "'" ? quote : quoteKey(match, quote, true);
      let index = quotes.length - 1;
      while (index >= 0 && quotes[index]?.key !== key) index -= 1;
      const closing = quotes[index];
      if (closing) {
        finish(end - closing.token.length);
        quotes.length = index;
      } else if (!header) {
        quotes.push({
          key: quote === "'" ? quote : quoteKey(match, quote),
          token: match[0].toLowerCase(),
          lineDepth: quote.toLowerCase() === "u0022" ? depth : depth + 1,
        });
      }
    } else if (header && spaceEscape && LINE_ESCAPE.test(spaceEscape)) {
      const open = quotes[quotes.length - 1];
      // At each JSON escape layer, paired backslashes are literal content.
      if (!open || open.key === "'") {
        finish(match.index);
      } else if (depth % (2 * open.lineDepth) === open.lineDepth) {
        finish(match.index + slashRun.length - open.lineDepth * slash.length);
      }
    }
  }
  finish(text.length);
}

function findCollectionEnd(text: string, start: number, opening: string) {
  const expected = [COLLECTION_CLOSERS[opening.slice(-2).toLowerCase()]];
  let openQuote: string | undefined;
  JSON_SYNTAX_TOKEN.lastIndex = start + opening.length;
  for (let match; (match = JSON_SYNTAX_TOKEN.exec(text));) {
    const quote = match[3] ?? match[4];
    if (quote !== undefined) {
      if (openQuote === undefined) openQuote = quoteKey(match, quote);
      else if (quoteKey(match, quote, true) === openQuote) openQuote = undefined;
    } else if (openQuote === undefined && match[5]?.length === opening.length) {
      const bracket = match[5].slice(-2).toLowerCase();
      const closer = COLLECTION_CLOSERS[bracket];
      if (closer) expected.push(closer);
      else if (expected.pop() !== bracket) break;
      else if (expected.length === 0) return JSON_SYNTAX_TOKEN.lastIndex;
    }
  }
  // A malformed or truncated collection may still contain credential text.
  return text.length;
}

function collectJsonSpans(text: string, spans: RedactionSpan[]) {
  const valueStarts = new Set<number>();
  let collectionEnd = 0;
  let bareEnd = 0;
  for (const match of text.matchAll(JSON_FIELD)) {
    if (match[1] === undefined) continue;
    const start = match.index + match[1].length;
    if (start < collectionEnd) continue;

    JSON_VALUE_COLLECTION.lastIndex = start;
    JSON_VALUE_QUOTE.lastIndex = start;
    const opening = JSON_VALUE_COLLECTION.exec(text)?.[0];
    if (opening) {
      collectionEnd = findCollectionEnd(text, start, opening);
      spans.push({ start, end: collectionEnd });
    } else if (JSON_VALUE_QUOTE.test(text)) {
      valueStarts.add(start);
    } else {
      // Overlapping bare values share the same next delimiter.
      if (start >= bareEnd) {
        JSON_BARE_END.lastIndex = start;
        let delimiter = JSON_BARE_END.exec(text);
        while (delimiter && !delimiter[1]) delimiter = JSON_BARE_END.exec(text);
        bareEnd = delimiter?.index ?? text.length;
        if (hasAmbiguousLineTail(text, bareEnd, match[1])) return true;
      }
      if (bareEnd > start) spans.push({ start, end: bareEnd });
    }
  }
  if (valueStarts.size === 0) return;

  const openValues = new Map<string, number>();
  let runStart = 0;
  let runEnd = -1;
  for (const match of text.matchAll(JSON_QUOTE_TOKEN)) {
    if (match.index !== runEnd) runStart = match.index;
    const end = match.index + match[0].length;
    const quote = match[3] ?? match[4];
    runEnd = quote === undefined ? end : -1;
    if (quote === undefined) continue;

    const openKey = quoteKey(match, quote);
    const closingKey = openValues.has(openKey) ? openKey : quoteKey(match, quote, true);
    const start = openValues.get(closingKey);
    JSON_VALUE_END.lastIndex = end;
    if (start !== undefined && JSON_VALUE_END.test(text)) {
      spans.push({ start, end });
      openValues.delete(closingKey);
    }
    if (valueStarts.has(runStart) && !openValues.has(openKey)) openValues.set(openKey, runStart);
  }
  for (const start of openValues.values()) spans.push({ start, end: text.length });
}

const PERCENT_CHARACTER = /%(?:[0-7][\da-f]|(?:c[2-9a-f]|d[\da-f])%[89ab][\da-f]|e[\da-f](?:%[89ab][\da-f]){2}|f[0-4](?:%[89ab][\da-f]){3})/gi;
const JSON_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const HTML_ENTITIES: Record<string, string> = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: "\u00a0" };
const NORMALIZED_ASSIGNMENT = /([a-z0-9_-]+)(?:\s+(key|ids?)\b)?["']*\s*[:=]\s*|[a-z0-9_-]+/gi;
const NORMALIZED_SENSITIVE_KEY = new RegExp(`^(?:${SENSITIVE_KEY_NAME}|${COOKIE_HEADER_KEY})$`, "i");
const REDACTED_VALUE = String.raw`(?:(?:Basic|Bearer)\s+)?\[(?:JWT_)?REDACTED\]`;
const SAFE_VALUE = new RegExp(
  String.raw`(?:(?:(['"])(?:${REDACTED_VALUE})?\1|${REDACTED_VALUE})(?=$|[\s,;&}\])/"'])|(?=$|[,;&}\])]))`, "iy",
);

function decodeUpToThreeTimes(text: string, decode: (input: string) => string) {
  for (let round = 0; round < 3; round += 1) {
    const next = decode(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

function hasUnredactedAssignment(output: string) {
  // Decode individual characters so malformed escapes cannot hide a later valid one.
  const percentDecoded = decodeUpToThreeTimes(output, (text) => text.replace(PERCENT_CHARACTER, (escape) => {
    try { return decodeURIComponent(escape); }
    catch { return escape; }
  }));
  const jsonDecoded = decodeUpToThreeTimes(percentDecoded, (text) =>
    text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (escape, hex: string | undefined, code: string, offset: number) => {
      if (code === "t" && text.slice(offset + 2, offset + 6).toLowerCase() === "oken") return escape;
      return hex === undefined ? JSON_ESCAPES[code] : String.fromCharCode(parseInt(hex, 16));
    }));
  const normalized = decodeUpToThreeTimes(jsonDecoded, (text) =>
    text.replace(/&(?:(quot|apos|amp|lt|gt|nbsp)|#(x[\da-f]+|\d+));/gi, (entity, name: string | undefined, number: string) => {
      if (name !== undefined) return HTML_ENTITIES[name.toLowerCase()];
      const value = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
      return value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    }));

  for (const match of normalized.matchAll(NORMALIZED_ASSIGNMENT)) {
    const [, key, suffix] = match;
    if (key === undefined || !NORMALIZED_SENSITIVE_KEY.test(suffix ? `${key} ${suffix}` : key)) continue;
    SAFE_VALUE.lastIndex = match.index + match[0].length;
    if (!SAFE_VALUE.test(normalized)) return true;
  }
  return false;
}

export function redactOutboxErrorText(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  let end = MAX_ERROR_TEXT_LENGTH;
  const lastKept = value.charCodeAt(end - 1);
  if (truncated && lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  const text = value.slice(0, end);

  const spans: RedactionSpan[] = [];
  const credentialStarts = new Set<number>();
  collectCookieSpans(text, spans);
  const encodedCredential = truncated ? TRUNCATED_ENCODED_CREDENTIAL : ENCODED_CREDENTIAL;
  for (const pattern of [...CREDENTIAL_PATTERNS, encodedCredential]) {
    for (const match of text.matchAll(pattern)) {
      if (match[2] === undefined) continue;
      const start = match.index + match[1].length;
      credentialStarts.add(start);
      const end = start + match[2].length;
      if (!/^(?:["']|%22)/i.test(match[2]) && hasAmbiguousLineTail(text, end, match[1])) return WITHHELD_MESSAGE;
      spans.push({ start, end });
    }
  }
  if (collectJsonSpans(text, spans)) return WITHHELD_MESSAGE;
  const authorizationSchemes = new Set<number>();
  for (const match of text.matchAll(AUTHORIZATION_SCHEME)) {
    if (match[1] !== undefined) authorizationSchemes.add(match.index + match[1].length);
  }
  let schemeChainEnd = 0;
  for (const match of text.matchAll(SCHEME)) {
    const basic = match[1].toLowerCase().startsWith("basic");
    let credential = match[2];
    if (basic && !authorizationSchemes.has(match.index) && !credentialStarts.has(match.index) && match.index >= schemeChainEnd) {
      const leading = BASIC_CREDENTIAL.exec(credential)?.[0];
      if (!leading || !(/[0-9+/=]/.test(leading) || (/[A-Z]/.test(leading) && /[a-z]/.test(leading)))) continue;
      credential = leading;
    }

    const valueStart = match.index + match[1].length;
    spans.push({ start: match.index, end: valueStart + credential.length, prefix: basic ? "Basic " : "Bearer " });
    schemeChainEnd = Math.max(schemeChainEnd, valueStart + match[2].length);
  }

  const jwtEnds = new Map<number, number>();
  for (const match of text.matchAll(JWT)) {
    const jwtEnd = match.index + match[0].length;
    jwtEnds.set(match.index, jwtEnd);
    spans.push({ start: match.index, end: jwtEnd });
  }
  if (truncated) {
    const basicTail = /Basic\s+\S+$/i.exec(text);
    if (basicTail) spans.push({ start: basicTail.index, end: text.length, prefix: "Basic " });
    const jwtTail = /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/.exec(text);
    if (jwtTail) {
      jwtEnds.set(jwtTail.index, text.length);
      spans.push({ start: jwtTail.index, end: text.length });
    }
  }

  // Merge overlapping spans only. A delimiter between two values stays in the output.
  spans.sort((left, right) => left.start - right.start || Number(!!right.cookie) - Number(!!left.cookie)
    || Number(!!left.prefix) - Number(!!right.prefix));
  let cursor = 0;
  let output = "";
  for (let index = 0, span; (span = spans[index]); index += 1) {
    const { start, prefix, end, cookie } = span;
    let spanEnd = end;
    let cookieEnd = cookie ? end : 0;
    for (let next; (next = spans[index + 1]) && next.start < spanEnd; index += 1) {
      // A pair inside a cookie header cannot extend past the header's closing delimiter.
      if (next.start < cookieEnd) continue;
      if (next.cookie) cookieEnd = next.end;
      spanEnd = Math.max(spanEnd, next.end);
    }
    const marker = jwtEnds.get(start) === spanEnd ? "[JWT_REDACTED]" : "[REDACTED]";
    output += text.slice(cursor, start) + (prefix ?? "") + marker;
    cursor = spanEnd;
  }
  output += text.slice(cursor);
  if (hasUnredactedAssignment(output)) return WITHHELD_MESSAGE;
  return output + (truncated ? "\u2026[truncated]" : "");
}

export type OutboxSyncOptions = {
  limit?: number;
  /** Replay queued/failed entries immediately, ignoring retry backoff. */
  force?: boolean;
  shouldRetry?: (error: unknown) => boolean;
  backoff?: { base: number; max: number };
  staleInFlightMs?: number;
  maxAttempts?: number;
  // Observation is downstream of accepted execution; its failure must not replay a mutation.
  onSucceeded?: (entry: OutboxEntry, result: unknown) => Promise<void>;
};

export type OutboxSyncResult = {
  attempted: number;
  succeeded: number;
  succeededIds: string[];
  failed: number;
  dead: number;
};

export function createOutbox(store: OutboxStore) {
  async function enqueue(input: OutboxEnqueueInput) {
    if (!input.rpc || !input.rpc.trim()) {
      throw new Error("Outbox enqueue requires rpc name.");
    }
    if (input.transport !== undefined && input.transport !== "rpc" && input.transport !== "edge") {
      throw new Error("Unsupported outbox transport.");
    }
    return store.enqueue({
      ...input,
      display: normalizeOutboxDisplay(input.display),
      id: input.id ?? createOutboxId(),
    });
  }

  async function sync(executor: RpcExecutor, options: OutboxSyncOptions = {}) {
    const limit = normalizeOutboxLimit(options.limit, 50);
    const force = options.force === true;
    const shouldRetry = options.shouldRetry ?? (() => true);
    const base = Math.max(1, normalizeOutboxDuration(options.backoff?.base, DEFAULT_OUTBOX_BACKOFF_MS.base));
    const backoffConfig = {
      base,
      max: Math.max(base, normalizeOutboxDuration(options.backoff?.max, DEFAULT_OUTBOX_BACKOFF_MS.max)),
    };
    const maxAttempts = typeof options.maxAttempts === "number" && Number.isFinite(options.maxAttempts)
      ? Math.max(1, Math.floor(options.maxAttempts)) : Infinity;
    const staleInFlightMs = normalizeOutboxDuration(options.staleInFlightMs, DEFAULT_OUTBOX_STALE_IN_FLIGHT_MS);

    if (store.recoverStaleInFlight && staleInFlightMs > 0) {
      await store.recoverStaleInFlight({ olderThanMs: staleInFlightMs });
    }

    const entries = store.claimPending
      ? await store.claimPending({ limit, force })
      : await store.listPending({ limit, force });
    const result: OutboxSyncResult = {
      attempted: 0,
      succeeded: 0,
      succeededIds: [],
      failed: 0,
      dead: 0,
    };

    for (const entry of entries) {
      result.attempted += 1;
      if (!store.claimPending) {
        await store.update(entry.id, {
          status: "in_flight",
          updated_at: createOutboxNow(),
        });
      }

      try {
        if (entry.transport !== undefined && entry.transport !== "rpc" && entry.transport !== "edge") {
          throw new Error("Unsupported outbox transport.");
        }
        const executionResult = await executor(entry.rpc, entry.args, entry.transport ?? "rpc");
        await store.remove(entry.id);
        result.succeeded += 1;
        result.succeededIds.push(entry.id);
        try {
          await options.onSucceeded?.(entry, executionResult);
        } catch {
          // Missing observation remains unverified; the accepted mutation stays succeeded.
        }
      } catch (error) {
        const attemptCount = (Number.isSafeInteger(entry.attempt_count) && entry.attempt_count >= 0
          ? Math.min(entry.attempt_count, Number.MAX_SAFE_INTEGER - 1) : 0) + 1;
        const retriable = shouldRetry(error);
        const status: OutboxEntryStatus = retriable && attemptCount < maxAttempts ? "failed" : "dead";
        if (status === "dead") result.dead += 1;
        else result.failed += 1;

        const nextAttemptAt = status === "failed"
          ? new Date(Date.now() + computeBackoffMs(attemptCount, backoffConfig)).toISOString()
          : null;

        await store.update(entry.id, {
          status,
          attempt_count: attemptCount,
          last_error: serializeError(error),
          next_attempt_at: nextAttemptAt,
          updated_at: createOutboxNow(),
        });
      }
    }

    return result;
  }

  async function countPending() {
    return store.countPending();
  }

  return {
    init: () => store.init(),
    enqueue,
    sync,
    countPending,
    get: (id: string) => store.get(id),
    // Entry listing — surfaced so observability UIs (e.g. the Mobile V2
    // More screen's outbox panel) can render recent queued / failed
    // entries from the canonical outbox store rather than fabricating
    // them. Thin pass-throughs to the underlying store.
    list: (params?: { status?: OutboxEntryStatus[]; limit?: number }) =>
      store.list(params),
    listPending: (params?: { limit?: number; force?: boolean }) => store.listPending(params),
  };
}

export type OutboxAgingPolicy = {
  dead_ttl_days: number;
  warn_pending_hours: number;
  max_entries_warn: number;
  purge_batch_size: number;
};

export type OutboxAgingEntry = Pick<OutboxEntry, "id" | "status"> & {
  created_at: string | number | Date;
  updated_at?: string | number | Date | null;
};

// Compatibility defaults from the selected aging-helper contract, not an
// automatic retention policy. Callers supply resolved policy; these helpers never delete.
export const DEFAULT_OUTBOX_AGING_POLICY: OutboxAgingPolicy = {
  dead_ttl_days: 7, warn_pending_hours: 12, max_entries_warn: 50, purge_batch_size: 25,
};

const AGING_MINUTE_MS = 60_000;
const AGING_HOUR_MS = 60 * AGING_MINUTE_MS;
const AGING_DAY_MS = 24 * AGING_HOUR_MS;

export function normalizeOutboxAgingPolicy(raw: unknown): OutboxAgingPolicy {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const positive = (key: keyof OutboxAgingPolicy, multiplier = 1) => {
    const input = value[key];
    const n = typeof input === "number" ? Math.floor(input) : NaN;
    return Number.isSafeInteger(n) && n > 0 && n <= Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
      ? n : DEFAULT_OUTBOX_AGING_POLICY[key];
  };
  return {
    dead_ttl_days: positive("dead_ttl_days", AGING_DAY_MS),
    warn_pending_hours: positive("warn_pending_hours", AGING_HOUR_MS),
    max_entries_warn: positive("max_entries_warn"),
    purge_batch_size: positive("purge_batch_size"),
  };
}

function agingTimestamp(value: string | number | Date | null | undefined): number | null {
  const ms = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function classifyOutboxAge<T extends OutboxAgingEntry>(
  entry: T, rawPolicy: unknown, now = Date.now(),
) {
  if (!Number.isFinite(now)) throw new Error("Outbox aging requires a finite clock.");
  const policy = normalizeOutboxAgingPolicy(rawPolicy);
  const created = agingTimestamp(entry.created_at) ?? now;
  const ageMs = Math.max(0, now - created);
  // Current outbox records last activity in updated_at, not last_attempted_at.
  const idleMs = Math.max(0, now - (agingTimestamp(entry.updated_at) ?? created));
  const warningMs = policy.warn_pending_hours * AGING_HOUR_MS;
  const severity = entry.status === "dead"
    ? ageMs >= policy.dead_ttl_days * AGING_DAY_MS ? "dead_expired" : "stale"
    : entry.status === "succeeded" ? "fresh"
    : ageMs >= warningMs ? "overdue" : ageMs >= warningMs / 2 ? "stale" : "fresh";
  return { entry, ageMs, idleMs, severity };
}

export function summarizeOutboxAging(
  entries: readonly OutboxAgingEntry[], rawPolicy: unknown, now = Date.now(),
) {
  if (!Number.isFinite(now)) throw new Error("Outbox aging requires a finite clock.");
  const policy = normalizeOutboxAgingPolicy(rawPolicy);
  const list = Array.isArray(entries) ? entries : [];
  let overdue = 0, deadExpired = 0;
  let oldestMs: number | null = null;
  for (const entry of list) {
    const age = classifyOutboxAge(entry, policy, now);
    if (age.severity === "overdue") overdue += 1;
    if (age.severity === "dead_expired") deadExpired += 1;
    oldestMs = oldestMs === null ? age.ageMs : Math.max(oldestMs, age.ageMs);
  }
  const banner = deadExpired
    ? `${deadExpired} outbox item${deadExpired === 1 ? "" : "s"} failed permanently; purge to clear.`
    : overdue ? `${overdue} outbox item${overdue === 1 ? " is" : "s are"} overdue; sync when online.`
    : list.length > policy.max_entries_warn ? `${list.length} pending actions in outbox, sync when online.` : null;
  return { total: list.length, overdue, dead_expired: deadExpired, oldest_ms: oldestMs, banner_message: banner };
}

export function pickDeadEntriesForPurge<T extends OutboxAgingEntry>(
  entries: readonly T[], rawPolicy: unknown, now = Date.now(),
): T[] {
  if (!Number.isFinite(now)) throw new Error("Outbox aging requires a finite clock.");
  const policy = normalizeOutboxAgingPolicy(rawPolicy);
  const ttl = policy.dead_ttl_days * AGING_DAY_MS;
  return (Array.isArray(entries) ? entries : [])
    .map(entry => ({ entry, created: agingTimestamp(entry.created_at) }))
    .filter((item): item is { entry: T; created: number } =>
      item.entry.status === "dead" && item.created !== null && now - item.created >= ttl)
    .sort((a, b) => a.created - b.created)
    .slice(0, policy.purge_batch_size)
    .map(item => item.entry);
}

export function formatRelativeAge(agoMs: number): string {
  if (!Number.isFinite(agoMs) || agoMs < AGING_MINUTE_MS) return "just now";
  if (agoMs < AGING_HOUR_MS) return `${Math.floor(agoMs / AGING_MINUTE_MS)}m ago`;
  if (agoMs < AGING_DAY_MS) return `${Math.floor(agoMs / AGING_HOUR_MS)}h ago`;
  return `${Math.floor(agoMs / AGING_DAY_MS)}d ago`;
}
