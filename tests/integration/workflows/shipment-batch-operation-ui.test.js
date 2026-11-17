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
  setFixtureUserPolicyCapabilities,
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

async function completeOwnedBatchRuns(client, result, fixture, operation, slotDate = null) {
  const expectedStatus = operation === 'cancel' ? 'cancelled' : 'rescheduled';
  const accepted = result.items.filter((item) => item.ok && !item.already_processed);
  expect(result.success_count).toBe(accepted.filter((item) => item.status === expectedStatus).length);
  expect(result.queued_count).toBe(accepted.filter((item) => item.status === 'queued').length);
  expect(result.success_count + result.queued_count).toBe(accepted.length);
  await client.query('RESET ROLE');
  for (const item of accepted) {
    expect(['queued', expectedStatus]).toContain(item.status);
    expect(item.shipment_id).toBe(item.selection_id);
    expect(fixture.shipmentIds.map(String)).toContain(item.selection_id);
    const { rows } = await client.query(`
      SELECT wr.id, wr.workflow_status
      FROM public.workflow_runs wr
      JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
      WHERE wr.id = $1::uuid AND wt.name = $2
        AND wr.context->>'shipment_id' = $3
        AND wr.context->>'organization_id' = $4
        AND wr.context->>'client_id' = $5
        AND wr.context->>'sender_id' = $6
        AND wr.context->>'requested_by' = $7
    `, [item.workflow_run_id, operation === 'cancel' ? 'shipment_delete_v1' : 'shipment_reschedule_v1',
      item.selection_id, String(fixture.organizationId), String(fixture.clientId),
      String(fixture.senderId), String(fixture.userId)]);
    expect(rows).toHaveLength(1);
    if (item.status === expectedStatus) {
      expect(rows[0].workflow_status).toBe('completed');
      const { rows: immediate } = await client.query(
        'SELECT status, promised_delivery_date::text AS slot_date FROM public.shipments WHERE id = $1::uuid',
        [item.shipment_id]
      );
      if (operation === 'cancel') expect(immediate[0].status).toBe('cancelled');
      else expect(immediate[0].slot_date).toBe(slotDate);
    } else {
      expect(['pending', 'in_progress', 'running', 'waiting']).toContain(item.workflow_status);
      expect(result.success_count).toBeLessThan(accepted.length);
      let status = rows[0].workflow_status;
      for (let attempt = 0; attempt < 50 && !['completed', 'failed', 'cancelled', 'blocked', 'waiting'].includes(status); attempt += 1) {
        await client.query('SELECT public.progress_workflow_run($1::uuid)', [item.workflow_run_id]);
        const current = await client.query('SELECT workflow_status FROM public.workflow_runs WHERE id = $1::uuid', [item.workflow_run_id]);
        status = current.rows[0]?.workflow_status;
      }
      expect(status).toBe('completed');
    }
    const { rows: output } = await client.query(`
      SELECT operation_result FROM public.workflow_run_steps
      WHERE workflow_run_id = $1::uuid ORDER BY sequence_order DESC, updated_at DESC LIMIT 1
    `, [item.workflow_run_id]);
    const mutation = output[0]?.operation_result;
    expect(mutation?.shipment_id).toBe(item.shipment_id);
    if (operation === 'cancel') expect(mutation?.status).toBe('cancelled');
    else expect(mutation?.slot_date).toBe(slotDate);
    const { rows: audit } = await client.query(`
      SELECT sa.id, sa.canonical_status FROM public.shipment_actions sa
      WHERE sa.id = $1::uuid AND sa.shipment_id = $2::uuid AND sa.action_type = $3
    `, [mutation?.shipment_action_id, item.shipment_id,
      operation === 'cancel' ? 'delete' : 'delivery_slot_reserved']);
    expect(audit).toHaveLength(1);
    if (operation === 'cancel') expect(audit[0].canonical_status).toBe('cancelled');
  }
}

async function stubInnerShipmentResults(client, responses) {
  // Transaction-local dependency seam; the real batch authorization/visibility stays active.
  await client.query('RESET ROLE');
  await client.query("SELECT set_config('test.uc224_inner_results', $1, true)", [JSON.stringify(responses)]);
  await client.query(`
    CREATE OR REPLACE FUNCTION public.shipment_amend_cancel_v1(p_input jsonb)
    RETURNS jsonb LANGUAGE sql SECURITY DEFINER
    SET search_path TO public, extensions, pg_temp AS $fixture$
      SELECT current_setting('test.uc224_inner_results')::jsonb -> (p_input->>'shipment_id');
    $fixture$;
  `);
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

const readSelection = async (client, ids) => {
  const { rows } = await client.query(
    'SELECT api.ui_shipment_selection_readback_v1($1, $2::uuid[]) AS result',
    ['shipments.delete', ids],
  );
  return rows[0].result;
};

test('API readback returns every selected current status in selection order', async () => {
  await withTransaction(async (client) => {
    const fixture = await seedTenantFixture(client, { shipmentCount: 2, trackingPrefix: 'F329-READ' });
    const ids = [...fixture.shipmentIds].reverse();
    expect(await readSelection(client, ids)).toEqual({
      visible: true, count: 2,
      items: ids.map((selection_id) => ({ selection_id, status: 'pending' })),
    });
  });
});

test('API readback does not expose foreign selected shipment data', async () => {
  await withTransaction(async (client) => {
    const own = await seedTenantFixture(client, { trackingPrefix: 'F329-OWN' });
    await client.query('RESET ROLE');
    const foreign = await seedTenantFixture(client, { trackingPrefix: 'F329-OTHER', authenticate: false });
    await setAuthContext(client, own.userId);
    expect(await readSelection(client, [own.shipmentIds[0], foreign.shipmentIds[0]]))
      .toEqual({ visible: false, items: [] });
  });
});

test('API readback cannot confirm a missing selected shipment', async () => {
  await withTransaction(async (client) => {
    const own = await seedTenantFixture(client, { trackingPrefix: 'F329-MISSING' });
    expect(await readSelection(client, [own.shipmentIds[0], randomUUID()]))
      .toEqual({ visible: false, items: [] });
  });
});

test('API readback requires the command capability', async () => {
  await withTransaction(async (client) => {
    const fixture = await seedTenantFixture(client, {
      trackingPrefix: 'F329-DENIED', provisionRbac: false,
    });
    await setFixtureUserPolicyCapabilities(client, fixture.organizationId, fixture.userId, []);
    await expect(readSelection(client, fixture.shipmentIds)).rejects.toMatchObject({ code: '42501' });
  });
});

test('anonymous callers cannot execute selected shipment readback', async () => {
  await withTransaction(async (client) => {
    await client.query('SET LOCAL ROLE anon');
    await expect(readSelection(client, [randomUUID()])).rejects.toMatchObject({ code: '42501' });
  });
});

test.each(['empty', 'duplicate', 'null'])('API readback rejects %s selections', async (kind) => {
  await withTransaction(async (client) => {
    const fixture = await seedTenantFixture(client, { trackingPrefix: `F329-${kind}` });
    const id = fixture.shipmentIds[0];
    const ids = kind === 'empty' ? [] : kind === 'duplicate' ? [id, id] : [id, null];
    await expect(readSelection(client, ids)).rejects.toMatchObject({ code: '23514' });
  });
});

test('cohort command registry binds exact selected-record readback', async () => {
  const { rows } = await pool.query(`
    SELECT command->>'key' AS key, command#>'{execution,readback}' AS readback
    FROM public.settings s JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(sv.value->'commands') command
    WHERE s.category = 'ui_command_registry' AND sv.effective_until IS NULL
      AND command->>'key' IN ('shipments.delete', 'shipments.reschedule')
  `);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) expect(row.readback).toMatchObject({
    rpc: 'ui_shipment_selection_readback_v1',
    params: { p_action_key: { source: 'static', value: row.key },
      p_selection_ids: { source: 'selection', path: 'ids' } },
    success_path: 'visible',
  });
});


  test('registry declares structured batch results for both actions across every persisted scope', async () => {
    const { rows } = await pool.query(`
      SELECT
        s.scope_type,
        s.scope_id,
        s.cached_value = sv.value AS cache_matches_version,
        COUNT(*) FILTER (WHERE command->>'key' = 'shipments.delete')::int AS delete_count,
        COUNT(*) FILTER (WHERE command->>'key' = 'shipments.reschedule')::int AS reschedule_count,
        BOOL_AND(
          command #>> '{execution,result_contract}' = 'batch_items_v1'
        ) FILTER (
          WHERE command->>'key' IN ('shipments.delete', 'shipments.reschedule')
        ) AS result_contracts_match,
        BOOL_AND(
          CASE command->>'key'
            WHEN 'shipments.delete' THEN
              command #>> '{execution,rpc}' = 'ui_execute_shipment_batch_operation_v1'
              AND command #>> '{execution,params,operation}' = 'cancel'
              AND command #>> '{execution,confirm,tone}' = 'danger'
            WHEN 'shipments.reschedule' THEN
              command #>> '{execution,rpc}' = 'ui_execute_shipment_batch_operation_v1'
              AND command #>> '{execution,params,operation}' = 'reschedule'
              AND EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(
                    COALESCE(command #> '{execution,input_schema,fields}', '[]'::jsonb)
                  ) AS fields(field)
                 WHERE field->>'key' = 'slot_date'
                   AND COALESCE((field->>'required')::boolean, false) = true
              )
            ELSE true
          END
        ) FILTER (
          WHERE command->>'key' IN ('shipments.delete', 'shipments.reschedule')
        ) AS canonical_metadata_preserved
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      LEFT JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS commands(command)
        ON true
      WHERE s.category = 'ui_command_registry'
      GROUP BY s.id, s.scope_type, s.scope_id, s.cached_value, sv.value
      ORDER BY s.scope_type, s.scope_id NULLS FIRST
    `);

    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(row.cache_matches_version).toBe(true);
      expect(row.delete_count).toBe(1);
      expect(row.reschedule_count).toBe(1);
      expect(row.result_contracts_match).toBe(true);
      expect(row.canonical_metadata_preserved).toBe(true);
    });
  });

  test('active ui_command_registry schemas allow the batch_items_v1 discriminator', async () => {
    const { rows } = await pool.query(`
      SELECT
        version,
        schema #>> '{properties,commands,items,properties,execution,properties,result_contract,type}' AS result_contract_type,
        schema #> '{properties,commands,items,properties,execution,properties,result_contract,enum}' AS result_contract_values
      FROM public.schema_registry
      WHERE category = 'ui_command_registry'
        AND is_active = true
      ORDER BY version
    `);

    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(row.result_contract_type).toBe('string');
      expect(row.result_contract_values).toContain('batch_items_v1');
    });
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

      expect(result?.status).toBe(result.queued_count > 0 ? 'queued' : 'cancelled');
      expect(result?.count).toBe(2);
      expect(result?.success_count + result?.queued_count).toBe(2);
      expect(result?.failure_count).toBe(0);
      expect(result?.already_processed_count).toBe(0);
      expect(result?.items).toHaveLength(2);
      expect(result?.items).toEqual(
        expect.arrayContaining(
          fixture.shipmentIds.map((shipmentId) =>
            expect.objectContaining({
              shipment_id: String(shipmentId),
              selection_id: String(shipmentId),
              status: expect.stringMatching(/^(cancelled|queued)$/),
              ok: true,
            })
          )
        )
      );

      await completeOwnedBatchRuns(client, result, fixture, 'cancel');

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

      const workflowRunIds = result.items.map((item) => item.workflow_run_id);
      expect(workflowRunIds.every(Boolean)).toBe(true);
      expect(new Set(workflowRunIds).size).toBe(2);
      // Inline command progress is bounded; the uncommitted fixture needs same-client completion.
      for (const workflowRunId of workflowRunIds) {
        const readStatus = async () => {
          const { rows } = await client.query(
            'SELECT workflow_status FROM public.workflow_runs WHERE id = $1::uuid',
            [workflowRunId]
          );
          return rows[0]?.workflow_status;
        };
        let status = await readStatus();
        for (let attempt = 0; attempt < 8 && !['completed', 'failed', 'blocked', 'cancelled'].includes(status); attempt += 1) {
          await client.query('SELECT public.progress_workflow_run($1::uuid)', [workflowRunId]);
          status = await readStatus();
        }
        expect(status).toBe('completed');
      }

      const { rows: workflowRows } = await client.query(
        `
          SELECT COUNT(*)::int AS completed_count
          FROM public.workflow_runs wr
          JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
          WHERE wt.name = 'shipment_delete_v1'
            AND wr.workflow_status = 'completed'
            AND wr.context->>'shipment_id' = ANY($1::text[])
            AND wr.id = ANY($2::uuid[])
        `,
        [fixture.shipmentIds.map((id) => String(id)), workflowRunIds]
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
      expect(result?.count).toBe(2);
      expect(result?.success_count + result?.queued_count).toBe(1);
      expect(result?.failure_count).toBe(1);
      expect(result?.already_processed_count).toBe(0);
      expect(result?.items).toHaveLength(2);
      expect(
        result?.items?.find(
          (item) => item.selection_id === String(fixture.shipmentIds[0])
        )
      ).toEqual(
        expect.objectContaining({
          shipment_id: String(fixture.shipmentIds[0]),
          selection_id: String(fixture.shipmentIds[0]),
          status: expect.stringMatching(/^(cancelled|queued)$/),
          ok: true,
        })
      );
      expect(
        result?.items?.find(
          (item) => item.selection_id === String(foreignFixture.shipmentIds[0])
        )
      ).toEqual(
        expect.objectContaining({
          shipment_id: String(foreignFixture.shipmentIds[0]),
          selection_id: String(foreignFixture.shipmentIds[0]),
          status: 'blocked',
          error: expect.objectContaining({ code: 'shipment_not_visible' }),
        })
      );

      await completeOwnedBatchRuns(client, result, fixture, 'cancel');

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

      expect(result?.status).toBe(result.queued_count > 0 ? 'queued' : 'rescheduled');
      expect(result?.count).toBe(2);
      expect(result?.success_count + result?.queued_count).toBe(2);
      expect(result?.failure_count).toBe(0);
      expect(result?.already_processed_count).toBe(0);
      expect(result?.items).toHaveLength(2);
      expect(result?.items).toEqual(
        expect.arrayContaining(
          fixture.shipmentIds.map((shipmentId) =>
            expect.objectContaining({
              shipment_id: String(shipmentId),
              selection_id: String(shipmentId),
              status: expect.stringMatching(/^(rescheduled|queued)$/),
              ok: true,
            })
          )
        )
      );

      await completeOwnedBatchRuns(client, result, fixture, 'reschedule', slotDate);

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

  test('duplicate idempotent batch operation returns exact already-processed readback evidence', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, {
        shipmentCount: 1,
        trackingPrefix: 'UC224-IDEMPOTENT',
      });
      const idempotencyKey = `uc224-idempotent-${randomUUID()}`;

      const firstResult = await callShipmentBatchOperation(
        client,
        'shipments.delete',
        fixture.shipmentIds,
        { idempotency_key: idempotencyKey }
      );
      expect(firstResult?.status).toBe(firstResult.queued_count > 0 ? 'queued' : 'cancelled');
      await completeOwnedBatchRuns(client, firstResult, fixture, 'cancel');
      await setAuthContext(client, fixture.userId);

      const duplicateResult = await callShipmentBatchOperation(
        client,
        'shipments.delete',
        fixture.shipmentIds,
        { idempotency_key: idempotencyKey }
      );

      expect(duplicateResult).toEqual(
        expect.objectContaining({
          status: 'already_processed',
          count: 1,
          success_count: 0,
          failure_count: 0,
          already_processed_count: 1,
          items: [
            expect.objectContaining({
              shipment_id: String(fixture.shipmentIds[0]),
              selection_id: String(fixture.shipmentIds[0]),
              status: 'already_processed',
              ok: true,
              already_processed: true,
            }),
          ],
        })
      );
    });
  });

  test.each(['pending', 'in_progress', 'waiting'])('accepted %s work is never reported as completed', async (workflowStatus) => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, { shipmentCount: 2, trackingPrefix: 'UC224-QUEUED' });
      const responses = Object.fromEntries(fixture.shipmentIds.map((id) => [id, {
        ok: true, workflow_run_id: randomUUID(), workflow_status: workflowStatus, operation_result: {},
      }]));
      await stubInnerShipmentResults(client, responses);
      await setAuthContext(client, fixture.userId);
      const result = await callShipmentBatchOperation(client, 'shipments.delete', fixture.shipmentIds);
      expect(result).toMatchObject({ status: 'queued', success_count: 0, queued_count: 2, failure_count: 0 });
      expect(result.items).toHaveLength(2);
      result.items.forEach((item) => expect(item).toMatchObject({ status: 'queued', ok: true, workflow_status: workflowStatus }));
      await client.query('RESET ROLE');
      const { rows } = await client.query('SELECT status FROM public.shipments WHERE id = ANY($1::uuid[])', [fixture.shipmentIds]);
      expect(rows).toHaveLength(2);
      rows.forEach((row) => expect(row.status).toBe('pending'));
    });
  });

  test('completed, queued and failed inner results remain disjoint without invented cancellation', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, { shipmentCount: 3, trackingPrefix: 'UC224-MIXED' });
      const [completed, queued, failed] = fixture.shipmentIds;
      await stubInnerShipmentResults(client, {
        [completed]: { ok: true, workflow_run_id: randomUUID(), workflow_status: 'completed', operation_result: { status: 'cancelled' } },
        [queued]: { ok: true, workflow_run_id: randomUUID(), workflow_status: 'pending', operation_result: {} },
        [failed]: { ok: false, workflow_run_id: randomUUID(), workflow_status: 'failed', error: { code: 'shipment_mutation_failed' } },
      });
      await setAuthContext(client, fixture.userId);
      const result = await callShipmentBatchOperation(client, 'shipments.delete', fixture.shipmentIds);
      expect(result).toMatchObject({ status: 'partial', success_count: 1, queued_count: 1, failure_count: 1 });
      expect(result.items.map((item) => item.status)).toEqual(['cancelled', 'queued', 'shipment_mutation_failed']);
    });
  });

  test('completed workflow without canonical mutation output does not fabricate cancellation', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, { shipmentCount: 1, trackingPrefix: 'UC224-NO-OUTPUT' });
      await stubInnerShipmentResults(client, {
        [fixture.shipmentIds[0]]: { ok: true, workflow_run_id: randomUUID(), workflow_status: 'completed', operation_result: {} },
      });
      await setAuthContext(client, fixture.userId);
      const result = await callShipmentBatchOperation(client, 'shipments.delete', fixture.shipmentIds);
      expect(result).toMatchObject({ status: 'failed', success_count: 0, queued_count: 0, failure_count: 1 });
      expect(result.items[0].status).not.toBe('cancelled');
      expect(result.items[0].ok).not.toBe(true);
    });
  });

  test.each(['rescheduled', 'reschedule_no_change'])(
    'completed %s output remains supported without a fabricated status field', async (operation) => {
      await withTransaction(async (client) => {
        const fixture = await seedTenantFixture(client, { shipmentCount: 1, trackingPrefix: 'UC224-SLOT-OUTPUT' });
        const slotDate = '2026-11-01';
        await stubInnerShipmentResults(client, {
          [fixture.shipmentIds[0]]: {
            ok: true, workflow_run_id: randomUUID(), workflow_status: 'completed',
            operation_result: { operation, slot_date: slotDate },
          },
        });
        await setAuthContext(client, fixture.userId);
        const result = await callShipmentBatchOperation(client, 'shipments.reschedule', fixture.shipmentIds, { slot_date: slotDate });
        expect(result).toMatchObject({ status: 'rescheduled', success_count: 1, queued_count: 0, failure_count: 0 });
        expect(result.items[0]).toMatchObject({ status: 'rescheduled', ok: true, workflow_status: 'completed' });
      });
    }
  );
});
