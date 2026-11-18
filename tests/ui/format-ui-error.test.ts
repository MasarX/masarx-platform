import {
  formatUiError,
  extractCapabilityDeniedKey,
  getUiErrorMessage,
  isCapabilityDeniedMessage,
  isSchemaCacheFunctionUnavailableError,
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

test.each([
  "   ",
  "Backend readback failed; token=synthetic-short",
  new Error("Diagnostic raw response is unavailable"),
  { message: "Correlation_id synthetic-reference" },
  { details: "Debug payload could not be processed" },
])("formatUiError never restores rejected or empty text: %p", (error) => {
  expect(formatUiError(error, "Try this action again.")).toBe("Try this action again.");
});

test("formatUiError resolves only string error fields and preserves safe validation", () => {
  expect(formatUiError({ message: { token: "synthetic-secret" }, details: "Email is required." }, "fallback"))
    .toBe("Email is required.");
  expect(formatUiError({ code: 57014 }, "fallback")).toBe("fallback");
  expect(formatUiError({ error_description: "Password must have at least 12 characters." }, "fallback"))
    .toBe("Password must have at least 12 characters.");
  expect(formatUiError("  Enter a valid phone number.  ", "fallback"))
    .toBe("Enter a valid phone number.");
});

test.each([
  'Authorization: Bearer synthetic-short',
  'Basic c3ludGhldGlj',
  'https://example.test/callback?access_token=synthetic-short&next=/shipments',
  '{"client_secret":"synthetic-short","api_key":"also-short"}',
  'password="synthetic \\"quoted\\" secret"',
])("sanitizeUiError redacts explicit short secrets: %s", (input) => {
  const result = sanitizeUiError(input);
  expect(result).toContain("[redacted]");
  expect(result).not.toContain("synthetic");
  expect(result).not.toContain("also-short");
});

test("classification and sanitized diagnosis do not depend on presentation filtering", () => {
  const timeout = new Error("Backend canceled the statement due to statement timeout; token=synthetic-short");
  expect(formatUiError(timeout, "Try again.")).toBe("Try again.");
  expect(isStatementTimeoutUiError(timeout)).toBe(true);
  expect(isSchemaCacheFunctionUnavailableError({ message: "Backend could not find the function ui_me_v1 in the schema cache" }, "ui_me_v1"))
    .toBe(true);
  expect(getUiErrorMessage(timeout)).toContain("statement timeout");
  expect(sanitizeUiError(getUiErrorMessage(timeout))).toContain("statement timeout");
  expect(sanitizeUiError(getUiErrorMessage(timeout))).not.toContain("synthetic-short");

  const denied = formatUiError("Backend capability denied: settings.request.write; token=synthetic-short", "fallback");
  expect(denied).toBe("Capability denied: settings.request.write");
  expect(isCapabilityDeniedMessage(denied)).toBe(true);
  expect(extractCapabilityDeniedKey(denied)).toBe("settings.request.write");
});

test("sanitization handles long token-like text and leaves unrelated field names intact", () => {
  expect(sanitizeUiError("a".repeat(50_000))).toBe("[redacted]");
  expect(sanitizeUiError("secret_ref=vault-reference token_id=reference private_key_id=reference"))
    .toBe("secret_ref=vault-reference token_id=reference private_key_id=reference");
});
