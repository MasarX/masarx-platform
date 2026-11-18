import { buildMobileScanOutboxEntry } from "../../../apps/fieldops/src/mobile-scan-outbox";

describe("mobile scan outbox payload contract", () => {
  test("builds one idempotent record_scan_event payload with route and stop projection context", () => {
    const entry = buildMobileScanOutboxEntry({
      id: "scan-queue-1",
      deviceId: "device-1",
      scanType: " DELIVERY_ATTEMPT ",
      barcode: " BOX-1 ",
      scanInputMode: "scanner",
      capturedAt: "2026-04-19T00:00:00.000Z",
      activeOpsSessionId: "ops-session-1",
      scanContext: {
        label: "Stop 1",
        taskId: "task-1",
        resourceId: "resource-1",
        routeRunId: "route-run-1",
        routeStopId: "route-stop-1",
        shipmentId: "shipment-1",
        clientId: "client-1",
        opsSessionId: "ops-session-from-context",
        reference: "REF-1",
        customerName: "Customer One",
      },
      attestation: {
        provider: "android_play_integrity",
        challenge_id: "challenge-1",
        challenge: "nonce",
        generated_at: "2026-04-19T00:00:00.000Z",
        integrity_token: "token",
      },
    });

    expect(entry).toEqual({
      id: "scan-queue-1",
      rpc: "record_scan_event_v1",
      args: {
        p_scan: {
          idempotency_key: "scan-queue-1",
          scan_type: "delivery_attempt",
          barcode: "BOX-1",
          device_id: "device-1",
          route_run_id: "route-run-1",
          route_stop_id: "route-stop-1",
          shipment_id: "shipment-1",
          client_id: "client-1",
          ops_session_id: "ops-session-1",
          captured_at: "2026-04-19T00:00:00.000Z",
          metadata: {
            app: "fieldops",
            source: "mobile",
            scan_input_mode: "scanner",
            context: {
              label: "Stop 1",
              task_id: "task-1",
              resource_id: "resource-1",
              route_run_id: "route-run-1",
              route_stop_id: "route-stop-1",
              reference: "REF-1",
              customer_name: "Customer One",
            },
            attestation: {
              provider: "android_play_integrity",
              challenge_id: "challenge-1",
              challenge: "nonce",
              generated_at: "2026-04-19T00:00:00.000Z",
              integrity_token: "token",
            },
          },
        },
      },
    });
  });

  test("keeps shipment/client coupled and never emits blank optional IDs", () => {
    expect(() =>
      buildMobileScanOutboxEntry({
        id: "scan-queue-2",
        deviceId: "device-2",
        scanType: "delivered",
        barcode: "BOX-2",
        scanInputMode: "camera",
        capturedAt: "2026-04-19T00:01:00.000Z",
        scanContext: {
          shipmentId: "shipment-2",
          clientId: " ",
        },
      }),
    ).toThrow("shipment id and client id together");

    const entry = buildMobileScanOutboxEntry({
      id: "scan-queue-2b",
      deviceId: "device-2",
      scanType: "delivered",
      barcode: "BOX-2",
      scanInputMode: "camera",
      capturedAt: "2026-04-19T00:01:00.000Z",
      scanContext: {
        routeRunId: "",
        routeStopId: null,
      },
    });

    const payload = entry.args.p_scan as Record<string, unknown>;
    expect(payload).not.toHaveProperty("shipment_id");
    expect(payload).not.toHaveProperty("client_id");
    expect(payload).not.toHaveProperty("route_run_id");
    expect(payload).not.toHaveProperty("route_stop_id");
    expect(payload).not.toHaveProperty("ops_session_id");
  });

  test("uses the trimmed outbox id as the canonical scan idempotency key", () => {
    const input = {
      id: " scan-queue-5 ",
      deviceId: " device-5 ",
      scanType: " LOAD ",
      barcode: " BOX-5 ",
      scanInputMode: "scanner" as const,
      capturedAt: " 2026-04-19T00:03:00.000Z ",
      scanContext: {
        label: "  Route load  ",
        taskId: " task-5 ",
        resourceId: " resource-5 ",
        reference: " REF-5 ",
        customerName: " Customer Five ",
        opsSessionId: " ops-session-5 ",
      },
    };

    const first = buildMobileScanOutboxEntry(input);
    const second = buildMobileScanOutboxEntry(input);
    const payload = first.args.p_scan as Record<string, any>;

    expect(first).toEqual(second);
    expect(first.id).toBe("scan-queue-5");
    expect(payload.idempotency_key).toBe("scan-queue-5");
    expect(payload).not.toHaveProperty("id");
    expect(payload.device_id).toBe("device-5");
    expect(payload.scan_type).toBe("load");
    expect(payload.barcode).toBe("BOX-5");
    expect(payload.captured_at).toBe("2026-04-19T00:03:00.000Z");
    expect(payload.ops_session_id).toBe("ops-session-5");
    expect(payload.metadata).toEqual({
      app: "fieldops",
      source: "mobile",
      scan_input_mode: "scanner",
      context: {
        label: "Route load",
        task_id: "task-5",
        resource_id: "resource-5",
        route_run_id: null,
        route_stop_id: null,
        reference: "REF-5",
        customer_name: "Customer Five",
      },
    });
  });

  test("fails fast before a malformed offline scan can enter the outbox", () => {
    expect(() =>
      buildMobileScanOutboxEntry({
        id: "scan-queue-3",
        deviceId: "device-3",
        scanType: " ",
        barcode: "BOX-3",
        scanInputMode: "scanner",
        capturedAt: "2026-04-19T00:02:00.000Z",
      }),
    ).toThrow("scan type");

    expect(() =>
      buildMobileScanOutboxEntry({
        id: "scan-queue-4",
        deviceId: " ",
        scanType: "delivered",
        barcode: "BOX-4",
        scanInputMode: "scanner",
        capturedAt: "2026-04-19T00:02:00.000Z",
      }),
    ).toThrow("device id");
  });
});
