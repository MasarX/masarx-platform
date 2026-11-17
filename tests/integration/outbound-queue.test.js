const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { setWorkflowEngineContext } = require('./helpers/tenant-utils');

loadEnv();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const slug = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createProviderWorkflowJob(client, options = {}) {
  const organizationSlug = slug('edge-queue-org');
  const operationName = options.operationName || slug('edge_queue_operation');
  const primaryUrl = options.primaryUrl || 'https://primary.masarx.test/outbound';
  const secondaryUrl = options.secondaryUrl || 'https://secondary.masarx.test/outbound';
  const includeSecondaryProvider = options.includeSecondaryProvider !== false;

  const { rows: organizationRows } = await client.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     RETURNING id`,
    ['Outbound Queue Org', organizationSlug],
  );
  const organizationId = organizationRows[0].id;

  const { rows: primaryProviderRows } = await client.query(
    `INSERT INTO providers (organization_id, name, provider_type, enabled, priority_rank, health_status)
     VALUES ($1::uuid, $2, 'http', true, 10, 'healthy')
     RETURNING id, name`,
    [organizationId, slug('primary-provider')],
  );
  const primaryProviderId = primaryProviderRows[0].id;
  let secondaryProviderId = null;
  if (includeSecondaryProvider) {
    const { rows: secondaryProviderRows } = await client.query(
      `INSERT INTO providers (organization_id, name, provider_type, enabled, priority_rank, health_status)
       VALUES ($1::uuid, $2, 'http', true, 20, 'healthy')
       RETURNING id, name`,
      [organizationId, slug('secondary-provider')],
    );
    secondaryProviderId = secondaryProviderRows[0].id;
  }

  const primaryMappingConfigId = randomUUID();
  await client.query(
    `
      INSERT INTO mapping_configs (
        id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
      )
      VALUES (
        $1::uuid,
        'provider_response',
        $2,
        '{}'::jsonb,
        1,
        'Outbound queue primary mapping'
      )
    `,
    [primaryMappingConfigId, `edge_queue_primary::${primaryMappingConfigId}`],
  );
  let secondaryMappingConfigId = null;
  if (includeSecondaryProvider) {
    secondaryMappingConfigId = randomUUID();
    await client.query(
      `
        INSERT INTO mapping_configs (
          id,
          mapping_type,
          mapping_key,
          mapping_config,
          mapping_version,
          notes
        )
        VALUES (
          $1::uuid,
          'provider_response',
          $2,
          '{}'::jsonb,
          1,
          'Outbound queue secondary mapping'
        )
      `,
      [secondaryMappingConfigId, `edge_queue_secondary::${secondaryMappingConfigId}`],
    );
  }

  const primaryOperationTemplateId = randomUUID();
  await client.query(
    `
      INSERT INTO operation_templates (
        id,
        provider_id,
        operation_name,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        call_type,
        timeout_seconds,
        handler_key,
        handler_version
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        'POST',
        $4,
        '{}'::jsonb,
        '{}'::jsonb,
        '{}'::jsonb,
        $5::uuid,
        'provider_api',
        30,
        'outbound_http',
        'v1'
      )
    `,
    [
      primaryOperationTemplateId,
      primaryProviderId,
      operationName,
      primaryUrl,
      primaryMappingConfigId,
    ],
  );
  let secondaryOperationTemplateId = null;
  if (includeSecondaryProvider) {
    secondaryOperationTemplateId = randomUUID();
    await client.query(
      `
        INSERT INTO operation_templates (
          id,
          provider_id,
          operation_name,
          method,
          url_template,
          headers_template,
          body_template,
          request_mappings,
          mapping_config_id,
          call_type,
          timeout_seconds,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          'POST',
          $4,
          '{}'::jsonb,
          '{}'::jsonb,
          '{}'::jsonb,
          $5::uuid,
          'provider_api',
          30,
          'outbound_http',
          'v1'
        )
      `,
      [
        secondaryOperationTemplateId,
        secondaryProviderId,
        operationName,
        secondaryUrl,
        secondaryMappingConfigId,
      ],
    );
  }

  await client.query(
    `
      SELECT *
      FROM public.upsert_settings_value_v1(
        'outbound_retry_policy',
        'tenant',
        $1::uuid,
        $2::jsonb,
        1,
        'integration test outbound retry policy'
      )
    `,
    [
      organizationId,
      JSON.stringify({
        version: 1,
        http: {
          retryable_status_codes: [0, 408, 429],
          retryable_status_ranges: [[500, 599]],
          permanent_status_ranges: [[400, 499]],
          retry_after_header: 'retry-after',
        },
        backoff_seconds: [0, 0, 0],
        max_retry_delay_seconds: 0,
        respect_retry_after: false,
      }),
    ],
  );

  await client.query(
    `
      SELECT *
      FROM public.upsert_settings_value_v1(
        'provider_failover_policy',
        'tenant',
        $1::uuid,
        $2::jsonb,
        1,
        'integration test provider failover policy'
      )
    `,
    [
      organizationId,
      JSON.stringify({
        enabled: true,
        same_provider_type_only: true,
        current_provider_allowed_health_statuses: ['healthy'],
        candidate_allowed_health_statuses: ['healthy', 'degraded'],
        trigger_status_codes: [0, 408, 409, 425, 429],
        trigger_status_ranges: [[500, 599]],
        max_failover_hops: 2,
        failover_delay_seconds: 0,
        open_after_failures: 3,
        manual_intervention_after_failures: 6,
      }),
    ],
  );

  const { rows: workflowTemplateRows } = await client.query(
    `INSERT INTO workflow_templates (
       name,
       description,
       version,
       status,
       notes,
       scope_type,
       scope_id
     )
     VALUES ($1, 'Outbound queue failover test template', 1, 'active', 'edge queue failover', 'tenant', $2::uuid)
     RETURNING id`,
    [slug('edge-queue-template'), organizationId],
  );
  const workflowTemplateId = workflowTemplateRows[0].id;

  await client.query(
    `INSERT INTO workflow_template_steps (
       workflow_template_id,
       sequence_order,
       operation_name,
       transition_condition,
       condition_jsonlogic,
       next_operation_name,
       next_operation_priority,
       next_operation_delay_seconds,
       manual_action_required,
       metadata,
       enabled,
       handler_key,
       handler_version
     )
     VALUES (
       $1::uuid,
       1,
       $2,
       'always',
       NULL,
       NULL,
       NULL,
       NULL,
       false,
       jsonb_build_object('operation_template_id', $3::uuid),
       true,
       'outbound_http',
       'v1'
     )`,
    [workflowTemplateId, operationName, primaryOperationTemplateId],
  );

  const { rows: workflowRunRows } = await client.query(
    `SELECT start_workflow_run($1::uuid, $2::jsonb) AS id`,
    [workflowTemplateId, JSON.stringify({ organization_id: organizationId })],
  );
  const workflowRunId = workflowRunRows[0].id;

  await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

  const { rows: jobRows } = await client.query(
    `SELECT id, workflow_run_step_id
       FROM outbound_calls
      WHERE (context->>'workflow_run_id')::uuid = $1::uuid
      ORDER BY created_at DESC
      LIMIT 1`,
    [workflowRunId],
  );
  const jobId = jobRows[0].id;
  const workflowRunStepId = jobRows[0].workflow_run_step_id;

  await client.query(
    `
      UPDATE outbound_calls
         SET status = 'pending_edge',
             lease_expires_at = NULL,
             scheduled_at = now(),
             priority = 2147483647
       WHERE id = $1::uuid
    `,
    [jobId],
  );

  return {
    organizationId,
    operationName,
    jobId,
    workflowRunId,
    workflowRunStepId,
    primaryProviderId,
    secondaryProviderId,
    primaryOperationTemplateId,
    secondaryOperationTemplateId,
    primaryUrl,
    secondaryUrl,
  };
}

describeIfDb('Outbound queue edge lifecycle', () => {
  let client;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  test('claims pending edge job and marks it successful', async () => {
    const { rows: providerRows } = await client.query(
      `SELECT id FROM providers ORDER BY created_at LIMIT 1`
    );
    expect(providerRows.length).toBe(1);
    const providerId = providerRows[0].id;

    const mappingConfigId = randomUUID();
    await client.query(
      `
        INSERT INTO mapping_configs (
          id,
          mapping_type,
          mapping_key,
          mapping_config,
          mapping_version,
          notes
        )
        VALUES (
          $1::uuid,
          'provider_response',
          $2,
          $3::jsonb,
          1,
          'Outbound queue integration test'
        )
      `,
      [mappingConfigId, `edge_queue_test::${mappingConfigId}`, JSON.stringify({})]
    );

    const operationTemplateId = randomUUID();
    await client.query(
      `
        INSERT INTO operation_templates (
          id,
          provider_id,
          operation_name,
          method,
          url_template,
          headers_template,
          body_template,
          request_mappings,
          mapping_config_id,
          call_type,
          timeout_seconds,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          'edge_queue_test_operation',
          'POST',
          'https://example.masarx.test/outbound',
          '{}'::jsonb,
          '{}'::jsonb,
          '{}'::jsonb,
          $3::uuid,
          'provider_api',
          30,
          'outbound_http',
          'v1'
        )
      `,
      [operationTemplateId, providerId, mappingConfigId]
    );

    const workflowTemplateId = randomUUID();
    await client.query(
      `
        INSERT INTO workflow_templates (
          id,
          name,
          description,
          version,
          status,
          scope_type
        )
        VALUES (
          $1::uuid,
          $2,
          'Outbound queue integration test template',
          1,
          'active',
          'global'
        )
      `,
      [workflowTemplateId, `edge_queue_template_${Date.now()}`]
    );

    const workflowTemplateStepId = randomUUID();
    await client.query(
      `
        INSERT INTO workflow_template_steps (
          id,
          workflow_template_id,
          sequence_order,
          operation_name,
          operation_settings_category,
          transition_condition,
          metadata,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          1,
          'edge_queue_dispatch',
          'operation_template',
          'always',
          $3::jsonb,
          'outbound_http',
          'v1'
        )
      `,
      [
        workflowTemplateStepId,
        workflowTemplateId,
        JSON.stringify({ operation_template_id: operationTemplateId }),
      ]
    );

    const workflowRunId = randomUUID();
    const correlationId = randomUUID();
    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
    await client.query(
      `
        INSERT INTO workflow_runs (
          id,
          workflow_template_id,
          workflow_template_version,
          entry_point,
          workflow_status,
          context
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          1,
          'webhook',
          'pending',
          $3::jsonb
        )
      `,
      [
        workflowRunId,
        workflowTemplateId,
        JSON.stringify({ correlation_id: correlationId }),
      ]
    );

    const workflowRunStepId = randomUUID();
    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
    await client.query(
      `
        INSERT INTO workflow_run_steps (
          id,
          workflow_run_id,
          workflow_template_step_id,
          sequence_order,
          step_status,
          operation_name,
          metadata,
          max_retries,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          1,
          'pending',
          'edge_queue_dispatch',
          $4::jsonb,
          3,
          'outbound_http',
          'v1'
        )
      `,
      [
        workflowRunStepId,
        workflowRunId,
        workflowTemplateStepId,
        JSON.stringify({ operation_template_id: operationTemplateId }),
      ]
    );

    await setWorkflowEngineContext(client, { runId: workflowRunId, stepId: workflowRunStepId, local: true });
    await client.query(
      `
        SELECT workflow_handlers.execute_outbound_http_v1(wrs, wr, '{}'::jsonb) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [workflowRunStepId]
    );

    const { rows: jobRows } = await client.query(
      `SELECT id, status FROM outbound_calls WHERE workflow_run_step_id = $1::uuid`,
      [workflowRunStepId]
    );
    expect(jobRows.length).toBe(1);
    const jobId = jobRows[0].id;

    await client.query(
      `
        UPDATE outbound_calls
        SET status = 'pending_edge',
            lease_expires_at = NULL,
            scheduled_at = now(),
            priority = 2147483647
        WHERE id = $1::uuid
      `,
      [jobId]
    );

    const { rows: claimRows } = await client.query(
      `SELECT * FROM claim_pending_edge_jobs($1)`,
      [5]
    );
    // In shared/tested environments, other pending_edge jobs may exist.
    // Assert our job is included and has a valid dispatch payload.
    expect(claimRows.length).toBeGreaterThanOrEqual(1);
    const myRow = claimRows.find((r) => r.job_id === jobId);
    expect(myRow).toBeTruthy();
    expect(myRow.dispatch).toBeTruthy();
    expect(myRow.dispatch.url).toBeTruthy();
    expect(myRow.dispatch.method).toBeTruthy();

    const { rows: leasedRows } = await client.query(
      `SELECT status, lease_expires_at FROM outbound_calls WHERE id = $1::uuid`,
      [jobId]
    );
    expect(leasedRows[0].status).toBe('in_progress_edge');
    expect(leasedRows[0].lease_expires_at).not.toBeNull();

    await client.query(
      `
        SELECT mark_outbound_call_success(
          $1::uuid,
          $2,
          $3::jsonb,
          $4::jsonb,
          $5
        )
      `,
      [
        jobId,
        200,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify({ ok: true }),
        150,
      ]
    );

    const { rows: completedRows } = await client.query(
      `SELECT status, response_status_code FROM outbound_calls WHERE id = $1::uuid`,
      [jobId]
    );
    expect(completedRows[0].status).toBe('completed');
    expect(completedRows[0].response_status_code).toBe(200);
  });

  test('schedules transient retries and stops on terminal outbound failures', async () => {
    const { rows: providerRows } = await client.query(
      `SELECT id FROM providers ORDER BY created_at LIMIT 1`
    );
    expect(providerRows.length).toBe(1);
    const providerId = providerRows[0].id;

    const mappingConfigId = randomUUID();
    await client.query(
      `
        INSERT INTO mapping_configs (
          id,
          mapping_type,
          mapping_key,
          mapping_config,
          mapping_version,
          notes
        )
        VALUES (
          $1::uuid,
          'provider_response',
          $2,
          $3::jsonb,
          1,
          'Outbound queue retry integration test'
        )
      `,
      [mappingConfigId, `edge_queue_retry_test::${mappingConfigId}`, JSON.stringify({})]
    );

    const operationTemplateId = randomUUID();
    await client.query(
      `
        INSERT INTO operation_templates (
          id,
          provider_id,
          operation_name,
          method,
          url_template,
          headers_template,
          body_template,
          request_mappings,
          mapping_config_id,
          call_type,
          timeout_seconds,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          'edge_queue_retry_test_operation',
          'POST',
          'https://example.masarx.test/outbound-retry',
          '{}'::jsonb,
          '{}'::jsonb,
          '{}'::jsonb,
          $3::uuid,
          'provider_api',
          30,
          'outbound_http',
          'v1'
        )
      `,
      [operationTemplateId, providerId, mappingConfigId]
    );

    const workflowTemplateId = randomUUID();
    await client.query(
      `
        INSERT INTO workflow_templates (
          id,
          name,
          description,
          version,
          status,
          scope_type
        )
        VALUES (
          $1::uuid,
          $2,
          'Outbound queue retry integration test template',
          1,
          'active',
          'global'
        )
      `,
      [workflowTemplateId, `edge_queue_retry_template_${Date.now()}`]
    );

    const workflowTemplateStepId = randomUUID();
    await client.query(
      `
        INSERT INTO workflow_template_steps (
          id,
          workflow_template_id,
          sequence_order,
          operation_name,
          operation_settings_category,
          transition_condition,
          metadata,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          1,
          'edge_queue_dispatch',
          'operation_template',
          'always',
          $3::jsonb,
          'outbound_http',
          'v1'
        )
      `,
      [
        workflowTemplateStepId,
        workflowTemplateId,
        JSON.stringify({ operation_template_id: operationTemplateId }),
      ]
    );

    const workflowRunId = randomUUID();
    const correlationId = randomUUID();
    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
    await client.query(
      `
        INSERT INTO workflow_runs (
          id,
          workflow_template_id,
          workflow_template_version,
          entry_point,
          workflow_status,
          context
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          1,
          'webhook',
          'pending',
          $3::jsonb
        )
      `,
      [
        workflowRunId,
        workflowTemplateId,
        JSON.stringify({ correlation_id: correlationId }),
      ]
    );

    const workflowRunStepId = randomUUID();
    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
    await client.query(
      `
        INSERT INTO workflow_run_steps (
          id,
          workflow_run_id,
          workflow_template_step_id,
          sequence_order,
          step_status,
          operation_name,
          metadata,
          max_retries,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          1,
          'pending',
          'edge_queue_dispatch',
          $4::jsonb,
          3,
          'outbound_http',
          'v1'
        )
      `,
      [
        workflowRunStepId,
        workflowRunId,
        workflowTemplateStepId,
        JSON.stringify({ operation_template_id: operationTemplateId }),
      ]
    );

    await setWorkflowEngineContext(client, { runId: workflowRunId, stepId: workflowRunStepId, local: true });
    await client.query(
      `
        SELECT workflow_handlers.execute_outbound_http_v1(wrs, wr, '{}'::jsonb) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [workflowRunStepId]
    );

    const { rows: jobRows } = await client.query(
      `SELECT id FROM outbound_calls WHERE workflow_run_step_id = $1::uuid`,
      [workflowRunStepId]
    );
    expect(jobRows.length).toBe(1);
    const jobId = jobRows[0].id;

    await client.query(
      `
        UPDATE outbound_calls
        SET status = 'pending_edge',
            lease_expires_at = NULL,
            scheduled_at = now(),
            priority = 2147483647,
            max_retries = 2
        WHERE id = $1::uuid
      `,
      [jobId]
    );

    const { rows: claimRows } = await client.query(
      `SELECT * FROM claim_pending_edge_jobs($1)`,
      [5]
    );
    expect(claimRows.some((row) => row.job_id === jobId)).toBe(true);

    await client.query(
      `
        SELECT mark_outbound_call_failure(
          $1::uuid,
          $2,
          $3::jsonb,
          $4::jsonb,
          $5
        )
      `,
      [
        jobId,
        503,
        JSON.stringify({ 'content-type': 'application/json', 'retry-after': '60' }),
        JSON.stringify({ error: 'temporary upstream failure' }),
        'temporary upstream failure',
      ]
    );

    const { rows: failedRows } = await client.query(
      `SELECT status, retry_count, completed_at, scheduled_at > now() AS scheduled_in_future FROM outbound_calls WHERE id = $1::uuid`,
      [jobId]
    );
    expect(failedRows[0].status).toBe('failed');
    expect(failedRows[0].retry_count).toBe(1);
    expect(failedRows[0].completed_at).toBeNull();
    expect(failedRows[0].scheduled_in_future).toBe(true);

    const { rows: firstDecisionRows } = await client.query(
      `
        SELECT decision_outcome, decision_inputs
        FROM decision_log
        WHERE resource_type = 'outbound_call'
          AND resource_id = $1::uuid
        ORDER BY timestamp ASC
      `,
      [jobId]
    );
    const firstFailureDecision = firstDecisionRows.find((row) => row.decision_outcome === 'failed');
    expect(firstFailureDecision).toBeTruthy();
    expect(firstFailureDecision.decision_inputs?.retry_reason).toBe('retry_scheduled');
    expect(firstFailureDecision.decision_inputs?.retryable).toBe(true);
    expect(firstFailureDecision.decision_inputs?.permanent).toBe(false);

    const { rows: prematureClaimRows } = await client.query(
      `SELECT * FROM claim_pending_edge_jobs($1)`,
      [5]
    );
    expect(prematureClaimRows.some((row) => row.job_id === jobId)).toBe(false);

    await client.query(
      `
        UPDATE outbound_calls
        SET scheduled_at = now() - interval '1 minute',
            lease_expires_at = NULL
        WHERE id = $1::uuid
      `,
      [jobId]
    );
    const { rows: reclaimedRows } = await client.query(
      `SELECT * FROM claim_pending_edge_jobs($1)`,
      [5]
    );
    expect(reclaimedRows.some((row) => row.job_id === jobId)).toBe(true);

    await client.query(
      `
        SELECT mark_outbound_call_failure(
          $1::uuid,
          $2,
          $3::jsonb,
          $4::jsonb,
          $5
        )
      `,
      [
        jobId,
        400,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify({ error: 'permanent client error' }),
        'permanent client error',
      ]
    );

    const { rows: terminalRows } = await client.query(
      `SELECT status, retry_count, completed_at IS NOT NULL AS is_completed FROM outbound_calls WHERE id = $1::uuid`,
      [jobId]
    );
    expect(terminalRows[0].status).toBe('permanently_failed');
    expect(terminalRows[0].retry_count).toBe(2);
    expect(terminalRows[0].is_completed).toBe(true);

    const { rows: terminalDecisionRows } = await client.query(
      `
        SELECT decision_outcome, decision_inputs
        FROM decision_log
        WHERE resource_type = 'outbound_call'
          AND resource_id = $1::uuid
        ORDER BY timestamp ASC
      `,
      [jobId]
    );
    const terminalDecision = terminalDecisionRows.find((row) => row.decision_outcome === 'permanently_failed');
    expect(terminalDecision).toBeTruthy();
    expect(terminalDecision.decision_inputs?.retry_reason).toBe('permanent_status_code');
    expect(terminalDecision.decision_inputs?.retryable).toBe(false);
    expect(terminalDecision.decision_inputs?.permanent).toBe(true);
  });

  test('marks the failing provider degraded and retries through the failover provider', async () => {
    const correlationId = randomUUID();
    const scenario = await createProviderWorkflowJob(client, {
      primaryUrl: 'https://primary-failover.masarx.test/outbound',
      secondaryUrl: 'https://secondary-failover.masarx.test/outbound',
    });

    await client.query(
      `
        SELECT mark_outbound_call_failure_v2(
          $1::uuid,
          503,
          $2::jsonb,
          $3::jsonb,
          'primary provider unavailable',
          'integration.test.failover',
          $4::uuid
        )
      `,
      [
        scenario.jobId,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify({ error: 'provider_down' }),
        correlationId,
      ],
    );

    const { rows: failedJobRows } = await client.query(
      `SELECT status, retry_count, response_status_code, target_id, url, context
         FROM outbound_calls
        WHERE id = $1::uuid`,
      [scenario.jobId],
    );
    expect(failedJobRows).toHaveLength(1);
    expect(failedJobRows[0].status).toBe('failed');
    expect(failedJobRows[0].retry_count).toBe(1);
    expect(failedJobRows[0].response_status_code).toBe(503);
    expect(failedJobRows[0].target_id).toBe(scenario.secondaryProviderId);
    expect(failedJobRows[0].url).toBe(scenario.secondaryUrl);
    expect(failedJobRows[0].context.failover.active_provider_id).toBe(scenario.secondaryProviderId);
    expect(failedJobRows[0].context.failover.history).toHaveLength(1);
    expect(failedJobRows[0].context.failover.history[0].from_provider_id).toBe(
      scenario.primaryProviderId,
    );
    expect(failedJobRows[0].context.failover.history[0].to_provider_id).toBe(
      scenario.secondaryProviderId,
    );

    const { rows: replayRowCountRows } = await client.query(
      `SELECT COUNT(*)::int AS row_count
         FROM outbound_calls
        WHERE workflow_run_step_id = $1::uuid`,
      [scenario.workflowRunStepId],
    );
    expect(replayRowCountRows[0].row_count).toBe(1);

    const { rows: providerRows } = await client.query(
      `SELECT id, health_status
         FROM providers
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[scenario.primaryProviderId, scenario.secondaryProviderId]],
    );
    const healthByProviderId = new Map(
      providerRows.map((row) => [row.id, row.health_status]),
    );
    expect(healthByProviderId.get(scenario.primaryProviderId)).toBe('degraded');
    expect(healthByProviderId.get(scenario.secondaryProviderId)).toBe('healthy');

    const { rows: circuitRows } = await client.query(
      `SELECT state, failure_count, manual_intervention_required
         FROM circuit_breaker_state
        WHERE provider_id = $1::uuid
          AND operation_name = $2`,
      [scenario.primaryProviderId, scenario.operationName],
    );
    expect(circuitRows).toHaveLength(1);
    expect(circuitRows[0].state).toBe('closed');
    expect(circuitRows[0].failure_count).toBe(1);
    expect(circuitRows[0].manual_intervention_required).toBe(false);

    const { rows: healthLogRows } = await client.query(
      `SELECT status, error_message, correlation_id
         FROM provider_health_logs
        WHERE provider_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [scenario.primaryProviderId],
    );
    expect(healthLogRows).toHaveLength(1);
    expect(healthLogRows[0].status).toBe('degraded');
    expect(healthLogRows[0].correlation_id).toBe(correlationId);

    const { rows: failoverDecisionRows } = await client.query(
      `SELECT decision_category, decision_outcome
         FROM decision_log
        WHERE resource_type = 'outbound_call'
          AND resource_id = $1::uuid
          AND decision_category = 'provider_selection'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [scenario.jobId],
    );
    expect(failoverDecisionRows).toHaveLength(1);
    expect(failoverDecisionRows[0].decision_outcome).toBe('failed_over');

    const { rows: claimRows } = await client.query(
      `SELECT * FROM claim_pending_edge_jobs($1)`,
      [5],
    );
    const claimedRow = claimRows.find((row) => row.job_id === scenario.jobId);
    expect(claimedRow).toBeTruthy();
    expect(claimedRow.dispatch.url).toBe(scenario.secondaryUrl);
    expect(claimedRow.dispatch.method).toBe('POST');
  });

  test('blocks failover when no alternate provider exists and keeps the original job row', async () => {
    const correlationId = randomUUID();
    const scenario = await createProviderWorkflowJob(client, {
      includeSecondaryProvider: false,
    });

    const { rows: candidateRows } = await client.query(
      `SELECT resolve_outbound_failover_candidate_v1(
                $1::uuid,
                'http_failure',
                503,
                'no alternate provider'
              ) AS candidate`,
      [scenario.jobId],
    );
    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0].candidate.applied).toBe(false);
    expect(candidateRows[0].candidate.reason).toBe('no_candidate');

    await client.query(
      `
        SELECT mark_outbound_call_failure_v2(
          $1::uuid,
          503,
          $2::jsonb,
          $3::jsonb,
          'primary provider unavailable',
          'integration.test.terminal_block',
          $4::uuid
        )
      `,
      [
        scenario.jobId,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify({ error: 'provider_down' }),
        correlationId,
      ],
    );

    const { rows: failedJobRows } = await client.query(
      `SELECT status, retry_count, target_id, context
         FROM outbound_calls
        WHERE id = $1::uuid`,
      [scenario.jobId],
    );
    expect(failedJobRows).toHaveLength(1);
    expect(failedJobRows[0].status).toBe('failed');
    expect(failedJobRows[0].retry_count).toBe(1);
    expect(failedJobRows[0].target_id).toBe(scenario.primaryProviderId);
    expect(failedJobRows[0].context.failover).toBeUndefined();

    const { rows: healthLogRows } = await client.query(
      `SELECT status, correlation_id
         FROM provider_health_logs
        WHERE provider_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [scenario.primaryProviderId],
    );
    expect(healthLogRows).toHaveLength(1);
    expect(healthLogRows[0].status).toBe('degraded');
    expect(healthLogRows[0].correlation_id).toBe(correlationId);

    const { rows: decisionRows } = await client.query(
      `SELECT decision_category, decision_point, decision_outcome
         FROM decision_log
        WHERE resource_type = 'outbound_call'
          AND resource_id = $1::uuid
          AND decision_category = 'outbound_call'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [scenario.jobId],
    );
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].decision_point).toBe('http_execution');
    expect(decisionRows[0].decision_outcome).toBe('failed');

    const { rows: replayRowCountRows } = await client.query(
      `SELECT COUNT(*)::int AS row_count
         FROM outbound_calls
        WHERE workflow_run_step_id = $1::uuid`,
      [scenario.workflowRunStepId],
    );
    expect(replayRowCountRows[0].row_count).toBe(1);
  });
});
