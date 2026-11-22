import { randomUUID } from "node:crypto";

import { describeActionReceiptStatus } from "../../../apps/fieldops/src/mobile-action-receipt";
import { formatUnknownError } from "../../../apps/fieldops/src/mobile-display-error";
import { emitMobileV2TraceEvent } from "../../../apps/fieldops/src/mobile-v2-trace-context";
import { truncateError } from "../../../apps/fieldops/src/screens/outbox-screen-helpers";

const marker = randomUUID();
const errorKey = "password" + "=";
const errorText = errorKey + marker;
const safeErrorText = errorKey + "[REDACTED]";

test("the display formatter redacts strings, errors, and structured error details", () => {
  const cases = [
    errorText,
    new Error(errorText),
    { code: "P0001", message: "Unable to load outbox", details: errorText, hint: errorText },
  ];

  for (const error of cases) {
    const displayed = formatUnknownError(error);
    expect(displayed).toContain("[REDACTED]");
    expect(displayed).not.toContain(marker);
  }
  expect(formatUnknownError({ code: "P0001", message: "Unable to load outbox" }))
    .toBe("[P0001] Unable to load outbox");
});

test("outbox receipts and RPC traces redact error details", () => {
  const receipt = describeActionReceiptStatus({
    status: "retryable_failure",
    queueEntry: { status: "failed", last_error: errorText },
  });
  expect(receipt).toContain("[REDACTED]");
  expect(receipt).not.toContain(marker);
  expect(truncateError(errorText)).toBe(safeErrorText);

  const debug = jest.spyOn(console, "debug").mockImplementation(() => {});
  try {
    emitMobileV2TraceEvent("rpc.error", { message: errorText });
    const payload = debug.mock.calls[0]?.[1];
    expect(JSON.parse(payload)).toMatchObject({ step: "rpc.error", message: safeErrorText });
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
    message: safeErrorText,
    data: { reason: safeErrorText, arguments: [{ reason: safeErrorText, count: 1 }] },
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
    message: safeErrorText,
    exception: { values: [{ type: safeErrorText, value: safeErrorText }] },
    breadcrumbs: [expected],
    extra: { details: safeErrorText },
  });
  expect(JSON.stringify(event)).not.toContain(marker);
});
