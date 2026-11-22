import { randomUUID } from "node:crypto";

import { redactOutboxErrorText } from "@masarx/mobile-core";
import { describeActionReceiptStatus } from "../../../apps/fieldops/src/mobile-action-receipt";
import { formatUnknownError, readRawErrorText } from "../../../apps/fieldops/src/mobile-display-error";
import { emitMobileV2TraceEvent } from "../../../apps/fieldops/src/mobile-v2-trace-context";
import { truncateError } from "../../../apps/fieldops/src/screens/outbox-screen-helpers";

const marker = randomUUID();
const errorKey = "password" + "=";
const errorText = errorKey + marker;
const redactedText = expect.stringMatching(/\[REDACTED/);

test("the display formatter redacts strings, errors, and structured error details", () => {
  const cases = [
    errorText,
    new Error(errorText),
    { code: "P0001", message: "Unable to load outbox", details: errorText, hint: errorText },
  ];

  for (const error of cases) {
    const redacted = redactOutboxErrorText(readRawErrorText(error));
    expect(redacted).toMatch(/\[REDACTED/);
    expect(redacted).not.toContain(marker);
    expect(formatUnknownError(error)).not.toContain(marker);
  }
  expect(formatUnknownError({ code: "P0001", message: "Unable to load outbox" }))
    .toBe("[P0001] Unable to load outbox");
});

test("the display formatter replaces withheld messages with screen guidance", () => {
  const withheld = "[REDACTED: message withheld]";
  const fallback = "Refresh the route and try again.";
  expect(formatUnknownError(withheld, fallback)).toBe(fallback);
  expect(formatUnknownError(`${withheld} (auth)`, fallback)).toBe(fallback);
  expect(formatUnknownError(withheld)).toBe("Unable to complete this action. Try again.");
});

test("outbox receipts and RPC traces redact error details", () => {
  const receipt = describeActionReceiptStatus({
    status: "retryable_failure",
    queueEntry: { status: "failed", last_error: errorText },
  });
  expect(receipt).not.toContain(marker);
  expect(truncateError(errorText)).not.toContain(marker);

  const withheld = "[REDACTED: message withheld] (auth)";
  expect(describeActionReceiptStatus({
    status: "retryable_failure",
    queueEntry: { status: "failed", last_error: withheld },
  })).toBe("Queued, but sync could not complete. Review Outbox for retry state.");
  expect(truncateError(withheld)).toBe("Unable to complete this action. Try again.");

  const debug = jest.spyOn(console, "debug").mockImplementation(() => {});
  try {
    emitMobileV2TraceEvent("rpc.error", { message: errorText });
    const payload = debug.mock.calls[0]?.[1];
    expect(JSON.parse(payload)).toMatchObject({ step: "rpc.error", message: redactedText });
    expect(payload).not.toContain(marker);
  } finally {
    debug.mockRestore();
  }
});

test("Sentry hooks redact error fields and retain diagnostic context", async () => {
  const init = jest.fn();
  jest.doMock("@sentry/react-native", () => ({ init, setTag: jest.fn() }), { virtual: true });
  const { initMobileCrashReporting } = await import("../../../apps/fieldops/src/mobile-crash-reporting");
  expect(initMobileCrashReporting({ dsn: "https://dsn.example/1", enabledInDev: true })).toBe(true);

  const { beforeSend, beforeBreadcrumb } = init.mock.calls[0][0];
  const input = {
    category: "console",
    message: errorText,
    data: { reason: errorText, arguments: [{ reason: errorText, count: 1 }] },
  };
  const expected = {
    category: "console",
    message: redactedText,
    data: { reason: redactedText, arguments: [{ reason: redactedText, count: 1 }] },
  };

  const breadcrumb = beforeBreadcrumb(input);
  expect(breadcrumb).toEqual(expected);
  expect(JSON.stringify(breadcrumb)).not.toContain(marker);

  const event = beforeSend({
    message: errorText,
    exception: { values: [{ type: errorText, value: errorText }] },
    breadcrumbs: [input],
    extra: { details: errorText },
  }, {});
  expect(event).toEqual({
    message: redactedText,
    exception: { values: [{ type: redactedText, value: redactedText }] },
    breadcrumbs: [expected],
    extra: { details: redactedText },
  });
  expect(JSON.stringify(event)).not.toContain(marker);
});
