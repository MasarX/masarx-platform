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

test("retains historical secret coverage across 24,000 seeded inputs", () => {
  const start = performance.now();
  let seed = 0x7b3a54c1;
  function pick<T>(values: readonly T[]) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return values[(seed >>> 0) % values.length];
  }

  const keys = ["token", "password", "prefixJwtSuffix", "x-api-key", "api%2Dkey", '"client_secret"', "authorization", "x-request-id", "state"];
  const separators = ["=", ": ", " = ", "%3D", "%3a", "%253D", "%20%3D%20"];
  const quotes = ['"', "'", "%22", ""];
  const joins = ["&", "%26", "%20", " ", '", "'];
  const markers = ["fixtureAlpha1", "fixtureBeta2", "fixtureGamma3", "fixtureDelta4"];
  let checkedSecrets = 0;
  let leaks = 0;
  let firstLeak: { input: string; marker: string; actual: string } | undefined;
  for (let index = 0; index < 24000; index += 1) {
    const field = (marker: string) => {
      const quote = pick(quotes);
      return pick(keys) + pick(separators) + quote + marker + pick([quote, ""]);
    };
    const first = field(markers[0]);
    const next = field(markers[1]);
    const bearer = "Bearer" + pick([" ", "%20", ":"]) + markers[2];
    const jwt = "eyJ" + markers[3] + ".fixture.signature";
    const input = pick(["", "next=%2Fcb%3F", "{", "prefix-"]) + first
      + pick(joins) + next + pick(joins) + pick([bearer, jwt, bearer + pick(joins) + jwt]);
    const oldResults = [redactB22(input), redactFirstFollowup(input)];
    const actual = redactOutboxErrorText(input);
    for (const marker of markers) {
      if (!input.includes(marker) || oldResults.every((result) => result.includes(marker))) continue;
      checkedSecrets += 1;
      if (!actual.includes(marker)) continue;
      leaks += 1;
      firstLeak ??= { input, marker, actual };
    }
  }

  expect(checkedSecrets).toBeGreaterThan(24000);
  expect({ leaks, firstLeak }).toEqual({ leaks: 0, firstLeak: undefined });
  expect(performance.now() - start).toBeLessThan(3000);
}, 3000);
