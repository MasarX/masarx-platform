import {
  formatUiError,
  formatUiMessage,
  UiMessageError,
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

test("sanitizeUiError sanitizes error strings and formatUiError shows the fallback", () => {
  const input =
    ("Bearer " + [Buffer.from("{\"alg\":\"HS256\",\"typ\":\"JWT\"}").toString("base64url"),Buffer.from("payload-test-data-segment").toString("base64url"),"signaturevalue"].join("."));
  const output = sanitizeUiError(input);
  expect(output).toContain("[redacted]");
  expect(formatUiError(input, "fallback")).toBe("fallback");
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

test("formatUiError hides technical guard messages from the UI", () => {
  expect(formatUiError("backend readback missing workflow_runs", "Try again")).toBe("Try again");
  expect(formatUiError("Open debug trace failed", "Try again")).toBe("Try again");
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

test("formatUiError shows the fallback for unrecognised backend text; fields resolve to strings only", () => {
  expect(formatUiError({ message: { token: "synthetic-secret" }, details: "Email is required." }, "fallback"))
    .toBe("fallback");
  expect(formatUiError({ code: 57014 }, "fallback")).toBe("fallback");
  expect(formatUiError({ error_description: "Password must have at least 12 characters." }, "fallback"))
    .toBe("fallback");
  expect(formatUiError("  Enter a valid phone number.  ", "fallback")).toBe("fallback");
  expect(getUiErrorMessage({ message: { token: "synthetic-secret" }, details: "Email is required." }))
    .toBe("Email is required.");
  expect(formatUiMessage("  Enter a valid phone number.  ", "fallback")).toBe("Enter a valid phone number.");
});

test("formatUiError shows the fallback for a constraint violation", () => {
  const error = {
    code: "23505",
    message: 'duplicate key value violates unique constraint "synthetic_items_name_key"',
  };
  expect(formatUiError(error, "Try again.")).toBe("Try again.");
});

test("formatUiError shows the fallback for an error with message, details and hint", () => {
  const error = {
    message: "Synthetic shipment row could not be saved",
    details: "Key (synthetic_ref)=(ZZTEST000000) is not present in table synthetic_refs.",
    hint: "Check the synthetic_refs table.",
  };
  expect(formatUiError(error, "Try again.")).toBe("Try again.");
});

test("app-authored text shows only through the explicit path", () => {
  const text = "Choose a different template.";
  expect(formatUiMessage(text, "fallback")).toBe(text);
  expect(formatUiError(new UiMessageError(text), "fallback")).toBe(text);
  expect(formatUiError(text, "fallback")).toBe("fallback");
  expect(formatUiError(new Error(text), "fallback")).toBe("fallback");
});

test("the explicit path still sanitises", () => {
  const secret = ["synthetic", "runtime", Date.now().toString(36)].join("-");
  const output = formatUiMessage(`Request failed; token=${secret}`, "fallback");
  expect(output).toContain("[redacted]");
  expect(output).not.toContain(secret);
  expect(formatUiError(new UiMessageError(`Request failed; token=${secret}`), "fallback")).not.toContain(secret);
});

test.each([
  "",
  "   ",
  new Error("Choose a different template."),
  { message: "Choose a different template." },
  null,
  undefined,
])("the explicit path rejects empty text and non-text: %p", (input) => {
  expect(formatUiMessage(input, "fallback")).toBe("fallback");
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

describe("formatUiError reference ID (#723)", () => {
  const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
  const referenceId = "3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f";
  const backendText = "Synthetic relation zz_synthetic_rows could not be read";

  afterEach(() => {
    if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
  });

  test("an unrecognised backend error with a reference ID shows the English fallback and the ID", () => {
    process.env.NEXT_PUBLIC_LOCALE = "en";
    const result = formatUiError({ message: backendText, correlation_id: referenceId }, "Try again.");
    expect(result).toBe(`Try again. Reference: ${referenceId}`);
    expect(result).not.toContain("zz_synthetic_rows");
  });

  test("an unrecognised backend error with a reference ID shows the Arabic fallback and the isolated ID", () => {
    process.env.NEXT_PUBLIC_LOCALE = "ar";
    const result = formatUiError({ message: backendText, correlation_id: referenceId }, "حاول مرة أخرى.");
    expect(result).toBe(`حاول مرة أخرى. المرجع: ⁦${referenceId}⁩`);
    expect(result).not.toContain("zz_synthetic_rows");
  });

  test("a short request token in its own field is shown", () => {
    process.env.NEXT_PUBLIC_LOCALE = "en";
    expect(formatUiError({ message: backendText, request_id: "req_7Hq2LmZ9" }, "Try again."))
      .toBe("Try again. Reference: req_7Hq2LmZ9");
  });

  test("an unrecognised backend error without a reference ID shows the fallback only", () => {
    process.env.NEXT_PUBLIC_LOCALE = "en";
    expect(formatUiError(new Error(backendText), "Try again.")).toBe("Try again.");
    expect(formatUiError({ message: backendText, correlation_id: null }, "Try again.")).toBe("Try again.");
  });

  test("an ID-shaped string inside backend message text is not picked out", () => {
    process.env.NEXT_PUBLIC_LOCALE = "en";
    expect(formatUiError(new Error(`Request ${referenceId} failed`), "Try again.")).toBe("Try again.");
  });

  test.each([
    ["free text", { correlation_id: backendText }],
    ["an over-long token", { request_id: "a".repeat(33) }],
    ["markup", { trace_id: "<b>synthetic</b>" }],
    ["a non-string value", { request_id: 12345678 }],
  ])("a reference field holding %s is not shown", (_label, fields) => {
    process.env.NEXT_PUBLIC_LOCALE = "en";
    expect(formatUiError({ message: backendText, ...fields }, "Try again.")).toBe("Try again.");
  });
});
