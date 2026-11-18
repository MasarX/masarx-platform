import {
  buildMobileRouteDepartureCommand,
  buildMobileRouteScanOutboxCommand,
  isRouteLoadScanoutContext,
  mergeMobileRouteExecutionManifestReadback,
  resolveMobileRouteExecutionManifestRouteRunId,
} from "../../../apps/fieldops/src/mobile-route-scanout";

describe("mobile route scanout outbox command", () => {
  test("uses the canonical route scanout command for route-level load scans", () => {
    const command = buildMobileRouteScanOutboxCommand({
      id: " scan-1 ",
      scanType: " load ",
      barcode: " SHIP-001 ",
      deviceId: " device-1 ",
      scanInputMode: " camera ",
      capturedAt: " 2026-06-30T09:00:00.000Z ",
      activeOpsSessionId: "shift-1",
      attestation: { provider: "android_play_integrity", challenge_id: "challenge-1" },
      scanContext: {
        label: "Route load",
        resourceId: "route-run-1",
        routeRunId: "route-run-1",
        routeStopId: null,
        taskId: null,
        opsSessionId: "context-shift",
        reference: "R-001",
        customerName: null,
      },
    });

    expect(command).toEqual({
      rpc: "ui_execute_route_run_scanout_v1",
      args: {
        p_action_key: "routes.scan_load",
        p_resource_key: "routes",
        p_selection_ids: ["route-run-1"],
        p_selection_id: "route-run-1",
        p_selection_count: 1,
        p_params: {
          idempotency_key: "scan-1",
          scan_type: "load",
          barcode: "SHIP-001",
          device_id: "device-1",
          ops_session_id: "shift-1",
          captured_at: "2026-06-30T09:00:00.000Z",
          metadata: {
            app: "fieldops",
            source: "mobile",
            scan_input_mode: "camera",
            context: {
              label: "Route load",
              task_id: null,
              resource_id: "route-run-1",
              route_run_id: "route-run-1",
              route_stop_id: null,
              shipment_id: null,
              client_id: null,
              ops_session_id: "context-shift",
              reference: "R-001",
              customer_name: null,
              route_departure_confirmed_at: null,
            },
            attestation: {
              provider: "android_play_integrity",
              challenge_id: "challenge-1",
            },
          },
        },
      },
    });
  });

  test("fails closed before enqueueing route-level load scanout after departure confirmation", () => {
    expect(() =>
      buildMobileRouteScanOutboxCommand({
        id: "scan-after-departure",
        scanType: "load",
        barcode: "SHIP-001",
        deviceId: "device-1",
        scanInputMode: "camera",
        capturedAt: "2026-06-30T09:00:00.000Z",
        scanContext: {
          routeRunId: "route-run-1",
          routeStopId: null,
          routeDepartureConfirmedAt: "2026-07-02T09:00:00.000Z",
        },
      })
    ).toThrow("route_departure_confirmed");
  });

  test("fails closed before enqueueing route-level load scanout with missing scan evidence", () => {
    expect(() =>
      buildMobileRouteScanOutboxCommand({
        id: " ",
        scanType: "load",
        barcode: "SHIP-001",
        deviceId: "device-1",
        scanInputMode: "camera",
        capturedAt: "2026-06-30T09:00:00.000Z",
        scanContext: {
          routeRunId: "route-run-1",
          routeStopId: null,
        },
      })
    ).toThrow("idempotency_key_required");

    expect(() =>
      buildMobileRouteScanOutboxCommand({
        id: "scan-missing-barcode",
        scanType: "load",
        barcode: " ",
        deviceId: "device-1",
        scanInputMode: "camera",
        capturedAt: "2026-06-30T09:00:00.000Z",
        scanContext: {
          routeRunId: "route-run-1",
          routeStopId: null,
        },
      })
    ).toThrow("barcode_required");

    expect(() =>
      buildMobileRouteScanOutboxCommand({
        id: "scan-missing-device",
        scanType: "load",
        barcode: "SHIP-001",
        deviceId: " ",
        scanInputMode: "camera",
        capturedAt: "2026-06-30T09:00:00.000Z",
        scanContext: {
          routeRunId: "route-run-1",
          routeStopId: null,
        },
      })
    ).toThrow("device_id_required");

    expect(() =>
      buildMobileRouteScanOutboxCommand({
        id: "scan-missing-captured-at",
        scanType: "load",
        barcode: "SHIP-001",
        deviceId: "device-1",
        scanInputMode: "camera",
        capturedAt: " ",
        scanContext: {
          routeRunId: "route-run-1",
          routeStopId: null,
        },
      })
    ).toThrow("captured_at_required");

    expect(() =>
      buildMobileRouteScanOutboxCommand({
        id: "scan-invalid-captured-at",
        scanType: "load",
        barcode: "SHIP-001",
        deviceId: "device-1",
        scanInputMode: "camera",
        capturedAt: "not-a-timestamp",
        scanContext: {
          routeRunId: "route-run-1",
          routeStopId: null,
        },
      })
    ).toThrow("captured_at_invalid");

    expect(() =>
      buildMobileRouteScanOutboxCommand({
        id: "scan-missing-mode",
        scanType: "load",
        barcode: "SHIP-001",
        deviceId: "device-1",
        scanInputMode: " ",
        capturedAt: "2026-06-30T09:00:00.000Z",
        scanContext: {
          routeRunId: "route-run-1",
          routeStopId: null,
        },
      })
    ).toThrow("scan_input_mode_required");
  });

  test("keeps stop-level scans on the scan event ledger RPC", () => {
    const command = buildMobileRouteScanOutboxCommand({
      id: " scan-2 ",
      scanType: "load",
      barcode: " SHIP-002 ",
      deviceId: " device-1 ",
      scanInputMode: " manual ",
      capturedAt: " 2026-06-30T09:05:00.000Z ",
      scanContext: {
        label: "Stop load",
        routeRunId: "route-run-1",
        routeStopId: "route-stop-1",
        shipmentId: "shipment-1",
        clientId: "client-1",
        opsSessionId: "shift-1",
      },
    });

    expect(command.rpc).toBe("record_scan_event_v1");
    expect(command.args).toMatchObject({
      p_scan: {
        idempotency_key: "scan-2",
        scan_type: "load",
        barcode: "SHIP-002",
        device_id: "device-1",
        route_run_id: "route-run-1",
        route_stop_id: "route-stop-1",
        shipment_id: "shipment-1",
        client_id: "client-1",
        ops_session_id: "shift-1",
        captured_at: "2026-06-30T09:05:00.000Z",
        metadata: {
          scan_input_mode: "manual",
          context: {
            route_run_id: "route-run-1",
            route_stop_id: "route-stop-1",
            shipment_id: "shipment-1",
            client_id: "client-1",
            ops_session_id: "shift-1",
          },
        },
      },
    });
  });

  test("fails closed before enqueueing stop-level scans with missing scan evidence", () => {
    const baseInput = {
      id: "scan-stop-1",
      scanType: "load",
      barcode: "SHIP-002",
      deviceId: "device-1",
      scanInputMode: "manual",
      capturedAt: "2026-06-30T09:05:00.000Z",
      scanContext: {
        routeRunId: "route-run-1",
        routeStopId: "route-stop-1",
      },
    };

    expect(() =>
      buildMobileRouteScanOutboxCommand({
        ...baseInput,
        id: " ",
      })
    ).toThrow("idempotency_key_required");
    expect(() =>
      buildMobileRouteScanOutboxCommand({
        ...baseInput,
        barcode: " ",
      })
    ).toThrow("barcode_required");
    expect(() =>
      buildMobileRouteScanOutboxCommand({
        ...baseInput,
        deviceId: " ",
      })
    ).toThrow("device_id_required");
    expect(() =>
      buildMobileRouteScanOutboxCommand({
        ...baseInput,
        capturedAt: " ",
      })
    ).toThrow("captured_at_required");
    expect(() =>
      buildMobileRouteScanOutboxCommand({
        ...baseInput,
        capturedAt: "not-a-timestamp",
      })
    ).toThrow("captured_at_invalid");
    expect(() =>
      buildMobileRouteScanOutboxCommand({
        ...baseInput,
        scanInputMode: " ",
      })
    ).toThrow("scan_input_mode_required");
  });

  test("detects only route-level load scans as route scanout context", () => {
    expect(
      isRouteLoadScanoutContext({
        scanType: "load",
        scanContext: { routeRunId: "route-run-1", routeStopId: null },
      })
    ).toBe(true);
    expect(
      isRouteLoadScanoutContext({
        scanType: "delivery",
        scanContext: { routeRunId: "route-run-1", routeStopId: null },
      })
    ).toBe(false);
    expect(
      isRouteLoadScanoutContext({
        scanType: "load",
        scanContext: { routeRunId: "route-run-1", routeStopId: "route-stop-1" },
      })
    ).toBe(false);
  });

  test("uses the canonical route scanout command for departure confirmation", () => {
    const command = buildMobileRouteDepartureCommand({
      routeRunId: " route-run-1 ",
      routeStopId: " route-stop-1 ",
      taskId: " task-1 ",
      opsSessionId: " shift-1 ",
      attestation: { provider: "android_play_integrity", challenge_id: "challenge-1" },
    });

    expect(command).toEqual({
      rpc: "ui_execute_route_run_scanout_v1",
      args: {
        p_action_key: "routes.confirm_departure",
        p_resource_key: "routes",
        p_selection_ids: ["route-run-1"],
        p_selection_id: "route-run-1",
        p_selection_count: 1,
        p_params: {
          route_stop_id: "route-stop-1",
          task_id: "task-1",
          ops_session_id: "shift-1",
          metadata: {
            app: "fieldops",
            source: "mobile",
            action_key: "routes.confirm_departure",
            context: {
              route_run_id: "route-run-1",
              route_stop_id: "route-stop-1",
              task_id: "task-1",
              ops_session_id: "shift-1",
            },
            attestation: {
              provider: "android_play_integrity",
              challenge_id: "challenge-1",
            },
          },
        },
      },
    });
  });

  test("fails closed before enqueueing departure confirmation without route-run scope", () => {
    expect(() =>
      buildMobileRouteDepartureCommand({
        routeRunId: " ",
        routeStopId: "route-stop-1",
        taskId: "task-1",
        opsSessionId: "shift-1",
      })
    ).toThrow("route_run_id_required");
  });

  test("merges departure readback into the current route execution manifest", () => {
    expect(
      mergeMobileRouteExecutionManifestReadback({
        routeRunId: " route-run-1 ",
        current: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: true,
            scanned_stop_count: 3,
          },
          route_departure: {},
          stop_count: 3,
        },
        result: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: true,
            scanned_stop_count: 3,
            missing_stop_count: 0,
          },
          route_departure: {
            confirmed_at: "2026-07-02T09:00:00.000Z",
            confirmed_by_user_id: "driver-1",
          },
        },
      })
    ).toEqual({
      route_run_id: "route-run-1",
      scan_out: {
        ready_for_departure: true,
        scanned_stop_count: 3,
        missing_stop_count: 0,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
        missing_route_stop_ids: [],
        unexpected_barcodes: [],
        duplicate_route_stop_ids: [],
      },
      route_departure: {
        confirmed_at: "2026-07-02T09:00:00.000Z",
        confirmed_by_user_id: "driver-1",
      },
      stop_count: 3,
    });
  });

  test("uses canonical manifest readback when the departure RPC returns one", () => {
    expect(
      mergeMobileRouteExecutionManifestReadback({
        current: {
          route_run_id: "route-run-1",
          scan_out: { ready_for_departure: false },
        },
        result: {
          route_execution_manifest: {
            route_run_id: "route-run-1",
            scan_out: {
              ready_for_departure: true,
              scanned_stop_count: 3,
              expected_stop_count: 3,
              missing_stop_count: 0,
            },
            route_departure: {
              confirmed_at: "2026-07-02T09:00:00.000Z",
              confirmed_by_user_id: "driver-1",
            },
          },
          scan_out: {
            ready_for_departure: true,
          },
        },
      })
    ).toEqual({
      route_run_id: "route-run-1",
      scan_out: {
        ready_for_departure: true,
        scanned_stop_count: 3,
        expected_stop_count: 3,
        missing_stop_count: 0,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
        missing_route_stop_ids: [],
        unexpected_barcodes: [],
        duplicate_route_stop_ids: [],
      },
      route_departure: {
        confirmed_at: "2026-07-02T09:00:00.000Z",
        confirmed_by_user_id: "driver-1",
      },
    });
  });

  test("prefers canonical manifest readback over stale top-level route scanout fields", () => {
    expect(
      mergeMobileRouteExecutionManifestReadback({
        current: {
          route_run_id: "route-run-1",
          stop_count: 3,
          scan_out: {
            ready_for_departure: false,
            expected_stop_count: 3,
            scanned_stop_count: 1,
            missing_stop_count: 2,
          },
        },
        result: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: false,
            expected_stop_count: 3,
            scanned_stop_count: 1,
            missing_stop_count: 2,
            unexpected_scan_count: 1,
            duplicate_scan_count: 1,
            unexpected_barcodes: ["STALE-BARCODE"],
            duplicate_route_stop_ids: ["stale-duplicate"],
          },
          route_departure: {
            confirmed_at: null,
            confirmed_by_user_id: "driver-1",
          },
          route_execution_manifest: {
            route_run_id: "route-run-1",
            scan_out: {
              ready_for_departure: true,
              expected_stop_count: 3,
              scanned_stop_count: 3,
              missing_stop_count: 0,
              unexpected_scan_count: 0,
              duplicate_scan_count: 0,
            },
            route_departure: {
              confirmed_at: "2026-07-02T09:00:00.000Z",
            },
          },
        },
      })
    ).toEqual({
      route_run_id: "route-run-1",
      stop_count: 3,
      scan_out: {
        ready_for_departure: true,
        expected_stop_count: 3,
        scanned_stop_count: 3,
        missing_stop_count: 0,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
        unexpected_barcodes: [],
        duplicate_route_stop_ids: [],
        missing_route_stop_ids: [],
      },
      route_departure: {
        confirmed_at: "2026-07-02T09:00:00.000Z",
        confirmed_by_user_id: "driver-1",
      },
    });
  });

  test("clears stale scanout blockers when confirmed departure readback is cached", () => {
    expect(
      mergeMobileRouteExecutionManifestReadback({
        current: {
          route_run_id: "route-run-1",
          stop_count: 3,
          scan_out: {
            ready_for_departure: false,
            expected_stop_count: 3,
            scanned_stop_count: 1,
            missing_stop_count: 2,
            unexpected_scan_count: 1,
            duplicate_scan_count: 1,
            missing_route_stop_ids: ["stale-stop"],
            unexpected_barcodes: ["STALE-BARCODE"],
            duplicate_route_stop_ids: ["stale-duplicate"],
          },
        },
        result: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: false,
            expected_stop_count: 3,
            scanned_stop_count: 1,
            missing_stop_count: 2,
            unexpected_scan_count: 1,
            duplicate_scan_count: 1,
            missing_route_stop_ids: ["stale-stop"],
            unexpected_barcodes: ["STALE-BARCODE"],
            duplicate_route_stop_ids: ["stale-duplicate"],
          },
          route_departure: {
            confirmed_at: "2026-07-02T09:00:00.000Z",
            confirmed_by_user_id: "driver-1",
          },
        },
      })
    ).toMatchObject({
      route_run_id: "route-run-1",
      scan_out: {
        ready_for_departure: true,
        expected_stop_count: 3,
        scanned_stop_count: 3,
        missing_stop_count: 0,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
        missing_route_stop_ids: [],
        unexpected_barcodes: [],
        duplicate_route_stop_ids: [],
      },
      route_departure: {
        confirmed_at: "2026-07-02T09:00:00.000Z",
        confirmed_by_user_id: "driver-1",
      },
    });
  });

  test("merges route load readback when the RPC returns an array row", () => {
    expect(
      mergeMobileRouteExecutionManifestReadback({
        current: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: false,
            scanned_stop_count: 1,
            missing_stop_count: 2,
          },
        },
        result: [
          {
            route_run_id: "route-run-1",
            scan_out: {
              ready_for_departure: true,
              scanned_stop_count: 3,
              missing_stop_count: 0,
              unexpected_scan_count: 0,
              duplicate_scan_count: 0,
            },
            route_execution_manifest: {
              route_run_id: "route-run-1",
              scan_out: {
                ready_for_departure: true,
                scanned_stop_count: 3,
              },
            },
          },
        ],
      })
    ).toEqual({
      route_run_id: "route-run-1",
      scan_out: {
        ready_for_departure: true,
        scanned_stop_count: 3,
        missing_stop_count: 0,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
      },
    });
  });

  test("uses the first actionable route scanout row from array-shaped readback", () => {
    expect(
      mergeMobileRouteExecutionManifestReadback({
        current: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: false,
            scanned_stop_count: 1,
            missing_stop_count: 2,
          },
        },
        result: [
          {
            status: "accepted",
          },
          {
            route_execution_manifest: {
              route_run_id: "route-run-1",
              scan_out: {
                ready_for_departure: true,
                scanned_stop_count: 3,
                expected_stop_count: 3,
                missing_stop_count: 0,
              },
            },
            route_departure: {
              confirmed_at: "2026-07-02T09:00:00.000Z",
            },
          },
        ],
      })
    ).toEqual({
      route_run_id: "route-run-1",
      scan_out: {
        ready_for_departure: true,
        scanned_stop_count: 3,
        expected_stop_count: 3,
        missing_stop_count: 0,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
        missing_route_stop_ids: [],
        unexpected_barcodes: [],
        duplicate_route_stop_ids: [],
      },
      route_departure: {
        confirmed_at: "2026-07-02T09:00:00.000Z",
      },
    });
  });

  test("resolves route run id from array-shaped route scanout readback", () => {
    expect(
      resolveMobileRouteExecutionManifestRouteRunId({
        result: [
          {
            route_execution_manifest: {
              route_run_id: "route-run-from-array",
              scan_out: {
                ready_for_departure: true,
              },
            },
          },
        ],
      })
    ).toBe("route-run-from-array");

    expect(
      resolveMobileRouteExecutionManifestRouteRunId({
        routeRunId: " selected-route-run ",
        result: [{ route_run_id: "route-run-from-array" }],
      })
    ).toBe("selected-route-run");
  });

  test("resolves route run id from the first actionable array readback row", () => {
    expect(
      resolveMobileRouteExecutionManifestRouteRunId({
        result: [
          {
            status: "accepted",
          },
          {
            route_execution_manifest: {
              route_run_id: "route-run-from-manifest",
            },
          },
        ],
      })
    ).toBe("route-run-from-manifest");
  });
});
