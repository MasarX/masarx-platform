const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  applySetting,
  createClient,
  createOrganization,
  createSender,
  createUser,
  setAuthContext,
} = require('../helpers/tenant-utils');

loadEnv();

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be defined for shipment batch operation integration tests');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function buildShipmentOperationPolicy(deleteWindowHours = 24) {
  return {
    version: 1,
    modify: {
      allowed_statuses: ['pending'],
      workflow_template_name: 'shipment_modify_v1',
      allowed_fields: [
        'service_type',
        'service_level',
        'special_instructions',
        'cod_amount',
        'client_reference_number',
        'carrier_reference_number',
        'metadata',
        'references',
      ],
    },
    address: {
      allowed_statuses: ['pending'],
      workflow_template_name: 'shipment_update_address_v1',
      default_country_code: 'SA',
    },
    reschedule: {
      allowed_statuses: ['pending'],
      workflow_template_name: 'shipment_reschedule_v1',
    },
    delete: {
      allowed_statuses: ['pending'],
      mode: 'soft_cancel',
      window_hours: deleteWindowHours,
      workflow_template_name: 'shipment_delete_v1',
    },
  };
}

function buildPromisePolicy() {
  return {
    version: 3,
    enabled: true,
    timezone: 'UTC',
    use_branch_timezone: true,
    cutoff_time: '18:00',
    default_service_level: 'standard',
    default_transit_days: 1,
    service_level_transit_days: { standard: 1 },
    delivery_window_start: '09:00',
    delivery_window_end: '18:00',
    calendar_enabled: true,
    calendar_blackout_event_types: ['holiday'],
    calendar_max_shift_days: 7,
    capacity_enabled: true,
    capacity_behavior: 'shift',
    capacity_usage_mode: 'shipments_by_promised_date',
    capacity_limit_key: 'max_shipments',
    capacity_demand: 1,
    capacity_max_shift_days: 7,
  };
}

async function withTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await run(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore double-rollback when the test already closed the transaction
    }
    client.release();
  }
}

async function createBranchSlotFixture(client, organizationId, senderId, trackingToken) {
  const zoneId = randomUUID();
  const branchId = randomUUID();
  const capacityWindowId = randomUUID();
  const zoneSlug = `uc224-zone-${trackingToken}`.slice(0, 48);
  const branchCode = `uc224-${trackingToken}`.slice(0, 32);

  await client.query(
    `
      INSERT INTO public.zones (
        id,
        organization_id,
        name,
        slug,
        is_active,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        true,
        now(),
        now()
      )
    `,
    [zoneId, organizationId, `UC224 Zone ${trackingToken}`, zoneSlug]
  );

  await client.query(
    `
      INSERT INTO public.branches (
        id,
        organization_id,
        code,
        name,
        timezone,
        is_active,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        'UTC',
        true,
        now(),
        now()
      )
    `,
    [branchId, organizationId, branchCode, `UC224 Branch ${trackingToken}`]
  );

  await client.query(
    `
      INSERT INTO public.branch_zones (branch_id, zone_id)
      VALUES ($1::uuid, $2::uuid)
      ON CONFLICT DO NOTHING
    `,
    [branchId, zoneId]
  );

  await client.query(
    `
      INSERT INTO public.branch_capacity_windows (
        id,
        branch_id,
        zone_id,
        effective_from,
        effective_to,
        window_start_local,
        window_end_local,
        capacity,
        is_active,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        now() - interval '1 day',
        null,
        '09:00'::time,
        '18:00'::time,
        jsonb_build_object('max_shipments', 20),
        true,
        jsonb_build_object('source', 'shipment_batch_operation_ui_test'),
        now(),
        now()
      )
    `,
    [capacityWindowId, branchId, zoneId]
  );

  await applySetting(client, {
    category: 'shipment_promise_policy',
    scopeType: 'sender',
    scopeId: senderId,
    value: buildPromisePolicy(),
    version: 3,
    schemaVersion: 3,
    approvedAt: new Date().toISOString(),
    changeReason: 'shipment batch operation integration test',
  });

  return { branchId, zoneId };
}

async function seedTenantFixture(client, options = {}) {
  const organization = await createOrganization(
    client,
    options.organizationName || 'Shipment Batch Operation Org'
  );
  const tenantClient = await createClient(
    client,
    organization.id,
    options.clientName || 'Shipment Batch Operation Client'
  );
  const senderId = await createSender(
    client,
    tenantClient.id,
    options.senderName || 'Shipment Batch Operation Sender'
  );
  const userId = await createUser(
    client,
    organization.id,
    options.email || `ops+${Date.now()}@example.com`,
    {
      accessScopeType: 'tenant',
      accessScopeId: null,
      userType: options.userType || 'ops_admin',
      provisionRbac: options.provisionRbac,
    }
  );

  await applySetting(client, {
    category: 'shipment_operation_policy',
    scopeType: 'tenant',
    scopeId: organization.id,
    value: buildShipmentOperationPolicy(options.deleteWindowHours || 24),
    approvedAt: new Date().toISOString(),
    changeReason: 'shipment batch operation integration test',
  });

  const shipments = [];
  const shipmentCount = options.shipmentCount || 1;
  let branchFixture = null;

  if (options.withSlots) {
    branchFixture = await createBranchSlotFixture(
      client,
      organization.id,
      senderId,
      String(Date.now()).slice(-8)
    );
  }

  for (let index = 0; index < shipmentCount; index += 1) {
    const shipmentId = randomUUID();
    await client.query(
      `
        INSERT INTO public.shipments (
          id,
          organization_id,
          client_id,
          sender_id,
          branch_id,
          zone_id,
          service_type,
          service_level,
          tracking_number,
          status,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          $6::uuid,
          'delivery',
          'standard',
          $7,
          'pending',
          now(),
          now()
        )
      `,
      [
        shipmentId,
        organization.id,
        tenantClient.id,
        senderId,
        branchFixture?.branchId ?? null,
        branchFixture?.zoneId ?? null,
        `${options.trackingPrefix || 'UC224'}-${index + 1}-${Date.now()}`,
      ]
    );
    shipments.push(shipmentId);
  }

  if (options.authenticate !== false) {
    await setAuthContext(client, userId);
  }

  return {
    organizationId: organization.id,
    clientId: tenantClient.id,
    senderId,
    userId,
    shipmentIds: shipments,
    branchFixture,
  };
}

async function callShipmentBatchOperation(client, actionKey, shipmentIds, params = null) {
  const { rows } = await client.query(
    `
      SELECT api.ui_execute_shipment_batch_operation_v1(
        $1,
        $2,
        $3::text[],
        $4,
        $5,
        $6::jsonb
      ) AS result
    `,
    [
      actionKey,
      'shipments',
      shipmentIds.map((id) => String(id)),
      shipmentIds.length === 1 ? String(shipmentIds[0]) : null,
      shipmentIds.length,
      JSON.stringify(params ?? {}),
    ]
  );
  return rows[0]?.result ?? null;
}

async function findAvailableSlotDate(client, shipmentId, clientId, startDate = new Date()) {
  const slotStartDate = startDate.toISOString().slice(0, 10);
  const { rows } = await client.query(
    `
      SELECT slot_date::text AS slot_date
      FROM public.list_delivery_slots_v1(
        jsonb_build_object(
          'shipment_id', $1::uuid,
          'client_id', $2::uuid,
          'start_date', $3::date,
          'days', 7,
          'include_unavailable', false
        )
      )
      ORDER BY slot_start_at ASC
      LIMIT 1
    `,
    [shipmentId, clientId, slotStartDate]
  );
  return rows[0]?.slot_date ?? null;
}

describe('shipment batch operation UI contract', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('batch shipment delete soft-cancels every visible shipment through shipment_amend_cancel_v1', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, {
        shipmentCount: 2,
        trackingPrefix: 'UC224-CANCEL',
      });

      const result = await callShipmentBatchOperation(
        client,
        'shipments.delete',
        fixture.shipmentIds
      );

      expect(result?.status).toBe('cancelled');
      expect(result?.success_count).toBe(2);
      expect(result?.failure_count).toBe(0);
      expect(result?.items).toHaveLength(2);

      await client.query('RESET ROLE');

      const { rows: shipmentRows } = await client.query(
        `
          SELECT id, status
          FROM public.shipments
          WHERE id = ANY($1::uuid[])
          ORDER BY id
        `,
        [fixture.shipmentIds]
      );
      expect(shipmentRows).toHaveLength(2);
      shipmentRows.forEach((row) => {
        expect(row.status).toBe('cancelled');
      });

      const { rows: workflowRows } = await client.query(
        `
          SELECT COUNT(*)::int AS completed_count
          FROM public.workflow_runs wr
          JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
          WHERE wt.name = 'shipment_delete_v1'
            AND wr.workflow_status = 'completed'
            AND wr.context->>'shipment_id' = ANY($1::text[])
        `,
        [fixture.shipmentIds.map((id) => String(id))]
      );
      expect(workflowRows[0]?.completed_count).toBe(2);
    });
  });

  test('batch shipment delete fails closed for hidden selections and leaves visible rows cancellable', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, {
        shipmentCount: 1,
        trackingPrefix: 'UC224-PARTIAL',
      });
      await client.query('RESET ROLE');
      const foreignFixture = await seedTenantFixture(client, {
        shipmentCount: 1,
        trackingPrefix: 'UC224-FOREIGN',
        authenticate: false,
      });

      await setAuthContext(client, fixture.userId);

      const result = await callShipmentBatchOperation(
        client,
        'shipments.delete',
        [fixture.shipmentIds[0], foreignFixture.shipmentIds[0]]
      );

      expect(result?.status).toBe('partial');
      expect(result?.success_count).toBe(1);
      expect(result?.failure_count).toBe(1);
      expect(result?.items).toHaveLength(2);
      expect(result?.items?.find((item) => item.shipment_id === String(foreignFixture.shipmentIds[0]))?.error?.code)
        .toBe('shipment_not_visible');

      await client.query('RESET ROLE');

      const { rows: visibleShipmentRows } = await client.query(
        'SELECT status FROM public.shipments WHERE id = $1::uuid',
        [fixture.shipmentIds[0]]
      );
      expect(visibleShipmentRows[0]?.status).toBe('cancelled');

      const { rows: hiddenShipmentRows } = await client.query(
        'SELECT status FROM public.shipments WHERE id = $1::uuid',
        [foreignFixture.shipmentIds[0]]
      );
      expect(hiddenShipmentRows[0]?.status).toBe('pending');
    });
  });

  test('batch shipment reschedule reserves the requested slot date for every visible shipment', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, {
        shipmentCount: 2,
        trackingPrefix: 'UC224-RESCHEDULE',
        withSlots: true,
      });
      await client.query('RESET ROLE');
      const slotDate = await findAvailableSlotDate(
        client,
        fixture.shipmentIds[0],
        fixture.clientId
      );
      expect(slotDate).toBeTruthy();
      await setAuthContext(client, fixture.userId);

      const result = await callShipmentBatchOperation(
        client,
        'shipments.reschedule',
        fixture.shipmentIds,
        { slot_date: slotDate }
      );

      expect(result?.status).toBe('rescheduled');
      expect(result?.success_count).toBe(2);
      expect(result?.failure_count).toBe(0);
      expect(result?.items).toHaveLength(2);

      await client.query('RESET ROLE');

      const { rows: shipmentRows } = await client.query(
        `
          SELECT id, promised_delivery_date::text AS promised_delivery_date
          FROM public.shipments
          WHERE id = ANY($1::uuid[])
          ORDER BY id
        `,
        [fixture.shipmentIds]
      );
      expect(shipmentRows).toHaveLength(2);
      shipmentRows.forEach((row) => {
        expect(String(row.promised_delivery_date)).toBe(slotDate);
      });

      const { rows: actionRows } = await client.query(
        `
          SELECT COUNT(*)::int AS reserved_count
          FROM public.shipment_actions
          WHERE shipment_id = ANY($1::uuid[])
            AND action_type = 'delivery_slot_reserved'
        `,
        [fixture.shipmentIds]
      );
      expect(actionRows[0]?.reserved_count).toBe(2);
    });
  });
});
