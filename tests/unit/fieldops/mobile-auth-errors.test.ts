import {
  formatAuthErrorMessage,
  isAuthExpiredError,
} from "../../../apps/fieldops/src/mobile-auth-errors";

describe("mobile auth error formatter", () => {
  test("adds credentials hint for invalid login errors", () => {
    expect(
      formatAuthErrorMessage(
        new Error("Invalid login credentials"),
        "sroquvhuzhkomlopinuzvjim@example.invalid"
      )
    ).toBe(
      "Invalid login credentials. Verify email/password and remove spaces from email (e.g. sroquvhuzhkomlopinuzvjim@example.invalid)."
    );
  });

  test("adds email format hint for token-like validation errors", () => {
    expect(formatAuthErrorMessage(new Error("Invalid email"), "sroquvhuzhkomlopinuzvjim@example.invalid")).toBe(
      "Invalid email. Verify email format (no spaces), then retry."
    );
  });

  test("falls back to raw error message", () => {
    expect(formatAuthErrorMessage("service unavailable", "sroquvhuzhkomlopinuzvjim@example.invalid")).toBe(
      "service unavailable"
    );
  });

  test("maps TypeError: Failed to fetch to a user-friendly message", () => {
    expect(
      formatAuthErrorMessage(new TypeError("Failed to fetch"), "sroquvhuzhkomlopinuzvjim@example.invalid")
    ).toBe("Unable to reach the MasarX server. Check your connection and try again.");
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
