import {
  formatAuthErrorMessage,
  isAuthExpiredError,
} from "../../../apps/fieldops/src/mobile-auth-errors";

describe("mobile auth error formatter", () => {
  const validationHint = "Verify email format (no spaces), then retry.";
  const exampleEmail = ["sipkxyzyxvgv", "tksowrxwjgpn", String.fromCharCode(64), "example", ".invalid"].join("");

  test.each([
    ["Failed to fetch", "Unable to reach the MasarX server. Check your connection and try again."],
    ["Invalid login credentials", `Invalid login credentials. Verify email/password and remove spaces from email (e.g. ${exampleEmail}).`],
    ["HTTP 400", validationHint],
    ["Invalid email", validationHint],
    ["Invalid OTP", validationHint],
    ["Invalid token", validationHint],
    ["email NOT confirmed", "Email not confirmed. Check your inbox for the confirmation email, then retry."],
    ["Email rate limit exceeded", "Email rate limit exceeded. Wait before requesting another email."],
    ["Token has expired or is invalid", "Token has expired or is invalid. Request a new link or code, then retry."],
    ["Password should be at least 8 characters", "Password should be at least 8 characters. Choose a longer password and try again."],
    ["Password should be at least 128 characters", "Password should be at least 128 characters. Choose a longer password and try again."],
    ["Password should be at least 1024 characters", "Choose a longer password and try again."],
    ["Password should be at least \u0668 characters", "Choose a longer password and try again."],
    ["Password should be at least 8.5 characters", "Choose a longer password and try again."],
    ["Service unavailable", "[REDACTED: message withheld]"],
  ])("formats %s without exposing the credential value", (message, expected) => {
    const marker = ["sample", "value"].join("-");
    const formatted = formatAuthErrorMessage(new Error(`${message} password=${marker}`));
    expect(formatted).toBe(expected);
    expect(formatted).not.toContain(marker);
  });

  test("preserves a safe fallback message", () => {
    expect(formatAuthErrorMessage("service unavailable")).toBe("service unavailable");
  });
});

describe("isAuthExpiredError", () => {
  test("detects 401 status codes", () => {
    expect(isAuthExpiredError({ status: 401, message: "Unauthorized" })).toBe(true);
    expect(isAuthExpiredError({ statusCode: 403 })).toBe(true);
  });

  test("detects JWT expired messages", () => {
    expect(isAuthExpiredError(new Error("JWT expired"))).toBe(true);
    expect(isAuthExpiredError(new Error("token invalid"))).toBe(true);
    expect(isAuthExpiredError(new Error("Auth session missing!"))).toBe(true);
  });

  test("detects Supabase PGRST codes", () => {
    expect(isAuthExpiredError({ code: "PGRST301" })).toBe(true);
    expect(isAuthExpiredError({ code: "unauthorized" })).toBe(true);
  });

  test("ignores unrelated errors", () => {
    expect(isAuthExpiredError(null)).toBe(false);
    expect(isAuthExpiredError(undefined)).toBe(false);
    expect(isAuthExpiredError(new Error("Failed to fetch"))).toBe(false);
    expect(isAuthExpiredError({ status: 500 })).toBe(false);
  });
});
