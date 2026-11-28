#!/usr/bin/env node
/*
  Prepare a FieldOps Mobile V2 route-departure proof fixture.

  The helper never confirms departure. It only creates or prepares a real
  first-tenant route so native Mobile V2 can perform the visible
  "Confirm departure" action and prove same-context backend readback.

  Examples:
    ENV_FILE=path/to/local-config node scripts/qa/mobile-v2-route-departure-readiness.js \
      --org-id <org_uuid> --driver-email <driver@tenant.local> --create-fixture --prepare

    ENV_FILE=path/to/local-config node scripts/qa/mobile-v2-route-departure-readiness.js \
      --org-id <org_uuid> --driver-user-id <user_uuid> --route-run-id <run_uuid> --prepare
*/

const { randomBytes, randomUUID } = require("crypto");
const { Pool } = require("pg");

const TERMINAL_ROUTE_STATUSES = new Set(["completed", "cancelled", "canceled", "closed"]);
const TERMINAL_STOP_STATUSES = new Set(["done", "failed", "partial", "completed", "cancelled", "canceled"]);
const TERMINAL_CTAS = new Set(["done", "failed", "partial"]);
const DEFAULT_PROOF_SLICE = "mobile-v2-route-departure-readiness";
const DEFAULT_DESTINATION_LOCATION = Object.freeze({
  rawInput: "TEST0000, King Fahd Road, Al Olaya, Riyadh 12214, SA",
  normalizedLine1: "King Fahd Road",
  normalizedLine2: "Near Al Olaya district",
  district: "Al Olaya",
  city: "Riyadh",
  province: "Riyadh",
  postalCode: "12214",
  country: "SA",
  buildingNumber: "3294",
  shortNationalAddress: "TEST0000",
  latitude: 24.713,
  longitude: 46.6766,
  providerName: "mobile-v2-proof-geocoder",
  accuracyType: "sa_short_code_rooftop",
  accuracyM: 9,
  confidenceScore: 0.98,
  matchStrategy: "sa_short_code",
});

function normalizeUuid(value) {
  const text = String(value ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text.toLowerCase()
    : "";
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    allVisible: false,
    createFixture: false,
    dryRun: false,
    prepare: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.split("=", 2);
    const key = rawKey.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (["allVisible", "createFixture", "dryRun", "prepare"].includes(key)) {
      args[key] = true;
      continue;
    }
    const nextValue = inlineValue !== undefined ? inlineValue : argv[i + 1];
    if (inlineValue === undefined) i += 1;
    args[key] = normalizeText(nextValue);
  }
  return args;
}

function buildDriverClaims({ organizationId, userId }) {
  return {
    role: "authenticated",
    sub: userId,
    organization_id: organizationId,
    scope_type: "tenant",
    scope_id: organizationId,
  };
}

function routeTaskIsActionable(task) {
  const status = normalizeText(task?.meta?.route_stop_status).toLowerCase();
  if (status && TERMINAL_STOP_STATUSES.has(status)) return false;
  const cta = normalizeText(task?.cta).toLowerCase();
  return !cta || !TERMINAL_CTAS.has(cta);
}

function buildDepartureDestinationFixture({
  organizationId,
  clientId,
  proofMarker,
  addressId = randomUUID(),
  geocodeId = randomUUID(),
  destination = DEFAULT_DESTINATION_LOCATION,
} = {}) {
  return {
    address: {
      id: addressId,
      organization_id: organizationId,
      client_id: clientId,
      raw_input: destination.rawInput,
      normalized_line1: destination.normalizedLine1,
      normalized_line2: destination.normalizedLine2,
      district: destination.district,
      city: destination.city,
      province: destination.province,
      postal_code: destination.postalCode,
      country: destination.country,
      building_number: destination.buildingNumber,
      validation_status: "validated",
      line1: destination.normalizedLine1,
      line2: destination.normalizedLine2,
      sa_short_code: destination.shortNationalAddress,
      latitude: destination.latitude,
      longitude: destination.longitude,
    },
    geocode: {
      id: geocodeId,
      address_id: addressId,
      organization_id: organizationId,
      client_id: clientId,
      provider_name: destination.providerName,
      latitude: destination.latitude,
      longitude: destination.longitude,
      confidence_score: destination.confidenceScore,
      accuracy_type: destination.accuracyType,
      formatted_address: destination.rawInput,
      is_primary: true,
      metadata: {
        source: DEFAULT_PROOF_SLICE,
        proof_slice: DEFAULT_PROOF_SLICE,
        proof_marker: proofMarker,
        mobile_v2_only: true,
        match_strategy: destination.matchStrategy,
        accuracy_m: destination.accuracyM,
      },
    },
  };
}

function groupRouteTasks(rows) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const taskId = normalizeText(row?.task_id);
    if (!taskId.startsWith("stop:")) continue;
    const meta = row && typeof row.meta === "object" && row.meta !== null ? row.meta : {};
    const routeRunId = normalizeUuid(meta.route_run_id);
    if (!routeRunId) continue;
    const entry = grouped.get(routeRunId) ?? {
      routeRunId,
      tasks: [],
      actionable: false,
      hasDeliveryStop: false,
      hasPickupStop: false,
    };
    const normalized = {
      taskId,
      type: normalizeText(row.type).toLowerCase(),
      title: normalizeText(row.title),
      code: normalizeText(row.code),
      cta: normalizeText(row.cta),
      routeStopId: taskId.slice("stop:".length),
      routeStopStatus: normalizeText(meta.route_stop_status).toLowerCase(),
      shipmentId: normalizeUuid(meta.shipment_id),
      clientId: normalizeUuid(meta.client_id),
      routeRunStatus: normalizeText(meta.route_run_status).toLowerCase(),
      sequenceOrder: Number.isFinite(Number(meta.sequence_order)) ? Number(meta.sequence_order) : null,
    };
    entry.tasks.push(normalized);
    entry.actionable = entry.actionable || routeTaskIsActionable(row);
    entry.hasDeliveryStop = entry.hasDeliveryStop || normalized.type === "delivery";
    entry.hasPickupStop = entry.hasPickupStop || normalized.type === "pickup";
    grouped.set(routeRunId, entry);
  }
  return [...grouped.values()];
}

function selectRouteGroup(groups, preferredRouteRunId = "") {
  const preferred = normalizeUuid(preferredRouteRunId);
  if (preferred) {
    const match = groups.find((group) => group.routeRunId === preferred);
    if (match) return match;
  }
  return groups.find((group) => group.actionable && group.hasDeliveryStop)
    ?? groups.find((group) => group.actionable)
    ?? groups[0]
    ?? null;
}

function buildRouteLoadScanPayload({
  organizationId,
  routeRunId,
  stop,
  deviceId,
  opsSessionId,
  proofMarker,
}) {
  return {
    organization_id: organizationId,
    idempotency_key: `mobile-v2-route-departure-load-${routeRunId}-${stop.routeStopId}`,
    device_id: normalizeUuid(deviceId) || null,
    ops_session_id: normalizeUuid(opsSessionId) || null,
    route_run_id: routeRunId,
    route_stop_id: stop.routeStopId,
    shipment_id: stop.shipmentId,
    client_id: stop.clientId,
    branch_id: stop.branchId,
    scan_type: "load",
    barcode: stop.trackingNumber,
    captured_at: new Date().toISOString(),
    metadata: {
      source: "mobile-v2-route-departure-readiness",
      proof_slice: DEFAULT_PROOF_SLICE,
      proof_marker: proofMarker,
      mobile_v2_only: true,
    },
  };
}

function buildRouteAssignmentPayload({
  routeRunId,
  driverUserId,
  vehicleId,
  actorUserId,
  proofMarker,
}) {
  return {
    route_run_id: routeRunId,
    driver_user_id: driverUserId,
    vehicle_id: normalizeUuid(vehicleId) || null,
    actor_user_id: normalizeUuid(actorUserId) || null,
    actor_system: "mobile_v2_route_departure_readiness",
    idempotency_key: `mobile-v2-route-departure-assign-${proofMarker}`,
    metadata: {
      source: "mobile-v2-route-departure-readiness",
      proof_slice: DEFAULT_PROOF_SLICE,
      proof_marker: proofMarker,
      mobile_v2_only: true,
    },
  };
}

async function withDriverClaims(client, context, callback, options = {}) {
  const claims = buildDriverClaims(context);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [claims.sub]);
    await client.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await callback(client);
    if (options.commit === true) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore rollback failures
    }
    throw error;
  }
}

async function resolveDriverUser(client, args) {
  const driverUserId = normalizeUuid(args.driverUserId);
  if (driverUserId) return driverUserId;
  const email = normalizeText(args.driverEmail).toLowerCase();
  if (!email) {
    throw new Error("--driver-user-id or --driver-email is required");
  }
  const { rows } = await client.query(
    `
      select id
        from auth.users
       where lower(email) = $1
       limit 1
    `,
    [email],
  );
  const id = normalizeUuid(rows[0]?.id);
  if (!id) throw new Error(`Driver auth user not found for ${email}`);
  return id;
}

async function resolveAuthUserByEmail(client, email, label) {
  const normalizedEmail = normalizeText(email).toLowerCase();
  if (!normalizedEmail) return "";
  const { rows } = await client.query(
    `
      select id
        from auth.users
       where lower(email) = $1
       limit 1
    `,
    [normalizedEmail],
  );
  const id = normalizeUuid(rows[0]?.id);
  if (!id) throw new Error(`${label} auth user not found for ${normalizedEmail}`);
  return id;
}

async function assertTenantUserScope(client, { organizationId, userId }, label) {
  const { rows } = await client.query(
    `
      select id, email, user_type, status, organization_id
        from public.users
       where id = $1::uuid
       limit 1
    `,
    [userId],
  );
  const user = rows[0];
  if (!user) throw new Error(`${label} public.users row not found for ${userId}`);
  if (normalizeUuid(user.organization_id) !== organizationId) {
    throw new Error(`${label} ${userId} is not in organization ${organizationId}`);
  }
  if (normalizeText(user.status).toLowerCase() !== "active") {
    throw new Error(`${label} ${user.email} is not active`);
  }
  return user;
}

async function assertDriverTenantScope(client, context) {
  return assertTenantUserScope(client, context, "Driver");
}

async function resolveMobileV2Policy(client, context) {
  return withDriverClaims(client, context, async (tx) => {
    const { rows } = await tx.query(
      `
        select api.resolve_mobile_shell_policy(
          'driver',
          jsonb_build_object('organization_id', $1::uuid)
        ) as policy
      `,
      [context.organizationId],
    );
    return rows[0]?.policy ?? null;
  });
}

async function resolveDriverRouteTasks(client, context) {
  return withDriverClaims(client, context, async (tx) => {
    const { rows } = await tx.query(
      `
        select *
          from api.resolve_fieldops_tasks_v1(
            'driver',
            jsonb_build_object('organization_id', $1::uuid)
          )
      `,
      [context.organizationId],
    );
    return rows;
  });
}

async function fetchRouteStops(client, routeRunId) {
  const { rows } = await client.query(
    `
      select
        rr.id as route_run_id,
        rr.status as route_run_status,
        rr.branch_id,
        rr.metadata #> '{route_departure}' as route_departure,
        rs.id as route_stop_id,
        rs.client_id,
        rs.shipment_id,
        rs.sequence_order,
        rs.stop_kind,
        coalesce(s.tracking_number, 'STOP-' || substr(rs.id::text, 1, 8)) as tracking_number
      from public.route_runs rr
      join public.route_stops rs
        on rs.route_run_id = rr.id
       and rs.organization_id = rr.organization_id
      left join public.shipments s
        on s.id = rs.shipment_id
       and s.client_id = rs.client_id
      where rr.id = $1::uuid
      order by rs.sequence_order, rs.id
    `,
    [routeRunId],
  );
  return rows.map((row) => ({
    routeRunId: normalizeUuid(row.route_run_id),
    routeRunStatus: normalizeText(row.route_run_status).toLowerCase(),
    branchId: normalizeUuid(row.branch_id),
    routeDeparture: row.route_departure ?? null,
    routeStopId: normalizeUuid(row.route_stop_id),
    clientId: normalizeUuid(row.client_id),
    shipmentId: normalizeUuid(row.shipment_id),
    sequenceOrder: Number(row.sequence_order),
    stopKind: normalizeText(row.stop_kind).toLowerCase(),
    trackingNumber: normalizeText(row.tracking_number),
  }));
}

async function readScanOut(client, routeRunId) {
  const { rows } = await client.query(
    "select public.route_run_scan_out_reconciliation_v1($1::uuid) as scan_out",
    [routeRunId],
  );
  return rows[0]?.scan_out ?? null;
}

async function readManifest(client, context, routeRunId) {
  return withDriverClaims(client, context, async (tx) => {
    const { rows } = await tx.query(
      "select api.ui_route_run_execution_manifest_v1($1::uuid) as manifest",
      [routeRunId],
    );
    return rows[0]?.manifest ?? null;
  });
}

async function findActiveDeviceId(client, { organizationId, userId }) {
  const { rows } = await client.query(
    `
      select id
        from public.user_devices
       where organization_id = $1::uuid
         and user_id = $2::uuid
         and revoked_at is null
       order by last_seen_at desc nulls last, updated_at desc
       limit 1
    `,
    [organizationId, userId],
  );
  return normalizeUuid(rows[0]?.id);
}

async function findOpenOpsSessionId(client, { organizationId, userId }) {
  const { rows } = await client.query(
    `
      select id
        from public.ops_sessions
       where organization_id = $1::uuid
         and actor_user_id = $2::uuid
         and session_type = 'driver_shift'
         and lower(status) in ('open', 'active', 'in_progress', 'started')
       order by opened_at desc
       limit 1
    `,
    [organizationId, userId],
  );
  return normalizeUuid(rows[0]?.id);
}

async function selectExistingClient(client, organizationId) {
  const { rows } = await client.query(
    `
      select id
        from public.clients
       where organization_id = $1::uuid
         and lower(coalesce(status, 'active')) = 'active'
       order by updated_at desc nulls last, created_at desc nulls last, id
       limit 1
    `,
    [organizationId],
  );
  const id = normalizeUuid(rows[0]?.id);
  if (!id) throw new Error(`No active client found for organization ${organizationId}`);
  return id;
}

async function selectExistingSender(client, clientId) {
  const { rows } = await client.query(
    `
      select id
        from public.senders
       where client_id = $1::uuid
         and lower(coalesce(status, 'active')) = 'active'
       order by updated_at desc nulls last, created_at desc nulls last, id
       limit 1
    `,
    [clientId],
  );
  return normalizeUuid(rows[0]?.id) || null;
}

async function selectExistingBranch(client, organizationId) {
  const { rows } = await client.query(
    `
      select id
        from public.branches
       where organization_id = $1::uuid
         and is_active is true
       order by updated_at desc nulls last, created_at desc nulls last, id
       limit 1
    `,
    [organizationId],
  );
  const id = normalizeUuid(rows[0]?.id);
  if (!id) throw new Error(`No active branch found for organization ${organizationId}`);
  return id;
}

async function selectExistingVehicle(client, organizationId) {
  const { rows } = await client.query(
    `
      select id
        from public.vehicles
       where organization_id = $1::uuid
         and is_active is true
         and lower(coalesce(status, 'active')) in ('active', 'available')
       order by updated_at desc nulls last, created_at desc nulls last, id
       limit 1
    `,
    [organizationId],
  );
  return normalizeUuid(rows[0]?.id) || null;
}

async function insertDepartureDestinationFixture(client, fixture) {
  const { address, geocode } = fixture;
  await client.query(
    `
      insert into public.addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        normalized_line1,
        normalized_line2,
        district,
        city,
        province,
        postal_code,
        country,
        building_number,
        validation_status,
        line1,
        line2,
        coordinates,
        sa_short_code
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text,
        $5::text,
        $6::text,
        $7::text,
        $8::text,
        $9::text,
        $10::text,
        $11::text,
        $12::text,
        $13::text,
        $14::text,
        $15::text,
        ST_SetSRID(ST_MakePoint($16::double precision, $17::double precision), 4326)::geography,
        $18::text
      )
    `,
    [
      address.id,
      address.organization_id,
      address.client_id,
      address.raw_input,
      address.normalized_line1,
      address.normalized_line2,
      address.district,
      address.city,
      address.province,
      address.postal_code,
      address.country,
      address.building_number,
      address.validation_status,
      address.line1,
      address.line2,
      address.longitude,
      address.latitude,
      address.sa_short_code,
    ],
  );
  await client.query(
    `
      insert into public.geocodes (
        id,
        address_id,
        provider_name,
        coordinates,
        confidence_score,
        accuracy_type,
        formatted_address,
        metadata,
        is_primary,
        organization_id,
        client_id
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::text,
        ST_SetSRID(ST_MakePoint($4::double precision, $5::double precision), 4326)::geography,
        $6::numeric,
        $7::text,
        $8::text,
        $9::jsonb,
        $10::boolean,
        $11::uuid,
        $12::uuid
      )
    `,
    [
      geocode.id,
      geocode.address_id,
      geocode.provider_name,
      geocode.longitude,
      geocode.latitude,
      geocode.confidence_score,
      geocode.accuracy_type,
      geocode.formatted_address,
      JSON.stringify(geocode.metadata),
      geocode.is_primary,
      geocode.organization_id,
      geocode.client_id,
    ],
  );
}

async function createDepartureFixture(client, { organizationId, userId, proofMarker }) {
  const clientId = await selectExistingClient(client, organizationId);
  const senderId = await selectExistingSender(client, clientId);
  const branchId = await selectExistingBranch(client, organizationId);
  const vehicleId = await selectExistingVehicle(client, organizationId);
  const shipmentId = randomUUID();
  const destination = buildDepartureDestinationFixture({ organizationId, clientId, proofMarker });
  const trackingNumber = `MV2DEPART${randomBytes(4).toString("hex").toUpperCase()}`;
  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);

  await insertDepartureDestinationFixture(client, destination);

  await client.query(
    `
      insert into public.shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        branch_id,
        service_type,
        service_level,
        tracking_number,
        status,
        box_count,
        priority_score,
        cod_currency,
        promised_delivery_at,
        promised_window_start_at,
        promised_window_end_at,
        destination_address_id,
        shipment_settings_override,
        metadata
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        'delivery',
        'standard',
        $6::text,
        'out_for_delivery',
        1,
        100,
        'SAR',
        $7::timestamptz,
        $7::timestamptz,
        $8::timestamptz,
        $9::uuid,
        '{}'::jsonb,
        $10::jsonb
      )
    `,
    [
      shipmentId,
      organizationId,
      clientId,
      senderId,
      branchId,
      trackingNumber,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      destination.address.id,
      JSON.stringify({
        proof_slice: DEFAULT_PROOF_SLICE,
        proof_marker: proofMarker,
        mobile_v2_only: true,
      }),
    ],
  );

  const routeInput = {
    organization_id: organizationId,
    branch_id: branchId,
    driver_user_id: userId,
    vehicle_id: vehicleId,
    status: "in_progress",
    planned_date: windowStart.toISOString().slice(0, 10),
    planned_start_at: windowStart.toISOString(),
    planned_end_at: windowEnd.toISOString(),
    idempotency_key: `mobile-v2-route-departure-${proofMarker}`,
    metadata: {
      proof_slice: DEFAULT_PROOF_SLICE,
      proof_marker: proofMarker,
      mobile_v2_only: true,
    },
    stops: [
      {
        client_id: clientId,
        shipment_id: shipmentId,
        stop_kind: "delivery",
        sequence_order: 1,
        planned_window_start_at: windowStart.toISOString(),
        planned_window_end_at: windowEnd.toISOString(),
        metadata: {
          status: "open",
          proof_slice: DEFAULT_PROOF_SLICE,
          proof_marker: proofMarker,
          mobile_v2_only: true,
        },
      },
    ],
  };

  const routeResult = await client.query(
    "select route_run_id, stop_ids, created from public.create_route_run_v1($1::jsonb)",
    [JSON.stringify(routeInput)],
  );
  const routeRunId = normalizeUuid(routeResult.rows[0]?.route_run_id);
  const routeStopId = normalizeUuid(routeResult.rows[0]?.stop_ids?.[0]);
  if (!routeRunId || !routeStopId) {
    throw new Error("create_route_run_v1 did not return a route run and stop id");
  }

  return {
    routeRunId,
    routeStopId,
    shipmentId,
    trackingNumber,
    taskId: null,
    branchId,
    clientId,
    senderId,
    vehicleId,
    destinationAddressId: destination.address.id,
    geocodeId: destination.geocode.id,
  };
}

async function assignDepartureFixtureRoute(client, {
  routeRunId,
  driverUserId,
  vehicleId,
  actorUserId,
  proofMarker,
}) {
  const payload = buildRouteAssignmentPayload({
    routeRunId,
    driverUserId,
    vehicleId,
    actorUserId,
    proofMarker,
  });
  const { rows } = await client.query(
    "select * from public.assign_route_run_v1($1::jsonb)",
    [JSON.stringify(payload)],
  );
  const result = rows[0] ?? null;
  if (!normalizeUuid(result?.route_run_id)) {
    throw new Error("assign_route_run_v1 did not return a route_run_id for the fixture");
  }
  return {
    payload,
    result,
  };
}

async function prepareRouteScanOut(client, context, routeRunId, options) {
  const stops = await fetchRouteStops(client, routeRunId);
  if (!stops.length) throw new Error(`No route stops found for route_run ${routeRunId}`);
  const routeStatus = stops[0].routeRunStatus;
  if (TERMINAL_ROUTE_STATUSES.has(routeStatus)) {
    throw new Error(`Route ${routeRunId} has terminal status ${routeStatus}`);
  }
  const departure = stops[0].routeDeparture;
  if (departure && departure.confirmed_at) {
    throw new Error(`Route ${routeRunId} already has route departure confirmed_at`);
  }

  const before = await readScanOut(client, routeRunId);
  const payloads = stops.map((stop) => buildRouteLoadScanPayload({
    organizationId: context.organizationId,
    routeRunId,
    stop,
    deviceId: options.deviceId,
    opsSessionId: options.opsSessionId,
    proofMarker: options.proofMarker,
  }));

  if (!options.dryRun) {
    await withDriverClaims(client, context, async (tx) => {
      for (const payload of payloads) {
        await tx.query("select * from api.record_scan_event_v1($1::jsonb)", [JSON.stringify(payload)]);
      }
      return null;
    }, { commit: true });
  }

  const after = await readScanOut(client, routeRunId);
  const manifest = await readManifest(client, context, routeRunId);
  return {
    routeRunId,
    dryRun: options.dryRun,
    before,
    after,
    manifest,
    payloads,
    stops,
  };
}

async function run(argv = process.argv.slice(2), env = process.env) {
  const { loadEnv } = require("../utils/load-env");
  loadEnv();
  const args = parseArgs(argv);
  const organizationId = normalizeUuid(args.orgId || env.MOBILE_V2_ROUTE_DEPARTURE_ORG_ID);
  if (!organizationId) throw new Error("--org-id is required");
  const proofMarker = normalizeText(args.proofMarker) || `MobileV2RouteDepartureReadiness${Date.now()}`;
  const databaseUrl = normalizeText(env.DATABASE_URL || env.PG_CONN_STRING || env.DATABASE_URL_DIRECT || env.DATABASE_URL_POOLER);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL, PG_CONN_STRING, DATABASE_URL_DIRECT, or DATABASE_URL_POOLER is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const userId = await resolveDriverUser(client, args);
    const context = { organizationId, userId };
    const user = await assertDriverTenantScope(client, context);
    const actorUserId = normalizeUuid(args.actorUserId)
      || await resolveAuthUserByEmail(client, args.actorEmail, "Actor")
      || userId;
    const actor = await assertTenantUserScope(client, { organizationId, userId: actorUserId }, "Actor");
    const policy = await resolveMobileV2Policy(client, context);
    if (policy?.v2_enabled !== true) {
      throw new Error("mobile_shell_policy.v2_enabled is not true for this driver/tenant");
    }

    let createdFixture = null;
    let fixtureAssignment = null;
    if (args.createFixture) {
      if (args.dryRun) {
        throw new Error("--create-fixture cannot be combined with --dry-run because it must create backend rows");
      }
      createdFixture = await createDepartureFixture(client, {
        organizationId,
        userId,
        proofMarker,
      });
      fixtureAssignment = await assignDepartureFixtureRoute(client, {
        routeRunId: createdFixture.routeRunId,
        driverUserId: userId,
        vehicleId: createdFixture.vehicleId,
        actorUserId,
        proofMarker,
      });
    }

    const routeTasks = await resolveDriverRouteTasks(client, context);
    const groups = groupRouteTasks(routeTasks);
    const preferredRouteRunId = normalizeUuid(args.routeRunId || createdFixture?.routeRunId);
    const selectedGroup = selectRouteGroup(groups, preferredRouteRunId);
    if (!selectedGroup) throw new Error("No Mobile V2 driver route tasks are visible for this tenant driver");

    const deviceId = normalizeUuid(args.deviceId) || await findActiveDeviceId(client, context);
    const opsSessionId = normalizeUuid(args.opsSessionId) || await findOpenOpsSessionId(client, context);
    const routeGroupsToPrepare = args.allVisible
      ? groups.filter((group) => !group.tasks.every((task) => TERMINAL_ROUTE_STATUSES.has(task.routeRunStatus)))
      : [selectedGroup];

    const preparations = [];
    if (args.prepare || args.dryRun) {
      for (const group of routeGroupsToPrepare) {
        preparations.push(await prepareRouteScanOut(client, context, group.routeRunId, {
          deviceId,
          opsSessionId,
          proofMarker,
          dryRun: args.dryRun,
        }));
      }
    }

    return {
      ok: true,
      proofSlice: DEFAULT_PROOF_SLICE,
      proofMarker,
      mobileV2Policy: policy,
      driver: {
        userId,
        email: user.email,
        organizationId,
      },
      actor: {
        userId: actorUserId,
        email: actor.email,
        organizationId,
      },
      createdFixture,
      fixtureAssignment,
      selectedRoute: selectedGroup,
      visibleRouteGroups: groups,
      deviceId: deviceId || null,
      opsSessionId: opsSessionId || null,
      preparations,
      proofPath: {
        nativeRuntime: "Verify api.resolve_mobile_shell_policy returns v2_enabled=true and visible app shell is Mobile V2, not V1 fallback.",
        visibleSteps: [
          "Open native FieldOps Mobile V2 with this driver.",
          "Tap the visible Tasks tab.",
          `Tap the visible task ${selectedGroup.tasks[0]?.title || selectedGroup.routeRunId}.`,
          "Tap the visible Route tab.",
          "Verify the manifest shows Scan-out ready and Ready to depart.",
          "Tap Confirm departure.",
          "Stay in the same Route tab and verify Departed without app restart or reload.",
        ],
        backendReadback: [
          "api.ui_route_run_execution_manifest_v1(route_run_id)",
          "api.route_run_scan_out_reconciliation_v1(route_run_id)",
          "public.route_runs.metadata->'route_departure'",
        ],
      },
    };
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(`[mobile-v2-route-departure-readiness] ${error?.message || String(error)}`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildDepartureDestinationFixture,
  buildDriverClaims,
  buildRouteAssignmentPayload,
  buildRouteLoadScanPayload,
  groupRouteTasks,
  normalizeUuid,
  parseArgs,
  routeTaskIsActionable,
  selectRouteGroup,
};
