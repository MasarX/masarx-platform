const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const { loadEnv } = require('../../scripts/utils/load-env');
const {
  applySetting,
  createOrganization,
  setWorkflowEngineContext,
} = require('./helpers/tenant-utils');

loadEnv();

jest.setTimeout(120_000);

const DATABASE_URL = String(
  process.env.DATABASE_URL || process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL_POOLER || '',
).trim();
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 4 }) : null;

const slug = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const OUTBOUND_RETRY_POLICY = Object.freeze({
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
});

const PROVIDER_FAILOVER_POLICY = Object.freeze({
  enabled: true,
  same_provider_type_only: true,
  current_provider_allowed_health_statuses: ['healthy'],
  candidate_allowed_health_statuses: ['healthy', 'degraded'],
  trigger_status_codes: [0, 408, 409, 425, 429],
  trigger_status_ranges: [[500, 599]],
  max_failover_hops: 2,
  failover_delay_seconds: 0,
  open_after_failures: 2,
  manual_intervention_after_failures: 4,
});

async function insertProvider(client, organizationId, name, rank) {
  const { rows } = await client.query(
    `INSERT INTO public.providers (
       organization_id,
       name,
       provider_type,
       enabled,
       priority_rank,
       health_status
     )
     VALUES ($1::uuid, $2, 'http', TRUE, $3, 'healthy')
     RETURNING id`,
    [organizationId, name, rank],
  );
  return rows[0].id;
}

async function insertProviderAuth(client, providerId, token, expiresAt) {
  const authConfigId = randomUUID();
  await client.query(
    `INSERT INTO public.provider_auth_configs (
       id,
       provider_id,
       auth_type,
       credentials,
       credentials_vault_id,
       expires_at
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       'bearer_token',
       $3::jsonb,
       NULL,
       $4::timestamptz
     )`,
    [authConfigId, providerId, JSON.stringify({ token }), expiresAt],
  );
  return authConfigId;
}

async function insertMappingConfig(client, key, config, version) {
  const mappingConfigId = randomUUID();
  await client.query(
    `INSERT INTO public.mapping_configs (
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
       $4,
       'integration recovery/backfill test mapping'
     )`,
    [mappingConfigId, key, JSON.stringify(config), version],
  );
  return mappingConfigId;
}

function authMetadata(authConfigId) {
  return {
    auth: {
      mode: 'bearer_token_header',
      auth_type: 'bearer_token',
      auth_config_id: authConfigId,
      header: 'authorization',
      scheme: 'Bearer',
      credential_key: 'token',
    },
  };
}

async function insertOperationTemplate(client, {
  providerId,
  operationName,
  url,
  mappingConfigId,
  authConfigId,
}) {
  const operationTemplateId = randomUUID();
  await client.query(
    `INSERT INTO public.operation_templates (
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
       handler_version,
       metadata
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3,
       'POST',
       $4,
       '{"content-type":"application/json"}'::jsonb,
       '{}'::jsonb,
       '{}'::jsonb,
       $5::uuid,
       'provider_api',
       30,
       'outbound_http',
       'v1',
       $6::jsonb
     )`,
    [
      operationTemplateId,
      providerId,
      operationName,
      url,
      mappingConfigId,
      JSON.stringify(authMetadata(authConfigId)),
    ],
  );
  return operationTemplateId;
}

async function createOutboundWorkflowJob(client, {
  organizationId,
  operationName,
  operationTemplateId,
  correlationId,
}) {
  const { rows: templateRows } = await client.query(
    `INSERT INTO public.workflow_templates (
       name,
       description,
       version,
       status,
       scope_type,
       scope_id
     )
     VALUES ($1, 'Integration recovery/backfill template', 1, 'active', 'tenant', $2::uuid)
     RETURNING id`,
    [slug('integration-recovery-template'), organizationId],
  );
  const workflowTemplateId = templateRows[0].id;

  const { rows: stepRows } = await client.query(
    `INSERT INTO public.workflow_template_steps (
       workflow_template_id,
       sequence_order,
       operation_name,
       transition_condition,
       condition_jsonlogic,
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
       jsonb_build_object('operation_template_id', $3::uuid),
       TRUE,
       'outbound_http',
       'v1'
     )
     RETURNING id`,
    [workflowTemplateId, operationName, operationTemplateId],
  );

  const { rows: runRows } = await client.query(
    `SELECT public.start_workflow_run($1::uuid, $2::jsonb) AS id`,
    [
      workflowTemplateId,
      JSON.stringify({
        organization_id: organizationId,
        correlation_id: correlationId,
        transformed_payload: {
          provider_reference: `pkg-${correlationId.slice(0, 8)}`,
          status: 'ready_for_dispatch',
        },
      }),
    ],
  );
  const workflowRunId = runRows[0].id;

  await client.query(`SELECT public.progress_workflow_run($1::uuid)`, [workflowRunId]);

  const { rows: jobRows } = await client.query(
    `SELECT id, workflow_run_step_id, target_id
       FROM public.outbound_calls
      WHERE (context->>'workflow_run_id')::uuid = $1::uuid
      ORDER BY created_at DESC
      LIMIT 1`,
    [workflowRunId],
  );
  expect(jobRows).toHaveLength(1);

  await setWorkflowEngineContext(client, {
    runId: workflowRunId,
    stepId: jobRows[0].workflow_run_step_id,
    local: true,
  });

  await client.query(
    `UPDATE public.outbound_calls
        SET status = 'pending_edge',
            scheduled_at = now() - interval '1 minute',
            lease_expires_at = NULL,
            priority = 2147483647,
            max_retries = 3,
            retry_count = 0,
            response_status_code = NULL,
            response_body = NULL,
            response_headers = NULL,
            error_message = NULL,
            completed_at = NULL
      WHERE id = $1::uuid`,
      [jobRows[0].id],
  );

  await client.query(
    `UPDATE public.providers
        SET health_status = 'healthy',
            updated_at = now()
      WHERE id = $1::uuid`,
    [jobRows[0].target_id],
  );

  await client.query(
    `DELETE FROM public.provider_health_logs
      WHERE provider_id = $1::uuid
        AND correlation_id = $2::uuid`,
    [jobRows[0].target_id, correlationId],
  );

  await client.query(
    `DELETE FROM public.circuit_breaker_state
      WHERE provider_id = $1::uuid`,
    [jobRows[0].target_id],
  );

  return {
    workflowTemplateId,
    workflowTemplateStepId: stepRows[0].id,
    workflowRunId,
    workflowRunStepId: jobRows[0].workflow_run_step_id,
    jobId: jobRows[0].id,
  };
}

async function createMappingReport(client, {
  organizationId,
  mappingConfigId,
  status,
  correlationId,
  diagnostics,
  result,
}) {
  const { rows } = await client.query(
    `SELECT public.ui_create_mapping_operation_report_v1($1::jsonb) AS report`,
    [
      JSON.stringify({
        organization_id: organizationId,
        artifact_type: 'api_outbound',
        operation_kind: 'mapping_save',
        save_mode: 'direct',
        status,
        primary_resource_type: 'mapping_configs',
        primary_resource_id: mappingConfigId,
        correlation_id: correlationId,
        request_summary: {
          source: 'integration_recovery_backfill',
        },
        conversion_summary: {
          recovered: status === 'succeeded',
        },
        diagnostics_summary: diagnostics,
        result_payload: result,
        decision_refs: {
          correlation_id: correlationId,
        },
        next_steps: status === 'succeeded'
          ? ['Resume provider backfill']
          : ['Repair mapping or credentials before replay'],
      }),
    ],
  );
  return rows[0].report;
}

describeIfDb('integration recovery and provider backfill', () => {
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

  test('fails closed without dispatching stale provider config before repair approval completes', async () => {
    const correlationId = randomUUID();
    const organization = await createOrganization(client, 'Integration Recovery Guard Org');

    await applySetting(client, {
      category: 'outbound_retry_policy',
      scopeType: 'tenant',
      scopeId: organization.id,
      value: OUTBOUND_RETRY_POLICY,
      changeReason: 'integration recovery retry policy',
    });

    const primaryProviderId = await insertProvider(
      client,
      organization.id,
      slug('stale-recovery-provider'),
      10,
    );
    const expiredAuthId = await insertProviderAuth(
      client,
      primaryProviderId,
      'expired-token',
      '2024-01-01T00:00:00.000Z',
    );
    const driftedMappingId = await insertMappingConfig(
      client,
      slug('provider-response-pre-repair-drifted'),
      {
        field_mappings: {
          external_status: '$.legacy_status',
          provider_reference: '$.package_id',
        },
      },
      1,
    );

    const operationName = slug('integration_recovery_pre_repair');
    const operationTemplateId = await insertOperationTemplate(client, {
      providerId: primaryProviderId,
      operationName,
      url: 'https://stale-recovery.masarx.test/packages',
      mappingConfigId: driftedMappingId,
      authConfigId: expiredAuthId,
    });
    const workflow = await createOutboundWorkflowJob(client, {
      organizationId: organization.id,
      operationName,
      operationTemplateId,
      correlationId,
    });

    const providerPayload = {
      id: `pkg-${correlationId.slice(0, 8)}`,
      status: 'accepted_for_backfill',
    };
    const { rows: driftRows } = await client.query(
      `SELECT public.apply_mapping_config($1::jsonb, $2::uuid) AS mapped`,
      [JSON.stringify(providerPayload), driftedMappingId],
    );
    expect(driftRows[0].mapped.external_status).toBeNull();

    const failedCredentialReport = await createMappingReport(client, {
      organizationId: organization.id,
      mappingConfigId: driftedMappingId,
      status: 'failed',
      correlationId,
      diagnostics: {
        blocking_count: 2,
        reasons: ['credential_expired', 'mapping_drift'],
        expired_auth_config_id: expiredAuthId,
        missing_paths: ['$.legacy_status'],
      },
      result: {
        provider_id: primaryProviderId,
        operation_template_id: operationTemplateId,
        mapped_payload: driftRows[0].mapped,
      },
    });
    expect(failedCredentialReport.status).toBe('failed');
    expect(failedCredentialReport.diagnostics_summary.reasons).toEqual(
      expect.arrayContaining(['credential_expired', 'mapping_drift']),
    );

    const { rows: baselineRows } = await client.query(
      `SELECT status, retry_count, lease_expires_at, completed_at, response_status_code, url, context
         FROM public.outbound_calls
        WHERE id = $1::uuid`,
      [workflow.jobId],
    );
    expect(baselineRows).toHaveLength(1);
    expect(baselineRows[0]).toMatchObject({
      status: 'pending_edge',
      retry_count: 0,
      lease_expires_at: null,
      completed_at: null,
      response_status_code: null,
      url: 'https://stale-recovery.masarx.test/packages',
    });
    expect(baselineRows[0].context.operation_template_id).toBe(operationTemplateId);

    const { rows: [preRepairClaim] } = await client.query(
      `SELECT * FROM public.claim_edge_job_by_id_v1($1::uuid)`,
      [workflow.jobId],
    );
    expect(preRepairClaim).toEqual({ job_id: workflow.jobId, lease_token: expect.any(String) });
    const { rows: [{ spec: preRepairSpec }] } = await client.query(
      `SELECT public.get_claimed_edge_job_call_spec_v1($1::uuid, $2::uuid) AS spec`,
      [preRepairClaim.job_id, preRepairClaim.lease_token],
    );
    expect(preRepairSpec).toBeNull();

    const { rows: postClaimRows } = await client.query(
      `SELECT status, retry_count, lease_expires_at, completed_at, response_status_code, url, target_id, context
         FROM public.outbound_calls
        WHERE id = $1::uuid`,
      [workflow.jobId],
    );
    expect(postClaimRows).toHaveLength(1);
    expect(postClaimRows[0]).toMatchObject({
      status: 'permanently_failed',
      retry_count: 0,
      lease_expires_at: null,
      completed_at: expect.any(Date),
      response_status_code: null,
      url: 'https://stale-recovery.masarx.test/packages',
      target_id: primaryProviderId,
    });
    expect(postClaimRows[0].context.operation_template_id).toBe(operationTemplateId);
    expect(postClaimRows[0].context.failover).toBeUndefined();

    const { rows: sideEffectRows } = await client.query(
      `SELECT
         (SELECT COUNT(*)::int
            FROM public.provider_health_logs
           WHERE provider_id = $1::uuid
             AND correlation_id = $2::uuid) AS provider_health_count,
         (SELECT COUNT(*)::int
            FROM public.domain_events
           WHERE correlation_id = $2::uuid
             AND resource_type IN ('outbound_call', 'provider', 'operation_template')) AS domain_event_count`,
      [primaryProviderId, correlationId],
    );
    expect(sideEffectRows[0]).toMatchObject({
      provider_health_count: 0,
      domain_event_count: 0,
    });
  });

  test('repairs expired credentials and mapping drift before provider outage backfill resumes the same workflow job', async () => {
    const correlationId = randomUUID();
    const organization = await createOrganization(client, 'Integration Recovery Org');

    await applySetting(client, {
      category: 'outbound_retry_policy',
      scopeType: 'tenant',
      scopeId: organization.id,
      value: OUTBOUND_RETRY_POLICY,
      changeReason: 'integration recovery retry policy',
    });
    await applySetting(client, {
      category: 'provider_failover_policy',
      scopeType: 'tenant',
      scopeId: organization.id,
      value: PROVIDER_FAILOVER_POLICY,
      changeReason: 'integration recovery failover policy',
    });

    const primaryProviderId = await insertProvider(
      client,
      organization.id,
      slug('primary-recovery-provider'),
      10,
    );
    const secondaryProviderId = await insertProvider(
      client,
      organization.id,
      slug('secondary-recovery-provider'),
      20,
    );

    const expiredAuthId = await insertProviderAuth(
      client,
      primaryProviderId,
      'expired-token',
      '2024-01-01T00:00:00.000Z',
    );
    const recoveredCredential = randomUUID();
    const secondaryCredential = randomUUID();
    const leaseExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const recoveredAuthId = await insertProviderAuth(
      client,
      primaryProviderId,
      recoveredCredential,
      leaseExpiry,
    );
    const secondaryAuthId = await insertProviderAuth(
      client,
      secondaryProviderId,
      secondaryCredential,
      leaseExpiry,
    );

    const driftedMappingId = await insertMappingConfig(
      client,
      slug('provider-response-drifted'),
      {
        field_mappings: {
          external_status: '$.legacy_status',
          provider_reference: '$.package_id',
        },
      },
      1,
    );
    const recoveredMappingId = await insertMappingConfig(
      client,
      slug('provider-response-recovered'),
      {
        field_mappings: {
          external_status: ['$.status', '$.legacy_status'],
          provider_reference: ['$.package_id', '$.id'],
        },
      },
      2,
    );

    const operationName = slug('integration_recovery_backfill');
    const primaryOperationTemplateId = await insertOperationTemplate(client, {
      providerId: primaryProviderId,
      operationName,
      url: 'https://primary-recovery.masarx.test/packages',
      mappingConfigId: driftedMappingId,
      authConfigId: expiredAuthId,
    });
    await insertOperationTemplate(client, {
      providerId: secondaryProviderId,
      operationName,
      url: 'https://secondary-recovery.masarx.test/packages',
      mappingConfigId: recoveredMappingId,
      authConfigId: secondaryAuthId,
    });

    const workflow = await createOutboundWorkflowJob(client, {
      organizationId: organization.id,
      operationName,
      operationTemplateId: primaryOperationTemplateId,
      correlationId,
    });

    const { rows: expiredCredentialRows } = await client.query(
      `SELECT id, expires_at < now() AS is_expired
         FROM public.provider_auth_configs
        WHERE id = $1::uuid`,
      [expiredAuthId],
    );
    expect(expiredCredentialRows).toHaveLength(1);
    expect(expiredCredentialRows[0].is_expired).toBe(true);

    const failedCredentialReport = await createMappingReport(client, {
      organizationId: organization.id,
      mappingConfigId: driftedMappingId,
      status: 'failed',
      correlationId,
      diagnostics: {
        blocking_count: 1,
        reasons: ['credential_expired'],
        expired_auth_config_id: expiredAuthId,
      },
      result: {
        provider_id: primaryProviderId,
        operation_template_id: primaryOperationTemplateId,
      },
    });
    expect(failedCredentialReport.status).toBe('failed');
    expect(failedCredentialReport.diagnostics_summary.reasons).toContain('credential_expired');

    await client.query(
      `UPDATE public.operation_templates
          SET metadata = jsonb_set(
                metadata,
                '{auth,auth_config_id}',
                to_jsonb($2::text),
                TRUE
              ),
              mapping_config_id = $3::uuid,
              updated_at = now()
        WHERE id = $1::uuid`,
      [primaryOperationTemplateId, recoveredAuthId, recoveredMappingId],
    );

    const providerPayload = {
      id: `pkg-${correlationId.slice(0, 8)}`,
      status: 'accepted_for_backfill',
    };
    const { rows: driftRows } = await client.query(
      `SELECT public.apply_mapping_config($1::jsonb, $2::uuid) AS mapped`,
      [JSON.stringify(providerPayload), driftedMappingId],
    );
    expect(driftRows[0].mapped.external_status).toBeNull();

    const failedMappingReport = await createMappingReport(client, {
      organizationId: organization.id,
      mappingConfigId: driftedMappingId,
      status: 'failed',
      correlationId,
      diagnostics: {
        blocking_count: 1,
        reasons: ['mapping_drift'],
        missing_paths: ['$.legacy_status'],
      },
      result: driftRows[0].mapped,
    });
    expect(failedMappingReport.status).toBe('failed');
    expect(failedMappingReport.diagnostics_summary.reasons).toContain('mapping_drift');

    const { rows: recoveredRows } = await client.query(
      `SELECT public.apply_mapping_config($1::jsonb, $2::uuid) AS mapped`,
      [JSON.stringify(providerPayload), recoveredMappingId],
    );
    expect(recoveredRows[0].mapped).toMatchObject({
      external_status: 'accepted_for_backfill',
      provider_reference: providerPayload.id,
    });

    const recoveredMappingReport = await createMappingReport(client, {
      organizationId: organization.id,
      mappingConfigId: recoveredMappingId,
      status: 'succeeded',
      correlationId,
      diagnostics: {
        blocking_count: 0,
        reasons: [],
      },
      result: recoveredRows[0].mapped,
    });
    expect(recoveredMappingReport.status).toBe('succeeded');
    expect(recoveredMappingReport.result_payload.external_status).toBe('accepted_for_backfill');

    const { rows: [initialClaim] } = await client.query(
      `SELECT * FROM public.claim_edge_job_by_id_v1($1::uuid)`,
      [workflow.jobId],
    );
    expect(initialClaim).toEqual({ job_id: workflow.jobId, lease_token: expect.any(String) });
    const { rows: [{ spec: primarySpec, stored: primaryStored }] } = await client.query(
      `SELECT public.get_claimed_edge_job_call_spec_v1($1::uuid, $2::uuid) AS spec,
              row_to_json(o) AS stored FROM public.outbound_calls o WHERE o.id = $1::uuid`,
      [initialClaim.job_id, initialClaim.lease_token],
    );
    expect(primarySpec).toMatchObject({
      url: `https://${['primary-recovery', 'masarx', 'test'].join('.')}/packages`,
      headers: { authorization: `Bearer ${recoveredCredential}` },
    });
    for (const secret of [recoveredCredential, secondaryCredential]) {
      expect(JSON.stringify(initialClaim)).not.toContain(secret);
      expect(JSON.stringify(primaryStored)).not.toContain(secret);
    }

    await client.query(
      `SELECT public.mark_claimed_edge_job_failure_v1(
         $1::uuid, $2::uuid, 503, $3::jsonb, $4::jsonb, 'provider outage during backfill', 0
       )`,
      [
        workflow.jobId,
        initialClaim.lease_token,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify({ error: 'provider_outage' }),
      ],
    );

    const { rows: failedJobRows } = await client.query(
      `SELECT status, retry_count, target_id, url, context
         FROM public.outbound_calls
        WHERE id = $1::uuid`,
      [workflow.jobId],
    );
    expect(failedJobRows).toHaveLength(1);
    expect(failedJobRows[0].status).toBe('failed');
    expect(failedJobRows[0].retry_count).toBe(1);
    expect(failedJobRows[0].target_id).toBe(secondaryProviderId);
    expect(failedJobRows[0].url).toBe('https://secondary-recovery.masarx.test/packages');
    expect(failedJobRows[0].context.failover.active_provider_id).toBe(secondaryProviderId);
    expect(failedJobRows[0].context.failover.history).toHaveLength(1);

    await client.query(
      `UPDATE public.outbound_calls
          SET scheduled_at = now() - interval '1 minute',
              lease_expires_at = NULL
        WHERE id = $1::uuid`,
      [workflow.jobId],
    );

    const { rows: [backfillClaim] } = await client.query(
      `SELECT * FROM public.claim_edge_job_by_id_v1($1::uuid)`,
      [workflow.jobId],
    );
    expect(backfillClaim).toEqual({ job_id: workflow.jobId, lease_token: expect.any(String) });
    const { rows: [{ spec: secondarySpec, stored: secondaryStored }] } = await client.query(
      `SELECT public.get_claimed_edge_job_call_spec_v1($1::uuid, $2::uuid) AS spec,
              row_to_json(o) AS stored FROM public.outbound_calls o WHERE o.id = $1::uuid`,
      [backfillClaim.job_id, backfillClaim.lease_token],
    );
    expect(secondarySpec).toMatchObject({
      url: `https://${['secondary-recovery', 'masarx', 'test'].join('.')}/packages`,
      headers: { authorization: `Bearer ${secondaryCredential}` },
    });
    for (const secret of [recoveredCredential, secondaryCredential]) {
      expect(JSON.stringify(backfillClaim)).not.toContain(secret);
      expect(JSON.stringify(secondaryStored)).not.toContain(secret);
    }

    await client.query(
      `SELECT public.mark_claimed_edge_job_success_v1($1::uuid, $2::uuid, 200, $3::jsonb, $4::jsonb, 118)`,
      [
        workflow.jobId,
        backfillClaim.lease_token,
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify({ ok: true, backfilled: true }),
      ],
    );

    const { rows: completedJobRows } = await client.query(
      `SELECT status, response_status_code, completed_at IS NOT NULL AS completed
         FROM public.outbound_calls
        WHERE id = $1::uuid`,
      [workflow.jobId],
    );
    expect(completedJobRows).toHaveLength(1);
    expect(completedJobRows[0]).toMatchObject({
      status: 'completed',
      response_status_code: 200,
      completed: true,
    });

    const { rows: sameJobRows } = await client.query(
      `SELECT COUNT(*)::int AS row_count
         FROM public.outbound_calls
        WHERE workflow_run_step_id = $1::uuid`,
      [workflow.workflowRunStepId],
    );
    expect(sameJobRows[0].row_count).toBe(1);

    const { rows: traceRows } = await client.query(
      `SELECT decision_category, decision_outcome
         FROM public.decision_log
        WHERE resource_type = 'outbound_call'
          AND resource_id = $1::uuid
          AND correlation_id = $2::uuid
        ORDER BY timestamp ASC`,
      [workflow.jobId, correlationId],
    );
    expect(traceRows.map((row) => row.decision_category)).toEqual(
      expect.arrayContaining(['outbound_call', 'provider_selection']),
    );
    expect(traceRows.map((row) => row.decision_outcome)).toEqual(
      expect.arrayContaining(['failed', 'failed_over']),
    );

    const { rows: healthRows } = await client.query(
      `SELECT status, correlation_id
         FROM public.provider_health_logs
        WHERE provider_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [primaryProviderId],
    );
    expect(healthRows).toHaveLength(1);
    expect(healthRows[0]).toMatchObject({
      status: 'degraded',
      correlation_id: correlationId,
    });

    const { rows: workflowRows } = await client.query(
      `SELECT step_status, operation_result
         FROM public.workflow_run_steps
        WHERE id = $1::uuid`,
      [workflow.workflowRunStepId],
    );
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0].operation_result.outbound_call_id).toBe(workflow.jobId);

    const { rows: observabilityRows } = await client.query(
      `SELECT event_source, event_type, status
         FROM public.observability_sink_v
        WHERE correlation_id = $1::uuid
          AND event_source IN ('decision_log', 'provider_health_logs', 'outbound_calls')
        ORDER BY event_time ASC`,
      [correlationId],
    );
    expect(observabilityRows.map((row) => row.event_source)).toEqual(
      expect.arrayContaining(['decision_log', 'provider_health_logs', 'outbound_calls']),
    );
  });
});
