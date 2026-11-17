const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { applySetting, cleanupAutoOnboardingArtifacts } = require('../helpers/tenant-utils');

/**
 * Integration coverage for reservation + create workflow steps.
 * Verifies reserve_shipment_identifiers and shipment_create handlers operate together
 * and that shipment_create is idempotent (reuses existing rows when context provides them).
 */
describe('workflow handlers: reserve + create', () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const createdShipments = [];
  const workflowRunIds = [];
  const insertedSettings = [];
  let templateId = null;
  let templateName = null;
  let organizationId = null;
  let clientId = null;
  let organizationSlug = null;
  let clientSlug = null;

  beforeAll(async () => {
    organizationId = randomUUID();
    clientId = randomUUID();
    organizationSlug = `workflow-reserve-org-${Date.now()}`;
    clientSlug = `workflow-reserve-client-${Date.now()}`;

    await pool.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Workflow Reserve Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, organizationSlug],
    );

    await pool.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Workflow Reserve Client', $3, 'standard', 'active')`,
      [clientId, organizationId, clientSlug],
    );

    const trackingPolicy = {
      version: 1,
      unique_scope: 'client',
      alphabet: 'BASE36',
      checksum: 'iso7064_mod_37_36',
      prefix: { value: 'PG', separator: '', max_len: 4 },
      sequence: { scope: 'client', strategy: 'pg_sequence', cache: 100, start: 1 },
      tokens: [
        { type: 'prefix' },
        { type: 'seq', len: 6 },
        { type: 'chk' },
      ],
      sync_generate: true,
    };

    await pool.query(
      `DELETE FROM settings WHERE category = 'tracking_policy' AND scope_type = 'client' AND scope_id = $1::uuid`,
      [clientId],
    );
    await pool.query(
      `DELETE FROM settings_versions WHERE category = 'tracking_policy' AND scope_type = 'client' AND scope_id = $1::uuid`,
      [clientId],
    );
    const versionId = await applySetting(pool, {
      category: 'tracking_policy',
      scopeType: 'client',
      scopeId: clientId,
      value: trackingPolicy,
      version: 1,
      schemaVersion: 1,
      approvedAt: new Date().toISOString()
    });
    if (!versionId) {
      throw new Error('Failed to upsert tracking_policy for client');
    }
    insertedSettings.push({ scopeType: 'client', scopeId: clientId, versionId });

    await pool.query(
      `
        SELECT cached_value
        FROM settings
        WHERE category = 'tracking_policy'
          AND scope_type = 'client'
          AND scope_id = $1::uuid
      `,
      [clientId],
    );

    templateName = `pgtemp_create_from_reservation_${Date.now()}`;
    const { rows: templateRows } = await pool.query(
      `
        INSERT INTO workflow_templates (
          name, description, version, status, scope_type, scope_id, created_at, updated_at
        )
        VALUES ($1, 'Temporary workflow for reservation/create integration', 1, 'active', 'global', NULL, now(), now())
        RETURNING id
      `,
      [templateName],
    );
    templateId = templateRows[0].id;

    await pool.query(
      `
        INSERT INTO workflow_template_steps (
          workflow_template_id,
          sequence_order,
          operation_name,
          operation_settings_category,
          transition_condition,
          metadata,
          handler_key,
          handler_version,
          enabled,
          created_at,
          updated_at
        )
        VALUES
          (
            $1,
            0,
            'reserve_identifiers',
            'workflow',
            'always',
            jsonb_build_object(
              'resource_type', 'shipment',
              'tracking_scope_type', 'client',
              'tracking_scope_id', $2::uuid
            ),
            'reserve_shipment_identifiers',
            'v1',
            TRUE,
            now(),
            now()
          ),
          (
            $1,
            1,
            'create_shipment',
            'workflow',
            'always',
            '{}'::jsonb,
            'shipment_create',
            'v1',
            TRUE,
            now(),
            now()
          )
      `,
      [templateId, clientId],
    );
  });

  afterAll(async () => {
    try {
      if (createdShipments.length) {
        await pool.query(
          `DELETE FROM shipments WHERE id = ANY($1::uuid[])`,
          [createdShipments],
        );
      }

      if (insertedSettings.length) {
        for (const entry of insertedSettings) {
          await pool.query(
            `
              DELETE FROM settings
              WHERE category = 'tracking_policy'
                AND scope_type = $1
                AND scope_id = $2::uuid
            `,
            [entry.scopeType, entry.scopeId],
          );
        }
        const versionIds = insertedSettings.map((entry) => entry.versionId);
        await pool.query(
          `
            DELETE FROM settings_versions
            WHERE id = ANY($1::uuid[])
          `,
          [versionIds],
        );
      }

      if (workflowRunIds.length) {
        await pool.query(
          `DELETE FROM workflow_run_steps WHERE workflow_run_id = ANY($1::uuid[])`,
          [workflowRunIds],
        );
        await pool.query(
          `DELETE FROM workflow_runs WHERE id = ANY($1::uuid[])`,
          [workflowRunIds],
        );
      }

      if (templateId) {
        await pool.query(
          `DELETE FROM workflow_template_steps WHERE workflow_template_id = $1`,
          [templateId],
        );
        await pool.query(
          `DELETE FROM workflow_templates WHERE id = $1`,
          [templateId],
        );
      }

      if (clientId) {
        await pool.query(
          `DELETE FROM senders WHERE client_id = $1::uuid`,
          [clientId],
        );
        await pool.query(
          `DELETE FROM clients WHERE id = $1::uuid`,
          [clientId],
        );
      }

      if (organizationId) {
        await pool.query(
          `DELETE FROM decision_log WHERE organization_id = $1::uuid`,
          [organizationId],
        );
        await cleanupAutoOnboardingArtifacts(pool, organizationId);
        await pool.query(
          `DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid`,
          [organizationId],
        );
        await pool.query(
          `DELETE FROM organizations WHERE id = $1::uuid`,
          [organizationId],
        );
      }
    } finally {
      await pool.end();
    }
  });

  const progressRunToCompletion = async (runId) => {
    await pool.query('SELECT progress_workflow_run($1::uuid) AS result', [runId]);
    await pool.query('SELECT progress_workflow_run($1::uuid)', [runId]);
    await pool.query('SELECT progress_workflow_run($1::uuid)', [runId]);
  };

  test('reserve_shipment_identifiers seeds context and shipment_create inserts shipment', async () => {
    const runContext = {
      organization_id: organizationId,
      client_id: clientId,
      tracking_scope_type: 'client',
      tracking_scope_id: clientId,
    };

    const { rows } = await pool.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [
        templateId,
        runContext,
      ],
    );
    const runId = rows[0].run_id;
    workflowRunIds.push(runId);

    await pool.query(
      `
        SELECT cached_value
        FROM settings
        WHERE category = 'tracking_policy'
          AND scope_type = 'global'
          AND scope_id IS NULL
        LIMIT 1
      `,
    );
    await progressRunToCompletion(runId);

    const { rows: reserveRows } = await pool.query(
      `
        SELECT operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND sequence_order = 0
      `,
      [runId],
    );
    const reserveRow = reserveRows[0] ?? {};
    const reserveResult = reserveRow.operation_result ?? {};
    // Temporary debug to inspect handler output if assertions fail
    if (!reserveResult?.planned_resource_id) {
      throw new Error('reserve_shipment_identifiers did not yield planned_resource_id');
    }
    const plannedShipmentId = reserveResult.planned_resource_id;
    const plannedTrackingNumber = reserveResult.planned_tracking_number;

    const { rows: runRows } = await pool.query(
      'SELECT context FROM workflow_runs WHERE id = $1',
      [runId],
    );
    const context = runRows[0]?.context ?? {};

    expect(plannedShipmentId).toBeTruthy();
    expect(plannedTrackingNumber).toMatch(/^[A-Z0-9\-\*]+$/);

    createdShipments.push(plannedShipmentId);

    const { rows: shipmentRows } = await pool.query(
      `SELECT id, client_id, tracking_number
       FROM shipments
       WHERE id = $1`,
      [plannedShipmentId],
    );
    const shipment = shipmentRows[0];
    expect(shipment).toBeTruthy();
    expect(shipment.client_id).toBe(clientId);
    expect(shipment.tracking_number).toBe(plannedTrackingNumber);

    const { rows: stepRows } = await pool.query(
      `
        SELECT step_status, operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND sequence_order = 1
      `,
      [runId],
    );
    const createStep = stepRows[0];
    expect(createStep.step_status).toBe('completed');
    expect(createStep.operation_result?.shipment_id).toBe(plannedShipmentId);
    expect(createStep.operation_result?.tracking_number).toBe(plannedTrackingNumber);
    expect(createStep.operation_result?.operation ?? 'inserted').toBe('inserted');

    const nestedPatch = context.workflow?.context_patch?.planned_tracking_number;
    if (nestedPatch) {
      expect(nestedPatch).toBe(plannedTrackingNumber);
    }
  });

  test('shipment_create is idempotent when planned identifiers already exist', async () => {
    expect(createdShipments.length).toBeGreaterThan(0);
    const plannedShipmentId = createdShipments[0];

    const { rows: shipmentRows } = await pool.query(
      `SELECT tracking_number
       FROM shipments
       WHERE id = $1`,
      [plannedShipmentId],
    );
    const existingTracking = shipmentRows[0]?.tracking_number;
    expect(existingTracking).toBeTruthy();

    const { rows } = await pool.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [
        templateId,
        {
          organization_id: organizationId,
          client_id: clientId,
          tracking_scope_type: 'client',
          tracking_scope_id: clientId,
          planned_shipment_id: plannedShipmentId,
          planned_tracking_number: existingTracking,
        },
      ],
    );
    const runId = rows[0].run_id;
    workflowRunIds.push(runId);

    await progressRunToCompletion(runId);

    const { rows: stepRows } = await pool.query(
      `
        SELECT step_status, operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND sequence_order = 1
      `,
      [runId],
    );
    const createStep = stepRows[0];
    expect(createStep.step_status).toBe('completed');
    expect(createStep.operation_result.operation).toBe('reused');
    expect(createStep.operation_result.shipment_id).toBe(plannedShipmentId);

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM shipments WHERE id = $1',
      [plannedShipmentId],
    );
    expect(countRows[0].count).toBe(1);
  });

  test('shipment_create reuses an existing shipment when client_reference_number already exists', async () => {
    const existingClientReference = `WF-CLIENTREF-${Date.now()}`;
    const existingTracking = `WF-TRACK-${Date.now()}`;

    const { rows: seededRows } = await pool.query(
      `INSERT INTO shipments (
         organization_id,
         client_id,
         service_type,
         tracking_number,
         client_reference_number,
         status,
         box_count,
         created_at,
         updated_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         'delivery',
         $3,
         $4,
         'pending',
         1,
         now(),
         now()
       )
       RETURNING id`,
      [organizationId, clientId, existingTracking, existingClientReference],
    );
    const seededShipmentId = seededRows[0].id;
    createdShipments.push(seededShipmentId);

    const { rows } = await pool.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [
        templateId,
        {
          organization_id: organizationId,
          client_id: clientId,
          tracking_scope_type: 'client',
          tracking_scope_id: clientId,
          planned_tracking_number: `WF-NEW-${Date.now()}`,
          client_reference_number: existingClientReference,
        },
      ],
    );
    const runId = rows[0].run_id;
    workflowRunIds.push(runId);

    await progressRunToCompletion(runId);

    const { rows: stepRows } = await pool.query(
      `
        SELECT step_status, operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND sequence_order = 1
      `,
      [runId],
    );
    const createStep = stepRows[0];
    expect(createStep.step_status).toBe('completed');
    expect(createStep.operation_result.operation).toBe('reused_client_reference');
    expect(createStep.operation_result.shipment_id).toBe(seededShipmentId);

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM shipments
        WHERE client_id = $1::uuid
          AND client_reference_upper = upper($2)`,
      [clientId, existingClientReference],
    );
    expect(countRows[0].count).toBe(1);
  });
});
