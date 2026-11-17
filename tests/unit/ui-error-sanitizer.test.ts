import { sanitizeUiError } from "../../packages/ui/src/utils";

describe("sanitizeUiError", () => {
  test.each([
    ["Cookie: session=synthetic-first; sid=synthetic-second", "Cookie: [redacted]"],
    ["cookie: session=synthetic-first;sid=synthetic-second\r\nRetry: later", "cookie: [redacted]\r\nRetry: later"],
    ["Set-Cookie: session=synthetic-first; sid=synthetic-second; HttpOnly", "Set-Cookie: [redacted]"],
    ['{"Cookie":"session=synthetic-first; sid=synthetic-second","secret_ref":"vault-reference"}', '{"Cookie":[redacted],"secret_ref":"vault-reference"}'],
  ])("redacts complete cookie header values: %s", (input, expected) => {
    expect(sanitizeUiError(input)).toBe(expected);
  });

  test("redacts the complete JWT-shaped value", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    expect(sanitizeUiError(`token=${token}`)).toBe("token=[redacted]");
  });
});
