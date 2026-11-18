import {
  describeActionReceiptStatus,
  getOutboxSyncFailureMessage,
  resolveActionSubmissionStatus,
} from "../../../apps/fieldops/src/mobile-action-receipt";

describe("fieldops mobile action receipt", () => {
  test("treats a clean sync result as synced", () => {
    expect(
      resolveActionSubmissionStatus({
        effectiveOnline: true,
        syncResult: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          dead: 0,
        },
      }),
    ).toBe("synced");
    expect(
      getOutboxSyncFailureMessage({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        dead: 0,
      }),
    ).toBeNull();
  });

  test("treats retryable outbox failures as a receipt failure", () => {
    expect(
      resolveActionSubmissionStatus({
        effectiveOnline: true,
        queueEntry: {
          status: "failed",
          last_error: "network unavailable",
        },
      }),
    ).toBe("retryable_failure");
    expect(
      describeActionReceiptStatus({
        status: "retryable_failure",
        queueEntry: {
          status: "failed",
          last_error: "network unavailable",
        },
      }),
    ).toBe("Queued, but sync could not complete. network unavailable");
  });

  test("treats dead outbox failures as a receipt failure with terminal wording", () => {
    expect(
      resolveActionSubmissionStatus({
        effectiveOnline: true,
        queueEntry: {
          status: "dead",
          last_error: "Capability denied: tasks.complete\nstack trace omitted",
        },
      }),
    ).toBe("retryable_failure");
    expect(
      describeActionReceiptStatus({
        status: "retryable_failure",
        queueEntry: {
          status: "dead",
          last_error: "Capability denied: tasks.complete\nstack trace omitted",
        },
      }),
    ).toBe("Sync failed and needs review. Capability denied: tasks.complete");
  });

  test("reports aggregate sync failures even when the queue entry is missing", () => {
    expect(
      getOutboxSyncFailureMessage({
        attempted: 3,
        succeeded: 1,
        failed: 1,
        dead: 1,
      }),
    ).toBe("Outbox sync left 1 retryable and 1 terminal failures.");
    expect(
      resolveActionSubmissionStatus({
        effectiveOnline: true,
        syncResult: {
          attempted: 3,
          succeeded: 1,
          failed: 1,
          dead: 1,
        },
      }),
    ).toBe("retryable_failure");
  });
});
