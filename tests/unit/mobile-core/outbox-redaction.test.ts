import { redactOutboxErrorText } from "@masarx/mobile-core";

test.each([
  ["x-api-key=hk1", "x-api-key=[REDACTED]"],
  ["X-Api-Key: hk2", "X-Api-Key: [REDACTED]"],
  ["api-key: v", "api-key: [REDACTED]"],
  ["refresh_token%3Dabc", "refresh_token%3D[REDACTED]"],
  ["access_token%3Dabc%26x", "access_token%3D[REDACTED]%26x"],
  ["refresh_token%3Aabc", "refresh_token%3A[REDACTED]"],
  ["access_token%3Aabc%26x", "access_token%3A[REDACTED]%26x"],
  ["ReFrEsH_ToKeN%3dabc", "ReFrEsH_ToKeN%3d[REDACTED]"],
  ["AcCeSs_ToKeN%3aabc", "AcCeSs_ToKeN%3a[REDACTED]"],
  ["access_token%3Dabc%26state%3Dok", "access_token%3D[REDACTED]%26state%3Dok"],
  ["access_token%3Dabc&state=ok", "access_token%3D[REDACTED]&state=ok"],
  ["access_token=abc&state=ok", "access_token=[REDACTED]&state=ok"],
  ["state%3Dok%26api-key%3Dabc", "state%3Dok%26api-key%3D[REDACTED]"],
])("redacts %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test.each(["eyJ", "token"])("caps a 1 MiB run of %s in under 200 ms", (pattern) => {
  const input = pattern.repeat(Math.ceil(1024 * 1024 / pattern.length));
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(200);
  expect(output.endsWith("…[truncated]")).toBe(true);
});

test("redacts a credential spanning the cap and discards the raw remainder", () => {
  const prefix = " ".repeat(8192 - "api-key=visible".length);
  expect(redactOutboxErrorText(prefix + "api-key=visible-fixture-tail"))
    .toBe(prefix + "api-key=[REDACTED]…[truncated]");
});

test("redacts a JWT whose second segment spans the cap", () => {
  const prefix = " ".repeat(8192 - "eyJfixture.pay".length);
  expect(redactOutboxErrorText(prefix + "eyJfixture.payload.signature"))
    .toBe(prefix + "[JWT_REDACTED]…[truncated]");
});

test.each([
  ["token%253Dfixture", "token%253D[REDACTED]"],
  ["x-api-key%20%3D%20v", "x-api-key%20%3D%20[REDACTED]"],
  ["api%2Dkey%3Dfixture", "api%2Dkey%3D[REDACTED]"],
  ["Bearer%20fixture", "Bearer [REDACTED]"],
  ["bearer:fixture", "Bearer [REDACTED]"],
  ["Basic Zml4dHVyZQ==", "Basic [REDACTED]"],
  ["token%3D%22a b%22%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["-token=fixture", "-token=[REDACTED]"],
  ["x-request-id=1", "x-request-id=1"],
])("handles %s without exposing credentials", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test("processes 8 KiB of repeated x- in under 20 ms", () => {
  const input = "x-".repeat(4096);
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(20);
  expect(output).toBe(input);
});

test("drops an emoji when the cap would split its surrogate pair", () => {
  const prefix = " ".repeat(8191);
  expect(redactOutboxErrorText(prefix + "\u{1F600}")).toBe(prefix + "\u2026[truncated]");
});

test.each([
  ["password%3D%22a b token=%22SECRET", "password%3D[REDACTED]"],
  ["token%3D%22abc%26jwt%3D%22SECRET%22%26state%3Dok", "token%3D[REDACTED]%26jwt%3D[REDACTED]%26state%3Dok"],
  ["token%3D%22%22SECRET", "token%3D[REDACTED]"],
  ["token%3D%22x%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["token%3D%22a b%22%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["token%3Dabc%20password = SECRET", "token%3D[REDACTED]%20password = [REDACTED]"],
  ["token%3Dabc%20password: SECRET", "token%3D[REDACTED]%20password: [REDACTED]"],
  ["token%3Da%20b", "token%3D[REDACTED]"],
  ["Basic validation failed", "Basic validation failed"],
  ["Basic auth required", "Basic auth required"],
  ["Basic plan expired", "Basic plan expired"],
  ["x-request-id%3D1", "x-request-id%3D1"],
])("keeps credential boundaries in %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test.each([
  ["authorization%3DBasic%20YWJjOmRlZg==", "authorization%3D[REDACTED]"],
  ["token%3Dabc%20def=ghi", "token%3D[REDACTED]"],
  ["password%3Dp%20q%3Dr", "password%3D[REDACTED]"],
  ["Basic dXNlcjpwYXNz", "Basic [REDACTED]"],
  ["Bearer%20token: X", "Bearer%20token: [REDACTED]"],
  ["Bearer%20client_secret%3Aabc", "Bearer%20client_secret%3A[REDACTED]"],
  ["token%3Djwt: X", "token%3D[REDACTED] [REDACTED]"],
  ['token%3Dx{"password": "SECRET"}', "token%3D[REDACTED] [REDACTED]}"],
])("redacts compound credential input %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test("redacts a short Basic credential fragment at the cap", () => {
  const prefix = " ".repeat(8192 - "Basic dXN".length);
  expect(redactOutboxErrorText(prefix + "Basic dXNlcjpwYXNz"))
    .toBe(prefix + "Basic [REDACTED]\u2026[truncated]");
});

// Frozen references for the differential test. Keep their patterns and pass order unchanged.
function redactB22(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(\b(?=[a-z0-9_]*(?:api_?key|token|authorization|password|secret|jwt))[a-z0-9_]+["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");
}

const MAX_ERROR_TEXT_LENGTH = 8 * 1024;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function redactFirstFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  const redacted = value.slice(0, MAX_ERROR_TEXT_LENGTH)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:%26|\b)(?=[a-z0-9_-]*(?:api[_-]?key|token|authorization|password|secret|jwt))[a-z0-9_-]+["']?\s*)(?:([:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|(%3[ad]\s*)((?:(?!%26)[^\s&,}])+))/gi,
      (_match, key, separator, encodedSeparator, encodedValue?: string) => {
        const jwtOnly = encodedValue?.replace(JWT_PATTERN, "[JWT_REDACTED]") === "[JWT_REDACTED]";
        return key + (separator ?? encodedSeparator) + (jwtOnly ? "[JWT_REDACTED]" : "[REDACTED]");
      },
    )
    .replace(JWT_PATTERN, "[JWT_REDACTED]");
  if (!truncated) return redacted;

  // A JWT split by the cap may be missing the segments required by the normal matcher.
  return redacted.replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "…[truncated]";
}

function redactSecondFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  let end = MAX_ERROR_TEXT_LENGTH;
  const lastKept = value.charCodeAt(end - 1);
  if (truncated && lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;

  const redacted = value.slice(0, end)
    .replace(/Bearer(?:\s+|%20|:\s*)[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    // Consume other key-shaped runs whole so the lookahead never restarts at each hyphen.
    .replace(
      /((?:%26|\b|(?=-|%2d))(?=(?:[a-z0-9_-]|%2d)*(?:api(?:[_-]|%2d)?key|token|authorization|password|secret|jwt))(?:[a-z0-9_-]|%2d)+["']?)(?:(\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|((?:\s|%20)*%(?:25)?3[ad](?:\s|%20)*)(%22(?:(?!%22)[\s\S])*(?:%22|$)|(?:(?!%26)[^\s&,}])+))|(?:[a-z0-9_-]|%2d)+/gi,
      (_match, key, separator, encodedSeparator, encodedValue?: string) => {
        if (key === undefined) return _match;
        const jwtOnly = encodedValue?.replace(JWT_PATTERN, "[JWT_REDACTED]") === "[JWT_REDACTED]";
        return key + (separator ?? encodedSeparator) + (jwtOnly ? "[JWT_REDACTED]" : "[REDACTED]");
      },
    )
    .replace(JWT_PATTERN, "[JWT_REDACTED]");
  if (!truncated) return redacted;

  // A JWT split by the cap may be missing the segments required by the normal matcher.
  return redacted.replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "…[truncated]";
}

function redactThirdFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  let end = MAX_ERROR_TEXT_LENGTH;
  const lastKept = value.charCodeAt(end - 1);
  if (truncated && lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;

  const redacted = value.slice(0, end)
    .replace(/Bearer(?:\s+|%20|:\s*)[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/gi, "Basic [REDACTED]")
    // Consume other key-shaped runs whole so the lookahead never restarts at each hyphen.
    .replace(
      /((?:%26|%20|\b|(?=-|%2d))(?=(?:[a-z0-9_-]|%2d)*(?:api(?:[_-]|%2d)?key|token|authorization|password|secret|jwt))(?:[a-z0-9_-]|%2d)+["']?)(?:(\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|((?:\s|%20)*%(?:25)?3[ad](?:\s|%20)*)(%22(?:(?!%26|&|%22(?=%26|[&\s,}]|$))[\s\S])*(?:%22(?=%26|[&\s,}]|$)|(?=%26|&|$))|(?:(?!%26|%20(?=[a-z0-9_-]+\s*(?:%3[ad]|[:=])))[^\s&,}])+))|(?:[a-z0-9_-]|%2d)+/gi,
      (_match, key, separator, encodedSeparator, encodedValue?: string) => {
        if (key === undefined) return _match;
        const jwtOnly = encodedValue?.replace(JWT_PATTERN, "[JWT_REDACTED]") === "[JWT_REDACTED]";
        return key + (separator ?? encodedSeparator) + (jwtOnly ? "[JWT_REDACTED]" : "[REDACTED]");
      },
    )
    .replace(JWT_PATTERN, "[JWT_REDACTED]");
  if (!truncated) return redacted;

  // A JWT split by the cap may be missing the segments required by the normal matcher.
  return redacted.replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "…[truncated]";
}

test.each([
  ["Authorization: Basic YWJjOmRlZg==", ["YWJjOmRlZg=="]],
  ["proxy-authorization: Basic YWJjOmRlZg==", ["YWJjOmRlZg=="]],
  ['curl -H "Authorization: Basic YWJjOmRlZg=="', ["YWJjOmRlZg=="]],
  ["token=x/Basic YWJjOmRlZg==", ["YWJjOmRlZg=="]],
  ["authorization: Bearer: X==", ["X=="]],
  ["access_token%20%3D%20Bearer: X==", ["X=="]],
  ["token%3Dabc%20QW42329KZ449 = fixtureTail", ["QW42329KZ449"]],
  ["token=fixtureFirst%26api-key\t=\tfixtureNext", ["fixtureFirst", "fixtureNext"]],
  ["token=fixtureFirst%26password\t=\tfixtureNext", ["fixtureFirst", "fixtureNext"]],
])("redacts overlapping values in %s", (input, secrets) => {
  const result = redactOutboxErrorText(input);
  expect(result).toContain("[REDACTED]");
  for (const secret of secrets) expect(result).not.toContain(secret);
});

const KEY_CHAR = String.raw`(?:[a-z0-9_-]|%2d)`;
const SENSITIVE_KEY = String.raw`(?=${KEY_CHAR}*(?:api(?:[_-]|%2d)?key|token|authorization|password|secret|jwt))${KEY_CHAR}+["']?`;
const ENCODED_SEPARATOR = String.raw`(?:\s|%20)*%(?:25)?3[ad](?:\s|%20)*`;
const NEXT_SENSITIVE_KEY = String.raw`${SENSITIVE_KEY}(?:\s*[:=]|${ENCODED_SEPARATOR})`;
const KEY_BOUNDARY = String.raw`(?:%26|%20|\b|(?=-|%2d))`;
// Skip markers and consume other key-shaped runs whole to avoid restarting at each hyphen.
const MARKER_OR_KEY_RUN = String.raw`\[(?:JWT_)?REDACTED\]|${KEY_CHAR}+`;
const PLAIN_CREDENTIAL = new RegExp(
  String.raw`(${KEY_BOUNDARY}${SENSITIVE_KEY}\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|${MARKER_OR_KEY_RUN}`, "gi",
);
const ENCODED_QUOTED_VALUE = String.raw`%22(?:(?!%26|&|%22(?=%26|[&\s,}]|$))[\s\S])*(?:%22(?=%26|[&\s,}]|$)|(?=%26|&|$))`;
const ENCODED_UNQUOTED_VALUE = String.raw`(?:(?!%26|%20(?=${NEXT_SENSITIVE_KEY}))[^\s&,}])+`;
const ENCODED_CREDENTIAL = new RegExp(
  String.raw`(${KEY_BOUNDARY}${SENSITIVE_KEY}${ENCODED_SEPARATOR})(${ENCODED_QUOTED_VALUE}|${ENCODED_UNQUOTED_VALUE})|${MARKER_OR_KEY_RUN}`, "gi",
);
const EXTRA_BEARER = new RegExp(
  String.raw`Bearer(?:%20|:\s*)(?!${NEXT_SENSITIVE_KEY})(?:(?!%26|%20)[A-Za-z0-9._~+/=-])+`, "gi",
);

type RedactionText = { text: string; offsets: number[] };

function redactMatches(
  { text, offsets }: RedactionText,
  pattern: RegExp,
  marker: string,
  credential = false,
): RedactionText {
  let cursor = 0;
  let result = "";
  const remaining: number[] = [];
  for (const match of text.matchAll(pattern)) {
    if (credential && match[1] === undefined) continue;
    const prefix = credential ? match[1] : "";
    const replacement = match[2] === "[JWT_REDACTED]" ? match[2] : marker;
    result += text.slice(cursor, match.index) + prefix + replacement;
    remaining.push(...offsets.slice(cursor, match.index));
    for (let index = 0; index < prefix.length + replacement.length; index += 1) remaining.push(-1);
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return { text, offsets };
  remaining.push(...offsets.slice(cursor));
  return { text: result + text.slice(cursor), offsets: remaining };
}

// Record first-follow-up value spans before another pass can hide their opening delimiter.
const FIRST_FOLLOWUP_CREDENTIAL = /((?:%26|\b|(?=-))(?=[a-z0-9_-]*(?:api[_-]?key|token|authorization|password|secret|jwt))[a-z0-9_-]+["']?\s*)(?:([:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|(%3[ad]\s*)(?:(?!%26)[^\s&,}])+)|[a-z0-9_-]+/gi;

function redactFourthFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  let end = MAX_ERROR_TEXT_LENGTH;
  const lastKept = value.charCodeAt(end - 1);
  if (truncated && lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;

  const text = value.slice(0, end)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  const covered = new Uint8Array(text.length);
  for (const match of text.matchAll(FIRST_FOLLOWUP_CREDENTIAL)) {
    if (match[1] === undefined) continue;
    const prefixLength = match[1].length + (match[2] ?? match[3]).length;
    covered.fill(1, match.index + prefixLength, match.index + match[0].length);
  }

  // Apply B22's original credential and JWT replacements before extending coverage.
  let redacted = redactMatches(
    { text, offsets: Array.from({ length: text.length }, (_, index) => index) },
    /(\b(?=[a-z0-9_]*(?:api_?key|token|authorization|password|secret|jwt))[a-z0-9_]+["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)/gi, "[REDACTED]", true,
  );
  redacted = redactMatches(redacted, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");
  redacted = redactMatches(redacted, ENCODED_CREDENTIAL, "[REDACTED]", true);
  redacted = redactMatches(redacted, PLAIN_CREDENTIAL, "[REDACTED]", true);
  redacted = redactMatches(redacted, EXTRA_BEARER, "Bearer [REDACTED]");

  // Keep the recognized field prefixes and mask historical value characters still present.
  let output = "";
  let inCoveredRun = false;
  for (let index = 0; index < redacted.text.length; index += 1) {
    const isCovered = covered[redacted.offsets[index]] === 1;
    if (!isCovered) output += redacted.text[index];
    else if (!inCoveredRun) output += "[REDACTED]";
    inCoveredRun = isCovered;
  }

  output = output.replace(/Basic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi, (match, credential: string) =>
    /[0-9+/=]/.test(credential) || (/[A-Z]/.test(credential) && /[a-z]/.test(credential))
      ? "Basic [REDACTED]"
      : match,
  );
  if (!truncated) return output;

  return output
    .replace(/Basic\s+\S+$/i, "Basic [REDACTED]")
    // A JWT split by the cap may be missing the segments required by the normal matcher.
    .replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "\u2026[truncated]";
}

test.each([
  ['token=""SECRET1', "SECRET1"],
  ['token: ""SECRET1', "SECRET1"],
  ["token=''SECRET1", "SECRET1"],
  ['"access_token": ""SECRET1"', "SECRET1"],
  ['token="prefix"SECRET1&state=ok', "SECRET1"],
  ["Bearer:\tX+Bearer Y", "Y"],
  ["Bearer%20X/Bearer Y", "Y"],
  ["Authorization: BASIC X/Basic Y", "Y"],
  ["Bearer abc/Bearer S", "S"],
  ["Authorization: Basic QUFBQUFB", "QUFBQUFB"],
  ["proxy-authorization: basic QUFBQUFBQUFB", "QUFBQUFBQUFB"],
  ['"authorization": "Basic QUFBQUFB"', "QUFBQUFB"],
  ["%22proxy-authorization%22%3A%22Basic%20QUFBQUFB%22", "QUFBQUFB"],
  ["%7B%22access_token%22%3A%22S%22%7D", "%22S%22"],
  ["%22token%22=fixtureSecret", "fixtureSecret"],
  ["%22token%22%3AfixtureSecret", "fixtureSecret"],
])("redacts quote and authorization variants in %s", (input, secret) => {
  const result = redactOutboxErrorText(input);
  expect(result).toContain("[REDACTED]");
  expect(result).not.toContain(secret);
});

test.each([
  ["Basic YWJjOmRlZg==.", ["YWJjOmRlZg=="]],
  ["Basic YWJjOmRlZg==-", ["YWJjOmRlZg=="]],
  ["Basic QUFBQUFB1_x", ["QUFBQUFB1"]],
  ["Basic QUFBQUFB1~x", ["QUFBQUFB1"]],
  ["Basic YWJjOmRlZg===", ["YWJjOmRlZg=="]],
  ["Basic QUFBQUFB1.Basic SECRET1", ["QUFBQUFB1", "SECRET1"]],
  ["password: basic QFJBVZQ968QX98_x", ["QFJBVZQ968QX98"]],
  ["token%3Dabc%7D%22password%22%22%3A%22SECRET1", ["abc", "SECRET1"]],
  ['token%3Dabc%7D"password"":"SECRET1"', ["abc", "SECRET1"]],
  ["token%3Dabc%7D'password'%22%3ASECRET1", ["abc", "SECRET1"]],
])("redacts credential prefixes and doubled quotes in %s", (input, secrets) => {
  const result = redactOutboxErrorText(input);
  expect(result).toContain("[REDACTED]");
  for (const secret of secrets) expect(result).not.toContain(secret);
});

test("redacts %26 inside a closed encoded quote and preserves the next parameter", () => {
  expect(redactOutboxErrorText("token%3D%22X%26Y%22%26state%3Dok"))
    .toBe("token%3D[REDACTED]%26state%3Dok");
});

function checkHistoricalCoverage(seed: number, count: number) {
  function pick<T>(values: readonly T[]) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return values[(seed >>> 0) % values.length];
  }

  const keys = ["token", "password", "prefixJwtSuffix", "x-api-key", "api%2Dkey", '"client_secret"', "Authorization", "proxy-authorization", "jwt"];
  const separators = ["=", ": ", " = ", "\t=\t", "%3D", "%3a", "%253D", "%20%3D%20"];
  const quotes = ['"', "'", "%22", ""];
  const joins = ["&", "%26", "%26%26", "%20", "\t", " ", '", "'];
  const chains = ["/", "+", "."];
  const fixtures = ["fixtureAlpha1", "fixtureBeta2", "fixtureGamma3", "fixtureDelta4"];
  const frozen = [redactB22, redactFirstFollowup, redactSecondFollowup, redactThirdFollowup, redactFourthFollowup];
  let checkedSecrets = 0;
  let leaks = 0;
  let firstLeak: { input: string; marker: string; actual: string } | undefined;
  for (let index = 0; index < count; index += 1) {
    const field = (fixture: string) => {
      const quote = pick(quotes);
      const scheme = pick(["", "", "", "Basic ", "Bearer ", "Bearer:", "Bearer%20"]);
      const value = pick(["", quote + quote, quote]) + scheme + fixture + pick([quote, ""]);
      return pick(keys) + pick(separators) + value;
    };
    const first = field(fixtures[0]);
    const next = field(fixtures[1]);
    const scheme = pick(["Basic ", "Bearer ", "Bearer%20", "Bearer:"]) + fixtures[2];
    const jwt = "eyJ" + fixtures[3] + ".fixture.signature";
    const standard = pick(["", "next=%2Fcb%3F", "{", "prefix-", 'curl -H "']) + first
      + pick(joins) + next + pick(joins) + pick([scheme, jwt, scheme + pick(joins) + jwt]);
    const chained = pick(["Bearer ", "Bearer:\t", "Bearer%20", "Authorization: Basic "])
      + fixtures[0] + pick(chains) + scheme;
    const singleCase = "QUFBQUFB";
    const authorization = pick(["Authorization: Basic ", "proxy-authorization:\tbasic ", "%22authorization%22%3A%22Basic%20"])
      + singleCase + pick(["", "%22"]);
    const encodedJson = "%7B%22access_token%22%3A%22" + fixtures[1] + "%22%7D";
    const basicEnded = "Basic " + fixtures[0] + pick([".", "-", "_", "~", "==="]);
    const basicChain = "Basic " + fixtures[0] + ".Basic " + fixtures[1];
    const doubledKey = pick(['%22password%22%22', '"password""', "'password'%22"]);
    const doubledValue = "token%3Dabc%7D" + doubledKey + pick([":", "%3A", "="]) + fixtures[1];
    const encodedQuote = "token%3D%22" + fixtures[0] + "%26" + fixtures[1] + "%22%26state%3Dok";
    const input = pick([
      standard, standard, standard, chained + pick(joins) + next, authorization + " " + encodedJson,
      basicEnded, basicChain, doubledValue, encodedQuote,
    ]);
    const oldResults = frozen.map((redact) => redact(input));
    const actual = redactOutboxErrorText(input);
    for (const fixture of [...fixtures, singleCase]) {
      if (!input.includes(fixture) || oldResults.every((result) => result.includes(fixture))) continue;
      checkedSecrets += 1;
      if (!actual.includes(fixture)) continue;
      leaks += 1;
      firstLeak ??= { input, marker: fixture, actual };
    }
  }
  return { checkedSecrets, leaks, firstLeak };
}

test("retains historical secret coverage across 4,000 seeded inputs", () => {
  const { checkedSecrets, leaks, firstLeak } = checkHistoricalCoverage(0x7b3a54c1, 4000);
  expect(checkedSecrets).toBeGreaterThan(4000);
  expect({ leaks, firstLeak }).toEqual({ leaks: 0, firstLeak: undefined });
}, 10000);
