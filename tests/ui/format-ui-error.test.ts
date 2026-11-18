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

test("formatUiError falls back for technical guard messages", () => {
  const fallback = "Action failed.";

  expect(
    formatUiError(
      new Error("ui_update_resource_v1 backend readback missing shipments:ship_1"),
      fallback
    )
  ).toBe(fallback);
  expect(formatUiError("Workflow task event readback was not found", fallback)).toBe(fallback);
  expect(formatUiError("Trace failed for correlation id abc123", fallback)).toBe(fallback);
  expect(formatUiError("Raw JSON payload unavailable", fallback)).toBe(fallback);
  expect(formatUiError("Debug details are unavailable", fallback)).toBe(fallback);
});

test("sanitizeUiError returns null for technical guard messages", () => {
  expect(sanitizeUiError("backend readback missing workflow_runs")).toBeNull();
  expect(sanitizeUiError("Open debug trace failed")).toBeNull();
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
