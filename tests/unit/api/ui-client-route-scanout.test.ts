import { createUiClientFromSupabase } from "../../../packages/api/src/ui-client";

describe("createUiClientFromSupabase route scanout helpers", () => {
  test("scanRouteLoad sends scan context through the canonical route scanout RPC", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        status: "route_load_scan_recorded",
        action_key: "routes.scan_load",
        resource_key: "routes",
        route_run_id: "route-run-1",
        route_stop_id: "route-stop-1",
        scan_event_id: "scan-event-1",
        scan_created: true,
        scan_out: {
          scanned_stop_count: 1,
          missing_stop_count: 2,
          unexpected_scan_count: 0,
          duplicate_scan_count: 0,
          last_load_scanned_at: "2026-06-30T08:00:00.000Z",
          ready_for_departure: false,
        },
        route_execution_manifest: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: false,
          },
        },
        count: 1,
        items: [
          {
            route_run_id: "route-run-1",
            route_stop_id: "route-stop-1",
            scan_event_id: "scan-event-1",
            scan_created: true,
          },
        ],
      },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    const result = await uiClient.scanRouteLoad({
      routeRunId: "route-run-1",
      routeStopId: "route-stop-1",
      branchId: "branch-1",
      barcode: "SHIP-001",
      deviceId: "device-1",
      opsSessionId: "ops-session-1",
      capturedAt: "2026-06-30T08:00:00.000Z",
      lat: 24.7136,
      lng: 46.6753,
      accuracyM: 12,
      notes: "Loaded at dock 3",
      idempotencyKey: "route-load-ui:route-run-1:SHIP-001",
      metadata: { source: "fieldops-scan" },
    });

    expect(result).toMatchObject({
      status: "route_load_scan_recorded",
      action_key: "routes.scan_load",
      resource_key: "routes",
      route_run_id: "route-run-1",
      route_stop_id: "route-stop-1",
      scan_event_id: "scan-event-1",
      scan_created: true,
      scan_out: {
        scanned_stop_count: 1,
        missing_stop_count: 2,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
        last_load_scanned_at: "2026-06-30T08:00:00.000Z",
        ready_for_departure: false,
      },
      route_execution_manifest: {
        route_run_id: "route-run-1",
        scan_out: {
          ready_for_departure: false,
        },
      },
      count: 1,
      items: [
        {
          route_run_id: "route-run-1",
          route_stop_id: "route-stop-1",
          scan_event_id: "scan-event-1",
          scan_created: true,
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.scan_load",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        barcode: "SHIP-001",
        route_stop_id: "route-stop-1",
        branch_id: "branch-1",
        device_id: "device-1",
        ops_session_id: "ops-session-1",
        captured_at: "2026-06-30T08:00:00.000Z",
        lat: 24.7136,
        lng: 46.6753,
        accuracy_m: 12,
        notes: "Loaded at dock 3",
        idempotency_key: "route-load-ui:route-run-1:SHIP-001",
        metadata: { source: "fieldops-scan" },
      },
    });
  });

  test("scanRouteLoad preserves duplicate scan reconciliation readback from the canonical RPC", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        status: "route_load_scan_recorded",
        action_key: "routes.scan_load",
        resource_key: "routes",
        route_run_id: "route-run-1",
        route_stop_id: "route-stop-2",
        scan_event_id: "scan-event-duplicate",
        scan_created: true,
        scan_out: {
          scanned_stop_count: 3,
          missing_stop_count: 0,
          unexpected_scan_count: 0,
          duplicate_scan_count: 1,
          duplicate_route_stop_ids: ["route-stop-2"],
          ready_for_departure: false,
        },
        route_execution_manifest: {
          route_run_id: "route-run-1",
          scan_out: {
            duplicate_scan_count: 1,
            duplicate_route_stop_ids: ["route-stop-2"],
            ready_for_departure: false,
          },
        },
        count: 1,
        items: [
          {
            route_run_id: "route-run-1",
            route_stop_id: "route-stop-2",
            scan_event_id: "scan-event-duplicate",
            scan_created: true,
            scan_out: {
              duplicate_scan_count: 1,
              duplicate_route_stop_ids: ["route-stop-2"],
              ready_for_departure: false,
            },
          },
        ],
      },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await expect(
      uiClient.scanRouteLoad({
        routeRunId: "route-run-1",
        routeStopId: "route-stop-2",
        barcode: "SHIP-002",
      })
    ).resolves.toMatchObject({
      status: "route_load_scan_recorded",
      scan_out: {
        missing_stop_count: 0,
        duplicate_scan_count: 1,
        unexpected_scan_count: 0,
        duplicate_route_stop_ids: ["route-stop-2"],
        ready_for_departure: false,
      },
      route_execution_manifest: {
        scan_out: {
          duplicate_scan_count: 1,
          duplicate_route_stop_ids: ["route-stop-2"],
          ready_for_departure: false,
        },
      },
      items: [
        {
          scan_event_id: "scan-event-duplicate",
          scan_out: {
            duplicate_scan_count: 1,
            duplicate_route_stop_ids: ["route-stop-2"],
            ready_for_departure: false,
          },
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.scan_load",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        barcode: "SHIP-002",
        route_stop_id: "route-stop-2",
        branch_id: null,
        device_id: null,
        ops_session_id: null,
        captured_at: null,
        lat: null,
        lng: null,
        accuracy_m: null,
        notes: null,
        idempotency_key: null,
        metadata: {},
      },
    });
  });

  test("scanRouteLoad normalizes route scan input before mutation", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: { status: "route_load_scan_recorded" },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await uiClient.scanRouteLoad({
      routeRunId: " route-run-1 ",
      barcode: " SHIP-001 ",
      routeStopId: " route-stop-1 ",
      branchId: " branch-1 ",
      deviceId: " device-1 ",
      opsSessionId: " ops-session-1 ",
      notes: " Loaded at dock 3 ",
      idempotencyKey: " route-load-ui:route-run-1:SHIP-001 ",
    });

    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.scan_load",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: expect.objectContaining({
        barcode: "SHIP-001",
        route_stop_id: "route-stop-1",
        branch_id: "branch-1",
        device_id: "device-1",
        ops_session_id: "ops-session-1",
        notes: "Loaded at dock 3",
        idempotency_key: "route-load-ui:route-run-1:SHIP-001",
      }),
    });
  });

  test("scanRouteLoad keeps the canonical action and resource fixed", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: { status: "route_load_scan_recorded" },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await uiClient.scanRouteLoad({
      routeRunId: "route-run-1",
      barcode: "SHIP-001",
      actionKey: "routes.confirm_departure",
      resourceKey: "route_stops",
    } as any);

    expect(rpc).toHaveBeenCalledWith(
      "ui_execute_route_run_scanout_v1",
      expect.objectContaining({
        p_action_key: "routes.scan_load",
        p_resource_key: "routes",
      })
    );
  });

  test("scanRouteLoad fails closed before RPC for missing route run or barcode", () => {
    const rpc = jest.fn();
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    expect(() =>
      uiClient.scanRouteLoad({
        routeRunId: " ",
        barcode: "SHIP-001",
      })
    ).toThrow("route_run_id_required");
    expect(() =>
      uiClient.scanRouteLoad({
        routeRunId: "route-run-1",
        barcode: " ",
      })
    ).toThrow("barcode_required");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("scanRouteLoad propagates scan-event scope errors from the canonical RPC", async () => {
    const scanScopeError = {
      code: "42501",
      message: "record_scan_event_v1 device_id is not owned by current user",
    };
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: scanScopeError,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await expect(
      uiClient.scanRouteLoad({
        routeRunId: "route-run-1",
        routeStopId: "route-stop-1",
        barcode: "SHIP-001",
        deviceId: "device-outside-route",
      })
    ).rejects.toMatchObject(scanScopeError);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.scan_load",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        barcode: "SHIP-001",
        route_stop_id: "route-stop-1",
        branch_id: null,
        device_id: "device-outside-route",
        ops_session_id: null,
        captured_at: null,
        lat: null,
        lng: null,
        accuracy_m: null,
        notes: null,
        idempotency_key: null,
        metadata: {},
      },
    });
  });

  test("confirmRouteDeparture sends departure context through the canonical route scanout RPC", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        status: "route_departure_confirmed",
        action_key: "routes.confirm_departure",
        resource_key: "routes",
        route_run_id: "route-run-1",
        route_stop_id: "route-stop-1",
        task_id: "task-1",
        scan_out: {
          scanned_stop_count: 3,
          missing_stop_count: 0,
          unexpected_scan_count: 0,
          duplicate_scan_count: 0,
          last_load_scanned_at: "2026-06-30T08:12:00.000Z",
          ready_for_departure: true,
        },
        route_departure: {
          confirmed_at: "2026-06-30T08:15:00.000Z",
          confirmed_by: "operator-1",
          ops_session_id: "ops-session-1",
        },
        route_execution_manifest: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: true,
          },
          route_departure: {
            confirmed_at: "2026-06-30T08:15:00.000Z",
          },
        },
        count: 1,
        items: [
          {
            route_run_id: "route-run-1",
            status: "route_departure_confirmed",
            route_departure: {
              confirmed_at: "2026-06-30T08:15:00.000Z",
            },
          },
        ],
      },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    const result = await uiClient.confirmRouteDeparture({
      routeRunId: "route-run-1",
      routeStopId: "route-stop-1",
      taskId: "task-1",
      opsSessionId: "ops-session-1",
      metadata: {
        source: "fieldops-mobile",
        action_key: "routes.confirm_departure",
      },
    });

    expect(result).toMatchObject({
      status: "route_departure_confirmed",
      action_key: "routes.confirm_departure",
      resource_key: "routes",
      route_run_id: "route-run-1",
      route_stop_id: "route-stop-1",
      task_id: "task-1",
      scan_out: {
        scanned_stop_count: 3,
        missing_stop_count: 0,
        unexpected_scan_count: 0,
        duplicate_scan_count: 0,
        last_load_scanned_at: "2026-06-30T08:12:00.000Z",
        ready_for_departure: true,
      },
      route_departure: {
        confirmed_at: "2026-06-30T08:15:00.000Z",
        confirmed_by: "operator-1",
        ops_session_id: "ops-session-1",
      },
      route_execution_manifest: {
        route_run_id: "route-run-1",
        scan_out: {
          ready_for_departure: true,
        },
        route_departure: {
          confirmed_at: "2026-06-30T08:15:00.000Z",
        },
      },
      count: 1,
      items: [
        {
          route_run_id: "route-run-1",
          status: "route_departure_confirmed",
          route_departure: {
            confirmed_at: "2026-06-30T08:15:00.000Z",
          },
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.confirm_departure",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        route_stop_id: "route-stop-1",
        task_id: "task-1",
        ops_session_id: "ops-session-1",
        metadata: {
          source: "fieldops-mobile",
          action_key: "routes.confirm_departure",
        },
      },
    });
  });

  test("confirmRouteDeparture normalizes route scanout selection and params", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: { status: "route_departure_confirmed" },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await uiClient.confirmRouteDeparture({
      routeRunId: " route-run-1 ",
      routeStopId: " route-stop-1 ",
      taskId: " task-1 ",
      opsSessionId: " ops-session-1 ",
    });

    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.confirm_departure",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        route_stop_id: "route-stop-1",
        task_id: "task-1",
        ops_session_id: "ops-session-1",
        metadata: {},
      },
    });
  });

  test("confirmRouteDeparture keeps the canonical action and resource fixed", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: { status: "route_departure_confirmed" },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await uiClient.confirmRouteDeparture({
      routeRunId: "route-run-1",
      actionKey: "routes.scan_load",
      resourceKey: "route_stops",
    } as any);

    expect(rpc).toHaveBeenCalledWith(
      "ui_execute_route_run_scanout_v1",
      expect.objectContaining({
        p_action_key: "routes.confirm_departure",
        p_resource_key: "routes",
      })
    );
  });

  test("confirmRouteDeparture fails closed before RPC for missing route run", () => {
    const rpc = jest.fn();
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    expect(() =>
      uiClient.confirmRouteDeparture({
        routeRunId: " ",
      })
    ).toThrow("route_run_id_required");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("confirmRouteDeparture returns blocked departure readback from the canonical RPC", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        status: "route_departure_blocked",
        action_key: "routes.confirm_departure",
        resource_key: "routes",
        blocked_reason: "route_load_reconciliation",
        route_run_id: "route-run-1",
        route_stop_id: "route-stop-1",
        task_id: "task-1",
        scan_out: {
          scanned_stop_count: 1,
          missing_stop_count: 2,
          unexpected_scan_count: 1,
          duplicate_scan_count: 0,
          ready_for_departure: false,
        },
        route_execution_manifest: {
          route_run_id: "route-run-1",
          scan_out: {
            ready_for_departure: false,
          },
        },
        error: {
          code: "23514",
          message:
            "confirm_route_run_departure_v1 route_run route-run-1 is not ready for departure (missing 2, unexpected 1)",
        },
        items: [
          {
            route_run_id: "route-run-1",
            route_stop_id: "route-stop-1",
            task_id: "task-1",
            status: "route_departure_blocked",
            blocked_reason: "route_load_reconciliation",
          },
        ],
      },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await expect(
      uiClient.confirmRouteDeparture({
        routeRunId: "route-run-1",
        routeStopId: "route-stop-1",
        taskId: "task-1",
      })
    ).resolves.toMatchObject({
      status: "route_departure_blocked",
      blocked_reason: "route_load_reconciliation",
      scan_out: {
        missing_stop_count: 2,
        unexpected_scan_count: 1,
        ready_for_departure: false,
      },
      error: {
        code: "23514",
      },
      items: [
        {
          status: "route_departure_blocked",
          blocked_reason: "route_load_reconciliation",
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.confirm_departure",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        route_stop_id: "route-stop-1",
        task_id: "task-1",
        ops_session_id: null,
        metadata: {},
      },
    });
  });

  test("confirmRouteDeparture preserves duplicate-scan blocked guidance from the canonical RPC", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        status: "route_departure_blocked",
        action_key: "routes.confirm_departure",
        resource_key: "routes",
        blocked_reason: "route_load_reconciliation",
        route_run_id: "route-run-1",
        scan_out: {
          scanned_stop_count: 3,
          missing_stop_count: 0,
          unexpected_scan_count: 0,
          duplicate_scan_count: 1,
          duplicate_route_stop_ids: ["route-stop-2"],
          ready_for_departure: false,
        },
        route_execution_manifest: {
          route_run_id: "route-run-1",
          scan_out: {
            duplicate_scan_count: 1,
            ready_for_departure: false,
          },
        },
        error: {
          code: "23514",
          message:
            "confirm_route_run_departure_v1 route_run route-run-1 is not ready for departure (missing 0, duplicate 1, unexpected 0)",
        },
        items: [
          {
            route_run_id: "route-run-1",
            status: "route_departure_blocked",
            blocked_reason: "route_load_reconciliation",
            scan_out: {
              duplicate_scan_count: 1,
              duplicate_route_stop_ids: ["route-stop-2"],
              ready_for_departure: false,
            },
          },
        ],
      },
      error: null,
    });
    const client = {
      rpc,
      auth: { getSession: jest.fn() },
    } as any;

    const uiClient = createUiClientFromSupabase(client);

    await expect(
      uiClient.confirmRouteDeparture({
        routeRunId: "route-run-1",
      })
    ).resolves.toMatchObject({
      status: "route_departure_blocked",
      blocked_reason: "route_load_reconciliation",
      scan_out: {
        missing_stop_count: 0,
        duplicate_scan_count: 1,
        unexpected_scan_count: 0,
        duplicate_route_stop_ids: ["route-stop-2"],
        ready_for_departure: false,
      },
      route_execution_manifest: {
        scan_out: {
          duplicate_scan_count: 1,
          ready_for_departure: false,
        },
      },
      error: {
        code: "23514",
        message:
          "confirm_route_run_departure_v1 route_run route-run-1 is not ready for departure (missing 0, duplicate 1, unexpected 0)",
      },
      items: [
        {
          status: "route_departure_blocked",
          blocked_reason: "route_load_reconciliation",
          scan_out: {
            duplicate_scan_count: 1,
            duplicate_route_stop_ids: ["route-stop-2"],
            ready_for_departure: false,
          },
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ui_execute_route_run_scanout_v1", {
      p_action_key: "routes.confirm_departure",
      p_resource_key: "routes",
      p_selection_ids: ["route-run-1"],
      p_selection_id: "route-run-1",
      p_selection_count: 1,
      p_params: {
        route_stop_id: null,
        task_id: null,
        ops_session_id: null,
        metadata: {},
      },
    });
  });
});
