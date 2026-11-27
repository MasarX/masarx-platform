const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { applySetting } = require('../helpers/tenant-utils');

function normalizeProgressResult(result) {
  return {
    status: result.status,
    reason: result.reason ?? null,
    handler_key: result.handler_key ?? null,
    in_progress_operation: result.in_progress_operation ?? null,
    has_step_reference: Boolean(result.step_id),
    has_next_run_at: Boolean(result.next_run_at),
    skipped: result.skipped ?? false,
  };
}

function summarizeWorkflowSteps(state) {
  return state.steps.map(({ decision_log_id, operation_result, ...step }) => {
    const { planned_tracking_number, planned_resource_id, ...result } = operation_result;
    return {
      ...step,
      has_decision: Boolean(decision_log_id),
      operation_result: result,
    };
  });
}

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
  const workflowTemplateIds = [];
  const insertedSettings = [];
  let templateId = null;
  let templateName = null;
  let organizationId = null;
  let clientId = null;

  async function createWorkflowTemplate({ name, description, steps }) {
    const { rows: templateRows } = await pool.query(
      `
        INSERT INTO workflow_templates (
          name, description, version, status, scope_type, scope_id, created_at, updated_at
        )
        VALUES ($1, $2, 1, 'active', 'global', NULL, now(), now())
        RETURNING id
      `,
      [name, description],
    );

    const workflowTemplateId = templateRows[0].id;
    workflowTemplateIds.push(workflowTemplateId);

    for (const step of steps) {
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
            $1::uuid,
            $2::int,
            $3::text,
            $4::text,
            $5::text,
            $6::jsonb,
            $7::text,
            $8::text,
            $9::boolean,
            now(),
            now()
          )
        `,
        [
          workflowTemplateId,
          step.sequenceOrder,
          step.operationName,
          step.operationSettingsCategory ?? 'workflow',
          step.transitionCondition ?? 'always',
          JSON.stringify(step.metadata ?? {}),
          step.handlerKey ?? 'workflow_control',
          step.handlerVersion ?? 'v1',
          step.enabled ?? true,
        ],
      );
    }

    return workflowTemplateId;
  }

  async function startWorkflowRun(contextOverrides = {}, workflowTemplateId = templateId) {
    const workflowContext = {
      organization_id: organizationId,
      client_id: clientId,
      tracking_scope_type: 'client',
      tracking_scope_id: clientId,
      ...contextOverrides,
    };

    const { rows } = await pool.query(
      'SELECT public.start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [workflowTemplateId, workflowContext],
    );
    const runId = rows[0].run_id;
    workflowRunIds.push(runId);
    return runId;
  }

  async function progressWorkflow(functionName, runId, operationResult = {}) {
    if (!['progress_workflow_run', 'progress_workflow_run_base'].includes(functionName)) {
      throw new Error(`Unsupported workflow function: ${functionName}`);
    }

    const { rows } = await pool.query(
      `SELECT public.${functionName}($1::uuid, $2::jsonb) AS result`,
      [runId, JSON.stringify(operationResult)],
    );

    return rows[0]?.result ?? null;
  }

  async function readWorkflowState(runId) {
    const { rows: workflowRows } = await pool.query(
      `
        SELECT workflow_status, current_step_id, completed_at, context, failure_reason, last_error
        FROM public.workflow_runs
        WHERE id = $1::uuid
      `,
      [runId],
    );

    const { rows: stepRows } = await pool.query(
      `
        SELECT
          sequence_order,
          operation_name,
          step_status,
          handler_key,
          decision_log_id,
          operation_result
        FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order ASC
      `,
      [runId],
    );

    return {
      ...(workflowRows[0] ?? {}),
      steps: stepRows,
    };
  }

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

      for (const cleanupTemplateId of new Set([templateId, ...workflowTemplateIds].filter(Boolean))) {
        await pool.query(
          `DELETE FROM workflow_template_steps WHERE workflow_template_id = $1`,
          [cleanupTemplateId],
        );
        await pool.query(
          `DELETE FROM workflow_templates WHERE id = $1`,
          [cleanupTemplateId],
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

  test('progress_workflow_run matches progress_workflow_run_base on the normal delegation path', async () => {
    const wrapperRunId = await startWorkflowRun();
    const baseRunId = await startWorkflowRun();

    const wrapperResult = await progressWorkflow('progress_workflow_run', wrapperRunId, {});
    const baseResult = await progressWorkflow('progress_workflow_run_base', baseRunId, {});

    expect(normalizeProgressResult(wrapperResult)).toEqual(normalizeProgressResult(baseResult));
    expect(wrapperResult.step_id).toBeTruthy();
    expect(baseResult.step_id).toBeTruthy();

    const wrapperState = await readWorkflowState(wrapperRunId);
    const baseState = await readWorkflowState(baseRunId);

    for (const workflowState of [wrapperState, baseState]) {
      expect(workflowState.workflow_status).toBe('in_progress');
      expect(workflowState.current_step_id).toBeTruthy();
      expect(workflowState.completed_at).toBeNull();
      expect(workflowState.context?.planned_tracking_number).toMatch(/^[A-Z0-9-]+$/);
      expect(workflowState.steps).toHaveLength(1);
      expect(workflowState.steps[0].step_status).toBe('completed');
      expect(workflowState.steps[0].operation_result?.planned_tracking_number).toBe(
        workflowState.context.planned_tracking_number,
      );
    }

    expect(summarizeWorkflowSteps(wrapperState)).toEqual(summarizeWorkflowSteps(baseState));

    const wrapperFinalizeResult = await progressWorkflow('progress_workflow_run', wrapperRunId, {});
    const baseFinalizeResult = await progressWorkflow('progress_workflow_run_base', baseRunId, {});

    expect(normalizeProgressResult(wrapperFinalizeResult)).toEqual(normalizeProgressResult(baseFinalizeResult));

    const finalWrapperState = await readWorkflowState(wrapperRunId);
    const finalBaseState = await readWorkflowState(baseRunId);

    for (const workflowState of [finalWrapperState, finalBaseState]) {
      expect(workflowState.workflow_status).toBe('completed');
      expect(workflowState.current_step_id).toBeNull();
      expect(workflowState.completed_at).toBeTruthy();
      expect(workflowState.context?.planned_tracking_number).toMatch(/^[A-Z0-9-]+$/);
      expect(workflowState.steps).toHaveLength(1);
      expect(workflowState.steps[0].step_status).toBe('completed');
    }
  });

  test('progress_workflow_run only executes the earliest pending step and wakes it with explicit input', async () => {
    const sequenceTemplateId = await createWorkflowTemplate({
      name: `pgtemp_engine_lifecycle_sequence_wake_${Date.now()}`,
      description: 'Temporary template for sequence gate and explicit wake integration test',
      steps: [
        {
          sequenceOrder: 0,
          operationName: 'reserve_identifiers_delayed_first',
          operationSettingsCategory: 'workflow',
          transitionCondition: 'always',
          metadata: {
            stage: 'delayed_first',
            resource_type: 'shipment',
            tracking_scope_type: 'client',
            tracking_scope_id: clientId,
          },
          handlerKey: 'reserve_shipment_identifiers',
          handlerVersion: 'v1',
          enabled: true,
        },
        {
          sequenceOrder: 1,
          operationName: 'reserve_identifiers_due_second',
          operationSettingsCategory: 'workflow',
          transitionCondition: 'always',
          metadata: {
            stage: 'due_second',
            resource_type: 'shipment',
            tracking_scope_type: 'client',
            tracking_scope_id: clientId,
          },
          handlerKey: 'reserve_shipment_identifiers',
          handlerVersion: 'v1',
          enabled: true,
        },
      ],
    });

    const runId = await startWorkflowRun({}, sequenceTemplateId);

    await pool.query(
      `
        UPDATE public.workflow_runs
        SET workflow_status = 'pending',
            current_step_id = NULL,
            completed_at = NULL,
            started_at = NULL,
            context = jsonb_build_object(
              'organization_id', $2::uuid,
              'client_id', $3::uuid,
              'tracking_scope_type', 'client',
              'tracking_scope_id', $3::uuid
            ),
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [runId, organizationId, clientId],
    );

    await pool.query(
      `
        UPDATE public.workflow_run_steps
        SET step_status = 'pending',
            run_at = CASE
              WHEN sequence_order = 0 THEN now() + interval '1 hour'
              ELSE now() - interval '1 minute'
            END,
            operation_started_at = NULL,
            operation_completed_at = NULL,
            duration_ms = NULL,
            operation_result = NULL,
            decision_log_id = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE workflow_run_id = $1::uuid
      `,
      [runId],
    );

    const passiveResult = await progressWorkflow('progress_workflow_run', runId, {});
    expect(passiveResult.status).toBe('waiting');
    expect(passiveResult.next_run_at).toBeTruthy();
    expect(new Date(passiveResult.next_run_at).getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000);

    const passiveState = await readWorkflowState(runId);
    expect(passiveState.steps.map((step) => step.step_status)).toEqual(['pending', 'pending']);
    expect(passiveState.steps.map((step) => step.has_operation_result ?? step.operation_result != null)).toEqual([
      false,
      false,
    ]);

    const explicitWakeResult = await progressWorkflow('progress_workflow_run', runId, {
      wake_reason: 'operator_input',
      source: 'engine_lifecycle_contract',
    });
    expect(normalizeProgressResult(explicitWakeResult)).toEqual({
      status: 'completed',
      reason: null,
      handler_key: 'reserve_shipment_identifiers',
      in_progress_operation: null,
      has_step_reference: true,
      has_next_run_at: false,
      skipped: false,
    });

    const wakeState = await readWorkflowState(runId);
    expect(wakeState.workflow_status).toBe('in_progress');
    expect(wakeState.current_step_id).toBeTruthy();
    expect(wakeState.steps.map((step) => step.step_status)).toEqual(['completed', 'pending']);
    expect(wakeState.steps[0].operation_result?.planned_tracking_number).toMatch(/^[A-Z0-9-]+$/);
    expect(wakeState.steps[1].operation_result).toBeNull();

    const dueSecondResult = await progressWorkflow('progress_workflow_run', runId, {});
    expect(normalizeProgressResult(dueSecondResult)).toEqual({
      status: 'completed',
      reason: null,
      handler_key: 'reserve_shipment_identifiers',
      in_progress_operation: null,
      has_step_reference: true,
      has_next_run_at: false,
      skipped: false,
    });

    const dueSecondState = await readWorkflowState(runId);
    expect(dueSecondState.workflow_status).toBe('in_progress');
    expect(dueSecondState.steps.map((step) => step.step_status)).toEqual(['completed', 'completed']);
    expect(dueSecondState.steps[1].operation_result?.planned_tracking_number).toMatch(/^[A-Z0-9-]+$/);

    const finalizeResult = await progressWorkflow('progress_workflow_run', runId, {});
    expect(finalizeResult.status).toBe('completed');

    const finalState = await readWorkflowState(runId);
    expect(finalState.workflow_status).toBe('completed');
    expect(finalState.current_step_id).toBeNull();
    expect(finalState.completed_at).toBeTruthy();
  });

  test('progress_workflow_run reopens completed runs that still have pending steps before delegating to base', async () => {
    const reopenTemplateId = await createWorkflowTemplate({
      name: `pgtemp_engine_lifecycle_reopen_${Date.now()}`,
      description: 'Temporary template for reopen-pending workflow integration test',
      steps: [
        {
          sequenceOrder: 0,
          operationName: 'reserve_identifiers',
          operationSettingsCategory: 'workflow',
          transitionCondition: 'always',
          metadata: {
            stage: 'preclose',
            resource_type: 'shipment',
            tracking_scope_type: 'client',
            tracking_scope_id: clientId,
          },
          handlerKey: 'reserve_shipment_identifiers',
          handlerVersion: 'v1',
          enabled: true,
        },
        {
          sequenceOrder: 1,
          operationName: 'reserve_identifiers',
          operationSettingsCategory: 'workflow',
          transitionCondition: 'always',
          metadata: {
            stage: 'pending',
            resource_type: 'shipment',
            tracking_scope_type: 'client',
            tracking_scope_id: clientId,
          },
          handlerKey: 'reserve_shipment_identifiers',
          handlerVersion: 'v1',
          enabled: true,
        },
      ],
    });

    const runId = await startWorkflowRun({}, reopenTemplateId);

    const firstBaseResult = await progressWorkflow('progress_workflow_run_base', runId, {});
    expect(firstBaseResult.status).toBe('completed');

    const midRunState = await readWorkflowState(runId);
    expect(midRunState.workflow_status).toBe('in_progress');
    expect(midRunState.steps.map((step) => step.step_status)).toEqual(['completed', 'pending']);

    await pool.query(
      `
        UPDATE public.workflow_runs
        SET workflow_status = 'completed',
            current_step_id = NULL,
            completed_at = now(),
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [runId],
    );

    const reopenResult = await progressWorkflow('progress_workflow_run', runId, {});
    expect(normalizeProgressResult(reopenResult)).toEqual({
      status: 'completed',
      reason: null,
      handler_key: 'reserve_shipment_identifiers',
      in_progress_operation: null,
      has_step_reference: true,
      has_next_run_at: false,
      skipped: false,
    });

    const postReopenState = await readWorkflowState(runId);
    expect(postReopenState.workflow_status).toBe('in_progress');
    expect(postReopenState.current_step_id).toBeTruthy();
    expect(postReopenState.completed_at).toBeNull();
    expect(postReopenState.steps.map((step) => step.step_status)).toEqual(['completed', 'completed']);
    expect(postReopenState.steps[1].operation_result?.planned_tracking_number).toMatch(/^[A-Z0-9-]+$/);

    const finalizeResult = await progressWorkflow('progress_workflow_run', runId, {});
    expect(normalizeProgressResult(finalizeResult)).toEqual({
      status: 'completed',
      reason: null,
      handler_key: null,
      in_progress_operation: null,
      has_step_reference: false,
      has_next_run_at: false,
      skipped: false,
    });

    const finalRunState = await readWorkflowState(runId);
    expect(finalRunState.workflow_status).toBe('completed');
    expect(finalRunState.current_step_id).toBeNull();
    expect(finalRunState.completed_at).toBeTruthy();
    expect(finalRunState.steps.map((step) => step.step_status)).toEqual(['completed', 'completed']);
  });
});
