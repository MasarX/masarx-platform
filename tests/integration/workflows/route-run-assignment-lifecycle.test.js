const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const {
  DATABASE_URL,
  createOrganization,
  createClient,
  createShipment,
  createSender,
  createUser,
  setFixtureUserPolicyCapabilities,
  setAuthContext,
  withFixtureAdminContext,
  setServiceContext: setCanonicalServiceContext,
} = require('../helpers/tenant-utils');

const {
  completeRouteStopTask,
  fetchLookupValues,
  openDriverShiftSession,
  registerMobileArtifact,
  transitionTaskAsUser,
} = require('../helpers/cross-surface-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

describe('UC076 route run assignment lifecycle foundation', () => {
  let client;

  async function setServiceContext(userId, organizationId) {
    await setCanonicalServiceContext(client, userId, organizationId);
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

  async function listRouteStopExecutionTasks(routeRunId) {
    const { rows } = await client.query(
      `SELECT
          rs.id AS route_stop_id,
          rs.shipment_id,
          rs.sequence_order,
          t.id AS task_id,
          t.assigned_to
         FROM public.route_stops rs
         JOIN public.tasks t
           ON t.resource_id = rs.id
          AND t.resource_type = 'route_stop'
         JOIN public.task_types tt
           ON tt.id = t.task_type_id
          AND tt.key = 'route_stop_execute'
        WHERE rs.route_run_id = $1::uuid
        ORDER BY rs.sequence_order, rs.created_at, rs.id`,
      [routeRunId]
    );
    return rows;
  }

  async function attachShipmentContactData(adminClient, seed) {
    for (const [index, shipment] of seed.shipments.entries()) {
      const recipientId = randomUUID();
      const addressId = randomUUID();
      const phoneNumber = `+96650000${String(index + 1).padStart(4, '0')}`;

      await adminClient.query(
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

      await adminClient.query(
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

      await adminClient.query(
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

  // R11 uses the real authenticated API and UC078 event producer. The enclosing
  // transaction owns every fixture and rolls back; this is not mocked Edge proof.
  async function seedReassignmentRequest() {
    const seed = await seedRouteRun();
    await withFixtureAdminContext(client, async (db) => {
      await db.query(`INSERT INTO public.driver_profiles (organization_id,user_id,status,metadata)
        VALUES ($1,$2,'active','{}'),($1,$3,'active',
          '{"capacity_left":7,"reassign_eta_min":12,"reassign_distance_km":3.5}')
        ON CONFLICT (organization_id,user_id) DO UPDATE SET status='active',metadata=EXCLUDED.metadata`,
        [seed.organizationId,seed.driverId,seed.secondaryDriverId]);
    });
    await assignReassignmentDriver(seed,seed.driverId,seed.vehicleId);
    await setServiceContext(seed.operatorId,seed.organizationId);
    await client.query("UPDATE public.route_runs SET status='in_progress' WHERE id=$1",[seed.routeRunId]);
    const stops = await client.query('SELECT id FROM public.route_stops WHERE route_run_id=$1 ORDER BY sequence_order,id',[seed.routeRunId]);
    expect(stops.rows).toHaveLength(2);
    return { ...seed, stopId:stops.rows[1].id, requestKey:'r11-'+randomUUID() };
  }
  async function assignReassignmentDriver(seed,driver,vehicle) {
    await setAuthContext(client,seed.operatorId);
    return client.query(`SELECT api.ui_execute_route_run_assign_v1('routes.assign','routes',$1::text[],$2,1,$3::jsonb)`,
      [[seed.routeRunId],seed.routeRunId,JSON.stringify({driver_user_id:driver,vehicle_id:vehicle,idempotency_key:randomUUID()})]);
  }
  async function prepareReassignment(seed,expectedActor=seed.driverId,key=seed.requestKey,reason='Capacity review') {
    const result = await client.query('SELECT api.prepare_fieldops_reassignment_v1($1,$2,$3,$4,$5) AS result',
      [seed.stopId,seed.secondaryDriverId,reason,key,expectedActor]);
    return result.rows[0].result;
  }
  async function submitReassignment(seed,requestId) {
    await setServiceContext(seed.operatorId,seed.organizationId);
    return (await client.query('SELECT api.submit_fieldops_reassignment_v1($1) AS result',[requestId])).rows[0].result;
  }
  async function moveRequestedStop(seed,key='r11-move-'+randomUUID()) {
    return (await client.query(`SELECT api.ui_execute_route_stop_reassign_v1(
      'route_stops.reassign','route_stops',$1::text[],NULL,1,$2::jsonb) AS result`,
      [[seed.stopId],JSON.stringify({driver_user_id:seed.secondaryDriverId,vehicle_id:seed.secondaryVehicleId,
        reassignment_reason:'Capacity review',idempotency_key:key})])).rows[0].result;
  }
  async function rejectedReassignment(operation,code) {
    await client.query('SAVEPOINT r11_expected_rejection');
    try { await expect(operation()).rejects.toMatchObject({code}); }
    finally { await client.query('ROLLBACK TO SAVEPOINT r11_expected_rejection'); await client.query('RELEASE SAVEPOINT r11_expected_rejection'); }
  }
  async function requestSnapshot(requestId) {
    return withFixtureAdminContext(client,async (db) => (await db.query(
      'SELECT * FROM public.fieldops_reassignment_requests WHERE id=$1',[requestId])).rows[0]);
  }

  it('R11 driver intent creates one exact workflow task and real UC078 closes it without changing operator JWT', async () => {
    const seed = await seedReassignmentRequest();
    await setAuthContext(client,seed.driverId);
    const candidates = (await client.query('SELECT * FROM api.fieldops_reassignment_candidates_v1($1)',[seed.stopId])).rows;
    const target = candidates.find((row)=>row.value===seed.secondaryDriverId);
    expect(target).toMatchObject({metadata:{capacity_left:7,eta_min:12,distance_km:3.5}});
    expect(candidates.some((row)=>row.value===seed.driverId)).toBe(false);
    const prepared = await prepareReassignment(seed);
    expect(await prepareReassignment(seed)).toEqual(prepared);
    const submitted = await submitReassignment(seed,prepared.request_id);
    expect(submitted.ok).toBe(true);
    for (const key of ['dispatch_task_id','workflow_run_id','dispatch_id','decision_log_id']) expect(submitted[key]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await submitReassignment(seed,prepared.request_id)).toEqual(submitted);
    const before = await requestSnapshot(prepared.request_id);
    expect(before.actor_user_id).toBe(seed.driverId);
    expect(before.source_assignment_version).toBeGreaterThan(0);
    const task = await withFixtureAdminContext(client,async(db)=>(await db.query(
      'SELECT metadata,idempotency_key FROM public.tasks WHERE id=$1',[submitted.dispatch_task_id])).rows[0]);
    expect(task.metadata.correlation_id).toBe(prepared.request_id);
    expect(task.metadata.parent_workflow_run_id).toBe(submitted.workflow_run_id);
    expect(task.idempotency_key).toBe('fieldops-reassignment:'+prepared.request_id);
    await setAuthContext(client,seed.operatorId);
    const operatorCorrelation=randomUUID();
    await client.query("SELECT set_config('request.correlation_id',$1,true)",[operatorCorrelation]);
    const claims=(await client.query("SELECT current_setting('request.jwt.claims') AS claims")).rows[0].claims;
    const moveKey=randomUUID();
    const moved=await moveRequestedStop(seed,moveKey);
    expect(moved.items[0].target_route_run_id).not.toBe(seed.routeRunId);
    expect((await client.query("SELECT current_setting('request.jwt.claims') AS claims")).rows[0].claims).toBe(claims);
    await moveRequestedStop(seed,moveKey);
    const after=await requestSnapshot(prepared.request_id);
    expect(after.completed_event_id).toBeTruthy();
    await withFixtureAdminContext(client,async(db)=>{
      const rows=(await db.query(`SELECT status,completed_at FROM public.tasks WHERE id=$1`,[submitted.dispatch_task_id])).rows;
      expect(rows[0].status).toBe('completed'); expect(rows[0].completed_at).toBeTruthy();
      const events=(await db.query(`SELECT payload FROM public.task_events WHERE task_id=$1
        AND to_status='completed' AND actor_system='fieldops-reassignment-event'`,[submitted.dispatch_task_id])).rows;
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({request_id:prepared.request_id,
        route_stop_reassignment_event_id:after.completed_event_id,request_correlation_id:prepared.request_id,
        operator_correlation_id:operatorCorrelation});
      const dispatches=(await db.query('SELECT id FROM public.workflow_binding_dispatches WHERE idempotency_key=$1',
        ['fieldops-reassignment:'+prepared.request_id])).rows;
      expect(dispatches.map(r=>r.id)).toEqual([submitted.dispatch_id]);
    });
  });

  it('R11 rejects direct privileged calls and old-account queued or prepared intent after ownership changes',async()=>{
    const seed=await seedReassignmentRequest();
    await setAuthContext(client,seed.driverId);
    const prepared=await prepareReassignment(seed);
    await rejectedReassignment(()=>client.query('SELECT api.submit_fieldops_reassignment_v1($1)',[prepared.request_id]),'42501');
    await rejectedReassignment(()=>client.query('SELECT public.fieldops_reassignment_source_v1($1)',[seed.stopId]),'42501');
    await rejectedReassignment(()=>client.query('SELECT public.complete_fieldops_reassignment_request_v1()'),'42501');
    await rejectedReassignment(()=>client.query('SELECT public.transition_task_system_v1($1,$2,NULL,$3,NULL,NULL)',
      [randomUUID(),'completed','{}']),'42501');
    await rejectedReassignment(()=>prepareReassignment(seed,seed.driverId,seed.requestKey,'Changed reason'),'23505');
    await assignReassignmentDriver(seed,seed.secondaryDriverId,seed.secondaryVehicleId);
    await setAuthContext(client,seed.secondaryDriverId);
    await rejectedReassignment(()=>prepareReassignment(seed,seed.driverId),'42501');
    await rejectedReassignment(()=>prepareReassignment(seed,seed.driverId,'never-sent-'+randomUUID()),'42501');
    expect((await requestSnapshot(prepared.request_id)).dispatch_task_id).toBeNull();
  });

  it('R11 rejects a newer assignment generation even when the row ID and driver return to the original values',async()=>{
    const seed=await seedReassignmentRequest();
    await setAuthContext(client,seed.driverId);
    const prepared=await prepareReassignment(seed);
    const before=await requestSnapshot(prepared.request_id);
    await assignReassignmentDriver(seed,seed.secondaryDriverId,seed.secondaryVehicleId);
    await assignReassignmentDriver(seed,seed.driverId,seed.vehicleId);
    await setServiceContext(seed.operatorId,seed.organizationId);
    const assignment=(await client.query('SELECT id,assignment_version FROM public.route_run_assignments WHERE route_run_id=$1',[seed.routeRunId])).rows[0];
    expect(assignment.id).toBe(before.source_assignment_id);
    expect(assignment.assignment_version).toBeGreaterThan(before.source_assignment_version);
    await rejectedReassignment(()=>submitReassignment(seed,prepared.request_id),'55000');
    expect((await requestSnapshot(prepared.request_id)).dispatch_task_id).toBeNull();
  });

  it.each(['completed','foreign','shipment_action'])('R11 latest task and stop marker eligibility rejects %s before prepare and new dispatch',async(mode)=>{
    const seed=await seedReassignmentRequest();
    await setAuthContext(client,seed.driverId);
    const prepared=await prepareReassignment(seed);
    await withFixtureAdminContext(client,async(db)=>{
      if(mode==='shipment_action') {
        await db.query("UPDATE public.route_stops SET metadata=metadata||'{\"shipment_action\":\"completed\"}'::jsonb WHERE id=$1",[seed.stopId]);
      } else {
        const inserted=await db.query(`INSERT INTO public.tasks
          (organization_id,task_type_id,resource_type,resource_id,status,priority,assigned_to,created_at)
          SELECT t.organization_id,t.task_type_id,t.resource_type,t.resource_id,$2,t.priority,$3,clock_timestamp()+interval '1 second'
          FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
          WHERE t.resource_id=$1 AND tt.key='route_stop_execute' ORDER BY t.created_at DESC,t.id DESC LIMIT 1 RETURNING id`,
          [seed.stopId,mode==='completed'?'completed':'open',mode==='foreign'?seed.secondaryDriverId:seed.driverId]);
        expect(inserted.rows).toHaveLength(1);
      }
    });
    await setAuthContext(client,seed.driverId);
    await rejectedReassignment(()=>prepareReassignment(seed,seed.driverId,randomUUID()),'42501');
    await rejectedReassignment(()=>client.query('SELECT * FROM api.fieldops_reassignment_candidates_v1($1)',[seed.stopId]),'42501');
    await setServiceContext(seed.operatorId,seed.organizationId);
    await rejectedReassignment(()=>submitReassignment(seed,prepared.request_id),'55000');
    expect((await requestSnapshot(prepared.request_id)).dispatch_task_id).toBeNull();
  });

  it('R11 real operator reassignment rolls back completely when canonical review-task transition fails',async()=>{
    const seed=await seedReassignmentRequest();
    await setAuthContext(client,seed.driverId);
    const prepared=await prepareReassignment(seed);
    const submitted=await submitReassignment(seed,prepared.request_id);
    await withFixtureAdminContext(client,async(db)=>{
      await db.query(`CREATE FUNCTION pg_temp.r11_reject_transition() RETURNS trigger LANGUAGE plpgsql AS $r11$
        BEGIN IF NEW.id=TG_ARGV[0]::uuid AND NEW.status='completed' THEN
          RAISE EXCEPTION 'r11_owned_transition_failure' USING ERRCODE='23514'; END IF; RETURN NEW; END;
        $r11$`);
      // UUID is generated by the owned fixture and validated above, not caller SQL.
      expect(submitted.dispatch_task_id).toMatch(/^[0-9a-f-]{36}$/);
      await db.query(`CREATE TRIGGER r11_owned_transition_failure BEFORE UPDATE ON public.tasks
        FOR EACH ROW EXECUTE FUNCTION pg_temp.r11_reject_transition('${submitted.dispatch_task_id}')`);
    });
    await setAuthContext(client,seed.operatorId);
    await rejectedReassignment(()=>moveRequestedStop(seed),'23514');
    await withFixtureAdminContext(client,async(db)=>{
      expect((await db.query('SELECT route_run_id FROM public.route_stops WHERE id=$1',[seed.stopId])).rows[0].route_run_id).toBe(seed.routeRunId);
      expect((await db.query('SELECT id FROM public.route_stop_reassignment_events WHERE route_stop_id=$1',[seed.stopId])).rows).toHaveLength(0);
      expect((await db.query('SELECT completed_at FROM public.tasks WHERE id=$1',[submitted.dispatch_task_id])).rows[0].completed_at).toBeNull();
    });
    expect((await requestSnapshot(prepared.request_id)).completed_event_id).toBeNull();
  });

  it.each(['inactive','no_capability'])('R11 current actor %s cannot prepare or replay',async(mode)=>{
    const seed=await seedReassignmentRequest();
    await setAuthContext(client,seed.driverId);
    const prepared=await prepareReassignment(seed);
    await withFixtureAdminContext(client,async(db)=>{
      if(mode==='inactive') await db.query("UPDATE public.users SET status='suspended' WHERE id=$1::uuid",[seed.driverId]);
      else {
        const { rows } = await db.query(`SELECT
          public.resolve_settings_merged('access_control_policy','tenant',$1::uuid) AS policy,
          (SELECT version FROM public.schema_registry WHERE category='access_control_policy'
            AND is_active ORDER BY version DESC LIMIT 1) AS schema_version`,[seed.organizationId]);
        const current=rows[0];
        expect(current.policy && typeof current.policy === 'object' && !Array.isArray(current.policy)).toBe(true);
        expect(Number.isInteger(current.schema_version)).toBe(true);
        const denies=current.policy.denies || [];
        expect(Array.isArray(denies)).toBe(true);
        const policy={...current.policy,denies:[...denies,{
          capability_key:'routes.read',scope_type:'tenant',scope_id:seed.organizationId,
        }]};
        await db.query(`SELECT public.upsert_settings_value_v1('access_control_policy','tenant',$1::uuid,
          $2::jsonb,$3::integer,'R11 owned capability revocation')`,
          [seed.organizationId,JSON.stringify(policy),current.schema_version]);
      }
    });
    await setAuthContext(client,seed.driverId);
    if(mode==='no_capability') {
      const capability=(await client.query("SELECT public.user_has_resource_capability_v1('routes','read',public.current_user_scope_type(),COALESCE(public.current_user_scope_id(),public.current_user_org_id())) AS allowed")).rows[0].allowed;
      expect(capability).toBe(false); // The fixture must really remove authority, not merely change labels.
    }
    await rejectedReassignment(()=>prepareReassignment(seed),'42501');
    await rejectedReassignment(()=>prepareReassignment(seed,seed.driverId,randomUUID()),'42501');
    await rejectedReassignment(()=>client.query('SELECT * FROM api.fieldops_reassignment_candidates_v1($1)',[seed.stopId]),'42501');
    await setServiceContext(seed.operatorId,seed.organizationId);
    await rejectedReassignment(()=>submitReassignment(seed,prepared.request_id),'42501');
    expect((await requestSnapshot(prepared.request_id)).dispatch_task_id).toBeNull();
  });

  it('R11 candidates and request targets exclude inactive and cross-organization drivers',async()=>{
    const seed=await seedReassignmentRequest();
    const foreignOrg=await createOrganization(client,'R11 foreign target');
    const foreign=await createUser(client,foreignOrg.id,'r11-foreign-'+randomUUID()+'@example.com',{accessScopeType:'tenant',userType:'driver'});
    await withFixtureAdminContext(client,async(db)=>{
      await db.query("INSERT INTO public.driver_profiles(organization_id,user_id,status) VALUES($1,$2,'active')",[foreignOrg.id,foreign]);
      await db.query("UPDATE public.driver_profiles SET status='inactive' WHERE organization_id=$1 AND user_id=$2",[seed.organizationId,seed.secondaryDriverId]);
    });
    await setAuthContext(client,seed.driverId);
    const values=(await client.query('SELECT value FROM api.fieldops_reassignment_candidates_v1($1)',[seed.stopId])).rows.map(r=>r.value);
    expect(values).not.toContain(foreign); expect(values).not.toContain(seed.secondaryDriverId);
    await rejectedReassignment(()=>prepareReassignment({...seed,secondaryDriverId:foreign}),'22023');
    await rejectedReassignment(()=>prepareReassignment(seed),'22023');
    await setAuthContext(client,foreign);
    await rejectedReassignment(()=>client.query('SELECT * FROM api.fieldops_reassignment_candidates_v1($1)',[seed.stopId]),'42501');
  });

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

  it.each(['missing', 'unassigned_driver'])('E47 rejects SQL-identity authority for all route entrypoints with %s JWT', async (mode) => {
    const seed = await seedRouteRun();
    await setAuthContext(client, seed.operatorId);
    await client.query('SELECT * FROM public.assign_route_run_v1($1::jsonb)', [JSON.stringify({
      route_run_id: seed.routeRunId, driver_user_id: seed.driverId, vehicle_id: seed.vehicleId,
    })]);
    await setServiceContext(seed.operatorId, seed.organizationId);
    await client.query("UPDATE public.route_runs SET status='in_progress' WHERE id=$1", [seed.routeRunId]);
    const { rows: stops } = await client.query('SELECT id FROM public.route_stops WHERE route_run_id=$1 ORDER BY sequence_order', [seed.routeRunId]);
    expect(stops).toHaveLength(2);
    const stopId = stops[1].id;
    const operations = [
      ['assign', 'SELECT * FROM public.assign_route_run_v1($1::jsonb)', [JSON.stringify({
        route_run_id: seed.routeRunId, driver_user_id: seed.secondaryDriverId, vehicle_id: seed.secondaryVehicleId,
      })]],
      ['handoff', 'SELECT * FROM public.route_run_prepare_partner_handoff_v1($1::uuid,$2::uuid[],NULL,NULL)', [seed.routeRunId,[stopId]]],
      ['reassign', 'SELECT * FROM public.reassign_route_stops_v1($1::jsonb)', [JSON.stringify({
        route_stop_ids: [stopId], driver_user_id: seed.secondaryDriverId, vehicle_id: seed.secondaryVehicleId,
        reassignment_reason: 'E47 rollback authority regression',
      })]],
      ['respond', 'SELECT * FROM public.respond_route_run_assignment_v1($1::jsonb)', [JSON.stringify({
        route_run_id: seed.routeRunId, action_key: 'route_runs.acknowledge_assignment', response_status: 'acknowledged',
      })]],
    ];
    async function setDeniedContext() {
      await client.query('SET LOCAL ROLE postgres');
      const claims = mode === 'missing' ? {} : { sub: seed.secondaryDriverId, role: 'authenticated' };
      await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.role',$2,true),set_config('request.jwt.claim.sub',$3,true)",
        [JSON.stringify(claims), claims.role || '', claims.sub || '']);
    }
    await setDeniedContext();
    const { rows: reader } = await client.query(
      'SELECT public.route_run_actor_can_read_v1($1,$2,$3) AS allowed',
      [seed.organizationId,seed.routeRunId,seed.driverId]);
    expect(reader[0].allowed).toBe(false);
    for (const [name,sql,params] of operations) {
      await setDeniedContext();
      await client.query('SAVEPOINT e47_denied');
      let failure;
      try { await client.query(sql,params); } catch (error) { failure=error; }
      finally { await client.query('ROLLBACK TO SAVEPOINT e47_denied'); await client.query('RELEASE SAVEPOINT e47_denied'); }
      expect({ operation:name, code:failure?.code }).toEqual({ operation:name,code:'42501' });
    }
    // Each supported service control uses the same input and an independent rollback.
    await setServiceContext(seed.operatorId,seed.organizationId);
    expect((await client.query('SELECT public.route_run_actor_can_read_v1($1,$2,$3) AS allowed',
      [seed.organizationId,seed.routeRunId,seed.driverId])).rows[0].allowed).toBe(true);
    for (const [name,sql,params] of operations) {
      await setServiceContext(seed.operatorId,seed.organizationId);
      await client.query('SAVEPOINT e47_control');
      try {
        const result=await client.query(sql,params);
        expect({operation:name,rows:result.rows.length}).toEqual({operation:name,rows:1});
        if(name==='assign') expect(result.rows[0].driver_user_id).toBe(seed.secondaryDriverId);
        if(name==='handoff') expect(Number(result.rows[0].unassigned_task_count)).toBe(1);
        if(name==='reassign') expect(result.rows[0].target_route_run_id).not.toBe(seed.routeRunId);
        if(name==='respond') expect(result.rows[0].assignment_status).toBe('acknowledged');
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT e47_control');
        await client.query('RELEASE SAVEPOINT e47_control');
      }
    }
  });

  it('E47 service-only scan telemetry denies raw reads while scoped manifest projection remains readable', async () => {
    const seed=await seedRouteRun();
    const foreign=await seedRouteRun();
    await setServiceContext(seed.operatorId,seed.organizationId);
    const {rows:stops}=await client.query('SELECT id,shipment_id FROM public.route_stops WHERE route_run_id=$1 ORDER BY sequence_order',[seed.routeRunId]);
    expect(stops).toHaveLength(2);
    const ids=[randomUUID(),randomUUID(),randomUUID()];
    // Admitted native DB must have its normal current scan partition; never skip or create infrastructure here.
    for(const [index,org,actor,route,stop] of [
      [0,seed.organizationId,seed.operatorId,seed.routeRunId,stops[0].id],
      [1,seed.organizationId,seed.driverId,seed.routeRunId,stops[1].id],
      [2,foreign.organizationId,foreign.operatorId,foreign.routeRunId,null],
    ]) {
      await client.query('INSERT INTO public.scan_events(id,organization_id,actor_user_id,route_run_id,route_stop_id,scan_type,barcode,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',
        [ids[index],org,actor,route,stop,'load','E47-'+ids[index]]);
    }
    await setAuthContext(client,seed.operatorId);
    // 202601251090_telemetry_partitioning_config_restore_v1 deliberately supersedes
    // the earlier authenticated scan grant with service-only telemetry. Executor
    // reads remain through the scoped manifest below; never regrant raw telemetry.
    await client.query('SAVEPOINT e47_raw_scan_denial');
    try {
      await expect(client.query('SELECT id FROM public.scan_events WHERE id=ANY($1::uuid[]) ORDER BY id',[ids]))
        .rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT e47_raw_scan_denial');
      await client.query('RELEASE SAVEPOINT e47_raw_scan_denial');
    }
    const {rows:visibleStops}=await client.query('SELECT id FROM api.route_stops WHERE route_run_id=$1 ORDER BY id',[seed.routeRunId]);
    expect(visibleStops.map(row=>row.id).sort()).toEqual(stops.map(row=>row.id).sort());
    expect((await client.query('SELECT id FROM api.route_stops WHERE route_run_id=$1',[foreign.routeRunId])).rows).toHaveLength(0);
  });

  it('assigns a route run to an internal driver and syncs route_stop tasks', async () => {
    const seed = await seedRouteRun();
    await withFixtureAdminContext(client, (adminClient) =>
      attachShipmentContactData(adminClient, seed)
    );
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

  it.each(['driver', 'partner'])('splits selected in-progress route stops into a new route run and reassigns the moved cohort to %s', async (assignmentMode) => {
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
          ...(assignmentMode === 'partner'
            ? { partner_id: 'partner-1', partner_name: 'Partner Fleet' }
            : { driver_user_id: seed.secondaryDriverId,
                vehicle_id: seed.secondaryVehicleId }),
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
    expect(stopPayload?.items?.[0]?.driver_user_id).toBe(assignmentMode === 'partner' ? undefined : seed.secondaryDriverId);

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
    expect(targetTaskRows[0].assigned_to).toBe(assignmentMode === 'partner' ? null : seed.secondaryDriverId);
    if (assignmentMode === 'partner') {
      const targetAssignments = await client.query(
        `SELECT assignment_mode,driver_user_id,vehicle_id,partner
           FROM public.route_run_assignments WHERE route_run_id=$1::uuid`,
        [targetRouteRunId]);
      expect(targetAssignments.rows).toHaveLength(1);
      expect(targetAssignments.rows[0]).toMatchObject({
        assignment_mode: 'partner_fleet', driver_user_id: null, vehicle_id: null,
        partner: { partner_id: 'partner-1', partner_name: 'Partner Fleet' },
      });
    }

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
      assignmentMode === 'partner' ? undefined : seed.secondaryDriverId
    );
    if (assignmentMode === 'partner') {
      expect(eventRows[0].payload.target_assignment).toMatchObject({
        assignment_mode: 'partner_fleet',
        partner: { partner_id: 'partner-1', partner_name: 'Partner Fleet' },
      });
    }

    await setAuthContext(client, seed.operatorId);
    const { rows: targetManifestRows } = await client.query(
      `SELECT api.ui_route_run_execution_manifest_v1($1::uuid) AS manifest`,
      [targetRouteRunId]
    );
    expect(targetManifestRows[0]?.manifest?.route_assignment?.driver_user_id).toBe(
      assignmentMode === 'partner' ? undefined : seed.secondaryDriverId
    );
    if (assignmentMode === 'partner') {
      expect(targetManifestRows[0].manifest.route_assignment).toMatchObject({
        assignment_mode: 'partner_fleet',
        partner: { partner_id: 'partner-1', partner_name: 'Partner Fleet' },
      });
    }
    expect(targetManifestRows[0]?.manifest?.stop_count).toBe(1);
    expect(targetManifestRows[0]?.manifest?.stops?.[0]?.route_stop_id).toBe(movedStopId);
    const resource = 'route_stop_reassignment_events';
    const eventId = (await withFixtureAdminContext(client, db => db.query(
      'SELECT id FROM public.route_stop_reassignment_events WHERE route_stop_id=$1::uuid', [movedStopId]))).rows[0].id;
    const reads = [
      ['SELECT public.ui_list_resource_v1($1,$2::jsonb,25,0,NULL) AS result', [resource, '{}']],
      ['SELECT public.ui_get_resource_v1($1,$2::uuid) AS result', [resource, eventId]],
      ['SELECT public.ui_resource_metrics_v1($1,$2::jsonb,NULL) AS result', [resource, '{}']],
      ['SELECT public.ui_filter_distinct_values_v1($1,$2,NULL,25) AS result', [resource, 'route_stop_id']],
    ];
    const own = [];
    for (const [sql, params] of reads) own.push((await client.query(sql, params)).rows[0].result);
    expect(own[0].items).toHaveLength(1);
    expect(own[0].items[0]).toMatchObject({ id: eventId, route_stop_id: movedStopId,
      source_route_run_id: seed.routeRunId, target_route_run_id: targetRouteRunId });
    expect(own[0].items[0].payload).toEqual(eventRows[0].payload);
    expect(own[1]).toMatchObject({ id: eventId, payload: eventRows[0].payload });
    const expectedColumns = ['id','organization_id','route_stop_id','shipment_id',
      'source_route_run_id','target_route_run_id','event_type','actor_user_id','notes','payload','created_at'].sort();
    expect(Object.keys(own[0].items[0]).sort()).toEqual(expectedColumns);
    expect(Object.keys(own[1]).sort()).toEqual(expectedColumns);
    expect(own[2].total).toBe(1);
    expect(own[3]).toEqual([movedStopId]);
    const foreign = await createOrganization(client, 'E49 isolated organization');
    const foreignOperator = await createUser(client, foreign.id, `e49-foreign-${randomUUID()}@example.test`,
      { accessScopeType: 'tenant', userType: 'ops_admin' });
    await setAuthContext(client, foreignOperator);
    const hidden = [];
    for (const [sql, params] of reads) hidden.push((await client.query(sql, params)).rows[0].result);
    expect(hidden[0].items).toEqual([]);
    expect(hidden[1]).toBeNull();
    expect(hidden[2].total).toBe(0);
    expect(hidden[3]).toEqual([]);
    const unprivileged = await createUser(client, seed.organizationId, `e49-denied-${randomUUID()}@example.test`,
      { accessScopeType: 'tenant', userType: 'driver', provisionRbac: false });
    // No relational RBAC assignment does not disable user-type policy inheritance.
    // Bind this negative-test actor explicitly to an empty-capability fixture role.
    await setFixtureUserPolicyCapabilities(client, seed.organizationId, unprivileged, []);
    await setAuthContext(client, unprivileged);
    expect((await client.query("SELECT public.user_has_resource_capability_v1('routes','read','tenant',$1::uuid) AS allowed",
      [seed.organizationId])).rows[0].allowed).toBe(false);
    for (const [sql, params] of reads) {
      await client.query('SAVEPOINT e49_denial');
      try {
        await expect(client.query(sql, params)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT e49_denial');
        await client.query('RELEASE SAVEPOINT e49_denial');
      }
    }
    await setAuthContext(client, seed.operatorId);
    const scopeClient = await createClient(client, seed.organizationId, 'E49 scoped client');
    const scopeSender = await createSender(client, scopeClient.id, 'E49 scoped sender');
    for (const [scope, scopeId, userType] of [
      ['client', scopeClient.id, 'client_admin'],
      ['sender', scopeSender, 'sender_user'],
      ['platform', null, 'ops_admin'],
    ]) {
      const scopedUser = await createUser(client, seed.organizationId, `e49-${scope}-${randomUUID()}@example.test`,
        { accessScopeType: scope, accessScopeId: scopeId, provisionRbac: false, userType });
      await setAuthContext(client, scopedUser);
      expect((await client.query('SELECT public.current_user_scope_type() AS scope')).rows[0].scope).toBe(scope);
      for (const [sql, params] of reads) {
        await client.query('SAVEPOINT e49_scope_denial');
        try {
          await expect(client.query(sql, params)).rejects.toMatchObject({
            code: '42501', message: 'Resource read scope denied',
          });
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT e49_scope_denial');
          await client.query('RELEASE SAVEPOINT e49_scope_denial');
        }
      }
    }
    await setAuthContext(client, seed.operatorId);
    // Global is not a valid user fixture; this is shared-guard proof only.
    await client.query('SAVEPOINT e49_global_guard');
    try {
      await expect(client.query(`SELECT public.ui_assert_resource_read_scope_v1(
        '{"read_scope_types":["tenant"],"scope_columns":{"tenant":"organization_id"}}'::jsonb,'global',NULL)`))
        .rejects.toMatchObject({ code:'42501',message:'Resource read scope denied' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT e49_global_guard');
      await client.query('RELEASE SAVEPOINT e49_global_guard');
    }
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

  it('carries a breakdown handoff shipment through replacement-driver POD and COD completion', async () => {
    const seed = await seedRouteRun();
    await withFixtureAdminContext(client, (db) => attachShipmentContactData(db, seed));
    const codShipment = seed.shipments[0];

    await setServiceContext(seed.operatorId, seed.organizationId);
    await withFixtureAdminContext(client, (db) => db.query(
      `UPDATE public.shipments
          SET cod_amount = 150,
              cod_currency = 'SAR',
              metadata = jsonb_strip_nulls(
                COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'source', 'integration.route-run-assignment-lifecycle',
                  'handoff_reason', 'vehicle_breakdown',
                  'cod_amount', 150,
                  'cod_currency', 'SAR'
                )
              ),
              updated_at = now()
        WHERE id = $1::uuid
          AND client_id = $2::uuid`,
      [codShipment.id, seed.clientId]
    ));

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
          idempotency_key: `uc078-cod-base-${randomUUID()}`,
        }),
      ]
    );

    await respondToRouteRunAssignment(
      seed,
      'route_runs.acknowledge_assignment',
      {},
      `route-run-ack-cod-${randomUUID()}`
    );
    await respondToRouteRunAssignment(
      seed,
      'route_runs.accept_assignment',
      {},
      `route-run-accept-cod-${randomUUID()}`
    );
    await setServiceContext(seed.operatorId, seed.organizationId);
    await client.query(
      `UPDATE public.route_runs
          SET status = 'in_progress',
              started_at = COALESCE(started_at, now())
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
          reassignment_reason: 'Vehicle breakdown replacement completion',
          idempotency_key: `uc078-cod-handoff-${randomUUID()}`,
        }),
      ]
    );
    expect(reassignRows[0]?.payload?.items?.[0]?.driver_user_id).toBe(
      seed.secondaryDriverId
    );

    await setAuthContext(client, seed.secondaryDriverId);
    const replacementManifest = await listVisibleResource('route_stops', {
      route_run_id: seed.routeRunId,
    });
    expect(replacementManifest?.items).toHaveLength(2);
    replacementManifest?.items?.forEach((item) => {
      expect(item?.driver_user_id).toBe(seed.secondaryDriverId);
    });

    await setServiceContext(seed.operatorId, seed.organizationId);
    const [
      attemptOutcomes,
      completionKinds,
      handoverModes,
      paymentOutcomes,
      paymentMethods,
    ] = await Promise.all([
      fetchLookupValues(client, 'attempt_outcome'),
      fetchLookupValues(client, 'delivery_completion_kind'),
      fetchLookupValues(client, 'delivery_handover_mode'),
      fetchLookupValues(client, 'payment_collection_outcome'),
      fetchLookupValues(client, 'payment_collection_method'),
    ]);
    const deliveredOutcome = requireLookupValue(
      attemptOutcomes,
      'delivered',
      'attempt_outcome'
    );
    const fullCompletionKind = requireLookupValue(
      completionKinds,
      'full',
      'delivery_completion_kind'
    );
    const namedRecipientMode = requireLookupValue(
      handoverModes,
      'named_recipient',
      'delivery_handover_mode'
    );
    const collectedOutcome = requireLookupValue(
      paymentOutcomes,
      'collected',
      'payment_collection_outcome'
    );
    const cashMethod = requireLookupValue(
      paymentMethods,
      'cash',
      'payment_collection_method'
    );

    const routeStopTasks = await listRouteStopExecutionTasks(seed.routeRunId);
    expect(routeStopTasks).toHaveLength(2);
    routeStopTasks.forEach((task) => {
      expect(task.assigned_to).toBe(seed.secondaryDriverId);
    });

    const driverShiftId = await openDriverShiftSession(client, {
      organizationId: seed.organizationId,
      userId: seed.secondaryDriverId,
      branchId: seed.branchId,
      metadata: {
        source: 'integration.route-run-assignment-lifecycle',
        handoff_reason: 'vehicle_breakdown',
      },
    });

    for (const task of routeStopTasks) {
      await transitionTaskAsUser(client, {
        organizationId: seed.organizationId,
        userId: seed.secondaryDriverId,
        taskId: task.task_id,
        toStatus: 'in_progress',
        statusReason: 'en_route',
        payload: {
          ops_session_id: driverShiftId,
          source: 'integration.route-run-assignment-lifecycle',
        },
      });
      await transitionTaskAsUser(client, {
        organizationId: seed.organizationId,
        userId: seed.secondaryDriverId,
        taskId: task.task_id,
        toStatus: 'in_progress',
        statusReason: 'arrived',
        payload: {
          ops_session_id: driverShiftId,
          source: 'integration.route-run-assignment-lifecycle',
        },
      });

      const signatureArtifactId = await registerMobileArtifact(client, {
        organizationId: seed.organizationId,
        userId: seed.secondaryDriverId,
        taskId: task.task_id,
        artifactKind: 'signature',
        metadata: {
          source: 'integration.route-run-assignment-lifecycle',
          route_stop_id: task.route_stop_id,
          handoff_reason: 'vehicle_breakdown',
        },
      });
      const photoArtifactId = await registerMobileArtifact(client, {
        organizationId: seed.organizationId,
        userId: seed.secondaryDriverId,
        taskId: task.task_id,
        artifactKind: 'photo',
        metadata: {
          source: 'integration.route-run-assignment-lifecycle',
          route_stop_id: task.route_stop_id,
          handoff_reason: 'vehicle_breakdown',
        },
      });

      const isCodStop = task.shipment_id === codShipment.id;
      await completeRouteStopTask(client, {
        organizationId: seed.organizationId,
        userId: seed.secondaryDriverId,
        taskId: task.task_id,
        routeStopId: task.route_stop_id,
        outcomeReason: deliveredOutcome,
        payload: {
          ops_session_id: driverShiftId,
          handover_mode: namedRecipientMode,
          recipient_name: 'UC078 Replacement Recipient',
          recipient_class: 'customer',
          completion_kind: fullCompletionKind,
          completion_notes: 'Replacement driver completed the handoff stop.',
          signature_artifact_id: signatureArtifactId,
          artifact_ids: [signatureArtifactId, photoArtifactId],
          ...(isCodStop
            ? {
                payment_outcome: collectedOutcome,
                payment_method: cashMethod,
                payment_amount: 150,
                payment_receipt_context: 'UC078-HANDOFF-COD-150',
                delivery_completion: {
                  completion_kind: fullCompletionKind,
                  payment_collection: {
                    outcome: collectedOutcome,
                    method: cashMethod,
                    expected_amount: 150,
                    collected_amount: 150,
                    currency_code: 'SAR',
                    receipt_context: 'UC078-HANDOFF-COD-150',
                  },
                },
              }
            : {
                delivery_completion: {
                  completion_kind: fullCompletionKind,
                },
              }),
          pod: {
            captured_at: new Date().toISOString(),
            geostamp: {
              latitude: 24.7136,
              longitude: 46.6753,
              accuracy_m: 9,
            },
            signature_artifact_id: signatureArtifactId,
            artifact_ids: [signatureArtifactId, photoArtifactId],
          },
          source: 'integration.route-run-assignment-lifecycle',
          handoff_reason: 'vehicle_breakdown',
          run: randomUUID(),
        },
      });
    }

    await setServiceContext(seed.operatorId, seed.organizationId);
    const { rows: routeRows } = await client.query(
      `SELECT status
         FROM public.route_runs
        WHERE id = $1::uuid`,
      [seed.routeRunId]
    );
    expect(routeRows[0]?.status).toBe('completed');

    const { rows: codShipmentRows } = await client.query(
      `SELECT status
         FROM public.shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid`,
      [codShipment.id, seed.clientId]
    );
    expect(codShipmentRows[0]?.status).toBe(deliveredOutcome);

    const { rows: codActionRows } = await client.query(
      `SELECT performed_by_user_id,
              delivery_completion_kind,
              payment_collection_outcome,
              payment_collection_method,
              payment_collected_amount::numeric AS payment_collected_amount,
              action_data
         FROM public.shipment_actions
        WHERE shipment_id = $1::uuid
        ORDER BY timestamp DESC, created_at DESC, id DESC
        LIMIT 1`,
      [codShipment.id]
    );
    expect(codActionRows[0]?.performed_by_user_id).toBe(seed.secondaryDriverId);
    expect(codActionRows[0]?.delivery_completion_kind).toBe(fullCompletionKind);
    expect(codActionRows[0]?.payment_collection_outcome).toBe(collectedOutcome);
    expect(codActionRows[0]?.payment_collection_method).toBe(cashMethod);
    expect(Number(codActionRows[0]?.payment_collected_amount)).toBe(150);
    expect(
      codActionRows[0]?.action_data?.delivery_completion?.payment_collection?.expected_amount
    ).toBe(150);

    await setAuthContext(client, seed.driverId);
    const originalDriverRoutes = await listVisibleResource('routes');
    expect(originalDriverRoutes?.items || []).toHaveLength(0);

    await setAuthContext(client, seed.secondaryDriverId);
    const replacementDriverRoutes = await listVisibleResource('routes');
    expect(replacementDriverRoutes?.items?.map((item) => item?.id)).toEqual([
      seed.routeRunId,
    ]);
  });
});
