import {
  mapRowToTimelineEntry,
  mapRelatedItemsToTimeline,
  isActivityRelatedKey,
} from "../../packages/ui/src/detail/timeline-mapper";

describe("isActivityRelatedKey", () => {
  test("returns true for keys ending with _actions", () => {
    expect(isActivityRelatedKey("shipment_actions")).toBe(true);
    expect(isActivityRelatedKey("order_actions")).toBe(true);
  });

  test("returns true for keys ending with _events", () => {
    expect(isActivityRelatedKey("domain_events")).toBe(true);
  });

  test("returns true for keys ending with _history", () => {
    expect(isActivityRelatedKey("audit_history")).toBe(true);
  });

  test("returns true for keys ending with _timeline", () => {
    expect(isActivityRelatedKey("shipment_timeline")).toBe(true);
  });

  test("returns true for keys ending with _steps", () => {
    expect(isActivityRelatedKey("workflow_run_steps")).toBe(true);
    expect(isActivityRelatedKey("pipeline_steps")).toBe(true);
  });

  test("returns false for non-activity keys", () => {
    expect(isActivityRelatedKey("shipment_items")).toBe(false);
    expect(isActivityRelatedKey("labels")).toBe(false);
    expect(isActivityRelatedKey("boxes")).toBe(false);
    expect(isActivityRelatedKey("clients")).toBe(false);
  });
});

describe("mapRowToTimelineEntry", () => {
  test("maps shipment_actions row with standard fields", () => {
    const row = {
      id: "action-1",
      action_type: "status_update",
      timestamp: "2026-04-10T12:00:00Z",
      canonical_status: "delivered",
      notes: "Package delivered to door",
      performed_by_user_id: "user-42",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.id).toBe("action-1");
    expect(entry.type).toBe("status_update");
    expect(entry.timestamp).toBe("2026-04-10T12:00:00Z");
    expect(entry.label).toBe("delivered");
    expect(entry.description).toBe("Package delivered to door");
    expect(entry.actor).toBe("user-42");
    expect(entry.tone).toBe("success");
  });

  test("maps row with event_id and event_type fields", () => {
    const row = {
      event_id: "evt-1",
      event_type: "webhook_sent",
      event_time: "2026-04-10T13:00:00Z",
      summary: "Webhook dispatched",
      actor: "system",
      correlation_id: "corr-abc",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.id).toBe("evt-1");
    expect(entry.type).toBe("webhook_sent");
    expect(entry.timestamp).toBe("2026-04-10T13:00:00Z");
    expect(entry.description).toBe("Webhook dispatched");
    expect(entry.actor).toBe("system");
    expect(entry.traceId).toBe("corr-abc");
  });

  test("falls back to index for id when missing", () => {
    const row = {
      action_type: "created",
      timestamp: "2026-04-10T14:00:00Z",
    };
    const entry = mapRowToTimelineEntry(row, 5);
    expect(entry.id).toBe("5");
  });

  test("resolves danger tone for failed status", () => {
    const row = {
      id: "a1",
      action_type: "delivery_attempt",
      timestamp: "2026-04-10T14:00:00Z",
      canonical_status: "failed",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.tone).toBe("danger");
  });

  test("resolves warning tone for exception status", () => {
    const row = {
      id: "a2",
      action_type: "investigation",
      timestamp: "2026-04-10T14:00:00Z",
      canonical_status: "exception",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.tone).toBe("warning");
  });

  test("resolves info tone for in_transit status", () => {
    const row = {
      id: "a3",
      action_type: "scan",
      timestamp: "2026-04-10T14:00:00Z",
      canonical_status: "in_transit",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.tone).toBe("info");
  });

  test("resolves neutral tone for unknown status", () => {
    const row = {
      id: "a4",
      action_type: "custom_event",
      timestamp: "2026-04-10T14:00:00Z",
      canonical_status: "some_unknown_status",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.tone).toBe("neutral");
  });

  test("maps workflow_run_steps row with step-specific fields", () => {
    const row = {
      id: "step-1",
      operation_name: "validate_address",
      step_status: "completed",
      enqueued_at: "2026-04-10T12:00:00Z",
      operation_started_at: "2026-04-10T12:00:01Z",
      operation_completed_at: "2026-04-10T12:00:03Z",
      duration_ms: 2000,
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.id).toBe("step-1");
    expect(entry.type).toBe("validate_address");
    expect(entry.timestamp).toBe("2026-04-10T12:00:00Z");
    expect(entry.label).toBe("completed");
    expect(entry.tone).toBe("success");
  });

  test("resolves info tone for running step_status", () => {
    const row = {
      id: "step-2",
      operation_name: "send_webhook",
      step_status: "running",
      enqueued_at: "2026-04-10T12:00:00Z",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.tone).toBe("info");
  });

  test("resolves warning tone for queued step_status", () => {
    const row = {
      id: "step-3",
      operation_name: "generate_label",
      step_status: "queued",
      enqueued_at: "2026-04-10T12:00:00Z",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.tone).toBe("warning");
  });

  test("resolves danger tone for timed_out step_status", () => {
    const row = {
      id: "step-4",
      operation_name: "external_api_call",
      step_status: "timed_out",
      enqueued_at: "2026-04-10T12:00:00Z",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.tone).toBe("danger");
  });

  test("includes all row fields in metadata", () => {
    const row = {
      id: "a5",
      action_type: "pickup",
      timestamp: "2026-04-10T14:00:00Z",
      location_type: "warehouse",
      extra_field: "extra_value",
    };
    const entry = mapRowToTimelineEntry(row, 0);
    expect(entry.metadata).toMatchObject({
      id: "a5",
      action_type: "pickup",
      location_type: "warehouse",
      extra_field: "extra_value",
    });
  });
});

describe("mapRelatedItemsToTimeline", () => {
  test("returns empty array for empty input", () => {
    expect(mapRelatedItemsToTimeline([])).toEqual([]);
  });

  test("sorts entries newest-first by timestamp", () => {
    const items = [
      { id: "old", action_type: "created", timestamp: "2026-04-08T10:00:00Z" },
      { id: "new", action_type: "delivered", timestamp: "2026-04-10T10:00:00Z" },
      { id: "mid", action_type: "dispatched", timestamp: "2026-04-09T10:00:00Z" },
    ];
    const entries = mapRelatedItemsToTimeline(items);
    expect(entries.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  test("maps all items to TimelineEntry objects", () => {
    const items = [
      {
        id: "a1",
        action_type: "status_update",
        timestamp: "2026-04-10T12:00:00Z",
        canonical_status: "delivered",
        notes: "At door",
      },
      {
        id: "a2",
        action_type: "scan",
        timestamp: "2026-04-10T11:00:00Z",
        canonical_status: "in_transit",
      },
    ];
    const entries = mapRelatedItemsToTimeline(items);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe("a1");
    expect(entries[0]!.tone).toBe("success");
    expect(entries[1]!.id).toBe("a2");
    expect(entries[1]!.tone).toBe("info");
  });
});
