const {
  buildDepartureDestinationFixture,
  buildRouteAssignmentPayload,
  buildDriverClaims,
  buildRouteLoadScanPayload,
  groupRouteTasks,
  normalizeUuid,
  parseArgs,
  routeTaskIsActionable,
  selectRouteGroup,
} = require("../../../scripts/qa/mobile-v2-route-departure-readiness");

describe("mobile-v2-route-departure-readiness helper", () => {
  test("parses create and prepare flags without requiring process env", () => {
    expect(
      parseArgs([
        "--org-id",
        "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
        "--driver-email=driver@example.test",
        "--create-fixture",
        "--prepare",
      ]),
    ).toEqual({
      allVisible: false,
      createFixture: true,
      dryRun: false,
      prepare: true,
      orgId: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
      driverEmail: "driver@example.test",
    });
  });

  test("groups route tasks in the same route-run shape used by Mobile V2 route selection", () => {
    const rows = [
      {
        task_id: "stop:4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
        type: "delivery",
        title: "MV2DEPART1",
        cta: "Open",
        meta: {
          route_run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          route_run_status: "in_progress",
          route_stop_status: "open",
          shipment_id: "22222222-2222-4222-8222-222222222222",
          client_id: "33333333-3333-4333-8333-333333333333",
          sequence_order: 1,
        },
      },
      {
        task_id: "stop:44444444-4444-4444-8444-444444444444",
        type: "pickup",
        title: "MV2PICKUP",
        cta: "Start",
        meta: {
          route_run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          route_run_status: "in_progress",
          route_stop_status: "open",
          shipment_id: "55555555-5555-4555-8555-555555555555",
          client_id: "66666666-6666-4666-8666-666666666666",
          sequence_order: 1,
        },
      },
    ];

    const grouped = groupRouteTasks(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      routeRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actionable: true,
      hasDeliveryStop: true,
      hasPickupStop: false,
    });
    expect(selectRouteGroup(grouped)?.routeRunId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  test("keeps terminal task rows out of default actionable route selection", () => {
    expect(routeTaskIsActionable({ cta: "Done", meta: { route_stop_status: "done" } })).toBe(false);
    expect(routeTaskIsActionable({ cta: "Start", meta: { route_stop_status: "open" } })).toBe(true);
  });

  test("builds canonical load scan payload with route, stop, shipment, and proof lineage", () => {
    const payload = buildRouteLoadScanPayload({
      organizationId: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
      routeRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      stop: {
        routeStopId: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
        shipmentId: "22222222-2222-4222-8222-222222222222",
        clientId: "33333333-3333-4333-8333-333333333333",
        branchId: "44444444-4444-4444-8444-444444444444",
        trackingNumber: "MV2DEPART1",
      },
      deviceId: "",
      opsSessionId: "",
      proofMarker: "MobileV2RouteDepartureReadinessTest",
    });

    expect(payload).toMatchObject({
      organization_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
      route_run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      route_stop_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
      shipment_id: "22222222-2222-4222-8222-222222222222",
      scan_type: "load",
      barcode: "MV2DEPART1",
      metadata: {
        proof_slice: "mobile-v2-route-departure-readiness",
        proof_marker: "MobileV2RouteDepartureReadinessTest",
        mobile_v2_only: true,
      },
    });
    expect(payload.device_id).toBeNull();
    expect(payload.ops_session_id).toBeNull();
  });

  test("builds destination address and geocode readback for Mobile V2 route-map proof fixtures", () => {
    const fixture = buildDepartureDestinationFixture({
      organizationId: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
      clientId: "33333333-3333-4333-8333-333333333333",
      proofMarker: "MobileV2RouteDepartureReadinessTest",
      addressId: "77777777-7777-4777-8777-777777777777",
      geocodeId: "88888888-8888-4888-8888-888888888888",
    });

    expect(fixture.address).toMatchObject({
      id: "77777777-7777-4777-8777-777777777777",
      organization_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
      client_id: "33333333-3333-4333-8333-333333333333",
      city: "Riyadh",
      validation_status: "validated",
      sa_short_code: "TEST0000",
      latitude: 24.713,
      longitude: 46.6766,
    });
    expect(fixture.geocode).toMatchObject({
      id: "88888888-8888-4888-8888-888888888888",
      address_id: "77777777-7777-4777-8777-777777777777",
      provider_name: "mobile-v2-proof-geocoder",
      is_primary: true,
      metadata: {
        proof_slice: "mobile-v2-route-departure-readiness",
        proof_marker: "MobileV2RouteDepartureReadinessTest",
        mobile_v2_only: true,
        match_strategy: "sa_short_code",
        accuracy_m: 9,
      },
    });
  });

  test("builds canonical route assignment payload for prepared proof fixtures", () => {
    expect(
      buildRouteAssignmentPayload({
        routeRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        driverUserId: "5456be0e-0cd3-4fb2-8d92-5ed5e503de60",
        vehicleId: "d5aad887-4c02-4836-a791-9d3361b243c0",
        actorUserId: "a492e5a2-5587-4499-8b39-a721f56457e1",
        proofMarker: "MobileV2RouteDepartureReadinessTest",
      }),
    ).toEqual({
      route_run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      driver_user_id: "5456be0e-0cd3-4fb2-8d92-5ed5e503de60",
      vehicle_id: "d5aad887-4c02-4836-a791-9d3361b243c0",
      actor_user_id: "a492e5a2-5587-4499-8b39-a721f56457e1",
      actor_system: "mobile_v2_route_departure_readiness",
      idempotency_key: "mobile-v2-route-departure-assign-MobileV2RouteDepartureReadinessTest",
      metadata: {
        source: "mobile-v2-route-departure-readiness",
        proof_slice: "mobile-v2-route-departure-readiness",
        proof_marker: "MobileV2RouteDepartureReadinessTest",
        mobile_v2_only: true,
      },
    });
  });

  test("normalizes only UUID-shaped identifiers and builds driver claims", () => {
    expect(normalizeUuid("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(normalizeUuid("not-a-uuid")).toBe("");
    expect(
      buildDriverClaims({
        organizationId: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
        userId: "5456be0e-0cd3-4fb2-8d92-5ed5e503de60",
      }),
    ).toEqual({
      role: "authenticated",
      sub: "5456be0e-0cd3-4fb2-8d92-5ed5e503de60",
      organization_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
      scope_type: "tenant",
      scope_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
    });
  });
});
