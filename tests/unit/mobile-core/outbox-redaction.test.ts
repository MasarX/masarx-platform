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
