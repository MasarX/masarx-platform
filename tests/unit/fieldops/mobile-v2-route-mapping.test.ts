// Unit coverage for `mapMobileV2TaskToRouteStop`, the pure projection that
// turns a `resolve_fieldops_tasks_v1` driver task (`stop:<UUID>`) into the
// `MobileV2RouteStop` the Route screen renders.

import {
  buildConfirmFieldopsRouteDepartureRpcInput,
  mapMobileV2TaskToRouteStop,
  parseMobileV2RouteLoadScanReadback,
  parseMobileV2RouteDepartureConfirmation,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  buildMobileV2RouteDepartureMutationInput,
  buildMobileV2RouteLoadScanMutationInput,
  mobileV2RouteHasDepartureReadback,
  mobileV2RouteHasReadyScanOutReadback,
} from "../../../apps/fieldops/src/mobile-v2-route-departure";
import type { MobileV2Task } from "../../../apps/fieldops/src/mobile-v2-tasks-types";

function makeTask(overrides: Partial<MobileV2Task> = {}): MobileV2Task {
  return Object.freeze({
    task_id: "stop:11111111-1111-1111-1111-111111111111",
    type: "delivery",
    title: "MX-2026-04421-003",
    sub: "Al Murooj \u00b7 4419 \u00b7 Apt 12",
    urgency: "today",
    cta: "Open",
    route: "/mobile/stop/11111111-1111-1111-1111-111111111111",
    eta_iso: "2026-05-17T11:30:00.000Z",
    priority: 60,
    area: "Al Murooj",
    code: "MX-2026-04421-003",
    action: "delivery",
    tone: "neutral",
    meta: Object.freeze({}),
    ...overrides,
  });
}

describe("mapMobileV2TaskToRouteStop", () => {
  test("keeps the `stop:` task_id verbatim as the route stop id", () => {
    const stop = mapMobileV2TaskToRouteStop(makeTask(), 0);
    expect(stop.id).toBe("stop:11111111-1111-1111-1111-111111111111");
  });

  test("reads seq from meta.sequence_order when present", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({ meta: Object.freeze({ sequence_order: 7 }) }),
      0,
    );
    expect(stop.seq).toBe(7);
  });

  test("falls back to index+1 for seq when meta.sequence_order is absent", () => {
    const stop = mapMobileV2TaskToRouteStop(makeTask(), 4);
    expect(stop.seq).toBe(5);
  });

  test("projects title to customer and sub to address", () => {
    const stop = mapMobileV2TaskToRouteStop(makeTask(), 0);
    expect(stop.customer).toBe("MX-2026-04421-003");
    expect(stop.address).toBe("Al Murooj \u00b7 4419 \u00b7 Apt 12");
  });

  test("falls back to area for address when sub is null", () => {
    const stop = mapMobileV2TaskToRouteStop(makeTask({ sub: null }), 0);
    expect(stop.address).toBe("Al Murooj");
  });

  test("uses empty string for address when both sub and area are null", () => {
    const stop = mapMobileV2TaskToRouteStop(makeTask({ sub: null, area: null }), 0);
    expect(stop.address).toBe("");
  });

  test("formats eta_iso into an HH:MM sla string", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({ eta_iso: "2026-05-17T09:05:00.000Z" }),
      0,
    );
    expect(stop.sla).toMatch(/^\d{2}:\d{2}$/);
  });

  test("renders dash for sla when eta_iso is null", () => {
    const stop = mapMobileV2TaskToRouteStop(makeTask({ eta_iso: null }), 0);
    expect(stop.sla).toBe("\u2014");
  });

  test("reads a positive cod from meta.cod_amount", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({ meta: Object.freeze({ cod_amount: 320 }) }),
      0,
    );
    expect(stop.cod).toBe(320);
  });

  test("collapses absent / non-positive cod_amount to 0", () => {
    expect(mapMobileV2TaskToRouteStop(makeTask(), 0).cod).toBe(0);
    expect(
      mapMobileV2TaskToRouteStop(makeTask({ meta: Object.freeze({ cod_amount: 0 }) }), 0).cod,
    ).toBe(0);
    expect(
      mapMobileV2TaskToRouteStop(makeTask({ meta: Object.freeze({ cod_amount: -5 }) }), 0).cod,
    ).toBe(0);
  });

  test("maps a delivered shipment_status to 'done'", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({ meta: Object.freeze({ shipment_status: "delivered" }) }),
      0,
    );
    expect(stop.status).toBe("done");
  });

  test("maps a failed / returned / cancelled shipment_status to 'failed'", () => {
    for (const s of ["failed", "returned", "cancelled"]) {
      const stop = mapMobileV2TaskToRouteStop(
        makeTask({ meta: Object.freeze({ shipment_status: s }) }),
        0,
      );
      expect(stop.status).toBe("failed");
    }
  });

  test("maps a danger / warning task tone to 'sla' (SLA risk)", () => {
    expect(
      mapMobileV2TaskToRouteStop(makeTask({ tone: "danger" }), 0).status,
    ).toBe("sla");
    expect(
      mapMobileV2TaskToRouteStop(makeTask({ tone: "warning" }), 0).status,
    ).toBe("sla");
  });

  test("maps a 'now' urgency (non-SLA tone) to 'current'", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({ urgency: "now", tone: "accent" }),
      0,
    );
    expect(stop.status).toBe("current");
  });

  test("defaults to 'pending' for an ordinary upcoming stop", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({ urgency: "today", tone: "neutral" }),
      0,
    );
    expect(stop.status).toBe("pending");
  });

  test("shipment_status wins over tone (delivered stop is never sla)", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({
        tone: "warning",
        meta: Object.freeze({ shipment_status: "delivered" }),
      }),
      0,
    );
    expect(stop.status).toBe("done");
  });

  test("does not fabricate fragile / attempts (the envelope omits them)", () => {
    const stop = mapMobileV2TaskToRouteStop(makeTask(), 0);
    expect(stop.fragile).toBe(false);
    expect(stop.attempts).toBe(1);
  });

  test("projects route-map geocode metadata from the task envelope", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({
        meta: Object.freeze({
          destination_latitude: "24.7136",
          destination_longitude: "46.6753",
          geocoding_accuracy_m: 8,
          short_national_address: "TEST0000",
          geocoding_status: "geocoded",
          geocoding_accuracy: "rooftop",
          geocoding_provider: "local_postgis",
          geocoding_match_strategy: "sa_short_code_registry",
        }),
      }),
      0,
    );

    expect(stop.latitude).toBe(24.7136);
    expect(stop.longitude).toBe(46.6753);
    expect(stop.accuracyM).toBe(8);
    expect(stop.shortAddress).toBe("TEST0000");
    expect(stop.geocodingStatus).toBe("geocoded");
    expect(stop.geocodingAccuracy).toBe("rooftop");
    expect(stop.geocodingProvider).toBe("local_postgis");
    expect(stop.geocodingMatch).toBe("sa_short_code_registry");
  });

  test("reads nested coordinate metadata without app-side schema branching", () => {
    const stop = mapMobileV2TaskToRouteStop(
      makeTask({
        meta: Object.freeze({
          geocoding: {
            lat: 24.75,
            lng: 46.7,
            provider_name: "short_code_registry",
            match_type: "fuzzy_sa_short_code",
          },
        }),
      }),
      0,
    );

    expect(stop.latitude).toBe(24.75);
    expect(stop.longitude).toBe(46.7);
    expect(stop.geocodingProvider).toBe("short_code_registry");
    expect(stop.geocodingMatch).toBe("fuzzy_sa_short_code");
  });
});

describe("parseMobileV2RouteDepartureConfirmation", () => {
  test("keeps canonical route departure readback fields", () => {
    const parsed = parseMobileV2RouteDepartureConfirmation({
      route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
      status: "in_progress",
      started_at: "2026-05-26T10:00:00Z",
      scan_out: {
        expected_stop_count: 1,
        scanned_stop_count: 1,
        ready_for_departure: true,
      },
      route_departure: {
        confirmed_at: "2026-05-26T10:01:00Z",
        confirmed_by_user_id: "1c654cc7-f985-4e86-aca9-64e3829b481d",
      },
    });

    expect(parsed).toEqual({
      routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
      status: "in_progress",
      startedAt: "2026-05-26T10:00:00Z",
      scanOut: {
        expected_stop_count: 1,
        scanned_stop_count: 1,
        ready_for_departure: true,
      },
      routeDeparture: {
        confirmed_at: "2026-05-26T10:01:00Z",
        confirmed_by_user_id: "1c654cc7-f985-4e86-aca9-64e3829b481d",
      },
    });
  });

  test("fails closed when the departure response lacks a route_run_id", () => {
    expect(() => parseMobileV2RouteDepartureConfirmation({ status: "in_progress" })).toThrow(
      /unexpected route departure response/,
    );
  });
});

describe("buildConfirmFieldopsRouteDepartureRpcInput", () => {
  test("builds the route departure mutation input from the active driver shift", () => {
    expect(
      buildMobileV2RouteDepartureMutationInput({
        routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
        activeOpsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
      }),
    ).toEqual({
      p_route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
      p_ops_session_id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
    });
  });

  test("keeps route departure unavailable when no backend route run is active", () => {
    expect(
      buildMobileV2RouteDepartureMutationInput({
        routeRunId: " ",
        activeOpsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
      }),
    ).toBeNull();
  });

  test("attaches the active driver-shift ops_session_id to the canonical wrapper payload", () => {
    expect(
      buildConfirmFieldopsRouteDepartureRpcInput({
        p_route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
        p_ops_session_id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
      }),
    ).toEqual({
      route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
      route_stop_id: null,
      task_id: null,
      ops_session_id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
    });
  });

  test("trims optional lineage ids and keeps absent ops session explicit", () => {
    expect(
      buildConfirmFieldopsRouteDepartureRpcInput({
        p_route_run_id: " 046b311e-33d2-4d07-802f-694d8698a1eb ",
        p_route_stop_id: " 5cc3bf6d-bfc3-46bd-a193-c0aac491271a ",
        p_task_id: " ",
        p_ops_session_id: null,
      }),
    ).toEqual({
      route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
      route_stop_id: "5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
      task_id: null,
      ops_session_id: null,
    });
  });
});

describe("buildMobileV2RouteLoadScanMutationInput", () => {
  test("builds a canonical load scan payload from the active route task metadata", () => {
    const input = buildMobileV2RouteLoadScanMutationInput({
      tasks: [
        makeTask({
          task_id: "stop:5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
          title: "MXFTCTXCOD00006298",
          code: "MXFTCTXCOD00006298",
          meta: Object.freeze({
            route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
            shipment_id: "bc54c170-072d-4ede-b27d-b19f9f35f2aa",
            client_id: "0ea4add3-9d54-4663-b0ea-6670d2589946",
            branch_id: "2e2a95ba-b03f-47e4-81ad-60fa5e9a5cbb",
          }),
        }),
      ],
      routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
      barcode: "MXFTCTXCOD00006298",
      deviceId: "0ee51c33-ab6b-497c-be8d-66deb8040e6a",
      activeOpsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
    });

    expect(input).toEqual({
      p_scan: {
        route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
        route_stop_id: "5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
        shipment_id: "bc54c170-072d-4ede-b27d-b19f9f35f2aa",
        client_id: "0ea4add3-9d54-4663-b0ea-6670d2589946",
        branch_id: "2e2a95ba-b03f-47e4-81ad-60fa5e9a5cbb",
        barcode: "MXFTCTXCOD00006298",
        scan_type: "load",
        device_id: "0ee51c33-ab6b-497c-be8d-66deb8040e6a",
        ops_session_id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
        captured_at: expect.any(String),
        metadata: {
          source: "fieldops_mobile_v2_route_scan_out",
          mobile_v2_only: true,
        },
      },
    });
  });

  test("allows route-run-backed load scans when the task omits branch metadata", () => {
    const input = buildMobileV2RouteLoadScanMutationInput({
      tasks: [
        makeTask({
          task_id: "stop:5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
          title: "MXFTCTXCOD00006298",
          code: "MXFTCTXCOD00006298",
          meta: Object.freeze({
            route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
            shipment_id: "bc54c170-072d-4ede-b27d-b19f9f35f2aa",
            client_id: "0ea4add3-9d54-4663-b0ea-6670d2589946",
          }),
        }),
      ],
      routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
      barcode: "MXFTCTXCOD00006298",
      deviceId: null,
      activeOpsSessionId: null,
    });

    expect(input).toMatchObject({
      p_scan: {
        route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
        route_stop_id: "5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
        shipment_id: "bc54c170-072d-4ede-b27d-b19f9f35f2aa",
        client_id: "0ea4add3-9d54-4663-b0ea-6670d2589946",
        branch_id: null,
        barcode: "MXFTCTXCOD00006298",
        scan_type: "load",
      },
    });
  });

  test("fails closed when the scan is not backed by a current route task", () => {
    expect(
      buildMobileV2RouteLoadScanMutationInput({
        tasks: [makeTask()],
        routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
        barcode: "MXFTCTXCOD00006298",
        deviceId: "0ee51c33-ab6b-497c-be8d-66deb8040e6a",
        activeOpsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
      }),
    ).toBeNull();
  });
});

describe("parseMobileV2RouteLoadScanReadback", () => {
  test("keeps the route load scan lineage from api.record_scan_event_v1", () => {
    const parsed = parseMobileV2RouteLoadScanReadback(
      [{ scan_event_id: "de1b3572-6210-4c5d-a0a7-3afd37fe235b", created: true }],
      {
        route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
        route_stop_id: "5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
        shipment_id: "bc54c170-072d-4ede-b27d-b19f9f35f2aa",
        client_id: "0ea4add3-9d54-4663-b0ea-6670d2589946",
        branch_id: "2e2a95ba-b03f-47e4-81ad-60fa5e9a5cbb",
        barcode: "MXFTCTXCOD00006298",
        scan_type: "load",
        captured_at: "2026-06-09T01:00:00.000Z",
      },
      "idem-1",
    );

    expect(parsed).toEqual({
      scanEventId: "de1b3572-6210-4c5d-a0a7-3afd37fe235b",
      created: true,
      idempotencyKey: "idem-1",
      routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
      routeStopId: "5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
      barcode: "MXFTCTXCOD00006298",
    });
  });

  test("fails closed on malformed scan-event readback", () => {
    expect(() =>
      parseMobileV2RouteLoadScanReadback(
        [{ created: true }],
        {
          route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
          route_stop_id: "5cc3bf6d-bfc3-46bd-a193-c0aac491271a",
          shipment_id: "bc54c170-072d-4ede-b27d-b19f9f35f2aa",
          client_id: "0ea4add3-9d54-4663-b0ea-6670d2589946",
          branch_id: "2e2a95ba-b03f-47e4-81ad-60fa5e9a5cbb",
          barcode: "MXFTCTXCOD00006298",
          scan_type: "load",
          captured_at: "2026-06-09T01:00:00.000Z",
        },
        "idem-1",
      ),
    ).toThrow(/unexpected route load scan readback/);
  });
});

describe("mobileV2RouteHasDepartureReadback", () => {
  test("accepts only the backend-refetched route manifest departed state for the same route run", () => {
    expect(
      mobileV2RouteHasDepartureReadback(
        {
          routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
          routeId: "RT-046b311e",
          rows: [],
          totalStops: 0,
          manifestSummary: {
            routeLabel: "RT-046b311e",
            assignmentLabel: "Assignment Assigned",
            scanOutLabel: "Scan-out ready 1/1",
            departureLabel: "Departed",
            readyForDeparture: true,
            departed: true,
          },
        },
        "046b311e-33d2-4d07-802f-694d8698a1eb",
      ),
    ).toBe(true);
  });

  test("rejects write-response-only or stale route data", () => {
    expect(
      mobileV2RouteHasDepartureReadback(
        {
          routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
          routeId: "RT-046b311e",
          rows: [],
          totalStops: 0,
          manifestSummary: {
            routeLabel: "RT-046b311e",
            assignmentLabel: "Assignment Assigned",
            scanOutLabel: "Scan-out ready 1/1",
            departureLabel: "Ready to depart",
            readyForDeparture: true,
            departed: false,
          },
        },
        "046b311e-33d2-4d07-802f-694d8698a1eb",
      ),
    ).toBe(false);

    expect(
      mobileV2RouteHasDepartureReadback(
        {
          routeRunId: "bf9c8e67-c03d-4a02-8e5a-f9c40b804e4f",
          routeId: "RT-bf9c8e67",
          rows: [],
          totalStops: 0,
          manifestSummary: {
            routeLabel: "RT-bf9c8e67",
            assignmentLabel: "Assignment Assigned",
            scanOutLabel: "Scan-out ready 1/1",
            departureLabel: "Departed",
            readyForDeparture: true,
            departed: true,
          },
        },
        "046b311e-33d2-4d07-802f-694d8698a1eb",
      ),
    ).toBe(false);
  });
});

describe("mobileV2RouteHasReadyScanOutReadback", () => {
  test("accepts only backend-refetched scan-out ready state for the same route run", () => {
    expect(
      mobileV2RouteHasReadyScanOutReadback(
        {
          routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
          routeId: "RT-046b311e",
          rows: [],
          totalStops: 0,
          manifestSummary: {
            routeLabel: "RT-046b311e",
            assignmentLabel: "Assignment Assigned",
            scanOutLabel: "Scan-out ready 1/1",
            departureLabel: "Ready to depart",
            readyForDeparture: true,
            departed: false,
          },
        },
        "046b311e-33d2-4d07-802f-694d8698a1eb",
      ),
    ).toBe(true);
  });

  test("rejects stale scan-out and raw mutation readback", () => {
    expect(
      mobileV2RouteHasReadyScanOutReadback(
        {
          routeRunId: "046b311e-33d2-4d07-802f-694d8698a1eb",
          routeId: "RT-046b311e",
          rows: [],
          totalStops: 0,
          manifestSummary: {
            routeLabel: "RT-046b311e",
            assignmentLabel: "Assignment Assigned",
            scanOutLabel: "Scan-out missing 1/1",
            departureLabel: "Departure gated",
            readyForDeparture: false,
            departed: false,
          },
        },
        "046b311e-33d2-4d07-802f-694d8698a1eb",
      ),
    ).toBe(false);

    expect(
      mobileV2RouteHasReadyScanOutReadback(
        { scan_event_id: "de1b3572-6210-4c5d-a0a7-3afd37fe235b", created: true },
        "046b311e-33d2-4d07-802f-694d8698a1eb",
      ),
    ).toBe(false);
  });
});
