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
