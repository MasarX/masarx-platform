import { redactOutboxErrorText } from "@masarx/mobile-core";

const base64PairA = Buffer.from(["abc", "def"].join(":")).toString("base64");
const base64PairB = Buffer.from(["user", "pass"].join(":")).toString("base64");
const basicFixture = Buffer.from("fixture").toString("base64");
const basicUpperLong = Buffer.from("A".repeat(9)).toString("base64");
const basicUpper = Buffer.from("A".repeat(6)).toString("base64");
const basicUpperWithDigit = basicUpper + "1";
const basicWithSuffix = ["QFJBVZQ", "968QX98"].join("");
const overlapFixture = ["QW423", "29KZ", "449"].join("");
const mixedCaseFixture = ["fixture", "Secret"].join("");
const firstFragment = ["fixture", "First"].join("");
const nextFragment = ["fixture", "Next"].join("");
const fixtureTail = ["fixture", "Tail"].join("");
const uppercaseWithDigit = ["SE", "CRET", "1"].join("");
const uppercaseFixture = ["SE", "CRET"].join("");
const shortFixture = ["ab", "c"].join("");
const fixtureWord = ["fixt", "ure"].join("");
const capFragment = ["visi", "ble"].join("");
const visibleTail = [capFragment, fixtureWord, "tail"].join("-");
const fixtureA = ["hk", "1"].join("");
const fixtureB = ["hk", "2"].join("");
const jwtFixture = ["eyJ" + fixtureWord, "payload", "signature"].join(".");
const jwtCapPrefix = jwtFixture.slice(0, 14);
const basicCapPrefix = "Basic " + base64PairB.slice(0, 3);
const paddedFragment = ["X", "=".repeat(2)].join("");
const [upperX, upperY, upperS, lowerX, lowerV] = "XYSxv";
const alphaMarker = fixtureWord + "Alpha" + 1;
const betaMarker = fixtureWord + "Beta" + 2;
const gammaMarker = fixtureWord + "Gamma" + 3;
const deltaMarker = fixtureWord + "Delta" + 4;

test("constructed credential fixtures preserve their original bytes", () => {
  const fixtures = [
    base64PairA, base64PairB, basicFixture, basicUpperLong, basicUpper,
    basicUpperWithDigit, basicWithSuffix, overlapFixture, mixedCaseFixture, firstFragment,
    nextFragment, fixtureTail, uppercaseWithDigit, uppercaseFixture, shortFixture, fixtureWord,
    capFragment, visibleTail, fixtureA, fixtureB, jwtFixture, jwtCapPrefix,
    basicCapPrefix, paddedFragment, alphaMarker, betaMarker, gammaMarker, deltaMarker,
  ];
  // FNV-1a over the original, ordered fixture bytes.
  let checksum = 0x811c9dc5;
  for (const byte of Buffer.from(JSON.stringify(fixtures))) {
    checksum = Math.imul(checksum ^ byte, 0x01000193);
  }
  expect(checksum >>> 0).toBe(0xcaa06ffc);
});

test.each([
  ["x-api-key=" + fixtureA, "x-api-key=[REDACTED]"],
  ["X-Api-Key: " + fixtureB, "X-Api-Key: [REDACTED]"],
  ["api-key: " + lowerV, "api-key: [REDACTED]"],
  ["refresh_token%3D" + shortFixture, "refresh_token%3D[REDACTED]"],
  ["access_token%3D" + shortFixture + "%26x", "access_token%3D[REDACTED]%26x"],
  ["refresh_token%3A" + shortFixture, "refresh_token%3A[REDACTED]"],
  ["access_token%3A" + shortFixture + "%26x", "access_token%3A[REDACTED]%26x"],
  ["ReFrEsH_ToKeN%3d" + shortFixture, "ReFrEsH_ToKeN%3d[REDACTED]"],
  ["AcCeSs_ToKeN%3a" + shortFixture, "AcCeSs_ToKeN%3a[REDACTED]"],
  ["access_token%3D" + shortFixture + "%26state%3Dok", "access_token%3D[REDACTED]%26state%3Dok"],
  ["access_token%3D" + shortFixture + "&state=ok", "access_token%3D[REDACTED]&state=ok"],
  ["access_token=" + shortFixture + "&state=ok", "access_token=[REDACTED]&state=ok"],
  ["state%3Dok%26api-key%3D" + shortFixture, "state%3Dok%26api-key%3D[REDACTED]"],
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
  const prefix = " ".repeat(8192 - ("api-key=" + capFragment).length);
  expect(redactOutboxErrorText(prefix + "api-key=" + visibleTail))
    .toBe(prefix + "api-key=[REDACTED]…[truncated]");
});

test("redacts a JWT whose second segment spans the cap", () => {
  const prefix = " ".repeat(8192 - jwtCapPrefix.length);
  expect(redactOutboxErrorText(prefix + jwtFixture))
    .toBe(prefix + "[JWT_REDACTED]…[truncated]");
});

test.each([
  ["token%253D" + fixtureWord, "token%253D[REDACTED]"],
  ["x-api-key%20%3D%20" + lowerV, "x-api-key%20%3D%20[REDACTED]"],
  ["api%2Dkey%3D" + fixtureWord, "api%2Dkey%3D[REDACTED]"],
  ["Bearer%20" + fixtureWord, "Bearer [REDACTED]"],
  ["bearer:" + fixtureWord, "Bearer [REDACTED]"],
  ["Basic " + basicFixture, "Basic [REDACTED]"],
  ["token%3D%22a b%22%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["-token=" + fixtureWord, "-token=[REDACTED]"],
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
  ["password%3D%22a b token=%22" + uppercaseFixture, "password%3D[REDACTED]"],
  ["token%3D%22" + shortFixture + "%26jwt%3D%22" + uppercaseFixture + "%22%26state%3Dok", "token%3D[REDACTED]%26jwt%3D[REDACTED]%26state%3Dok"],
  ["token%3D%22%22" + uppercaseFixture, "token%3D[REDACTED]"],
  ["token%3D%22" + lowerX + "%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["token%3D%22a b%22%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["token%3D" + shortFixture + "%20password = " + uppercaseFixture, "token%3D[REDACTED]%20password = [REDACTED]"],
  ["token%3D" + shortFixture + "%20password: " + uppercaseFixture, "token%3D[REDACTED]%20password: [REDACTED]"],
  ["token%3Da%20b", "token%3D[REDACTED]"],
  ["Basic validation failed", "Basic validation failed"],
  ["Basic auth required", "Basic auth required"],
  ["Basic plan expired", "Basic plan expired"],
  ["x-request-id%3D1", "x-request-id%3D1"],
])("keeps credential boundaries in %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test.each([
  ["authorization%3DBasic%20" + base64PairA, "authorization%3D[REDACTED]"],
  ["token%3D" + shortFixture + "%20def=ghi", "token%3D[REDACTED]"],
  ["password%3Dp%20q%3Dr", "password%3D[REDACTED]"],
  ["Basic " + base64PairB, "Basic [REDACTED]"],
  ["Bearer%20token: " + upperX, "Bearer%20token: [REDACTED]"],
  ["Bearer%20client_secret%3A" + shortFixture, "Bearer%20client_secret%3A[REDACTED]"],
  ["token%3Djwt: " + upperX, "token%3D[REDACTED] [REDACTED]"],
  ["token%3Dx{\"password\": \"" + uppercaseFixture + "\"}", "token%3D[REDACTED] [REDACTED]}"],
])("redacts compound credential input %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test("redacts a short Basic credential fragment at the cap", () => {
  const prefix = " ".repeat(8192 - basicCapPrefix.length);
  expect(redactOutboxErrorText(prefix + "Basic " + base64PairB))
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
  ["Authorization: Basic " + base64PairA, [base64PairA]],
  ["proxy-authorization: Basic " + base64PairA, [base64PairA]],
  ["curl -H \"Authorization: Basic " + base64PairA + "\"", [base64PairA]],
  ["token=" + lowerX + "/Basic " + base64PairA, [base64PairA]],
  ["authorization: Bearer: " + paddedFragment, [paddedFragment]],
  ["access_token%20%3D%20Bearer: " + paddedFragment, [paddedFragment]],
  ["token%3D" + shortFixture + "%20" + overlapFixture + " = " + fixtureTail, [overlapFixture]],
  ["token=" + firstFragment + "%26api-key\t=\t" + nextFragment, [firstFragment, nextFragment]],
  ["token=" + firstFragment + "%26password\t=\t" + nextFragment, [firstFragment, nextFragment]],
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
  ["token=\"\"" + uppercaseWithDigit, uppercaseWithDigit],
  ["token: \"\"" + uppercaseWithDigit, uppercaseWithDigit],
  ["token=''" + uppercaseWithDigit, uppercaseWithDigit],
  ["\"access_token\": \"\"" + uppercaseWithDigit + "\"", uppercaseWithDigit],
  ["token=\"prefix\"" + uppercaseWithDigit + "&state=ok", uppercaseWithDigit],
  ["Bearer:\t" + upperX + "+Bearer " + upperY, upperY],
  ["Bearer%20" + upperX + "/Bearer " + upperY, upperY],
  ["Authorization: BASIC " + upperX + "/Basic " + upperY, upperY],
  ["Bearer " + shortFixture + "/Bearer " + upperS, upperS],
  ["Authorization: Basic " + basicUpper, basicUpper],
  ["proxy-authorization: basic " + basicUpperLong, basicUpperLong],
  ["\"authorization\": \"Basic " + basicUpper + "\"", basicUpper],
  ["%22proxy-authorization%22%3A%22Basic%20" + basicUpper + "%22", basicUpper],
  ["%7B%22access_token%22%3A%22" + upperS + "%22%7D", "%22" + upperS + "%22"],
  ["%22token%22=" + mixedCaseFixture, mixedCaseFixture],
  ["%22token%22%3A" + mixedCaseFixture, mixedCaseFixture],
])("redacts quote and authorization variants in %s", (input, secret) => {
  const result = redactOutboxErrorText(input);
  expect(result).toContain("[REDACTED]");
  expect(result).not.toContain(secret);
});

test.each([
  ["Basic " + base64PairA + ".", [base64PairA]],
  ["Basic " + base64PairA + "-", [base64PairA]],
  ["Basic " + basicUpperWithDigit + "_x", [basicUpperWithDigit]],
  ["Basic " + basicUpperWithDigit + "~x", [basicUpperWithDigit]],
  ["Basic " + base64PairA + "=", [base64PairA]],
  ["Basic " + basicUpperWithDigit + ".Basic " + uppercaseWithDigit, [basicUpperWithDigit, uppercaseWithDigit]],
  ["password: basic " + basicWithSuffix + "_x", [basicWithSuffix]],
  ["token%3D" + shortFixture + "%7D%22password%22%22%3A%22" + uppercaseWithDigit, [shortFixture, uppercaseWithDigit]],
  ["token%3D" + shortFixture + "%7D\"password\"\":\"" + uppercaseWithDigit + "\"", [shortFixture, uppercaseWithDigit]],
  ["token%3D" + shortFixture + "%7D'password'%22%3A" + uppercaseWithDigit, [shortFixture, uppercaseWithDigit]],
])("redacts credential prefixes and doubled quotes in %s", (input, secrets) => {
  const result = redactOutboxErrorText(input);
  expect(result).toContain("[REDACTED]");
  for (const secret of secrets) expect(result).not.toContain(secret);
});

test("redacts %26 inside a closed encoded quote and preserves the next parameter", () => {
  expect(redactOutboxErrorText("token%3D%22" + upperX + "%26" + upperY + "%22%26state%3Dok"))
    .toBe("token%3D[REDACTED]%26state%3Dok");
});

test.each([
  "token%3D" + shortFixture + "%7D%22password%22%22%22%3A" + uppercaseWithDigit,
  "token%3D" + shortFixture + "%7D\"password\"\"\":\"" + uppercaseWithDigit + "\"",
  "token%3D" + shortFixture + "%7D'password''\":\"" + uppercaseWithDigit + "\"",
  "token%3D" + shortFixture + "%7D\"password\"\"%22%3A%22" + uppercaseWithDigit,
])("redacts the value after three closing quotes in %s", (input) => {
  const output = redactOutboxErrorText(input);
  expect(output).not.toContain(uppercaseWithDigit);
  expect(output.match(/\[REDACTED\]/g)).toHaveLength(2);
});

test.each(["%2C", "%2c", "%5D", "%7D", ")", "/", '"'])(
  "closes an encoded quoted value before %s",
  (delimiter) => {
    const suffix = delimiter + "%22b%22%3A1%7D";
    expect(redactOutboxErrorText("%7B%22password%22%3A%22" + upperX + "%26" + upperY + "%22" + suffix))
      .toBe("%7B%22password%22%3A[REDACTED]" + suffix);
  },
);

test("redacts an encoded quoted value whose closing quote crosses the cap", () => {
  const input = "token%3D%22" + upperS + "%26" + upperS + "%22";
  for (const kept of [15, 16, 17]) {
    const prefix = " ".repeat(8192 - kept);
    expect(redactOutboxErrorText(prefix + input)).toBe(prefix + "token%3D[REDACTED]\u2026[truncated]");
  }
});

function escapeJsonPayload(text: string) {
  return JSON.stringify(text).slice(1, -1);
}

const escapedJsonForms = [
  ["escaped JSON", escapeJsonPayload],
  ["URL-encoded escaped JSON", (text: string) => encodeURIComponent(escapeJsonPayload(text))],
  ["double URL-encoded escaped JSON", (text: string) => encodeURIComponent(encodeURIComponent(escapeJsonPayload(text)))],
  ["twice-escaped JSON", (text: string) => escapeJsonPayload(escapeJsonPayload(text))],
  ["escaped JSON with encoded backslashes", (text: string) => escapeJsonPayload(text).replace(/\\/g, "%5c")],
  ["escaped JSON with encoded quotes", (text: string) => escapeJsonPayload(text).replace(/"/g, "%22")],
] as const;

test.each(escapedJsonForms)("redacts a complete credential value in %s", (_label, transform) => {
  const key = "password";
  const credential = [alphaMarker, '"', ", & ", betaMarker, "%5C%22, ", gammaMarker, "\\"].join("");
  const json = JSON.stringify({ [key]: credential, status: 503 });
  const prefix = transform(`{${JSON.stringify(key)}:`);
  const suffix = transform(',"status":503}');

  expect(redactOutboxErrorText(transform(json))).toBe(prefix + "[REDACTED]" + suffix);
});

test.each([true, false])("redacts mixed quoting with an escaped key set to %s", (escapeKey) => {
  const key = JSON.stringify("access_token");
  const credential = [firstFragment, nextFragment].join(" & ");
  const rawValue = JSON.stringify(credential);
  const prefix = `{${escapeKey ? escapeJsonPayload(key) : key}:`;
  const value = escapeKey ? rawValue : escapeJsonPayload(rawValue);
  const suffix = ',"status":503}';

  expect(redactOutboxErrorText(prefix + value + suffix)).toBe(prefix + "[REDACTED]" + suffix);
});

test("redacts credentials nested in serialized error messages", () => {
  const error = { message: JSON.stringify({ password: alphaMarker, token: betaMarker, status: 503 }) };
  const expected = `{"message":"${escapeJsonPayload('{"password":')}[REDACTED]`
    + `${escapeJsonPayload(',"token":')}[REDACTED]${escapeJsonPayload(',"status":503}')}"}`;

  expect(redactOutboxErrorText(JSON.stringify(error))).toBe(expected);
});

const structuredJsonForms = [
  ["plain JSON", (text: string) => text],
  ...escapedJsonForms,
  ["Unicode quote escapes", (text: string) => text.replace(/"/g, () => String.raw`\u0022`)],
] as const;

test.each([
  ["lowercase", "cookie: ", "theme=dark; sid=" + alphaMarker, ""],
  ["three pairs", "Cookie: ", "a=1; b=2; sid=" + alphaMarker, ""],
  ["before CRLF", "Cookie: ", "a=1; b=2; sid=" + alphaMarker, "\r\nstatus: 503"],
  ["Set-Cookie attributes", "Set-Cookie: ", "theme=dark; Path=/, sid=" + alphaMarker + "; Path=/", ""],
  ["single-quoted argument", "curl -H 'Cookie: ", "a=1; sid=" + alphaMarker, "' --verbose"],
  ["quoted pair", "Cookie: ", 'a="one"; sid=' + alphaMarker, ""],
  ["literal encoded newline", "Cookie: ", "a=%0A; sid=" + alphaMarker, ""],
  ["before an encoded newline", "cOoKiE%3A%20", "a%3D1%3B%20sid%3D" + alphaMarker, "%0Astatus%3A503"],
  ["encoded literal percent", "Cookie%3A%20", encodeURIComponent("a=%0A; sid=" + alphaMarker), "%0Astatus%3A503"],
])("redacts the entire cookie header in %s", (_label, prefix, value, suffix) => {
  expect(redactOutboxErrorText(prefix + value + suffix)).toBe(prefix + "[REDACTED]" + suffix);
});

test.each(structuredJsonForms)("redacts cookie headers within %s", (_label, transform) => {
  const prefix = transform('{"error":"Cookie: ');
  const suffix = transform('","status":503}');
  expect(redactOutboxErrorText(prefix + transform("a=1; sid=" + alphaMarker) + suffix))
    .toBe(prefix + "[REDACTED]" + suffix);

  const request = transform('{"error":"request Cookie: ');
  expect(redactOutboxErrorText(request + transform("theme=dark; connect.sid=" + alphaMarker) + suffix))
    .toBe(request + "[REDACTED]" + suffix);

  const pairs = escapeJsonPayload('theme="dark"; connect.sid=' + alphaMarker + "; token=" + betaMarker);
  expect(redactOutboxErrorText(request + transform(pairs) + suffix))
    .toBe(request + "[REDACTED]" + suffix);

  const nextLine = transform('\\nrequest complete","status":503}');
  expect(redactOutboxErrorText(prefix + transform("a=1; sid=" + alphaMarker) + nextLine))
    .toBe(prefix + "[REDACTED]" + nextLine);

  const field = transform('{"Set-Cookie":');
  const cookie = JSON.stringify("theme=dark; Path=/, sid=" + alphaMarker + "; Path=/");
  const fieldSuffix = transform(',"status":503}');
  expect(redactOutboxErrorText(field + transform(cookie) + fieldSuffix)).toBe(field + "[REDACTED]" + fieldSuffix);

  const bareField = transform('"Cookie": ');
  expect(redactOutboxErrorText(bareField + transform("a=1; sid=" + alphaMarker)))
    .toBe(bareField + "[REDACTED]");
});

test.each([
  ["once", encodeURIComponent],
  ["twice", (text: string) => encodeURIComponent(encodeURIComponent(text))],
] as const)("redacts a JSON cookie field URL-encoded %s", (_label, transform) => {
  const prefix = transform('{"Cookie":');
  const value = transform(JSON.stringify("a=1; sid=" + alphaMarker));
  const suffix = transform(',"status":503}');
  expect(redactOutboxErrorText(prefix + value + suffix)).toBe(prefix + "[REDACTED]" + suffix);
});

test.each(structuredJsonForms)("redacts plural and spaced credential keys in %s", (_label, transform) => {
  for (const [key, value] of [
    ["credentials", alphaMarker], ["clientCredential", alphaMarker], ["cookies", "sid=" + alphaMarker],
    ["session id", alphaMarker], ["session_ids", alphaMarker], ["session ids", alphaMarker],
  ]) {
    const prefix = transform(`{${JSON.stringify(key)}:`);
    const suffix = transform(',"status":503}');
    const input = transform(JSON.stringify({ [key]: value, status: 503 }));
    expect(redactOutboxErrorText(input)).toBe(prefix + "[REDACTED]" + suffix);
  }
});

test.each(structuredJsonForms)("redacts bare values and entire collections in %s", (_label, transform) => {
  const cases = [
    ["pin_token", String(Number([123, 456, 789].join("")))],
    ["pin_token", JSON.stringify(true)],
    ["pin_token", JSON.stringify(false)],
    ["pin_token", JSON.stringify(null)],
    ["pin_token", alphaMarker],
    ["secret", JSON.stringify({ value: alphaMarker })],
    ["api_key", JSON.stringify(["x", alphaMarker])],
    ["password", JSON.stringify(["x y", alphaMarker + " z"])],
    ["password", JSON.stringify([{ details: [alphaMarker + '" ], } & \\', false, { x: 1 }] }])],
  ];
  for (const [key, value] of cases) {
    const prefix = transform(`{${JSON.stringify(key)}:`);
    const suffix = transform(',"status":503}');
    expect(redactOutboxErrorText(prefix + transform(value) + suffix)).toBe(prefix + "[REDACTED]" + suffix);
  }
});

test("redacts an unterminated or mismatched collection through the end", () => {
  const prefix = escapeJsonPayload('{"secret":');
  for (const suffix of ["", "]"]) {
    const value = escapeJsonPayload(`{"value":${JSON.stringify(alphaMarker)}${suffix}`);
    expect(redactOutboxErrorText(prefix + value)).toBe(prefix + "[REDACTED]");
  }
});

test.each([true, false])("redacts a mixed-quoting collection with an escaped key set to %s", (escapeKey) => {
  const key = JSON.stringify("private_key");
  const value = JSON.stringify({ value: ["] } & " + alphaMarker, { content: betaMarker + '" \\' }] });
  const prefix = `{${escapeKey ? escapeJsonPayload(key) : key}:`;
  const suffix = ',"status":503}';
  expect(redactOutboxErrorText(prefix + (escapeKey ? value : escapeJsonPayload(value)) + suffix))
    .toBe(prefix + "[REDACTED]" + suffix);
});

test.each([
  ["token: ", shortFixture, "; retry=3 status=503"],
  ["secret=", lowerX, " keepme"],
])("preserves diagnostics after the escaped quote in %s", (prefix, value, suffix) => {
  const input = prefix + escapeJsonPayload(JSON.stringify(value)) + suffix;
  expect(redactOutboxErrorText(input)).toBe(prefix + "[REDACTED]" + suffix);
});

test.each(structuredJsonForms)("redacts additional sensitive keys in %s", (_label, transform) => {
  for (const key of [
    "passwd", "PWD", "Cookie", "Set-Cookie", "credential", "SESSION_ID", "private_key", "api key",
    "x-auth-cookie", "session-id", "PRIVATE-KEY", "API KEY",
  ]) {
    const prefix = transform(`{${JSON.stringify(key)}:`);
    const suffix = transform(',"status":503}');
    expect(redactOutboxErrorText(prefix + transform(JSON.stringify(alphaMarker)) + suffix))
      .toBe(prefix + "[REDACTED]" + suffix);
  }
});

const cookieHeaderKeys = [
  "Cookie", "cookies", "Set-Cookie", "HTTP_COOKIE", "x-cookie", "request_cookie", "cookie-header", "upstream-set-cookie",
];
const boundaryForms = [...structuredJsonForms, ["URL-encoded JSON", encodeURIComponent] as const];

test.each(boundaryForms)(
  "redacts keys after escape boundaries in %s",
  (_label, transform) => {
    const keys = [
      "apiKey", "api_key", "api-key", "api key", "token", "authorization", "password", "secret", "jwt",
      "passwd", "pwd", "session_id", "sessionId", "session_ids", "session id", "session ids",
      "private_key", "privateKey", "credential", "credentials", ...cookieHeaderKeys,
    ];
    const escapes = ["\n", "\t", "\r", "\f", "\b", "\\n", "\\u00a0", "\\u0009", "%0A", "%0D", "%09", "%250A"];
    for (const key of keys) {
      const cookie = cookieHeaderKeys.includes(key);
      const value = cookie ? "a=1; sid=" + alphaMarker : alphaMarker;
      const separator = cookie && key !== "HTTP_COOKIE" ? ": " : "=";
      for (const escape of escapes) {
        const log = "line1" + escape + key + separator;
        const json = '{"log":"' + escapeJsonPayload(log);
        for (const [before, after] of [
          [log, "\nkeep line"], [json, String.raw`\nkeep line","status":503}`], [json, '","status":503}'],
        ] as const) {
          const prefix = transform(before);
          const suffix = transform(after);
          expect(redactOutboxErrorText(prefix + transform(value) + suffix)).toBe(prefix + "[REDACTED]" + suffix);
        }
      }
    }
  },
);

test.each(cookieHeaderKeys)("redacts every pair in the %s header", (key) => {
  const prefix = key + "=";
  expect(redactOutboxErrorText(prefix + "a=1; sid=" + alphaMarker)).toBe(prefix + "[REDACTED]");
});

test.each(["\u00a0", "\u2003", "\u202f", "\\u00a0", "\\u2003", "\\t"])(
  "redacts a cookie header with space %j before the colon",
  (space) => {
    const prefix = `Cookie${space}: `;
    expect(redactOutboxErrorText(prefix + "a=1; sid=" + alphaMarker)).toBe(prefix + "[REDACTED]");
  },
);

test.each([
  ["once", encodeURIComponent],
  ["twice", (text: string) => encodeURIComponent(encodeURIComponent(text))],
] as const)(
  "preserves the raw query parameter after a cookie header encoded %s",
  (_depth, encode) => {
    const prefix = "q=1&h=" + encode("Cookie: ");
    const suffix = "&keep=1";
    const input = prefix + encode("a=1; sid=" + alphaMarker) + suffix;
    expect(redactOutboxErrorText(input)).toBe(prefix + "[REDACTED]" + suffix);
  },
);

test.each(boundaryForms)(
  "only redacts the cookie scalar in %s",
  (_label, transform) => {
    const input = '{"cookies":4,"cookiePolicy":"accepted","status":503}';
    expect(redactOutboxErrorText(transform(input)))
      .toBe(transform('{"cookies":') + "[REDACTED]" + transform(',"cookiePolicy":"accepted","status":503}'));
    for (const scalar of ["true", "false", "null", "-1.4e+21"]) {
      for (const [prefix, suffix] of [['{"cookies":', '}'], ['[{"request_cookie":', '}]'], ['"cookies":', ']']]) {
        expect(redactOutboxErrorText(transform(prefix + scalar + suffix)))
          .toBe(transform(prefix) + "[REDACTED]" + transform(suffix));
      }
    }
  },
);

test("preserves cookies policy prose and similarly named diagnostic fields", () => {
  const input = 'cookies policy: accepted {"cookiePolicy":"accepted","credentialsMode":"omit"}';
  expect(redactOutboxErrorText(input)).toBe(input);
});

const boundaryMarker = ["Zq", "Mark"].join("");
const pathWithCredential = "C:\\tmp\\token=" + boundaryMarker;
const serializedPath = JSON.stringify({ path: pathWithCredential });

test.each([
  ["literal path", pathWithCredential],
  ["single backslash", "at \\token: " + boundaryMarker],
  ["plural after backslash", "\\tokens=" + boundaryMarker],
  ["serialized path", serializedPath],
  ["escaped serialized path", escapeJsonPayload(serializedPath)],
  ["encoded serialized path", encodeURIComponent(serializedPath)],
  ["backslash in JSON key", JSON.stringify({ "a\\token": boundaryMarker })],
  ["embedded URL", "next=" + encodeURIComponent("https://h/login?pwd=" + boundaryMarker + "&keep=1")],
  ["encoded comma", encodeURIComponent("a=1,session_id=" + boundaryMarker)],
  ["encoded pipe", encodeURIComponent("x|passwd: " + boundaryMarker)],
  ["raw URL with encoded question mark", "https://h/r%3Fpwd=" + boundaryMarker],
  ["raw assignment after encoded comma", "a=1%2Csession_id=" + boundaryMarker],
  ["named HTML quotes", "{&quot;password&quot;:&quot;" + boundaryMarker + "&quot;}"],
  ["numeric HTML quotes", "{&#34;pwd&#34;:&#x27;" + boundaryMarker + "&#x27;}"],
])("removes the synthetic credential behind a %s boundary", (_label, input) => {
  expect(redactOutboxErrorText(input)).not.toContain(boundaryMarker);
});

test.each(["%3F", "%2C", "%3B", "%7C", "%2F", "%3D", "%26", "%C2%A0"])(
  "redacts a short key after encoded punctuation %s at four depths",
  (punctuation) => {
    for (let depth = 1; depth <= 4; depth += 1) {
      const prefix = "diagnostic" + punctuation + "pwd=";
      expect(redactOutboxErrorText(prefix + boundaryMarker)).toBe(prefix + "[REDACTED]");
      punctuation = encodeURIComponent(punctuation);
    }
  },
);

test.each(["t", "n", "r", "u0009"])("only treats an odd backslash run before %s as a bare-value escape", (code) => {
  const value = boundaryMarker + "\\\\" + code + boundaryMarker;
  expect(redactOutboxErrorText("password=" + value)).not.toContain(boundaryMarker);
  const suffix = "\\" + code + "status=503";
  expect(redactOutboxErrorText("password=" + boundaryMarker + suffix)).toBe("password=[REDACTED]" + suffix);
});

test("withholds 50 encoded assignments that survive span redaction", () => {
  const keys = ["password", "pwd", "session ids", "set-cookie", "HTTP_COOKIE"];
  const transforms = [
    (text: string) => text,
    (text: string) => escapeJsonPayload(escapeJsonPayload(text)),
    (text: string) => "%FF%broken " + encodeURIComponent(text),
    (text: string) => encodeURIComponent(encodeURIComponent(encodeURIComponent(escapeJsonPayload(escapeJsonPayload(text))))),
    (text: string) => encodeURIComponent(text.replace(/&/g, "&amp;")),
  ];
  for (const key of keys) {
    for (const transform of transforms) {
      for (const separator of ["&#58;", "&#x3d;"]) {
        const hiddenKey = Array.from(key, (character) => `&#${character.charCodeAt(0)};`).join("");
        const input = transform(`{\\u0022${hiddenKey}\\u0022${separator}&#x27;${boundaryMarker}&#x27;}`);
        const output = redactOutboxErrorText(input);
        expect(output).not.toContain(boundaryMarker);
        expect(output).toBe("[REDACTED: message withheld]");
      }
    }
  }
});

test("withholds a path assignment whose key and separator require percent decoding", () => {
  const input = String.raw`C:\tmp\%2574oken%253D` + boundaryMarker;
  expect(redactOutboxErrorText(input)).toBe("[REDACTED: message withheld]");
});

test.each([
  "cookies policy",
  "status=503 retry=3 path=C:\\tmp\\logs",
  "next=https%3A%2F%2Fexample.invalid%2F%3Fstatus%3D503",
  "{&quot;cookiePolicy&quot;:&quot;accepted&quot;}",
  "password=",
])("keeps a diagnostic without a credential unchanged (%#)", (input) => {
  expect(redactOutboxErrorText(input)).toBe(input);
});

test.each([
  "the cookie was rejected", "credentialsProvider", "credential provider chain",
  JSON.stringify({ credentialsProvider: "runtime" }),
])(
  "preserves diagnostic prose %s", (input) => {
    expect(redactOutboxErrorText(input)).toBe(input);
  },
);

test("processes 8 KiB of nested escaped credential fields in under 50 ms", () => {
  const prefix = escapeJsonPayload('{"password":');
  const nested = escapeJsonPayload('{"api_key":[');
  const tail = escapeJsonPayload(JSON.stringify(alphaMarker));
  const depth = Math.floor((8192 - prefix.length - tail.length) / nested.length);
  const input = (prefix + nested.repeat(depth) + tail).padEnd(8192, " ");

  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(prefix + "[REDACTED]");
});

test("processes 8 KiB of repeated cookie-like key segments in under 50 ms", () => {
  const input = "cookie-".repeat(1170) + "ok";
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(input);
});

test("processes an 8 KiB multi-pair cookie header in under 50 ms", () => {
  const prefix = "Cookie: ";
  const pairs = "a=1; ".repeat(Math.ceil(8192 / 5));
  const tail = "sid=" + alphaMarker;
  const input = prefix + pairs.slice(0, 8192 - prefix.length - tail.length) + tail;
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(prefix + "[REDACTED]");
});

test("processes 8 KiB of repeated plural keys in under 50 ms", () => {
  const input = "credentials cookies session_ids ".repeat(256).slice(0, 8192);
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(input);
});

test("processes 8 KiB of escape-prefixed keys in under 50 ms", () => {
  const keys = String.raw`\nCookie: a=1; sid=` + alphaMarker + String.raw`\n\tprivate_key=` + betaMarker
    + String.raw`\r%250Asession_id=` + gammaMarker + String.raw`\nkeep line`;
  const expected = String.raw`\nCookie: [REDACTED]\n\tprivate_key=[REDACTED]\r%250Asession_id=[REDACTED]\nkeep line`;
  const repeats = Math.floor(8192 / keys.length);
  const input = keys.repeat(repeats).padEnd(8192);
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(expected.repeat(repeats) + " ".repeat(8192 - repeats * keys.length));
});

test("caps a 1 MiB unterminated escaped value with deeper quotes in under 200 ms", () => {
  const prefix = escapeJsonPayload('{"password":');
  const openQuote = escapeJsonPayload('"');
  const innerQuote = escapeJsonPayload(openQuote);
  const input = prefix + openQuote + (innerQuote + " " + alphaMarker).repeat(64) + "\\".repeat(1024 * 1024);

  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(200);
  expect(output).toBe(prefix + "[REDACTED]…[truncated]");
});

function checkHistoricalCoverage(seed: number, count: number, includeEscapedJson = false) {
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
  const fixtures = [alphaMarker, betaMarker, gammaMarker, deltaMarker];
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
    const jwt = ["eyJ" + fixtures[3], fixtureWord, "signature"].join(".");
    const standard = pick(["", "next=%2Fcb%3F", "{", "prefix-", 'curl -H "']) + first
      + pick(joins) + next + pick(joins) + pick([scheme, jwt, scheme + pick(joins) + jwt]);
    const chained = pick(["Bearer ", "Bearer:\t", "Bearer%20", "Authorization: Basic "])
      + fixtures[0] + pick(chains) + scheme;
    const singleCase = basicUpper;
    const authorization = pick(["Authorization: Basic ", "proxy-authorization:\tbasic ", "%22authorization%22%3A%22Basic%20"])
      + singleCase + pick(["", "%22"]);
    const encodedJson = "%7B%22access_token%22%3A%22" + fixtures[1] + "%22%7D";
    const basicEnded = "Basic " + fixtures[0] + pick([".", "-", "_", "~", "==="]);
    const basicChain = "Basic " + fixtures[0] + ".Basic " + fixtures[1];
    const quoteCount = pick([1, 2, 3, 4]);
    let quotedKey = pick(['%22password', '"password', "'password"]);
    for (let quote = 0; quote < quoteCount; quote += 1) quotedKey += pick(['%22', '"', "'"]);
    const quotedKeyValue = "token%3D" + shortFixture + "%7D" + quotedKey + pick([":", "%3A", "="]) + fixtures[1];
    const encodedQuote = "token%3D%22" + fixtures[0] + "%26" + fixtures[1] + "%22%26state%3Dok";
    const historical = pick([
      standard, standard, standard, chained + pick(joins) + next, authorization + " " + encodedJson,
      basicEnded, basicChain, quotedKeyValue, encodedQuote,
    ]);
    const escapedFixture = fixtureWord + "Escaped" + index;
    const transform = escapedJsonForms[index % escapedJsonForms.length][1];
    const input = includeEscapedJson
      ? transform(JSON.stringify({ password: escapedFixture })) + " & " + historical
      : historical;
    const oldResults = frozen.map((redact) => redact(input));
    const actual = redactOutboxErrorText(input);
    if (includeEscapedJson) {
      const structuredTransform = structuredJsonForms[index % structuredJsonForms.length][1];
      const endings = ['"', '\\', '", & ', ']}{[;=', "%26%5D", '" } \\'];
      const hostile = escapedFixture + endings[Math.floor(index / 24) % endings.length];
      const values = [
        hostile, { value: hostile, number: index }, [hostile, index, [true, { value: hostile }, null]],
      ];
      const pluralKey = ["credentials", "cookies", "session ids"][Math.floor(index / 4) % 3];
      const header = ["Cookie", "Set-Cookie"][index % 2] + ": ";
      const headerValue = "theme=dark; a=1; sid=" + hostile;
      const json = JSON.stringify({
        secret: values[Math.floor(index / structuredJsonForms.length) % values.length],
        pin_token: index, credential: false, session_id: null, [pluralKey]: hostile, error: header + headerValue, status: 503,
      });
      const expected = structuredTransform('{"secret":') + "[REDACTED]"
        + structuredTransform(',"pin_token":') + "[REDACTED]" + structuredTransform(',"credential":') + "[REDACTED]"
        + structuredTransform(',"session_id":') + "[REDACTED]" + structuredTransform(`,${JSON.stringify(pluralKey)}:`) + "[REDACTED]"
        + structuredTransform(`,"error":"${header}`) + "[REDACTED]" + structuredTransform('","status":503}');
      const historicalOutput = actual.slice(actual.indexOf(" & ") + 3);
      expect(redactOutboxErrorText(structuredTransform(json) + " & " + historical)).toBe(expected + " & " + historicalOutput);
    }
    for (const fixture of [...fixtures, singleCase, escapedFixture]) {
      if (!input.includes(fixture)) continue;
      if (fixture !== escapedFixture && oldResults.every((result) => result.includes(fixture))) continue;
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

test("retains historical coverage alongside escaped JSON across 1,000 seeded inputs", () => {
  const { checkedSecrets, leaks, firstLeak } = checkHistoricalCoverage(0x7b3a54c1, 1000, true);
  expect(checkedSecrets).toBeGreaterThan(2000);
  expect({ leaks, firstLeak }).toEqual({ leaks: 0, firstLeak: undefined });
}, 10000);
