import {
  formatUiError,
  isStatementTimeoutUiError,
  sanitizeUiError,
} from "../../packages/ui/src/utils";

test("sanitizeUiError redacts tokens and secrets", () => {
  const input =
    ("token=" + [Buffer.from("{\"alg\":\"HS256\",\"typ\":\"JWT\"}").toString("base64url"),Buffer.from("payload-test-data-segment").toString("base64url"),"signaturevalue"].join(".") + " secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const output = sanitizeUiError(input);
  expect(output).toContain("[redacted]");
});

test("formatUiError sanitizes error strings", () => {
  const input =
    ("Bearer " + [Buffer.from("{\"alg\":\"HS256\",\"typ\":\"JWT\"}").toString("base64url"),Buffer.from("payload-test-data-segment").toString("base64url"),"signaturevalue"].join("."));
  const output = formatUiError(input, "fallback");
  expect(output).toContain("[redacted]");
});

test("sanitizeUiError keeps capability keys readable", () => {
  expect(sanitizeUiError("Capability denied: settings.request.write")).toBe(
    "Capability denied: settings.request.write"
  );
  expect(sanitizeUiError("Requires workflow_runs.write capability.")).toBe(
    "Requires workflow_runs.write capability."
  );
});

test("formatUiError falls back when empty", () => {
  expect(formatUiError(null, "fallback")).toBe("fallback");
});

test("isStatementTimeoutUiError detects statement timeout messages", () => {
  expect(isStatementTimeoutUiError("canceling statement due to statement timeout")).toBe(true);
  expect(isStatementTimeoutUiError({ details: "canceling statement due to statement timeout" })).toBe(true);
});

test("isStatementTimeoutUiError detects Postgres cancel code 57014", () => {
  expect(isStatementTimeoutUiError({ code: "57014" })).toBe(true);
  expect(isStatementTimeoutUiError({ status: 57014 })).toBe(true);
});

test("isStatementTimeoutUiError returns false for non-timeout errors", () => {
  expect(isStatementTimeoutUiError("capability denied: shipments.read")).toBe(false);
  expect(isStatementTimeoutUiError({ message: "permission denied for table users", code: "42501" })).toBe(false);
});
