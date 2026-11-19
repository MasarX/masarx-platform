import {
  firstMobileUiEventType,
  normalizeMobileUiEvent,
  normalizeMobileUiEvents,
  resolveMobileUiEventLogReadback,
} from "../../../apps/fieldops/src/mobile-ui-event-log";

describe("mobile UI event log helpers", () => {
  test("normalizes Mobile V2 event_type/metadata payloads to canonical ui_log_events_v1 shape", () => {
    expect(
      normalizeMobileUiEvent({
        event_type: "mobile_route_contact",
        captured_at: "2026-05-29T10:00:00.000Z",
        metadata: {
          app: "fieldops",
          contact_role: "dispatcher",
          route_stop_id: "stop-1",
        },
      })
    ).toEqual({
      type: "mobile_route_contact",
      context: undefined,
      name: undefined,
      message: undefined,
      digest: undefined,
      meta: {
        app: "fieldops",
        contact_role: "dispatcher",
        route_stop_id: "stop-1",
        captured_at: "2026-05-29T10:00:00.000Z",
      },
    });
  });

  test("keeps canonical type/meta fields and filters empty event types", () => {
    expect(
      normalizeMobileUiEvents([
        { type: "mobile_boot", meta: { app: "fieldops" } },
        { event_type: "   ", metadata: { ignored: true } },
      ])
    ).toEqual([
      {
        type: "mobile_boot",
        context: undefined,
        name: undefined,
        message: undefined,
        digest: undefined,
        meta: { app: "fieldops" },
      },
    ]);
  });

  test("reads the first available event type from either payload shape", () => {
    expect(firstMobileUiEventType([{ event_type: "mobile_route_contact" }])).toBe(
      "mobile_route_contact"
    );
    expect(firstMobileUiEventType([{ type: "mobile_boot" }])).toBe("mobile_boot");
    expect(firstMobileUiEventType([{ event_type: "" }])).toBeNull();
  });

  test("requires backend row readback before reporting synced success", () => {
    expect(
      resolveMobileUiEventLogReadback({
        data: 0,
        expectedEventCount: 1,
        recordedAt: "2026-05-29T10:00:00.000Z",
        eventType: "mobile_route_contact",
      })
    ).toEqual({
      status: "readback_mismatch",
      eventCount: 0,
      recordedAt: "2026-05-29T10:00:00.000Z",
      eventType: "mobile_route_contact",
    });

    expect(
      resolveMobileUiEventLogReadback({
        data: 1,
        expectedEventCount: 1,
        recordedAt: "2026-05-29T10:00:00.000Z",
        eventType: "mobile_route_contact",
      }).status
    ).toBe("synced");
  });
});
