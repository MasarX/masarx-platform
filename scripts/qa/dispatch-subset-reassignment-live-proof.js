#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');

const DEFAULT_OUTPUT = 'docs/ops/evidence/2026-06-02/dispatch-subset-reassignment/backend-readback.json';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizeLocalhost(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname === '127.0.0.1') url.hostname = 'localhost';
  return url.toString();
}

async function setServiceContext(client, userId, organizationId) {
  await client.query('SET ROLE service_role');
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({
      sub: String(userId),
      role: 'service_role',
      organization_id: String(organizationId),
    }),
  ]);
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [String(userId)]);
  await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false)`);
}

async function setAuthContext(client, userId) {
  await client.query('SET ROLE authenticated');
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: String(userId), role: 'authenticated' }),
  ]);
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [String(userId)]);
  await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false)`);
}

async function one(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] ?? null;
}

async function ensureUser(client, organizationId, email, userType, fullName) {
  const existing = await one(
    client,
    `SELECT id FROM public.users WHERE organization_id = $1::uuid AND email = $2`,
    [organizationId, email],
  );
  if (existing?.id) return { id: existing.id, created: false };
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.users (
       id, organization_id, email, full_name, user_type, status, access_scope_type
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'active', 'tenant')`,
    [id, organizationId, email, fullName, userType],
  );
  const { rows } = await client.query(
    `SELECT template_key, role_id
       FROM public.provision_rbac_roles_from_templates_v1($1::uuid, $2::text[], $3::uuid)`,
    [organizationId, [userType], id],
  );
  const roleId = rows?.[0]?.role_id ?? null;
  if (roleId) {
    await client.query(
      `INSERT INTO public.rbac_user_role_assignments (
         organization_id, user_id, role_id, assigned_by_user_id, metadata
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $2::uuid, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [organizationId, id, roleId, JSON.stringify({ source: 'dispatch-subset-reassignment-live-proof' })],
    );
  }
  return { id, created: true };
}

async function ensureVehicle(client, organizationId, plateNumber, marker) {
  const existing = await one(
    client,
    `SELECT id FROM public.vehicles WHERE organization_id = $1::uuid AND plate_number = $2`,
    [organizationId, plateNumber],
  );
  if (existing?.id) return { id: existing.id, created: false };
  const row = await one(
    client,
    `INSERT INTO public.vehicles (organization_id, plate_number, status, is_active, metadata)
     VALUES ($1::uuid, $2, 'active', true, $3::jsonb)
     RETURNING id`,
    [organizationId, plateNumber, JSON.stringify({ proof_marker: marker })],
  );
  return { id: row.id, created: true };
}

async function createShipment(client, organizationId, clientId, trackingNumber, marker) {
  const row = await one(
    client,
    `INSERT INTO public.shipments (
       organization_id, client_id, service_type, tracking_number, status, metadata
     )
     VALUES ($1::uuid, $2::uuid, 'delivery', $3, 'pending', $4::jsonb)
     RETURNING id, tracking_number`,
    [organizationId, clientId, trackingNumber, JSON.stringify({ proof_marker: marker })],
  );
  return row;
}

async function main() {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const marker = argValue('--marker', `DispatchSubsetReassign${Date.now()}`);
  const output = argValue('--out', DEFAULT_OUTPUT);
  const organizationId = argValue('--org-id', process.env.FIRST_TENANT_ORG_ID ?? '');
  if (!organizationId) throw new Error('--org-id or FIRST_TENANT_ORG_ID is required');
  const client = new Client({
    connectionString: normalizeLocalhost(databaseUrl),
    connectionTimeoutMillis: 5000,
    query_timeout: 30000,
    statement_timeout: 30000,
  });

  await client.connect();
  try {
    const organization = await one(
      client,
      `SELECT id, name, slug FROM public.organizations WHERE id = $1::uuid`,
      [organizationId],
    );
    if (!organization) throw new Error(`organization not found: ${organizationId}`);
    const branch = await one(
      client,
      `SELECT id, code, name FROM public.branches
        WHERE organization_id = $1::uuid AND is_active IS DISTINCT FROM false
        ORDER BY created_at LIMIT 1`,
      [organizationId],
    );
    if (!branch) throw new Error('active branch not found');
    const tenantClient = await one(
      client,
      `SELECT id, name FROM public.clients
        WHERE organization_id = $1::uuid AND status = 'active'
        ORDER BY created_at LIMIT 1`,
      [organizationId],
    );
    if (!tenantClient) throw new Error('active client not found');

    const operator = await ensureUser(
      client,
      organizationId,
      `dispatch-subset-ops-${marker.toLowerCase()}@first-tenant.local`,
      'ops_admin',
      `Dispatch Subset Operator ${marker}`,
    );
    const sourceDriver = await ensureUser(
      client,
      organizationId,
      `dispatch-subset-driver-a-${marker.toLowerCase()}@first-tenant.local`,
      'driver',
      `Dispatch Source Driver ${marker}`,
    );
    const targetDriver = await ensureUser(
      client,
      organizationId,
      `dispatch-subset-driver-b-${marker.toLowerCase()}@first-tenant.local`,
      'driver',
      `Dispatch Target Driver ${marker}`,
    );
    const sourceVehicle = await ensureVehicle(client, organizationId, `DSA-${marker.slice(-6)}`, marker);
    const targetVehicle = await ensureVehicle(client, organizationId, `DSB-${marker.slice(-6)}`, marker);

    const shipments = [];
    for (const index of [1, 2]) {
      shipments.push(
        await createShipment(
          client,
          organizationId,
          tenantClient.id,
          `DSR-${marker.slice(-10).toUpperCase()}-${index}`,
          marker,
        ),
      );
    }

    await setServiceContext(client, operator.id, organizationId);
    const route = await one(
      client,
      `SELECT *
         FROM public.create_route_run_v1($1::jsonb)`,
      [
        JSON.stringify({
          organization_id: organizationId,
          branch_id: branch.id,
          status: 'in_progress',
          idempotency_key: `dispatch-subset-route-${marker}`,
          metadata: { proof_marker: marker, proof_slice: 'dispatch_subset_reassignment' },
          stops: shipments.map((shipment, index) => ({
            client_id: tenantClient.id,
            shipment_id: shipment.id,
            stop_kind: 'delivery',
            sequence_order: index + 1,
            metadata: { proof_marker: marker },
          })),
        }),
      ],
    );
    const routeRunId = route?.route_run_id;
    const stopIds = Array.isArray(route?.stop_ids) ? route.stop_ids.map(String) : [];
    if (!routeRunId || stopIds.length !== 2) throw new Error('create_route_run_v1 did not return a two-stop route');

    await setAuthContext(client, operator.id);
    const assign = await one(
      client,
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb) AS payload`,
      [
        'routes.assign',
        'routes',
        [routeRunId],
        routeRunId,
        1,
        JSON.stringify({
          driver_user_id: sourceDriver.id,
          vehicle_id: sourceVehicle.id,
          idempotency_key: `dispatch-subset-assign-source-${marker}`,
          metadata: { proof_marker: marker },
        }),
      ],
    );

    const movedStopId = stopIds[1];
    await setAuthContext(client, operator.id);
    const reassignment = await one(
      client,
      `SELECT api.ui_execute_route_stop_reassign_v1($1, $2, $3::text[], NULL, $4, $5::jsonb) AS payload`,
      [
        'route_stops.reassign',
        'route_stops',
        [movedStopId],
        1,
        JSON.stringify({
          driver_user_id: targetDriver.id,
          vehicle_id: targetVehicle.id,
          reassignment_reason: `Subset capacity rebalance ${marker}`,
          idempotency_key: `dispatch-subset-stop-reassign-${marker}`,
          metadata: { proof_marker: marker },
        }),
      ],
    );
    const targetRouteRunId = reassignment?.payload?.items?.[0]?.target_route_run_id;
    if (!targetRouteRunId || targetRouteRunId === routeRunId) {
      throw new Error('route stop reassignment did not create a separate target route');
    }

    await setServiceContext(client, operator.id, organizationId);
    const readback = {};
    readback.sourceStops = (await client.query(
      `SELECT id, route_run_id, sequence_order, shipment_id
         FROM public.route_stops WHERE route_run_id = $1::uuid
         ORDER BY sequence_order`,
      [routeRunId],
    )).rows;
    readback.targetStops = (await client.query(
      `SELECT id, route_run_id, sequence_order, shipment_id
         FROM public.route_stops WHERE route_run_id = $1::uuid
         ORDER BY sequence_order`,
      [targetRouteRunId],
    )).rows;
    readback.tasks = (await client.query(
      `SELECT t.id, t.resource_id, t.assigned_to, t.status, t.metadata
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
        WHERE tt.key = 'route_stop_execute'
          AND t.resource_type = 'route_stop'
          AND t.resource_id = ANY($1::uuid[])
        ORDER BY t.resource_id::text`,
      [stopIds],
    )).rows;
    readback.events = (await client.query(
      `SELECT id, route_stop_id, source_route_run_id, target_route_run_id, event_type, payload
         FROM public.route_stop_reassignment_events
        WHERE route_stop_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 5`,
      [movedStopId],
    )).rows;
    readback.directories = (await client.query(
      `SELECT id, run_display_id, stop_count, driver_user_id, vehicle_id, assignment_status
         FROM public.v_route_run_directory
        WHERE id IN ($1::uuid, $2::uuid)
        ORDER BY id::text`,
      [routeRunId, targetRouteRunId],
    )).rows;

    if (readback.sourceStops.length !== 1) throw new Error('source route did not keep exactly one stop');
    if (readback.targetStops.length !== 1) throw new Error('target route did not receive exactly one stop');
    if (String(readback.targetStops[0].id) !== String(movedStopId)) throw new Error('moved stop readback mismatch');
    if (!readback.events.length) throw new Error('route_stop_reassignment_events readback missing');

    const payload = {
      marker,
      generated_at: new Date().toISOString(),
      organization,
      branch,
      client: tenantClient,
      operator_user_id: operator.id,
      source_driver_user_id: sourceDriver.id,
      target_driver_user_id: targetDriver.id,
      source_vehicle_id: sourceVehicle.id,
      target_vehicle_id: targetVehicle.id,
      source_route_run_id: routeRunId,
      target_route_run_id: targetRouteRunId,
      source_stop_id: stopIds[0],
      moved_stop_id: movedStopId,
      shipment_tracking_numbers: shipments.map((shipment) => shipment.tracking_number),
      assign_payload: assign?.payload,
      reassign_payload: reassignment?.payload,
      readback,
    };

    const outputPath = path.resolve(output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({
      marker,
      output,
      source_route_run_id: routeRunId,
      target_route_run_id: targetRouteRunId,
      moved_stop_id: movedStopId,
      source_stop_count: readback.sourceStops.length,
      target_stop_count: readback.targetStops.length,
      event_count: readback.events.length,
    }, null, 2));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
