import { createHash } from "node:crypto";
import { redactOutboxErrorText } from "@masarx/mobile-core";

const basicAbcDef = Buffer.from(["abc", "def"].join(":")).toString("base64");
const basicUserPass = Buffer.from(["user", "pass"].join(":")).toString("base64");
const basicFixture = Buffer.from("fixture").toString("base64");
const basicUpperLong = Buffer.from("A".repeat(9)).toString("base64");
const basicUpper = Buffer.from("A".repeat(6)).toString("base64");
const basicUpperWithDigit = basicUpper + "1";
const basicWithSuffix = ["QFJBVZQ", "968QX98"].join("");
const overlapToken = ["QW423", "29KZ", "449"].join("");
const fixtureSecret = ["fixture", "Secret"].join("");
const firstToken = ["fixture", "First"].join("");
const nextToken = ["fixture", "Next"].join("");
const fixtureTail = ["fixture", "Tail"].join("");
const secretWithDigit = ["SE", "CRET", "1"].join("");
const syntheticSecret = ["SE", "CRET"].join("");
const shortToken = ["ab", "c"].join("");
const fixtureToken = ["fixt", "ure"].join("");
const visibleToken = ["visi", "ble"].join("");
const visibleTail = [visibleToken, fixtureToken, "tail"].join("-");
const firstApiKey = ["hk", "1"].join("");
const secondApiKey = ["hk", "2"].join("");
const jwtFixture = ["eyJ" + fixtureToken, "payload", "signature"].join(".");
const jwtCapPrefix = jwtFixture.slice(0, 14);
const basicCapPrefix = "Basic " + basicUserPass.slice(0, 3);
const shortBasicToken = ["X", "=".repeat(2)].join("");
const [upperX, upperY, upperS, lowerX, lowerV] = "XYSxv";
const alphaMarker = fixtureToken + "Alpha" + 1;
const betaMarker = fixtureToken + "Beta" + 2;
const gammaMarker = fixtureToken + "Gamma" + 3;
const deltaMarker = fixtureToken + "Delta" + 4;

test("constructed credential fixtures preserve their original bytes", () => {
  const fixtures = [
    basicAbcDef, basicUserPass, basicFixture, basicUpperLong, basicUpper,
    basicUpperWithDigit, basicWithSuffix, overlapToken, fixtureSecret, firstToken,
    nextToken, fixtureTail, secretWithDigit, syntheticSecret, shortToken, fixtureToken,
    visibleToken, visibleTail, firstApiKey, secondApiKey, jwtFixture, jwtCapPrefix,
    basicCapPrefix, shortBasicToken, alphaMarker, betaMarker, gammaMarker, deltaMarker,
  ];
  expect(createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"))
    .toBe("8d08a71f8672eac67be1064375e98032fd4c38b813fa28193de3e9ea21690e98");
});

test.each([
  ["x-api-key=" + firstApiKey, "x-api-key=[REDACTED]"],
  ["X-Api-Key: " + secondApiKey, "X-Api-Key: [REDACTED]"],
  ["api-key: " + lowerV, "api-key: [REDACTED]"],
  ["refresh_token%3D" + shortToken, "refresh_token%3D[REDACTED]"],
  ["access_token%3D" + shortToken + "%26x", "access_token%3D[REDACTED]%26x"],
  ["refresh_token%3A" + shortToken, "refresh_token%3A[REDACTED]"],
  ["access_token%3A" + shortToken + "%26x", "access_token%3A[REDACTED]%26x"],
  ["ReFrEsH_ToKeN%3d" + shortToken, "ReFrEsH_ToKeN%3d[REDACTED]"],
  ["AcCeSs_ToKeN%3a" + shortToken, "AcCeSs_ToKeN%3a[REDACTED]"],
  ["access_token%3D" + shortToken + "%26state%3Dok", "access_token%3D[REDACTED]%26state%3Dok"],
  ["access_token%3D" + shortToken + "&state=ok", "access_token%3D[REDACTED]&state=ok"],
  ["access_token=" + shortToken + "&state=ok", "access_token=[REDACTED]&state=ok"],
  ["state%3Dok%26api-key%3D" + shortToken, "state%3Dok%26api-key%3D[REDACTED]"],
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
  const prefix = " ".repeat(8192 - ("api-key=" + visibleToken).length);
  expect(redactOutboxErrorText(prefix + "api-key=" + visibleTail))
    .toBe(prefix + "api-key=[REDACTED]…[truncated]");
});

test("redacts a JWT whose second segment spans the cap", () => {
  const prefix = " ".repeat(8192 - jwtCapPrefix.length);
  expect(redactOutboxErrorText(prefix + jwtFixture))
    .toBe(prefix + "[JWT_REDACTED]…[truncated]");
});

test.each([
  ["token%253D" + fixtureToken, "token%253D[REDACTED]"],
  ["x-api-key%20%3D%20" + lowerV, "x-api-key%20%3D%20[REDACTED]"],
  ["api%2Dkey%3D" + fixtureToken, "api%2Dkey%3D[REDACTED]"],
  ["Bearer%20" + fixtureToken, "Bearer [REDACTED]"],
  ["bearer:" + fixtureToken, "Bearer [REDACTED]"],
  ["Basic " + basicFixture, "Basic [REDACTED]"],
  ["token%3D%22a b%22%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["-token=" + fixtureToken, "-token=[REDACTED]"],
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
  ["password%3D%22a b token=%22" + syntheticSecret, "password%3D[REDACTED]"],
  ["token%3D%22" + shortToken + "%26jwt%3D%22" + syntheticSecret + "%22%26state%3Dok", "token%3D[REDACTED]%26jwt%3D[REDACTED]%26state%3Dok"],
  ["token%3D%22%22" + syntheticSecret, "token%3D[REDACTED]"],
  ["token%3D%22" + lowerX + "%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["token%3D%22a b%22%26state%3Dok", "token%3D[REDACTED]%26state%3Dok"],
  ["token%3D" + shortToken + "%20password = " + syntheticSecret, "token%3D[REDACTED]%20password = [REDACTED]"],
  ["token%3D" + shortToken + "%20password: " + syntheticSecret, "token%3D[REDACTED]%20password: [REDACTED]"],
  ["token%3Da%20b", "token%3D[REDACTED]"],
  ["Basic validation failed", "Basic validation failed"],
  ["Basic auth required", "Basic auth required"],
  ["Basic plan expired", "Basic plan expired"],
  ["x-request-id%3D1", "x-request-id%3D1"],
])("keeps credential boundaries in %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test.each([
  ["authorization%3DBasic%20" + basicAbcDef, "authorization%3D[REDACTED]"],
  ["token%3D" + shortToken + "%20def=ghi", "token%3D[REDACTED]"],
  ["password%3Dp%20q%3Dr", "password%3D[REDACTED]"],
  ["Basic " + basicUserPass, "Basic [REDACTED]"],
  ["Bearer%20token: " + upperX, "Bearer%20token: [REDACTED]"],
  ["Bearer%20client_secret%3A" + shortToken, "Bearer%20client_secret%3A[REDACTED]"],
  ["token%3Djwt: " + upperX, "token%3D[REDACTED] [REDACTED]"],
  ["token%3Dx{\"password\": \"" + syntheticSecret + "\"}", "token%3D[REDACTED] [REDACTED]}"],
])("redacts compound credential input %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test("redacts a short Basic credential fragment at the cap", () => {
  const prefix = " ".repeat(8192 - basicCapPrefix.length);
  expect(redactOutboxErrorText(prefix + "Basic " + basicUserPass))
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
  ["Authorization: Basic " + basicAbcDef, [basicAbcDef]],
  ["proxy-authorization: Basic " + basicAbcDef, [basicAbcDef]],
  ["curl -H \"Authorization: Basic " + basicAbcDef + "\"", [basicAbcDef]],
  ["token=" + lowerX + "/Basic " + basicAbcDef, [basicAbcDef]],
  ["authorization: Bearer: " + shortBasicToken, [shortBasicToken]],
  ["access_token%20%3D%20Bearer: " + shortBasicToken, [shortBasicToken]],
  ["token%3D" + shortToken + "%20" + overlapToken + " = " + fixtureTail, [overlapToken]],
  ["token=" + firstToken + "%26api-key\t=\t" + nextToken, [firstToken, nextToken]],
  ["token=" + firstToken + "%26password\t=\t" + nextToken, [firstToken, nextToken]],
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
  ["token=\"\"" + secretWithDigit, secretWithDigit],
  ["token: \"\"" + secretWithDigit, secretWithDigit],
  ["token=''" + secretWithDigit, secretWithDigit],
  ["\"access_token\": \"\"" + secretWithDigit + "\"", secretWithDigit],
  ["token=\"prefix\"" + secretWithDigit + "&state=ok", secretWithDigit],
  ["Bearer:\t" + upperX + "+Bearer " + upperY, upperY],
  ["Bearer%20" + upperX + "/Bearer " + upperY, upperY],
  ["Authorization: BASIC " + upperX + "/Basic " + upperY, upperY],
  ["Bearer " + shortToken + "/Bearer " + upperS, upperS],
  ["Authorization: Basic " + basicUpper, basicUpper],
  ["proxy-authorization: basic " + basicUpperLong, basicUpperLong],
  ["\"authorization\": \"Basic " + basicUpper + "\"", basicUpper],
  ["%22proxy-authorization%22%3A%22Basic%20" + basicUpper + "%22", basicUpper],
  ["%7B%22access_token%22%3A%22" + upperS + "%22%7D", "%22" + upperS + "%22"],
  ["%22token%22=" + fixtureSecret, fixtureSecret],
  ["%22token%22%3A" + fixtureSecret, fixtureSecret],
])("redacts quote and authorization variants in %s", (input, secret) => {
  const result = redactOutboxErrorText(input);
  expect(result).toContain("[REDACTED]");
  expect(result).not.toContain(secret);
});

test.each([
  ["Basic " + basicAbcDef + ".", [basicAbcDef]],
  ["Basic " + basicAbcDef + "-", [basicAbcDef]],
  ["Basic " + basicUpperWithDigit + "_x", [basicUpperWithDigit]],
  ["Basic " + basicUpperWithDigit + "~x", [basicUpperWithDigit]],
  ["Basic " + basicAbcDef + "=", [basicAbcDef]],
  ["Basic " + basicUpperWithDigit + ".Basic " + secretWithDigit, [basicUpperWithDigit, secretWithDigit]],
  ["password: basic " + basicWithSuffix + "_x", [basicWithSuffix]],
  ["token%3D" + shortToken + "%7D%22password%22%22%3A%22" + secretWithDigit, [shortToken, secretWithDigit]],
  ["token%3D" + shortToken + "%7D\"password\"\":\"" + secretWithDigit + "\"", [shortToken, secretWithDigit]],
  ["token%3D" + shortToken + "%7D'password'%22%3A" + secretWithDigit, [shortToken, secretWithDigit]],
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
  "token%3D" + shortToken + "%7D%22password%22%22%22%3A" + secretWithDigit,
  "token%3D" + shortToken + "%7D\"password\"\"\":\"" + secretWithDigit + "\"",
  "token%3D" + shortToken + "%7D'password''\":\"" + secretWithDigit + "\"",
  "token%3D" + shortToken + "%7D\"password\"\"%22%3A%22" + secretWithDigit,
])("redacts the value after three closing quotes in %s", (input) => {
  const output = redactOutboxErrorText(input);
  expect(output).not.toContain(secretWithDigit);
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
    const jwt = ["eyJ" + fixtures[3], fixtureToken, "signature"].join(".");
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
    const quotedKeyValue = "token%3D" + shortToken + "%7D" + quotedKey + pick([":", "%3A", "="]) + fixtures[1];
    const encodedQuote = "token%3D%22" + fixtures[0] + "%26" + fixtures[1] + "%22%26state%3Dok";
    const input = pick([
      standard, standard, standard, chained + pick(joins) + next, authorization + " " + encodedJson,
      basicEnded, basicChain, quotedKeyValue, encodedQuote,
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
