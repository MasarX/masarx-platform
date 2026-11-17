import { formatAuthErrorMessage } from "../../../apps/fieldops/src/mobile-auth-errors";

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
});
