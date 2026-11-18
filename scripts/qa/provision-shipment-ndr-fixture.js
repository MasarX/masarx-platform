#!/usr/bin/env node
/*
  Controlled setup-only helper for Shipment UC20/NDR proof.

  This script creates an open dispatch_exception_review task through canonical
  RPC/workflow seams only. It does not insert/update/delete shipment, route, or
  task truth directly, and its output must be treated as setup evidence, not
  product proof.

  Example:
    ENV_FILE=config/env/.env.local node scripts/qa/provision-shipment-ndr-fixture.js --org-id <org_uuid>
*/

const { randomBytes } = require("crypto");
const { Pool } = require("pg");
const { loadEnv } = require("../utils/load-env");

const DEFAULT_FAILURE_REASON = "access_restricted";
const DEFAULT_SOURCE = "controlled_setup_only.shipment_uc20_ndr";
const TERMINAL_TASK_STATUSES = new Set(["completed", "closed", "resolved", "done", "cancelled", "canceled", "void", "rejected"]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeUuid(value) {
  const text = normalizeText(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text.toLowerCase()
    : "";
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.split("=", 2);
    const key = rawKey.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "help") {
      args.help = true;
      continue;
    }
    const value = inlineValue === undefined ? argv[i + 1] : inlineValue;
    if (inlineValue === undefined) i += 1;
    args[key] = normalizeText(value);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/qa/provision-shipment-ndr-fixture.js [options]",
    "",
    "Options:",
    "  --org-id <uuid>             Tenant organization. Defaults to first active org with shipment substrate.",
    "  --client-id <uuid>          Existing client in the organization.",
    "  --sender-id <uuid>          Existing active sender for the client.",
    "  --driver-user-id <uuid>     Existing driver user.",
    "  --driver-email <email>      Existing driver user email.",
    "  --actor-user-id <uuid>      Existing operator actor. Defaults to driver when suitable.",
    "  --actor-email <email>       Existing operator actor email.",
    "  --branch-id <uuid>          Existing active branch.",
    "  --vehicle-id <uuid>         Existing active vehicle; optional when no vehicle exists.",
    "  --failure-reason <key>      dispatch_exception_reason key. Default: access_restricted.",
    "  --proof-marker <text>       Marker in metadata/output. Default generated.",
  ].join("\n");
}

function buildClaims({ organizationId, userId, role = "authenticated", scopeType = "tenant" }) {
  return {
    role,
    sub: userId,
    organization_id: organizationId,
    scope_type: scopeType,
    scope_id: organizationId,
  };
}

async function withClaims(client, role, claims, callback) {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config($1, $2, true)", ["request.jwt.claims", JSON.stringify(claims)]);
    await client.query("SELECT set_config($1, $2, true)", ["request.jwt.claim.role", claims.role || role]);
    await client.query("SELECT set_config($1, $2, true)", ["request.jwt.claim.sub", claims.sub || ""]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] ?? null;
}

async function assertFunctionExists(client, schema, name) {
  const row = await one(
    client,
    `
      select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = $1
         and p.proname = $2
       limit 1
    `,
    [schema, name],
  );
  if (!row) throw new Error(`Required canonical seam missing: ${schema}.${name}`);
}

async function resolveContext(client, args, env) {
  const requestedOrgId = normalizeUuid(args.orgId || env.SHIPMENT_NDR_SETUP_ORG_ID);
  const requestedClientId = normalizeUuid(args.clientId || env.SHIPMENT_NDR_SETUP_CLIENT_ID);
  const requestedSenderId = normalizeUuid(args.senderId || env.SHIPMENT_NDR_SETUP_SENDER_ID);
  const requestedBranchId = normalizeUuid(args.branchId || env.SHIPMENT_NDR_SETUP_BRANCH_ID);
  const requestedVehicleId = normalizeUuid(args.vehicleId || env.SHIPMENT_NDR_SETUP_VEHICLE_ID);
  const requestedDriverId = normalizeUuid(args.driverUserId || env.SHIPMENT_NDR_SETUP_DRIVER_USER_ID);
  const requestedActorId = normalizeUuid(args.actorUserId || env.SHIPMENT_NDR_SETUP_ACTOR_USER_ID);
  const driverEmail = normalizeText(args.driverEmail || env.SHIPMENT_NDR_SETUP_DRIVER_EMAIL).toLowerCase();
  const actorEmail = normalizeText(args.actorEmail || env.SHIPMENT_NDR_SETUP_ACTOR_EMAIL).toLowerCase();

  const org = await one(
    client,
    `
      select o.id
        from public.organizations o
       where ($1::uuid is null or o.id = $1::uuid)
         and exists (
           select 1
             from public.clients c
            where c.organization_id = o.id
              and coalesce(c.status, 'active') = 'active'
         )
         and exists (
           select 1
             from public.clients c
             join public.senders s on s.client_id = c.id
            where c.organization_id = o.id
              and coalesce(c.status, 'active') = 'active'
              and coalesce(s.status, 'active') = 'active'
         )
         and exists (
           select 1
             from public.branches b
            where b.organization_id = o.id
              and coalesce(b.is_active, true) = true
         )
         and exists (
           select 1
             from public.users u
            where u.organization_id = o.id
              and coalesce(u.status, 'active') = 'active'
              and lower(coalesce(u.user_type, '')) in ('driver', 'field_ops_driver', 'courier')
         )
       order by o.created_at, o.id
       limit 1
    `,
    [requestedOrgId || null],
  );
  if (!org?.id) throw new Error("No organization found for setup context");
  const organizationId = org.id;

  const clientRow = await one(
    client,
    `
      select c.id
        from public.clients c
       where c.organization_id = $1::uuid
         and ($2::uuid is null or c.id = $2::uuid)
         and coalesce(c.status, 'active') = 'active'
       order by c.created_at, c.id
       limit 1
    `,
    [organizationId, requestedClientId || null],
  );
  if (!clientRow?.id) throw new Error(`No active client found for organization ${organizationId}`);

  const sender = await one(
    client,
    `
      select s.id
        from public.senders s
       where s.client_id = $1::uuid
         and ($2::uuid is null or s.id = $2::uuid)
         and coalesce(s.status, 'active') = 'active'
       order by s.created_at, s.id
       limit 1
    `,
    [clientRow.id, requestedSenderId || null],
  );
  if (!sender?.id) throw new Error(`No active sender found for client ${clientRow.id}`);

  const branch = await one(
    client,
    `
      select b.id
        from public.branches b
       where b.organization_id = $1::uuid
         and ($2::uuid is null or b.id = $2::uuid)
         and coalesce(b.is_active, true) = true
       order by b.created_at, b.id
       limit 1
    `,
    [organizationId, requestedBranchId || null],
  );
  if (!branch?.id) throw new Error(`No active branch found for organization ${organizationId}`);

  const driver = await one(
    client,
    `
      select u.id, u.email, u.user_type
        from public.users u
       where u.organization_id = $1::uuid
         and ($2::uuid is null or u.id = $2::uuid)
         and ($3::text = '' or lower(u.email) = $3::text)
         and coalesce(u.status, 'active') = 'active'
         and lower(coalesce(u.user_type, '')) in ('driver', 'field_ops_driver', 'courier')
       order by u.created_at, u.id
       limit 1
    `,
    [organizationId, requestedDriverId || null, driverEmail],
  );
  if (!driver?.id) throw new Error(`No active driver user found for organization ${organizationId}`);

  const actor = await one(
    client,
    `
      select u.id, u.email, u.user_type
        from public.users u
       where u.organization_id = $1::uuid
         and ($2::uuid is null or u.id = $2::uuid)
         and ($3::text = '' or lower(u.email) = $3::text)
         and coalesce(u.status, 'active') = 'active'
       order by case when lower(coalesce(u.user_type, '')) in ('ops_admin', 'admin', 'operator') then 0 else 1 end,
                u.created_at,
                u.id
       limit 1
    `,
    [organizationId, requestedActorId || null, actorEmail],
  );
  if (!actor?.id) throw new Error(`No active actor user found for organization ${organizationId}`);

  const vehicle = await one(
    client,
    `
      select v.id
        from public.vehicles v
       where v.organization_id = $1::uuid
         and ($2::uuid is null or v.id = $2::uuid)
         and lower(coalesce(v.status, 'active')) not in ('inactive', 'retired', 'deleted')
       order by v.created_at, v.id
       limit 1
    `,
    [organizationId, requestedVehicleId || null],
  );

  return {
    organizationId,
    clientId: clientRow.id,
    senderId: sender.id,
    branchId: branch.id,
    driverUserId: driver.id,
    driverEmail: driver.email,
    actorUserId: actor.id,
    actorEmail: actor.email,
    vehicleId: vehicle?.id ?? null,
  };
}

async function resolveFailureReason(client, requestedReason) {
  const reason = normalizeText(requestedReason || DEFAULT_FAILURE_REASON).toLowerCase();
  const preferred = await one(
    client,
    `
      select lv.value, lv.metadata
        from public.lookup_values lv
        join public.lookup_definitions ld on ld.id = lv.lookup_definition_id
       where ld.category = 'dispatch_exception_reason'
         and lv.value = $1
         and coalesce(lv.status, 'active') = 'active'
       limit 1
    `,
    [reason],
  );
  if (preferred?.value) return preferred;

  const fallback = await one(
    client,
    `
      select lv.value, lv.metadata
        from public.lookup_values lv
        join public.lookup_definitions ld on ld.id = lv.lookup_definition_id
       where ld.category = 'dispatch_exception_reason'
         and coalesce(lv.status, 'active') = 'active'
         and nullif(btrim(coalesce(lv.metadata->>'recommended_followup_task_type_key', '')), '') = 'dispatch_exception_review'
       order by lv.sort_order nulls last, lv.created_at, lv.id
       limit 1
    `,
  );
  if (!fallback?.value) throw new Error("No active dispatch_exception_reason can create dispatch_exception_review");
  return fallback;
}

async function createShipment(client, context, marker) {
  const trackingNumber = `UC20NDR${randomBytes(5).toString("hex").toUpperCase()}`;
  const clientReference = `UC20-NDR-${Date.now()}`;
  const metadata = {
    source: DEFAULT_SOURCE,
    controlled_setup_only: true,
    proof_marker: marker,
  };
  return withClaims(
    client,
    "service_role",
    buildClaims({ organizationId: context.organizationId, userId: context.actorUserId, role: "service_role" }),
    async (tx) => {
      const row = await one(
        tx,
        `
          select api.ui_create_shipment_v1(
            $1::uuid,
            $2::uuid,
            'delivery',
            $3::text,
            $4::text,
            null,
            'pending',
            $5::jsonb
          ) as result
        `,
        [context.clientId, context.senderId, trackingNumber, clientReference, JSON.stringify(metadata)],
      );
      const result = row?.result ?? {};
      if (!normalizeUuid(result.shipment_id)) throw new Error("api.ui_create_shipment_v1 did not return shipment_id");
      return {
        ...result,
        tracking_number: result.tracking_number || trackingNumber,
        client_reference_number: clientReference,
      };
    },
  );
}

async function createRoute(client, context, shipment, marker) {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const payload = {
    organization_id: context.organizationId,
    branch_id: context.branchId,
    driver_user_id: context.driverUserId,
    ...(context.vehicleId ? { vehicle_id: context.vehicleId } : {}),
    status: "planned",
    planned_date: start.toISOString().slice(0, 10),
    planned_start_at: start.toISOString(),
    planned_end_at: end.toISOString(),
    idempotency_key: `shipment-uc20-ndr-route-${marker}`,
    metadata: {
      source: DEFAULT_SOURCE,
      controlled_setup_only: true,
      proof_marker: marker,
    },
    stops: [
      {
        client_id: context.clientId,
        shipment_id: shipment.shipment_id,
        stop_kind: "delivery",
        sequence_order: 1,
        planned_window_start_at: start.toISOString(),
        planned_window_end_at: end.toISOString(),
        metadata: {
          source: DEFAULT_SOURCE,
          controlled_setup_only: true,
          proof_marker: marker,
        },
      },
    ],
  };

  return withClaims(
    client,
    "service_role",
    buildClaims({ organizationId: context.organizationId, userId: context.actorUserId, role: "service_role" }),
    async (tx) => {
      const row = await one(tx, "select * from public.create_route_run_v1($1::jsonb)", [JSON.stringify(payload)]);
      const routeRunId = normalizeUuid(row?.route_run_id);
      const routeStopId = normalizeUuid(Array.isArray(row?.stop_ids) ? row.stop_ids[0] : null);
      if (!routeRunId || !routeStopId) throw new Error("create_route_run_v1 did not return route_run_id and stop_ids[0]");
      return { routeRunId, routeStopId, payload, result: row };
    },
  );
}

async function assignRoute(client, context, routeRunId, marker) {
  const payload = {
    route_run_id: routeRunId,
    assignment_mode: "internal_driver",
    assignment_status: "assigned",
    driver_user_id: context.driverUserId,
    ...(context.vehicleId ? { vehicle_id: context.vehicleId } : {}),
    actor_user_id: context.actorUserId,
    actor_system: "shipment_uc20_ndr_controlled_setup",
    idempotency_key: `shipment-uc20-ndr-assign-${marker}`,
    metadata: {
      source: DEFAULT_SOURCE,
      controlled_setup_only: true,
      proof_marker: marker,
    },
  };
  return withClaims(
    client,
    "service_role",
    buildClaims({ organizationId: context.organizationId, userId: context.actorUserId, role: "service_role" }),
    async (tx) => {
      const row = await one(tx, "select * from public.assign_route_run_v1($1::jsonb)", [JSON.stringify(payload)]);
      if (!normalizeUuid(row?.route_run_id)) throw new Error("assign_route_run_v1 did not return route_run_id");
      if (Number(row.stop_task_count || 0) < 1 || Number(row.assigned_task_count || 0) < 1) {
        throw new Error("assign_route_run_v1 did not create/assign route_stop_execute task");
      }
      return { payload, result: row };
    },
  );
}

async function fetchStopTask(client, context, routeStopId) {
  const row = await one(
    client,
    `
      select t.id, t.status, t.assigned_to, t.resource_id, t.metadata
        from public.tasks t
       where t.organization_id = $1::uuid
         and t.task_type_key = 'route_stop_execute'
         and t.resource_type = 'route_stop'
         and t.resource_id = $2::uuid
       order by t.created_at desc, t.id desc
       limit 1
    `,
    [context.organizationId, routeStopId],
  );
  if (!row?.id) throw new Error(`No route_stop_execute task found for route_stop ${routeStopId}`);
  if (TERMINAL_TASK_STATUSES.has(normalizeText(row.status).toLowerCase())) {
    throw new Error(`route_stop_execute task ${row.id} is already terminal (${row.status})`);
  }
  return row;
}

async function recordLoadScan(client, context, route, shipment, marker) {
  const device = await registerDevice(client, context, marker);
  const payload = {
    organization_id: context.organizationId,
    idempotency_key: `shipment-uc20-ndr-load-${marker}`,
    device_id: device.device_id,
    route_run_id: route.routeRunId,
    route_stop_id: route.routeStopId,
    shipment_id: shipment.shipment_id,
    client_id: context.clientId,
    branch_id: context.branchId,
    scan_type: "load",
    barcode: shipment.tracking_number,
    captured_at: new Date().toISOString(),
    metadata: {
      source: DEFAULT_SOURCE,
      controlled_setup_only: true,
      proof_marker: marker,
    },
  };

  return withClaims(
    client,
    "authenticated",
    buildClaims({ organizationId: context.organizationId, userId: context.driverUserId }),
    async (tx) => {
      const row = await one(tx, "select * from api.record_scan_event_v1($1::jsonb)", [JSON.stringify(payload)]);
      return { device, payload, result: row };
    },
  );
}

async function registerDevice(client, context, marker) {
  const payload = {
    device_platform: "android",
    device_identifier_sha256: randomBytes(32).toString("hex"),
    device_label: `Shipment UC20 NDR setup ${marker}`,
    app_version: "qa-setup",
    os_version: "controlled-setup",
    metadata: {
      source: DEFAULT_SOURCE,
      controlled_setup_only: true,
      proof_marker: marker,
    },
  };
  return withClaims(
    client,
    "authenticated",
    buildClaims({ organizationId: context.organizationId, userId: context.driverUserId }),
    async (tx) => {
      const row = await one(tx, "select * from public.register_user_device_v1($1::jsonb)", [JSON.stringify(payload)]);
      if (!normalizeUuid(row?.device_id)) throw new Error("register_user_device_v1 did not return device_id");
      return { ...row, payload };
    },
  );
}

async function confirmDeparture(client, context, route, task, marker) {
  const payload = {
    route_run_id: route.routeRunId,
    route_stop_id: route.routeStopId,
    task_id: task.id,
    metadata: {
      source: DEFAULT_SOURCE,
      controlled_setup_only: true,
      proof_marker: marker,
    },
  };
  return withClaims(
    client,
    "authenticated",
    buildClaims({ organizationId: context.organizationId, userId: context.driverUserId }),
    async (tx) => {
      const row = await one(tx, "select api.ui_confirm_route_run_departure_v1($1::jsonb) as result", [JSON.stringify(payload)]);
      if (!row?.result?.route_departure?.confirmed_at) {
        throw new Error("ui_confirm_route_run_departure_v1 did not return confirmed_at");
      }
      return { payload, result: row.result };
    },
  );
}

function buildFailedAttemptPayload({ context, route, shipment, task, failureReason, marker }) {
  const capturedAt = new Date().toISOString();
  const exceptionEvidence = {
    notes: `Controlled setup-only failed delivery for Shipment UC20/NDR ${marker}`,
    captured_at: capturedAt,
    geostamp: {
      latitude: 24.7136,
      longitude: 46.6753,
      accuracy_m: 8,
    },
    proof_artifact_count: 0,
  };
  const deliveryAttempt = {
    outcome: "not_delivered",
    reason: failureReason,
    dispatch_exception_reason: failureReason,
    exception_reason: failureReason,
    attempted_at: capturedAt,
    exception_evidence: exceptionEvidence,
    route_stop_outcome: "attempted",
  };
  const routeStopCompletion = {
    completion_kind: "not_delivered",
    status_reason: failureReason,
    exception_reason: failureReason,
    notes: exceptionEvidence.notes,
    completion_notes: exceptionEvidence.notes,
    delivery_attempt: deliveryAttempt,
    captured_at: capturedAt,
    geostamp: exceptionEvidence.geostamp,
    pod: {
      completion_kind: "not_delivered",
      captured_at: capturedAt,
      geostamp: exceptionEvidence.geostamp,
    },
  };
  return {
    route_stop_id: route.routeStopId,
    shipment_id: shipment.shipment_id,
    route_stop_completion: routeStopCompletion,
    completion_kind: "not_delivered",
    status_reason: failureReason,
    outcome_reason: failureReason,
    exception_reason: failureReason,
    delivery_attempt: deliveryAttempt,
    exception_evidence: exceptionEvidence,
    controlled_setup_only: true,
    proof_marker: marker,
    context: {
      organization_id: context.organizationId,
      client_id: context.clientId,
      sender_id: context.senderId,
      route_run_id: route.routeRunId,
      route_stop_id: route.routeStopId,
      shipment_id: shipment.shipment_id,
      route_stop_execute_task_id: task.id,
    },
  };
}

async function completeFailedStop(client, context, route, shipment, task, failureReason, marker) {
  const payload = buildFailedAttemptPayload({ context, route, shipment, task, failureReason, marker });
  const transition = await withClaims(
    client,
    "authenticated",
    buildClaims({ organizationId: context.organizationId, userId: context.driverUserId }),
    async (tx) => {
      const row = await one(
        tx,
        `
          select *
            from api.transition_task_v1(
              $1::uuid,
              'completed',
              $2::text,
              $3::jsonb,
              $4::text
            )
        `,
        [task.id, failureReason, JSON.stringify(payload), `shipment-uc20-ndr-closeout-${marker}`],
      );
      if (!normalizeUuid(row?.task_event_id)) throw new Error("api.transition_task_v1 did not return task_event_id");
      return row;
    },
  );

  const finalize = await withClaims(
    client,
    "authenticated",
    buildClaims({ organizationId: context.organizationId, userId: context.driverUserId }),
    async (tx) => {
      const row = await one(tx, "select * from api.ui_finalize_route_stop_closeout_event_v1($1::uuid, 50)", [
        transition.task_event_id,
      ]);
      if (!normalizeUuid(row?.shipment_action_id)) {
        throw new Error("api.ui_finalize_route_stop_closeout_event_v1 did not return shipment_action_id");
      }
      return row;
    },
  );

  return { payload, transition, finalize };
}

async function readNdrTask(client, context, route, shipment, closeout) {
  const row = await one(
    client,
    `
      select
        t.id,
        t.status,
        t.status_reason,
        t.task_type_key,
        t.resource_type,
        t.resource_id,
        t.workflow_run_id,
        t.created_at,
        t.metadata
      from public.tasks t
      where t.organization_id = $1::uuid
        and t.task_type_key = 'dispatch_exception_review'
        and t.resource_type = 'shipment'
        and t.resource_id = $2::uuid
        and (
          t.metadata->>'shipment_action_id' = $3::text
          or t.metadata->>'route_stop_id' = $4::text
        )
      order by t.created_at desc, t.id desc
      limit 1
    `,
    [context.organizationId, shipment.shipment_id, closeout.finalize.shipment_action_id, route.routeStopId],
  );
  if (!row?.id) throw new Error("No dispatch_exception_review task was created by route-stop closeout");
  if (normalizeText(row.status).toLowerCase() !== "open") {
    throw new Error(`dispatch_exception_review task ${row.id} is not open (status=${row.status})`);
  }
  return row;
}

function taskHasAllowedActions(task) {
  const metadata = task && typeof task.metadata === "object" && task.metadata !== null ? task.metadata : {};
  return Array.isArray(metadata.allowed_ndr_actions) && metadata.allowed_ndr_actions.length > 0;
}

async function repairAllowedActionsIfNeeded(client, context, ndrTask) {
  if (taskHasAllowedActions(ndrTask)) {
    return { repaired: false, task: ndrTask, repair_result: null };
  }
  const repairResult = await withClaims(
    client,
    "service_role",
    buildClaims({ organizationId: context.organizationId, userId: context.actorUserId, role: "service_role" }),
    async (tx) => {
      const row = await one(tx, "select public.repair_dispatch_exception_review_allowed_actions_v1($1::uuid) as repaired_count", [
        ndrTask.id,
      ]);
      return row ?? {};
    },
  );
  const repairedTask = await one(
    client,
    `
      select
        t.id,
        t.status,
        t.status_reason,
        t.task_type_key,
        t.resource_type,
        t.resource_id,
        t.workflow_run_id,
        t.created_at,
        t.metadata
      from public.tasks t
      where t.id = $1::uuid
      limit 1
    `,
    [ndrTask.id],
  );
  if (!taskHasAllowedActions(repairedTask)) {
    throw new Error(`dispatch_exception_review task ${ndrTask.id} still has no allowed_ndr_actions after canonical repair`);
  }
  return { repaired: true, task: repairedTask, repair_result: repairResult };
}

async function run(argv = process.argv.slice(2), env = process.env) {
  loadEnv();
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return null;
  }

  const databaseUrl = normalizeText(args.databaseUrl || env.DATABASE_URL || env.PG_CONN_STRING || env.DATABASE_URL_DIRECT);
  if (!databaseUrl) throw new Error("DATABASE_URL, PG_CONN_STRING, or DATABASE_URL_DIRECT is required");

  const marker = normalizeText(args.proofMarker || env.SHIPMENT_NDR_SETUP_PROOF_MARKER)
    || `ShipmentUC20NDR${Date.now()}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await assertFunctionExists(client, "api", "ui_create_shipment_v1");
    await assertFunctionExists(client, "public", "create_route_run_v1");
    await assertFunctionExists(client, "public", "assign_route_run_v1");
    await assertFunctionExists(client, "public", "register_user_device_v1");
    await assertFunctionExists(client, "api", "record_scan_event_v1");
    await assertFunctionExists(client, "api", "ui_confirm_route_run_departure_v1");
    await assertFunctionExists(client, "api", "transition_task_v1");
    await assertFunctionExists(client, "api", "ui_finalize_route_stop_closeout_event_v1");
    await assertFunctionExists(client, "public", "repair_dispatch_exception_review_allowed_actions_v1");

    const context = await resolveContext(client, args, env);
    const failureReasonRow = await resolveFailureReason(client, args.failureReason || env.SHIPMENT_NDR_SETUP_FAILURE_REASON);
    const failureReason = failureReasonRow.value;
    const shipment = await createShipment(client, context, marker);
    const route = await createRoute(client, context, shipment, marker);
    const assignment = await assignRoute(client, context, route.routeRunId, marker);
    const task = await fetchStopTask(client, context, route.routeStopId);
    const loadScan = await recordLoadScan(client, context, route, shipment, marker);
    const departure = await confirmDeparture(client, context, route, task, marker);
    const closeout = await completeFailedStop(client, context, route, shipment, task, failureReason, marker);
    const createdNdrTask = await readNdrTask(client, context, route, shipment, closeout);
    const ndrRepair = await repairAllowedActionsIfNeeded(client, context, createdNdrTask);
    const ndrTask = ndrRepair.task;

    const result = {
      setup_type: "controlled_setup_only",
      source: DEFAULT_SOURCE,
      captured_at: new Date().toISOString(),
      proof_marker: marker,
      canonical_seams: [
        "api.ui_create_shipment_v1",
        "public.create_route_run_v1",
        "public.assign_route_run_v1",
        "api.record_scan_event_v1",
        "api.ui_confirm_route_run_departure_v1",
        "api.transition_task_v1",
        "api.ui_finalize_route_stop_closeout_event_v1",
        "workflow_handlers.execute_route_stop_finalize_v11",
        "public.create_task_system_v1",
        "public.repair_dispatch_exception_review_allowed_actions_v1",
      ],
      context,
      failure_reason: failureReason,
      shipment: {
        id: shipment.shipment_id,
        tracking_number: shipment.tracking_number,
        workflow_run_id: shipment.workflow_run_id,
        correlation_id: shipment.correlation_id,
      },
      route: {
        route_run_id: route.routeRunId,
        route_stop_id: route.routeStopId,
      },
      assignment: assignment.result,
      route_stop_execute_task: task,
      load_scan: loadScan.result,
      departure: departure.result,
      closeout: {
        task_event_id: closeout.transition.task_event_id,
        workflow_run_id: closeout.finalize.workflow_run_id,
        workflow_status: closeout.finalize.workflow_status,
        shipment_action_id: closeout.finalize.shipment_action_id,
      },
      dispatch_exception_review_task: ndrTask,
      allowed_actions_repair: {
        repaired: ndrRepair.repaired,
        result: ndrRepair.repair_result,
      },
      next_console_path: "Operate > Exceptions > Dispatch exception review > search tracking/task > Preview > Apply",
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      setup_type: "controlled_setup_only",
      source: DEFAULT_SOURCE,
      captured_at: new Date().toISOString(),
      ok: false,
      error: error.message,
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_FAILURE_REASON,
  buildClaims,
  buildFailedAttemptPayload,
  normalizeText,
  normalizeUuid,
  parseArgs,
  run,
};
