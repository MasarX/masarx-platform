const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { applySetting } = require('../helpers/tenant-utils');

/**
 * Integration coverage for workflow engine lifecycle semantics:
 * - pending -> in_progress -> completed transitions
 * - handler metadata applied to steps
 * - decision logging and timestamps populated
 */
describe('workflow engine lifecycle semantics', () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const workflowRunIds = [];
  const insertedSettings = [];
  let templateId = null;
  let templateName = null;
  let organizationId = null;
  let clientId = null;

  beforeAll(async () => {
    organizationId = randomUUID();
    clientId = randomUUID();

    await pool.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Engine Lifecycle Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `engine-lifecycle-org-${organizationId.slice(0, 8)}`]
    );

    await pool.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Engine Lifecycle Client', $3, 'standard', 'active')`,
      [clientId, organizationId, `engine-lifecycle-client-${clientId.slice(0, 8)}`]
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
      throw new Error('Failed to upsert tracking_policy for workflow engine test');
    }
    insertedSettings.push({
      scopeType: 'client',
      scopeId: clientId,
      versionId
    });

    templateName = `pgtemp_engine_lifecycle_${Date.now()}`;
    const { rows: templateRows } = await pool.query(
      `
        INSERT INTO workflow_templates (
          name, description, version, status, scope_type, scope_id, created_at, updated_at
        )
        VALUES ($1, 'Temporary template for engine lifecycle integration test', 1, 'active', 'global', NULL, now(), now())
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
        VALUES (
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
        )
       `,
      [templateId, organizationId],
    );
  });

  afterAll(async () => {
    try {
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

      if (organizationId) {
        await pool.query('DELETE FROM decision_log WHERE organization_id = $1::uuid', [organizationId]);
      }
      // Address versions are append-only; keep org/client rows to avoid cascades.
    } finally {
      await pool.end();
    }
  });

  test('workflow transitions through lifecycle states and records decision data', async () => {
    const { rows } = await pool.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [
        templateId,
        {
          organization_id: organizationId,
          client_id: clientId,
          tracking_scope_type: 'client',
          tracking_scope_id: clientId,
        },
      ],
    );
    const runId = rows[0].run_id;
    workflowRunIds.push(runId);

    const { rows: initialRows } = await pool.query(
      `SELECT workflow_status
       FROM workflow_runs
       WHERE id = $1`,
      [runId],
    );
    const { rows: defaultsRows } = await pool.query(
      `SELECT resolve_settings('workflow_defaults', 'tenant', $1::uuid) AS defaults`,
      [organizationId],
    );
    const inlineKick =
      defaultsRows[0]?.defaults?.inline_kick_on_start === true;
    if (inlineKick) {
      // Single-step workflows may finish inline before the first explicit progress call.
      expect(['pending', 'in_progress', 'completed']).toContain(
        initialRows[0].workflow_status,
      );
    } else {
      expect(initialRows[0].workflow_status).toBe('pending');
    }

    const { rows: firstProgressRows } = await pool.query(
      'SELECT progress_workflow_run($1::uuid) AS result',
      [runId],
    );
    const firstProgress = firstProgressRows[0].result;
    expect(firstProgress.status).toBe('completed');

    const handlerKey =
      firstProgress?.handler_key ||
      firstProgress?.handlerKey ||
      null;

    if (handlerKey) {
      expect(handlerKey).toBe('reserve_shipment_identifiers');
    } else {
      const { rows: handlerRows } = await pool.query(
        `SELECT handler_key
           FROM workflow_run_steps
          WHERE workflow_run_id = $1::uuid
            AND sequence_order = 0
          LIMIT 1`,
        [runId],
      );
      expect(handlerRows[0]?.handler_key).toBe('reserve_shipment_identifiers');
    }

    const { rows: midRunRows } = await pool.query(
      `SELECT workflow_status, current_step_id, context
       FROM workflow_runs
       WHERE id = $1`,
      [runId],
    );
    const midRun = midRunRows[0];
    expect(['in_progress', 'completed']).toContain(midRun.workflow_status);
    if (!midRun.context?.planned_tracking_number) {
      // eslint-disable-next-line no-console
      console.warn('[engine-lifecycle] mid-run context', midRun.context);
      const { rows: debugSteps } = await pool.query(
        `
          SELECT sequence_order, step_status, handler_key, operation_result, last_error
          FROM workflow_run_steps
          WHERE workflow_run_id = $1
          ORDER BY sequence_order
        `,
        [runId],
      );
      // eslint-disable-next-line no-console
      console.warn('[engine-lifecycle] workflow_run_steps', debugSteps);
    }
    expect(midRun.context.planned_tracking_number).toMatch(/^[A-Z0-9-]+$/);
    const { rows: stepRows } = await pool.query(
      `
        SELECT step_status,
               operation_started_at,
               operation_completed_at,
               decision_log_id,
               operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND sequence_order = 0
      `,
      [runId],
    );
    const step = stepRows[0];
    expect(step.step_status).toBe('completed');
    expect(step.operation_started_at).toBeTruthy();
    expect(step.operation_completed_at).toBeTruthy();
    expect(step.decision_log_id).toBeTruthy();
    expect(step.operation_result.planned_tracking_number).toBe(midRun.context.planned_tracking_number);
    const { rows: decisionRows } = await pool.query(
      `
        SELECT decision_inputs->>'handler_key' AS handler_key
        FROM decision_log
        WHERE id = $1
      `,
      [step.decision_log_id],
    );
    expect(decisionRows[0].handler_key).toBe('reserve_shipment_identifiers');

    const { rows: finalProgressRows } = await pool.query(
      'SELECT progress_workflow_run($1::uuid) AS result',
      [runId],
    );
    const finalProgress = finalProgressRows[0].result;
    expect(finalProgress.status).toBe('completed');

    const { rows: finalRows } = await pool.query(
      `SELECT workflow_status, current_step_id, completed_at
       FROM workflow_runs
       WHERE id = $1`,
      [runId],
    );
    const finalRun = finalRows[0];
    expect(finalRun.workflow_status).toBe('completed');
    expect(finalRun.current_step_id).toBeNull();
    expect(finalRun.completed_at).toBeTruthy();
  });
});
