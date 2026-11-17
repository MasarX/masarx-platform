import type { OutboxEntry } from "@masarx/mobile-core";
import { getFieldOpsStrings } from "../../../apps/fieldops/src/i18n";
import { describeMobileOutboxEntry, formatMobileActionReceipt, describeMobileActionReceiptStatus,
  isMobileOutboxSyncBatchSuccessful } from "../../../apps/fieldops/src/mobile-action-feedback";

const entry: OutboxEntry = {
  id: "queue-a", rpc: "ui_execute_command_v1", args: { p_action_key: "route_stops.arrived", p_selection_id: "stop-a" },
  status: "queued", created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
  attempt_count: 1, next_attempt_at: null, last_error: null,
};

test.each(["en", "ar"] as const)("receipt keeps action, target and references with %s readback guidance", locale => {
  const strings = getFieldOpsStrings(locale);
  const detail = describeMobileActionReceiptStatus("queued_offline", strings);
  const value = formatMobileActionReceipt({ actionKey: "route_stops.arrived", actionLabel: "Arrive",
    targetLabel: "Customer A", queueId: "queue-a", status: "queued_offline", detail,
    recordedAt: entry.created_at, resourceId: "stop-a" }, strings);
  expect(value).toContain("Arrive");
  expect(value).toContain("Customer A");
  expect(value).toContain(detail);
  expect(value).toContain(strings.detail.reference("stop-a"));
  expect(value).toContain(strings.actionFeedback.queueReference("queue-a"));
});

test.each([
  ["queued", null, "queued"], ["in_flight", null, "inFlight"], ["succeeded", null, "synced"],
  ["failed", "Recovered stale in flight", "recovered"], ["failed", "401 session", "auth"],
  ["dead", "401 session", "auth"], ["dead", "network request failed", "unavailable"],
  ["dead", "42501 permission denied", "permission"], ["failed", "409 state changed", "conflict"],
  ["failed", "network request failed", "unavailable"], ["failed", "temporary", "retry"], ["dead", "exhausted", "dead"],
] as const)("outbox %s/%s reports actionable state", (status, last_error, key) => {
  const strings = getFieldOpsStrings("en");
  const result = describeMobileOutboxEntry({ ...entry, status, last_error }, strings);
  expect(result.status).toBe(strings.actionFeedback[key]);
  if (status === "dead") expect(result.detail).toBe(strings.actionFeedback.deadDetail);
  expect(result.accessibilityLabel).toContain(result.detail);
  expect(result.lines).toContain(strings.actionFeedback.queueReference("queue-a"));
});

test("explicit label and multiselection precedence preserve context without exposing raw errors", () => {
  const result = describeMobileOutboxEntry({ ...entry, status: "failed", last_error: "password=do-not-display",
    args: { p_action_label: "Deliver", p_selection_count: 2, p_selection_id: "single-stale" } }, getFieldOpsStrings("en"));
  expect(result.title).toBe("Deliver");
  expect(result.targetLabel).toBe("2 selected records");
  expect(JSON.stringify(result)).not.toContain("do-not-display");
});

test.each([{ attempted: 0, succeeded: 0, failed: 0, dead: 0 }, undefined, null, { attempted: NaN }, { attempted: -1 }, { attempted: 1, succeeded: 2, failed: 0, dead: 0 }])(
  "missing or inconsistent aggregate result never claims a successful backend batch: %j", value => {
    expect(isMobileOutboxSyncBatchSuccessful(value as any)).toBe(false);
  }
);

test.each(["en", "ar"] as const)("persisted display labels take precedence without changing localized %s status", locale => {
  const strings = getFieldOpsStrings(locale);
  const value = describeMobileOutboxEntry({ ...entry,
    display: { actionLabel: " Saved action ", targetLabel: " Saved target " },
    args: { p_action_label: "legacy action", p_target_label: "legacy target" },
  }, strings);
  expect(value.title).toBe("Saved action");
  expect(value.targetLabel).toBe("Saved target");
  expect(value.status).toBe(strings.actionFeedback.queued);
});

test.each([undefined, null, [], "malformed", { actionLabel: 3, targetLabel: " " }])(
  "absent or malformed optional display retains historical payload fallback: %j", display => {
    const value = describeMobileOutboxEntry({ ...entry, display: display as any,
      args: { p_action_label: "Legacy action", p_target_label: "Legacy target" },
    }, getFieldOpsStrings("en"));
    expect(value.title).toBe("Legacy action");
    expect(value.targetLabel).toBe("Legacy target");
  }
);
