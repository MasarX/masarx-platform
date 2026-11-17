const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const {
  DATABASE_URL,
  createOrganization,
  createClient,
  createShipment,
  createUser,
  setAuthContext,
} = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

describe('UC076 route run assignment lifecycle foundation', () => {
  let client;

  async function setServiceContext(userId, organizationId) {
    await client.query('SET LOCAL ROLE service_role');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        sub: String(userId),
        role: 'service_role',
        organization_id: String(organizationId),
      }),
    ]);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [String(userId)]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
  }

  async function seedRouteRun() {
    const { id: organizationId } = await createOrganization(client, 'UC076 Route Assignment Org');
    const { id: clientId } = await createClient(client, organizationId, 'UC076 Route Assignment Client');
    const operatorId = await createUser(
      client,
      organizationId,
      `uc076-ops-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' }
    );
    const driverId = await createUser(
      client,
      organizationId,
      `uc076-driver-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );
    const secondaryDriverId = await createUser(
      client,
      organizationId,
      `uc076-driver-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );

    const { rows: branchRows } = await client.query(
      `INSERT INTO public.branches (organization_id, code, name, timezone)
       VALUES ($1::uuid, $2, $3, 'Asia/Riyadh')
       RETURNING id`,
      [organizationId, `uc076-${randomUUID().slice(0, 6)}`, 'UC076 Branch']
    );
    const branchId = branchRows[0].id;

    const { rows: vehicleRows } = await client.query(
      `INSERT INTO public.vehicles (organization_id, plate_number, status, is_active)
       VALUES ($1::uuid, $2, 'active', true)
       RETURNING id`,
      [organizationId, `UC076-${randomUUID().slice(0, 6).toUpperCase()}`]
    );
    const vehicleId = vehicleRows[0].id;
    const { rows: secondaryVehicleRows } = await client.query(
      `INSERT INTO public.vehicles (organization_id, plate_number, status, is_active)
       VALUES ($1::uuid, $2, 'active', true)
       RETURNING id`,
      [organizationId, `UC076-${randomUUID().slice(0, 6).toUpperCase()}`]
    );
    const secondaryVehicleId = secondaryVehicleRows[0].id;

    const shipmentRows = [
      await createShipment(client, {
        organizationId,
        clientId,
        trackingNumber: `UC076-${randomUUID().slice(0, 8)}`,
      }),
      await createShipment(client, {
        organizationId,
        clientId,
        trackingNumber: `UC076-${randomUUID().slice(0, 8)}`,
      }),
    ].map((shipment) => ({
      id: shipment.id,
      client_id: clientId,
      tracking_number: shipment.trackingNumber,
    }));

    await setServiceContext(operatorId, organizationId);
    const { rows: routeRows } = await client.query(
      `SELECT *
         FROM public.create_route_run_v1(
           jsonb_build_object(
             'organization_id', $1::uuid,
             'branch_id', $2::uuid,
             'stops', $3::jsonb
           )
         )`,
      [
        organizationId,
        branchId,
        JSON.stringify(
          shipmentRows.map((shipment, index) => ({
            client_id: shipment.client_id,
            shipment_id: shipment.id,
            stop_kind: 'delivery',
            sequence_order: index + 1,
          }))
        ),
      ]
    );

    return {
      organizationId,
      clientId,
      operatorId,
      driverId,
      secondaryDriverId,
      branchId,
      vehicleId,
      secondaryVehicleId,
      routeRunId: routeRows[0]?.route_run_id,
      shipments: shipmentRows,
    };
  }

  async function createRouteRunForExistingSeed(seed, options = {}) {
    const stopCount =
      Number.isInteger(options.stopCount) && options.stopCount > 0 ? options.stopCount : 1;
    const trackingPrefix = String(options.trackingPrefix || 'UC077').trim();
    const shipments = [];

    for (let index = 0; index < stopCount; index += 1) {
      const shipment = await createShipment(client, {
        organizationId: seed.organizationId,
        clientId: seed.clientId,
        trackingNumber: `${trackingPrefix}-${randomUUID().slice(0, 8)}`,
      });
      shipments.push({
        client_id: seed.clientId,
        shipment_id: shipment.id,
        stop_kind: 'delivery',
        sequence_order: index + 1,
      });
    }

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows } = await client.query(
      `SELECT *
         FROM public.create_route_run_v1(
           jsonb_build_object(
             'organization_id', $1::uuid,
             'branch_id', $2::uuid,
             'stops', $3::jsonb
           )
         )`,
      [seed.organizationId, seed.branchId, JSON.stringify(shipments)]
    );

    return {
      routeRunId: rows[0]?.route_run_id ?? null,
      stopIds: Array.isArray(rows[0]?.stop_ids) ? rows[0].stop_ids : [],
    };
  }

  async function seedMarketplacePrivatePoolRequest(
    requesterOrganizationId,
    supplierOrganizationId,
    options = {}
  ) {
    const {
      requestKindKey = 'capacity_block',
      releaseState = 'private_pool',
      title = `UC079 Alternate Capacity ${randomUUID().slice(0, 8)}`,
      requestDetails = {},
      metadata = {},
    } = options;

    const { rows } = await client.query(
      `INSERT INTO public.marketplace_requests (
         requester_organization_id,
         request_kind_key,
         status,
         release_state,
         title,
         request_details,
         private_pool,
         metadata,
         decision_metadata
       )
       VALUES (
         $1::uuid,
         $2,
         'published',
         $3,
         $4,
         $5::jsonb,
         jsonb_build_array($6::uuid),
         $7::jsonb,
         '{}'::jsonb
       )
       RETURNING id`,
      [
        requesterOrganizationId,
        requestKindKey,
        releaseState,
        title,
        JSON.stringify(requestDetails),
        supplierOrganizationId,
        JSON.stringify(metadata),
      ]
    );

    return rows[0]?.id ?? null;
  }

  async function setRouteRunAlternateCapacityMetadata(routeRunId, demandClass, marketplaceRequestId) {
    await client.query(
      `UPDATE public.route_runs
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{alternate_capacity}',
            jsonb_strip_nulls(
              jsonb_build_object(
                'demand_class', $2::text,
                'marketplace_request_id', $3::uuid
              )
            ),
            true
          )
        WHERE id = $1::uuid`,
      [routeRunId, demandClass, marketplaceRequestId]
    );
  }

  async function seedRouteRunAssignment(seed) {
    const routeRunAssignmentId = randomUUID();

    await client.query(
      `INSERT INTO public.route_run_assignments (
         id,
         organization_id,
         route_run_id,
         assignment_status,
         assignment_mode,
         assignment_version,
         driver_user_id,
         vehicle_id,
         partner,
         assigned_by_user_id,
         assigned_at,
         notes,
         metadata
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'assigned',
         'internal_driver',
         1,
         $4::uuid,
         $5::uuid,
         NULL,
         $6::uuid,
         now(),
         $7::text,
         '{}'::jsonb
       )`,
      [
        routeRunAssignmentId,
        seed.organizationId,
        seed.routeRunId,
        seed.driverId,
        seed.vehicleId,
        seed.operatorId,
        'Seeded route run assignment for UC080 response tests',
      ]
    );

    await client.query(
      `UPDATE public.route_runs
          SET driver_user_id = $2::uuid,
              vehicle_id = $3::uuid,
              metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{route_assignment}',
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'route_run_assignment_id', $1::uuid,
                    'assignment_status', 'assigned',
                    'assignment_mode', 'internal_driver',
                    'assignment_version', 1,
                    'driver_user_id', $2::uuid,
                    'vehicle_id', $3::uuid,
                    'assigned_by_user_id', $4::uuid,
                    'assigned_at', now(),
                    'notes', 'Seeded route run assignment for UC080 response tests'
                  )
                ),
                true
              )
        WHERE id = $5::uuid`,
      [
        routeRunAssignmentId,
        seed.driverId,
        seed.vehicleId,
        seed.operatorId,
        seed.routeRunId,
      ]
    );

    return { routeRunAssignmentId };
  }

  async function respondToRouteRunAssignment(seed, actionKey, params, idempotencyKey) {
    await setAuthContext(client, seed.driverId);
    const { rows } = await client.query(
      `SELECT api.ui_execute_route_run_assignment_response_v1($1, $2, $3::text[], $4, $5, $6::jsonb) AS result`,
      [
        actionKey,
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          ...params,
          idempotency_key: idempotencyKey,
        }),
      ]
    );

    return rows[0]?.result ?? null;
  }

  async function listVisibleResource(resourceKey, filters = {}) {
    const { rows } = await client.query(
      `SELECT public.ui_list_resource_v1($1, $2::jsonb, 25, 0, NULL) AS payload`,
      [resourceKey, JSON.stringify(filters)]
    );
    return rows[0]?.payload ?? null;
  }

  async function attachShipmentContactData(seed) {
    for (const [index, shipment] of seed.shipments.entries()) {
      const recipientId = randomUUID();
      const addressId = randomUUID();
      const phoneNumber = `+96650000${String(index + 1).padStart(4, '0')}`;

      await client.query(
        `INSERT INTO public.recipients (
           id,
           organization_id,
           client_id,
           name,
           phone_number,
           phone_number_normalized,
           preferred_language
         )
         VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4,
           $5,
           public.normalize_phone_number($5::text),
           'en'
         )`,
        [
          recipientId,
          seed.organizationId,
          seed.clientId,
          `UC076 Recipient ${index + 1}`,
          phoneNumber,
        ]
      );

      await client.query(
        `INSERT INTO public.addresses (
           id,
           organization_id,
           client_id,
           raw_input,
           normalized_line1,
           building_number,
           district,
           city,
           province,
           postal_code,
           country,
           additional_directions,
           validation_status
         )
         VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4,
           $5,
           $6,
           $7,
           'Riyadh',
           'Riyadh',
           $8,
           'SA',
           $9,
           'pending'
         )`,
        [
          addressId,
          seed.organizationId,
          seed.clientId,
          `${index + 1} Delivery Street, Riyadh`,
          `Delivery Street ${index + 1}`,
          `${7000 + index}`,
          'Al Olaya',
          `12${200 + index}`,
          `Gate ${index + 1}`,
        ]
      );

      await client.query(
        `UPDATE public.shipments
            SET recipient_id = $2::uuid,
                destination_address_id = $3::uuid,
                metadata = jsonb_strip_nulls(
                  COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'customer_name', $4::text,
                    'customer_phone', $5::text
                  )
                )
          WHERE id = $1::uuid`,
        [
          shipment.id,
          recipientId,
          addressId,
          `UC076 Recipient ${index + 1}`,
          phoneNumber,
        ]
      );
    }
  }

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    client.release();
    client = null;
  });

  it('assigns a route run to an internal driver and syncs route_stop tasks', async () => {
    const seed = await seedRouteRun();
    await attachShipmentContactData(seed);
    const supportContacts = [
      {
        id: 'dispatcher-desk',
        role: 'dispatcher',
        label: 'Dispatch desk',
        name: 'UC076 Dispatch',
        phone_number: '+12025550123',
        allowed_channels: ['call', 'sms'],
        notes: 'Use when the recipient is unreachable',
      },
    ];

    await setAuthContext(client, seed.operatorId);
    const { rows: assignRows } = await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb) AS payload`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.driverId,
          vehicle_id: seed.vehicleId,
          metadata: {
            support_contacts: supportContacts,
          },
          idempotency_key: `uc076-assign-${randomUUID()}`,
        }),
      ]
    );

    expect(assignRows).toHaveLength(1);
    expect(assignRows[0].payload?.status).toBe('assigned');
    expect(assignRows[0].payload?.items?.[0]?.assignment_mode).toBe('internal_driver');

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: assignmentRows } = await client.query(
      `SELECT assignment_mode, assignment_version, driver_user_id, vehicle_id
         FROM public.route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(assignmentRows).toHaveLength(1);
    expect(assignmentRows[0].assignment_mode).toBe('internal_driver');
    expect(Number(assignmentRows[0].assignment_version)).toBe(1);
    expect(assignmentRows[0].driver_user_id).toBe(seed.driverId);
    expect(assignmentRows[0].vehicle_id).toBe(seed.vehicleId);

    await setAuthContext(client, seed.operatorId);
    const { rows: routeRows } = await client.query(
      `SELECT driver_user_id, vehicle_id, route_assignment
         FROM api.route_runs
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(routeRows).toHaveLength(1);
    expect(routeRows[0].driver_user_id).toBe(seed.driverId);
    expect(routeRows[0].vehicle_id).toBe(seed.vehicleId);
    expect(routeRows[0].route_assignment?.assignment_mode).toBe('internal_driver');

    const { rows: taskRows } = await client.query(
      `SELECT t.id, t.assigned_to, t.metadata
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
         JOIN public.route_stops rs ON rs.id = t.resource_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND rs.route_run_id = $2::uuid
        ORDER BY rs.sequence_order, rs.created_at, rs.id`,
      [seed.organizationId, seed.routeRunId]
    );
    expect(taskRows).toHaveLength(2);
    taskRows.forEach((task, index) => {
      expect(task.assigned_to).toBe(seed.driverId);
      expect(task.metadata?.route_run_id).toBe(seed.routeRunId);
      expect(task.metadata?.route_stop?.route_run_id).toBe(seed.routeRunId);
      expect(task.metadata?.route_stop?.id).toBeTruthy();
      expect(task.metadata?.route_stop?.sequence_order).toBe(index + 1);
      expect(task.metadata?.customer?.name).toBe(`UC076 Recipient ${index + 1}`);
      expect(task.metadata?.customer?.phone_number).toBe(`+96650000${String(index + 1).padStart(4, '0')}`);
      expect(task.metadata?.customer?.tracking_number).toBe(seed.shipments[index].tracking_number);
      expect(task.metadata?.contact?.phone_number).toBe(`+96650000${String(index + 1).padStart(4, '0')}`);
      expect(task.metadata?.address?.city).toBe('Riyadh');
      expect(task.metadata?.address?.district).toBe('Al Olaya');
      expect(task.metadata?.address?.building_number).toBe(`${7000 + index}`);
      expect(task.metadata?.support_contacts).toEqual(supportContacts);
    });

    await setAuthContext(client, seed.driverId);
    const { rows: listRows } = await client.query(
      `SELECT public.ui_list_resource_v1('tasks', '{}'::jsonb, 25, 0, NULL) AS payload`
    );
    const listedIds = (listRows[0]?.payload?.items || []).map((item) => item?.id).filter(Boolean);
    expect(listedIds).toEqual(expect.arrayContaining(taskRows.map((task) => task.id)));
  });

  it('keeps direct partner-fleet takeover blocked without the explicit handoff helper', async () => {
    const seed = await seedRouteRun();

    await setAuthContext(client, seed.operatorId);
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.driverId,
          vehicle_id: seed.vehicleId,
          idempotency_key: `uc076-assign-${randomUUID()}`,
        }),
      ]
    );

    await expect(
      client.query(
        `SELECT *
           FROM api.assign_route_run_v1($1::jsonb)`,
        [
          JSON.stringify({
            route_run_id: seed.routeRunId,
            partner_id: 'partner-1',
            partner_name: 'Partner Fleet',
          }),
        ]
      )
    ).rejects.toThrow(/partner_fleet handoff/i);
  });

  it('allows route-level partner-fleet reassignment through the dedicated UI executor and clears active stop-task ownership', async () => {
    const seed = await seedRouteRun();

    await setAuthContext(client, seed.operatorId);
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.driverId,
          vehicle_id: seed.vehicleId,
          idempotency_key: `uc078-partner-base-${randomUUID()}`,
        }),
      ]
    );

    await setServiceContext(seed.operatorId, seed.organizationId);
    await client.query(
      `UPDATE public.route_runs
          SET status = 'in_progress'
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );

    await setAuthContext(client, seed.operatorId);
    const { rows: reassignRows } = await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb) AS payload`,
      [
        'routes.reassign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          partner_id: 'partner-1',
          partner_name: 'Partner Fleet',
          reassignment_reason: 'Vehicle breakdown escalation',
          idempotency_key: `uc078-route-partner-${randomUUID()}`,
        }),
      ]
    );

    expect(reassignRows[0]?.payload?.items?.[0]?.assignment_mode).toBe('partner_fleet');

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: assignmentRows } = await client.query(
      `SELECT assignment_mode, driver_user_id, vehicle_id, partner
         FROM public.route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(assignmentRows).toHaveLength(1);
    expect(assignmentRows[0].assignment_mode).toBe('partner_fleet');
    expect(assignmentRows[0].driver_user_id).toBeNull();
    expect(assignmentRows[0].vehicle_id).toBeNull();
    expect(assignmentRows[0].partner?.partner_id).toBe('partner-1');

    const { rows: taskRows } = await client.query(
      `SELECT t.assigned_to
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND EXISTS (
            SELECT 1
              FROM public.route_stops rs
             WHERE rs.id = t.resource_id
               AND rs.route_run_id = $2::uuid
          )`,
      [seed.organizationId, seed.routeRunId]
    );
    expect(taskRows).toHaveLength(2);
    taskRows.forEach((task) => {
      expect(task.assigned_to).toBeNull();
    });

    await setAuthContext(client, seed.operatorId);
    const { rows: manifestRows } = await client.query(
      `SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest`,
      [seed.routeRunId]
    );
    expect(manifestRows[0]?.manifest?.route_assignment?.assignment_mode).toBe('partner_fleet');
    expect(manifestRows[0]?.manifest?.route_assignment?.partner?.partner_id).toBe('partner-1');
    expect(manifestRows[0]?.manifest?.stops?.every((stop) => stop?.task?.assigned_to == null)).toBe(
      true
    );
  });

  it('exposes the route execution manifest and stop list through browser-safe route reads', async () => {
    const seed = await seedRouteRun();

    await setAuthContext(client, seed.operatorId);
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.driverId,
          vehicle_id: seed.vehicleId,
          idempotency_key: `uc077-assign-${randomUUID()}`,
        }),
      ]
    );

    const { rows: manifestRows } = await client.query(
      `SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest`,
      [seed.routeRunId]
    );
    const manifest = manifestRows[0]?.manifest;
    expect(manifest?.route_run_id).toBe(seed.routeRunId);
    expect(manifest?.route_assignment?.driver_user_id).toBe(seed.driverId);
    expect(manifest?.stop_count).toBe(2);
    expect(manifest?.stops).toHaveLength(2);
    expect(manifest?.manifest_hash).toBeTruthy();
    expect(manifest?.stops?.[0]?.task?.assigned_to).toBe(seed.driverId);

    const { rows: routeRows } = await client.query(
      `SELECT route_assignment, route_execution_manifest
         FROM api.route_runs
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(routeRows).toHaveLength(1);
    expect(routeRows[0].route_assignment?.driver_user_id).toBe(seed.driverId);
    expect(routeRows[0].route_execution_manifest?.manifest_hash).toBe(
      manifest?.manifest_hash
    );
    expect(routeRows[0].route_execution_manifest?.stops).toHaveLength(2);

    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', '', true)`);
    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ role: 'authenticated' })]
    );

    await expect(
      client.query(`SELECT api.ui_route_run_execution_manifest_v1($1::uuid)`, [
        seed.routeRunId,
      ])
    ).rejects.toThrow(/authenticated user/i);
  });

  it('reassigns an in-progress route run through the assignment SSOT and records reassignment context', async () => {
    const seed = await seedRouteRun();

    await setAuthContext(client, seed.operatorId);
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.driverId,
          vehicle_id: seed.vehicleId,
          idempotency_key: `uc078-assign-${randomUUID()}`,
        }),
      ]
    );

    await setServiceContext(seed.operatorId, seed.organizationId);
    await client.query(
      `UPDATE public.route_runs
          SET status = 'in_progress'
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );

    await setAuthContext(client, seed.operatorId);
    const { rows: reassignRows } = await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb) AS payload`,
      [
        'routes.reassign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.secondaryDriverId,
          vehicle_id: seed.secondaryVehicleId,
          reassignment_reason: 'Breakdown cover',
          idempotency_key: `uc078-reassign-${randomUUID()}`,
        }),
      ]
    );
    expect(reassignRows[0]?.payload?.items?.[0]?.assignment_version).toBe(2);
    expect(reassignRows[0]?.payload?.items?.[0]?.driver_user_id).toBe(
      seed.secondaryDriverId
    );

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: eventRows } = await client.query(
      `SELECT event_type, payload
         FROM public.route_run_assignment_events
        WHERE route_run_id = $1::uuid
        ORDER BY assignment_version DESC, created_at DESC
        LIMIT 1`,
      [seed.routeRunId]
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].event_type).toBe('reassigned');
    expect(eventRows[0].payload?.reassignment_reason).toBe('Breakdown cover');
    expect(eventRows[0].payload?.previous_assignment?.driver_user_id).toBe(
      seed.driverId
    );

    const { rows: assignmentRows } = await client.query(
      `SELECT assignment_version, driver_user_id, vehicle_id, metadata
         FROM public.route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(assignmentRows).toHaveLength(1);
    expect(Number(assignmentRows[0].assignment_version)).toBe(2);
    expect(assignmentRows[0].driver_user_id).toBe(seed.secondaryDriverId);
    expect(assignmentRows[0].vehicle_id).toBe(seed.secondaryVehicleId);
    expect(assignmentRows[0].metadata?.reassignment_reason).toBe(
      'Breakdown cover'
    );
    expect(assignmentRows[0].metadata?.previous_assignment?.driver_user_id).toBe(
      seed.driverId
    );

    const { rows: taskRows } = await client.query(
      `SELECT t.assigned_to
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND EXISTS (
            SELECT 1
              FROM public.route_stops rs
             WHERE rs.id = t.resource_id
               AND rs.route_run_id = $2::uuid
          )`,
      [seed.organizationId, seed.routeRunId]
    );
    expect(taskRows).toHaveLength(2);
    taskRows.forEach((task) => {
      expect(task.assigned_to).toBe(seed.secondaryDriverId);
    });

    const { rows: manifestRows } = await client.query(
      `SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest`,
      [seed.routeRunId]
    );
    const manifest = manifestRows[0]?.manifest;
    expect(manifest?.route_assignment?.driver_user_id).toBe(
      seed.secondaryDriverId
    );
    expect(
      manifest?.route_assignment?.metadata?.previous_assignment?.driver_user_id
    ).toBe(seed.driverId);
    expect(manifest?.route_assignment?.metadata?.reassignment_reason).toBe(
      'Breakdown cover'
    );
  });

  it('splits selected in-progress route stops into a new route run and reassigns the moved cohort', async () => {
    const seed = await seedRouteRun();

    await setAuthContext(client, seed.operatorId);
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.driverId,
          vehicle_id: seed.vehicleId,
          idempotency_key: `uc078-stop-base-${randomUUID()}`,
        }),
      ]
    );

    await setServiceContext(seed.operatorId, seed.organizationId);
    await client.query(
      `UPDATE public.route_runs
          SET status = 'in_progress'
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );
    const { rows: stopRows } = await client.query(
      `SELECT id
         FROM public.route_stops
        WHERE route_run_id = $1::uuid
        ORDER BY sequence_order, created_at, id`,
      [seed.routeRunId]
    );
    expect(stopRows).toHaveLength(2);
    const movedStopId = stopRows[1].id;

    await setAuthContext(client, seed.operatorId);
    const { rows: reassignRows } = await client.query(
      `SELECT api.ui_execute_route_stop_reassign_v1($1, $2, $3::text[], NULL, $4, $5::jsonb) AS payload`,
      [
        'route_stops.reassign',
        'route_stops',
        [movedStopId],
        1,
        JSON.stringify({
          driver_user_id: seed.secondaryDriverId,
          vehicle_id: seed.secondaryVehicleId,
          reassignment_reason: 'Capacity rebalance',
          idempotency_key: `uc078-stop-reassign-${randomUUID()}`,
        }),
      ]
    );

    const stopPayload = reassignRows[0]?.payload;
    const targetRouteRunId = stopPayload?.items?.[0]?.target_route_run_id;
    expect(stopPayload?.count).toBe(1);
    expect(targetRouteRunId).toBeTruthy();
    expect(targetRouteRunId).not.toBe(seed.routeRunId);
    expect(stopPayload?.items?.[0]?.driver_user_id).toBe(seed.secondaryDriverId);

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: sourceStops } = await client.query(
      `SELECT id, sequence_order
         FROM public.route_stops
        WHERE route_run_id = $1::uuid
        ORDER BY sequence_order, created_at, id`,
      [seed.routeRunId]
    );
    expect(sourceStops).toHaveLength(1);
    expect(Number(sourceStops[0].sequence_order)).toBe(1);
    expect(sourceStops[0].id).not.toBe(movedStopId);

    const { rows: targetStops } = await client.query(
      `SELECT id, sequence_order
         FROM public.route_stops
        WHERE route_run_id = $1::uuid
        ORDER BY sequence_order, created_at, id`,
      [targetRouteRunId]
    );
    expect(targetStops).toHaveLength(1);
    expect(targetStops[0].id).toBe(movedStopId);
    expect(Number(targetStops[0].sequence_order)).toBe(1);

    const { rows: sourceTaskRows } = await client.query(
      `SELECT t.assigned_to
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND EXISTS (
            SELECT 1
              FROM public.route_stops rs
             WHERE rs.id = t.resource_id
               AND rs.route_run_id = $2::uuid
          )`,
      [seed.organizationId, seed.routeRunId]
    );
    expect(sourceTaskRows).toHaveLength(1);
    expect(sourceTaskRows[0].assigned_to).toBe(seed.driverId);

    const { rows: targetTaskRows } = await client.query(
      `SELECT t.assigned_to
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND EXISTS (
            SELECT 1
              FROM public.route_stops rs
             WHERE rs.id = t.resource_id
               AND rs.route_run_id = $2::uuid
          )`,
      [seed.organizationId, targetRouteRunId]
    );
    expect(targetTaskRows).toHaveLength(1);
    expect(targetTaskRows[0].assigned_to).toBe(seed.secondaryDriverId);

    const { rows: eventRows } = await client.query(
      `SELECT route_stop_id, source_route_run_id, target_route_run_id, payload
         FROM public.route_stop_reassignment_events
        WHERE route_stop_id = $1::uuid`,
      [movedStopId]
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].source_route_run_id).toBe(seed.routeRunId);
    expect(eventRows[0].target_route_run_id).toBe(targetRouteRunId);
    expect(eventRows[0].payload?.reassignment_reason).toBe('Capacity rebalance');
    expect(eventRows[0].payload?.source_assignment?.driver_user_id).toBe(seed.driverId);
    expect(eventRows[0].payload?.target_assignment?.driver_user_id).toBe(
      seed.secondaryDriverId
    );

    await setAuthContext(client, seed.operatorId);
    const { rows: targetManifestRows } = await client.query(
      `SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest`,
      [targetRouteRunId]
    );
    expect(targetManifestRows[0]?.manifest?.route_assignment?.driver_user_id).toBe(
      seed.secondaryDriverId
    );
    expect(targetManifestRows[0]?.manifest?.stop_count).toBe(1);
    expect(targetManifestRows[0]?.manifest?.stops?.[0]?.route_stop_id).toBe(movedStopId);
  });

  it('assigns an express route run through the alternate capacity pool path and exposes it through the browser-safe route API', async () => {
    const seed = await seedRouteRun();
    const supplierOrg = await createOrganization(client, 'UC079 Alternate Capacity Supplier');

    await setServiceContext(seed.operatorId, seed.organizationId);
    const marketplaceRequestId = await seedMarketplacePrivatePoolRequest(
      seed.organizationId,
      supplierOrg.id
    );
    await setRouteRunAlternateCapacityMetadata(
      seed.routeRunId,
      'express',
      marketplaceRequestId
    );

    await setAuthContext(client, seed.operatorId);
    const idempotencyKey = `uc079-alt-capacity-${randomUUID()}`;
    const { rows: assignRows } = await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb) AS payload`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          use_alternate_capacity: true,
          idempotency_key: idempotencyKey,
        }),
      ]
    );

    const assignmentItem = assignRows[0]?.payload?.items?.[0];
    expect(assignmentItem?.assignment_mode).toBe('alternate_capacity_pool');
    expect(assignmentItem?.driver_user_id).toBeUndefined();
    expect(assignmentItem?.vehicle_id).toBeUndefined();
    expect(assignmentItem?.partner?.partner_id).toBe(supplierOrg.id);
    expect(assignmentItem?.partner?.source_type).toBe('marketplace_private_pool');

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: assignmentRows } = await client.query(
      `SELECT assignment_mode, driver_user_id, vehicle_id, partner, metadata
         FROM public.route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(assignmentRows).toHaveLength(1);
    expect(assignmentRows[0].assignment_mode).toBe('alternate_capacity_pool');
    expect(assignmentRows[0].driver_user_id).toBeNull();
    expect(assignmentRows[0].vehicle_id).toBeNull();
    expect(assignmentRows[0].partner?.partner_id).toBe(supplierOrg.id);
    expect(assignmentRows[0].metadata?.alternate_capacity?.marketplace_request_id).toBe(
      marketplaceRequestId
    );
    expect(assignmentRows[0].metadata?.alternate_capacity?.demand_class).toBe('express');

    const { rows: routeRows } = await client.query(
      `SELECT route_assignment
         FROM api.route_runs
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(routeRows).toHaveLength(1);
    expect(routeRows[0].route_assignment?.assignment_mode).toBe(
      'alternate_capacity_pool'
    );
    expect(routeRows[0].route_assignment?.partner?.partner_id).toBe(supplierOrg.id);
    expect(routeRows[0].route_assignment?.metadata?.alternate_capacity?.marketplace_request_id).toBe(
      marketplaceRequestId
    );

    const { rows: taskRows } = await client.query(
      `SELECT t.assigned_to
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND EXISTS (
            SELECT 1
              FROM public.route_stops rs
             WHERE rs.id = t.resource_id
               AND rs.route_run_id = $2::uuid
          )`,
      [seed.organizationId, seed.routeRunId]
    );
    expect(taskRows).toHaveLength(2);
    taskRows.forEach((task) => {
      expect(task.assigned_to).toBeNull();
    });

    await setAuthContext(client, seed.operatorId);
    const { rows: replayRows } = await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb) AS payload`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          use_alternate_capacity: true,
          idempotency_key: idempotencyKey,
        }),
      ]
    );
    expect(replayRows[0]?.payload?.items?.[0]?.created).toBe(false);

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: eventRows } = await client.query(
      `SELECT COUNT(*)::int AS total
         FROM public.route_run_assignment_events
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(eventRows[0]?.total).toBe(1);
  });

  it('fails closed when alternate capacity metadata points to a marketplace request outside the route organization', async () => {
    const seed = await seedRouteRun();
    const outsiderRequester = await createOrganization(client, 'UC079 Outside Requester');
    const supplierOrg = await createOrganization(client, 'UC079 Outside Supplier');

    await setServiceContext(seed.operatorId, seed.organizationId);
    const marketplaceRequestId = await seedMarketplacePrivatePoolRequest(
      outsiderRequester.id,
      supplierOrg.id
    );
    await setRouteRunAlternateCapacityMetadata(
      seed.routeRunId,
      'overflow',
      marketplaceRequestId
    );

    await setAuthContext(client, seed.operatorId);
    await expect(
      client.query(
        `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
        [
          'routes.assign',
          'routes',
          [seed.routeRunId],
          seed.routeRunId,
          1,
          JSON.stringify({
            use_alternate_capacity: true,
            idempotency_key: `uc079-alt-capacity-fail-${randomUUID()}`,
          }),
        ]
      )
    ).rejects.toThrow(/does not belong to route_run organization/i);
  });

  it('keeps alternate-capacity routes hidden from driver-scoped manifest reads while preserving audit evidence for tenant ops', async () => {
    const seed = await seedRouteRun();
    const supplierOrg = await createOrganization(client, 'UC079 Hidden Alternate Capacity Supplier');

    await setServiceContext(seed.operatorId, seed.organizationId);
    const marketplaceRequestId = await seedMarketplacePrivatePoolRequest(
      seed.organizationId,
      supplierOrg.id
    );
    await setRouteRunAlternateCapacityMetadata(
      seed.routeRunId,
      'overflow',
      marketplaceRequestId
    );

    await setAuthContext(client, seed.operatorId);
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          use_alternate_capacity: true,
          idempotency_key: `uc079-hidden-alt-capacity-${randomUUID()}`,
        }),
      ]
    );

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: eventRows } = await client.query(
      `SELECT payload
         FROM public.route_run_assignment_events
        WHERE route_run_id = $1::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [seed.routeRunId]
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].payload?.metadata?.alternate_capacity?.marketplace_request_id).toBe(
      marketplaceRequestId
    );
    expect(eventRows[0].payload?.metadata?.alternate_capacity?.demand_class).toBe('overflow');
    expect(eventRows[0].payload?.settings_resolution_id).toBeTruthy();
    expect(eventRows[0].payload?.stop_task_count).toBe(2);
    expect(eventRows[0].payload?.assigned_task_count).toBe(0);

    await setAuthContext(client, seed.driverId);
    const visibleRoutes = await listVisibleResource('routes');
    expect(visibleRoutes?.items || []).toHaveLength(0);

    const visibleStops = await listVisibleResource('route_stops', {
      route_run_id: seed.routeRunId,
    });
    expect(visibleStops?.items || []).toHaveLength(0);

    const { rows: hiddenRouteRows } = await client.query(
      `SELECT COUNT(*)::int AS total
         FROM api.route_runs`
    );
    expect(hiddenRouteRows[0]?.total).toBe(0);

    const { rows: hiddenStopRows } = await client.query(
      `SELECT COUNT(*)::int AS total
         FROM api.route_stops
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(hiddenStopRows[0]?.total).toBe(0);

    await client.query('SAVEPOINT uc079_hidden_manifest');
    await expect(
      client.query(`SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest`, [
        seed.routeRunId,
      ])
    ).rejects.toThrow(/is not visible to the current actor/i);
    await client.query('ROLLBACK TO SAVEPOINT uc079_hidden_manifest');

    await setAuthContext(client, seed.operatorId);
    const visibleOpsRoutes = await listVisibleResource('routes');
    expect((visibleOpsRoutes?.items || []).map((item) => item?.id)).toEqual(
      expect.arrayContaining([seed.routeRunId])
    );

    const { rows: projectedRouteRows } = await client.query(
      `SELECT route_assignment
         FROM api.route_runs
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(projectedRouteRows).toHaveLength(1);
    expect(projectedRouteRows[0].route_assignment?.assignment_mode).toBe(
      'alternate_capacity_pool'
    );
    expect(projectedRouteRows[0].route_assignment?.partner?.partner_id).toBe(supplierOrg.id);
  });

  it('allows the assigned driver to acknowledge and then accept a route run assignment', async () => {
    const seed = await seedRouteRun();

    const { routeRunAssignmentId } = await seedRouteRunAssignment(seed);
    expect(routeRunAssignmentId).toBeTruthy();

    const acknowledgeResult = await respondToRouteRunAssignment(
      seed,
      'route_runs.acknowledge_assignment',
      {},
      `route-run-ack-${randomUUID()}`
    );

    expect(acknowledgeResult?.status).toBe('acknowledged');
    expect(acknowledgeResult?.items?.[0]?.updated).toBe(true);

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: acknowledgedRows } = await client.query(
      `SELECT assignment_status, responded_by_user_id::text AS responded_by_user_id,
              acknowledged_at, accepted_at, refused_at
         FROM public.route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(acknowledgedRows).toHaveLength(1);
    expect(acknowledgedRows[0].assignment_status).toBe('acknowledged');
    expect(acknowledgedRows[0].responded_by_user_id).toBe(seed.driverId);
    expect(acknowledgedRows[0].acknowledged_at).toBeTruthy();
    expect(acknowledgedRows[0].accepted_at).toBeNull();
    expect(acknowledgedRows[0].refused_at).toBeNull();

    const acceptResult = await respondToRouteRunAssignment(
      seed,
      'route_runs.accept_assignment',
      {},
      `route-run-accept-${randomUUID()}`
    );

    expect(acceptResult?.status).toBe('accepted');
    expect(acceptResult?.items?.[0]?.updated).toBe(true);

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: acceptedRows } = await client.query(
      `SELECT assignment_status, assignment_version, responded_by_user_id::text AS responded_by_user_id,
              acknowledged_at, accepted_at, refused_at
         FROM public.route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0].assignment_status).toBe('accepted');
    expect(Number(acceptedRows[0].assignment_version)).toBe(3);
    expect(acceptedRows[0].responded_by_user_id).toBe(seed.driverId);
    expect(acceptedRows[0].acknowledged_at).toBeTruthy();
    expect(acceptedRows[0].accepted_at).toBeTruthy();
    expect(acceptedRows[0].refused_at).toBeNull();

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: eventRows } = await client.query(
      `SELECT COUNT(*)::int AS total
         FROM public.route_run_assignment_events
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(eventRows[0]?.total).toBe(2);

    const { rows: projectedRows } = await client.query(
      `SELECT route_assignment->>'assignment_status' AS assignment_status
         FROM api.route_runs
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(projectedRows[0]?.assignment_status).toBe('accepted');
  });

  it('captures refusal reason and replays refusal idempotently', async () => {
    const seed = await seedRouteRun();

    await seedRouteRunAssignment(seed);

    const refusalIdempotencyKey = `route-run-refuse-${randomUUID()}`;
    const refusalResult = await respondToRouteRunAssignment(
      seed,
      'route_runs.refuse_assignment',
      {
        refusal_reason: 'Vehicle unavailable',
        response_notes: 'Need a larger truck for this route.',
      },
      refusalIdempotencyKey
    );

    expect(refusalResult?.status).toBe('refused');
    expect(refusalResult?.items?.[0]?.updated).toBe(true);
    expect(refusalResult?.items?.[0]?.refusal_reason).toBe('Vehicle unavailable');
    expect(refusalResult?.items?.[0]?.response_notes).toBe('Need a larger truck for this route.');

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: refusedRows } = await client.query(
      `SELECT assignment_status, assignment_version, refused_at, accepted_at,
              refusal_reason, response_notes, responded_by_user_id::text AS responded_by_user_id
         FROM public.route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(refusedRows).toHaveLength(1);
    expect(refusedRows[0].assignment_status).toBe('refused');
    expect(Number(refusedRows[0].assignment_version)).toBe(2);
    expect(refusedRows[0].refused_at).toBeTruthy();
    expect(refusedRows[0].accepted_at).toBeNull();
    expect(refusedRows[0].refusal_reason).toBe('Vehicle unavailable');
    expect(refusedRows[0].response_notes).toBe('Need a larger truck for this route.');
    expect(refusedRows[0].responded_by_user_id).toBe(seed.driverId);

    const replayResult = await respondToRouteRunAssignment(
      seed,
      'route_runs.refuse_assignment',
      {
        refusal_reason: 'Vehicle unavailable',
        response_notes: 'Need a larger truck for this route.',
      },
      refusalIdempotencyKey
    );

    expect(replayResult?.items?.[0]?.updated).toBe(false);

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: eventRows } = await client.query(
      `SELECT COUNT(*)::int AS total
         FROM public.route_run_assignment_events
        WHERE route_run_id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(eventRows[0]?.total).toBe(1);
  });

  it('rejects invalid response transitions after acceptance', async () => {
    const seed = await seedRouteRun();

    await seedRouteRunAssignment(seed);

    await respondToRouteRunAssignment(
      seed,
      'route_runs.acknowledge_assignment',
      {},
      `route-run-ack-invalid-${randomUUID()}`
    );
    await respondToRouteRunAssignment(
      seed,
      'route_runs.accept_assignment',
      {},
      `route-run-accept-invalid-${randomUUID()}`
    );

    await expect(
      respondToRouteRunAssignment(
        seed,
        'route_runs.refuse_assignment',
        {
          refusal_reason: 'Wrong vehicle',
        },
        `route-run-invalid-transition-${randomUUID()}`
      )
    ).rejects.toThrow(/cannot transition accepted to refused/i);
  });

  it('scopes route and route-stop manifest reads to the assigned driver while leaving tenant ops visibility intact', async () => {
    const seed = await seedRouteRun();
    const secondDriverId = await createUser(
      client,
      seed.organizationId,
      `uc077-driver-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );

    const { rows: vehicleRows } = await client.query(
      `INSERT INTO public.vehicles (organization_id, plate_number, status, is_active)
       VALUES ($1::uuid, $2, 'active', true)
       RETURNING id`,
      [seed.organizationId, `UC077-${randomUUID().slice(0, 6).toUpperCase()}`]
    );
    const secondVehicleId = vehicleRows[0]?.id ?? null;

    const secondRoute = await createRouteRunForExistingSeed(seed, {
      stopCount: 1,
      trackingPrefix: 'UC077-ALT',
    });

    await setAuthContext(client, seed.operatorId);
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [seed.routeRunId],
        seed.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: seed.driverId,
          vehicle_id: seed.vehicleId,
          idempotency_key: `uc077-assign-primary-${randomUUID()}`,
        }),
      ]
    );
    await client.query(
      `SELECT api.ui_execute_route_run_assign_v1($1, $2, $3::text[], $4, $5, $6::jsonb)`,
      [
        'routes.assign',
        'routes',
        [secondRoute.routeRunId],
        secondRoute.routeRunId,
        1,
        JSON.stringify({
          driver_user_id: secondDriverId,
          vehicle_id: secondVehicleId,
          idempotency_key: `uc077-assign-secondary-${randomUUID()}`,
        }),
      ]
    );

    await setAuthContext(client, seed.driverId);
    const visibleRoutes = await listVisibleResource('routes');
    expect(visibleRoutes?.items?.map((item) => item?.id).filter(Boolean)).toEqual([seed.routeRunId]);

    const visibleStops = await listVisibleResource('route_stops', {
      route_run_id: seed.routeRunId,
    });
    expect(visibleStops?.items).toHaveLength(2);
    expect(
      [...(visibleStops?.items?.map((item) => Number(item?.sequence_order)) || [])].sort((a, b) => a - b)
    ).toEqual([1, 2]);
    visibleStops?.items?.forEach((item) => {
      expect(item?.route_run_id).toBe(seed.routeRunId);
      expect(item?.driver_user_id).toBe(seed.driverId);
    });

    const hiddenStops = await listVisibleResource('route_stops', {
      route_run_id: secondRoute.routeRunId,
    });
    expect(hiddenStops?.items || []).toHaveLength(0);

    const { rows: directDriverRouteRows } = await client.query(
      `SELECT id
         FROM api.route_runs
        ORDER BY id`
    );
    expect(directDriverRouteRows.map((row) => row.id)).toEqual([seed.routeRunId]);

    const { rows: directDriverStopRows } = await client.query(
      `SELECT route_run_id, sequence_order
         FROM api.route_stops
        ORDER BY route_run_id, sequence_order`
    );
    expect(directDriverStopRows).toHaveLength(2);
    expect(directDriverStopRows.every((row) => row.route_run_id === seed.routeRunId)).toBe(true);

    await setAuthContext(client, seed.operatorId);
    const visibleOpsRoutes = await listVisibleResource('routes');
    expect((visibleOpsRoutes?.items || []).map((item) => item?.id)).toEqual(
      expect.arrayContaining([seed.routeRunId, secondRoute.routeRunId])
    );

    const visibleOpsStops = await listVisibleResource('route_stops');
    expect(visibleOpsStops?.items).toHaveLength(3);
  });
});
