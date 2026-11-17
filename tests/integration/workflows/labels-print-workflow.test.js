const { loadEnv } = require('../../../scripts/utils/load-env');
loadEnv();

const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { upsertSettings } = require('../../utils/policies');
const {
  completeBundleAsync,
  ensureLabelPdf,
  generateSignedUrl,
  resolveLabelProviderSecret,
  verifySignedUrl,
} = require('./helpers/label-print-helpers');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.DATABASE_URL_DIRECT ||
  process.env.DATABASE_URL_POOLER;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL (or DATABASE_URL_DIRECT / DATABASE_URL_POOLER) must be defined for labels print workflow test',
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Labels print workflow exercises a full async path (DB + edge + storage).
// Treat it as an HTTP/edge E2E: only run when both label tests and webhook
// HTTP tests are explicitly enabled.
const labelsHttpEnabled =
  process.env.RUN_LABELS_WEBHOOK_TESTS === 'true' &&
  process.env.RUN_WEBHOOK_HTTP_TESTS === 'true' &&
  !!process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.EDGE_SUPABASE_SERVICE_ROLE_KEY ||
  null;

const describeIfLabels = labelsHttpEnabled ? describe : describe.skip;

// Use a higher timeout while keeping assertions strict.
jest.setTimeout(150000);

const getWorkflowTemplateId = async (client, templateName) => {
  const { rows } = await client.query(
    `SELECT id
       FROM workflow_templates
      WHERE name = $1
      LIMIT 1`
    ,
    [templateName]
  );
  if (!rows.length) {
    throw new Error(`${templateName} template not found`);
  }
  return rows[0].id;
};

const getLabelsPrintTemplateId = async (client, templateName = 'labels_print_workflow_v2') =>
  getWorkflowTemplateId(client, templateName);

const insertShipmentWithBox = async ({
  client,
  organizationId,
  clientId,
  shipmentId,
  shipmentBoxId,
  tracking,
}) => {
  await client.query(
    `INSERT INTO shipments (
        id, organization_id, client_id, service_type, tracking_number, status,
        box_count, created_at, updated_at
     ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'delivery', $4, 'created', 1, now(), now()
     )
     ON CONFLICT (id, client_id) DO NOTHING`,
    [shipmentId, organizationId, clientId, tracking]
  );

  await client.query(
    `INSERT INTO shipment_boxes (
        id, shipment_id, organization_id, client_id, box_number, barcode, created_at
     ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now()
     )
     ON CONFLICT DO NOTHING`,
    [shipmentBoxId, shipmentId, organizationId, clientId, `${tracking}:1`]
  );
};

const waitForFreshLabel = async ({
  client,
  workflowRunId,
  shipmentId,
  barcode,
  runCreatedAt,
  attempts = 20,
}) => {
  let labelRow = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await client.query(
      `SELECT public.progress_workflow_run_until_wait_v1($1::uuid, '{}'::jsonb, 1200, 10)`,
      [workflowRunId]
    );

    const { rows } = await client.query(
      `SELECT
          l.id,
          l.generated_at,
          l.file_url,
          lj.id AS label_job_id,
          lj.status AS label_job_status,
          lj.attempts,
          lj.workflow_run_step_id,
          wrs.workflow_run_id
       FROM public.labels l
       LEFT JOIN public.label_jobs lj
         ON lj.label_id = l.id
       LEFT JOIN public.workflow_run_steps wrs
         ON wrs.id = lj.workflow_run_step_id
      WHERE l.shipment_id = $1::uuid
        AND l.barcode = $2
      ORDER BY l.generated_at DESC
      LIMIT 1`,
      [shipmentId, barcode]
    );

    const candidate = rows[0] || null;
    if (
      candidate &&
      new Date(candidate.generated_at).getTime() >= new Date(runCreatedAt).getTime()
    ) {
      labelRow = candidate;
      break;
    }

    await client.query('SELECT pg_sleep(0.5)');
  }

  return labelRow;
};

const waitForCompletedBundleRun = async ({
  client,
  workflowRunId,
  progressBudgetMs = 1200,
  progressMaxSteps = 10,
  maxAttempts = 50,
  settleAttempts = 20,
  sleepMs = 500,
}) => {
  let workflowStatus = null;
  let runRow = null;
  let labelPrintContext = {};
  let bundleResp = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await client.query(
      `SELECT public.progress_workflow_run_until_wait_v1($1::uuid, '{}'::jsonb, $2::int, $3::int)`,
      [workflowRunId, progressBudgetMs, progressMaxSteps]
    );
    const { rows } = await client.query(
      'SELECT workflow_status, context, failure_reason, last_error FROM workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    runRow = rows[0] || null;
    workflowStatus = runRow?.workflow_status || null;
    labelPrintContext = runRow?.context?.label_print || {};
    bundleResp = labelPrintContext.bundle_response || null;
    if (workflowStatus === 'failed') {
      break;
    }
    if (workflowStatus === 'completed' && bundleResp?.file_path) {
      break;
    }
    await client.query('SELECT pg_sleep($1::double precision)', [sleepMs / 1000]);
  }

  if (
    labelPrintContext.bundle_async?.request_id &&
    ((!bundleResp || Object.keys(bundleResp).length === 0) || workflowStatus !== 'completed')
  ) {
    const asyncRequestId = Number(labelPrintContext.bundle_async.request_id);
    await completeBundleAsync(client, workflowRunId, asyncRequestId, { maxAttempts: 16 });

    const { rows: refreshedRunRows } = await client.query(
      'SELECT workflow_status, context, failure_reason, last_error FROM workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    runRow = refreshedRunRows[0] || runRow;
    workflowStatus = refreshedRunRows[0]?.workflow_status || workflowStatus;
    const refreshedContext = refreshedRunRows[0]?.context || {};
    labelPrintContext = refreshedContext.label_print || labelPrintContext;
    bundleResp = labelPrintContext.bundle_response || bundleResp;
  }

  if ((!bundleResp || !bundleResp.bundle_id || !bundleResp.file_path) && workflowStatus !== 'completed') {
    for (let attempt = 0; attempt < settleAttempts; attempt += 1) {
      await client.query(
        `SELECT public.progress_workflow_run_until_wait_v1($1::uuid, '{}'::jsonb, $2::int, $3::int)`,
        [workflowRunId, progressBudgetMs, progressMaxSteps]
      );
      const { rows: refreshedRunRows } = await client.query(
        'SELECT workflow_status, context, failure_reason, last_error FROM workflow_runs WHERE id = $1::uuid',
        [workflowRunId]
      );
      runRow = refreshedRunRows[0] || runRow;
      workflowStatus = refreshedRunRows[0]?.workflow_status || workflowStatus;
      const refreshedContext = refreshedRunRows[0]?.context || {};
      labelPrintContext = refreshedContext.label_print || labelPrintContext;
      bundleResp = labelPrintContext.bundle_response || bundleResp;
      if (workflowStatus === 'completed' && bundleResp?.file_path) {
        break;
      }
      await client.query('SELECT pg_sleep($1::double precision)', [sleepMs / 1000]);
    }
  }

  if (!bundleResp || !bundleResp.bundle_id || !bundleResp.file_path) {
    const { rows: bundleStepRows } = await client.query(
      `SELECT operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND handler_key = 'label_bundle'
        ORDER BY sequence_order DESC
        LIMIT 1`,
      [workflowRunId]
    );
    const opResult = bundleStepRows[0]?.operation_result || {};
    bundleResp = opResult.bundle || opResult || bundleResp;
  }

  if (!bundleResp || !bundleResp.bundle_id || !bundleResp.file_path) {
    const { rows: finalizeRows } = await client.query(
      `SELECT operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND handler_key = 'label_print_finalize'
        ORDER BY sequence_order DESC
        LIMIT 1`,
      [workflowRunId]
    );
    const finOp = finalizeRows[0]?.operation_result || {};
    bundleResp = finOp.bundle || finOp || bundleResp;
  }

  return {
    workflowStatus,
    runRow,
    labelPrintContext,
    bundleResp,
  };
};

const waitForPendingBundleStep = async ({
  client,
  workflowRunId,
  progressBudgetMs = 1200,
  progressMaxSteps = 10,
  maxAttempts = 30,
  sleepMs = 250,
}) => {
  let bundleStep = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await client.query(
      `SELECT public.progress_workflow_run_until_wait_v1($1::uuid, '{}'::jsonb, $2::int, $3::int)`,
      [workflowRunId, progressBudgetMs, progressMaxSteps]
    );
    const { rows } = await client.query(
      `SELECT id, step_status, operation_result
         FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND handler_key = 'label_bundle'
        ORDER BY sequence_order DESC
        LIMIT 1`,
      [workflowRunId]
    );
    bundleStep = rows[0] || null;
    if (bundleStep?.step_status === 'pending') {
      break;
    }
    await client.query('SELECT pg_sleep($1::double precision)', [sleepMs / 1000]);
  }
  return bundleStep;
};

const withAuthenticatedUser = async (client, userId, fn) => {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    throw new Error('withAuthenticatedUser requires userId');
  }

  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE authenticated');
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true)`, [normalizedUserId]);
    await client.query(`SELECT set_config('request.jwt.claims', $1::text, true)`, [
      JSON.stringify({
        role: 'authenticated',
        sub: normalizedUserId,
      }),
    ]);
    const output = await fn(client);
    await client.query('COMMIT');
    return output;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

describeIfLabels('labels_print_workflow_hybrid', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    await pool.end();
  });

  test('forces fresh label generation and records audit trail', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentBoxId = randomUUID();
    const labelId = randomUUID();

    const labelProviderSecret = resolveLabelProviderSecret();
    if (!labelProviderSecret) {
      throw new Error(
        'Label provider auth missing (LABEL_RENDERER_DB_JWT/LABEL_RENDERER_TOKEN/SUPABASE_SERVICE_ROLE_KEY)',
      );
    }

    const templateId = await getLabelsPrintTemplateId(client, 'labels_print_workflow_v2');

    const tracking = `LBL${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Labels Print Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `labels-print-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Labels Print Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `labels-print-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO shipments (
          id, organization_id, client_id, service_type, tracking_number, status,
          box_count, created_at, updated_at
       ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'delivery', $4, 'created', 1, now(), now()
       )
       ON CONFLICT (id, client_id) DO NOTHING`,
      [shipmentId, organizationId, clientId, tracking]
    );

    await client.query(
      `INSERT INTO shipment_boxes (
          id, shipment_id, organization_id, client_id, box_number, barcode, created_at
       ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now()
       )
       ON CONFLICT DO NOTHING`,
      [shipmentBoxId, shipmentId, organizationId, clientId, `${tracking}:1`]
    );

    await client.query(
      `INSERT INTO labels (
          id, shipment_id, organization_id, client_id,
          label_type, barcode, barcode_format, layout_template_id,
          file_url, file_size_bytes, generated_by, generated_at, print_count, metadata, renderer_metadata
       ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          'shipping',
          $5,
          'CODE128',
          NULL,
          $6,
          0,
          NULL,
          clock_timestamp() - interval '1 day',
          1,
          jsonb_build_object('label_job_id', $1::uuid),
          '{}'::jsonb
       )
       ON CONFLICT DO NOTHING`,
      [labelId, shipmentId, organizationId, clientId, `${tracking}:1`, `${organizationId}/labels/${labelId}.pdf`]
    );

    await ensureLabelPdf(`${organizationId}/labels/${labelId}.pdf`);

    // This workflow is completed by external async workers. Keep the fixture
    // committed and tenant-scoped so the renderer can see the rows and apply
    // the org-specific settings without mutating global benchmark defaults.
    await upsertSettings(
      'label_provider',
      'tenant',
      organizationId,
      {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: `${process.env.SUPABASE_URL}/functions/v1/label-renderer`,
            invoke_secret: labelProviderSecret,
            timeout_ms: 20000,
          },
        ],
      },
      'labels print integration provider',
      client,
    );

    await upsertSettings(
      'label_print_defaults',
      'tenant',
      organizationId,
      {
        synthesize_from_existing: true,
        prefer_signed_url: true,
      },
      'labels print defaults for tests',
      client,
    );

    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      {
        workflow_mode: 'print_sync_execute',
        execute_dispatch_mode: 'sync_wait',
        execute_wait_seconds: 12,
        execute_initial_defer_ms: 250,
        fresh_generation_required: true,
        fresh_resolve_mode: 'workflow_scope_only',
        prepare_inline_progress_enabled: true,
        prepare_inline_progress_budget_ms: 1200,
        prepare_inline_progress_max_steps: 10,
        print_sync_bundle_strategy: 'direct',
        print_sync_compact_enabled: true,
        single_file_passthrough_enabled: true,
        poll_interval_seconds: 1,
      },
      'labels print policy for tests',
      client,
    );

    const startContext = {
      organization_id: organizationId,
      requested_by: randomUUID(),
      correlation_id: randomUUID(),
      payload: {
        event: 'labels.print',
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
      transformed_payload: {
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
    };

    const { rows: startRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );

    const workflowRunId = startRows[0].run_id;
    const { rows: workflowMetaRows } = await client.query(
      'SELECT created_at FROM workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    const runCreatedAt = workflowMetaRows[0]?.created_at;

    let {
      workflowStatus,
      runRow,
      labelPrintContext,
      bundleResp,
    } = await waitForCompletedBundleRun({
      client,
      workflowRunId,
    });

    const runRows = runRow ? [runRow] : [];
    expect(runRows).toHaveLength(1);
    expect(runRows[0].failure_reason).toBeFalsy();
    expect(runRows[0].last_error).toBeFalsy();

    const { rows: stepRows } = await client.query(
      `SELECT handler_key, step_status, operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1
        ORDER BY sequence_order`,
      [workflowRunId]
    );
    expect(stepRows.find((row) => row.handler_key === 'label_print_execute')?.step_status).not.toBe('failed');

    const runContext = runRows[0].context || {};
    labelPrintContext = runContext.label_print || {};
    bundleResp = labelPrintContext.bundle_response || null;

    let bundleId = bundleResp?.bundle_id || null;
    let bundlePath = bundleResp?.file_path || bundleResp?.file_url || null;

    if (!bundleId || !bundlePath) {
      const { rows: decisionRows } = await client.query(
        `SELECT resource_id, decision_inputs
           FROM decision_log
          WHERE decision_category = 'label_print'
            AND organization_id = $1
          ORDER BY timestamp DESC
          LIMIT 1`,
        [organizationId]
      );
      if (decisionRows.length) {
        bundleId = bundleId || decisionRows[0].resource_id;
        bundlePath =
          bundlePath ||
          decisionRows[0].decision_inputs?.file_path ||
          decisionRows[0].decision_inputs?.bundle?.file_path ||
          decisionRows[0].decision_inputs?.bundle_response?.file_path ||
          null;
      }
    }

    if (!bundleId || !bundlePath) {
      const { rows: objectRows } = await client.query(
        `SELECT name
           FROM storage.objects
          WHERE bucket_id = 'labels'
          ORDER BY created_at DESC
          LIMIT 1`,
        []
      );
      if (objectRows.length) {
        bundlePath = objectRows[0].name;
        const inferredMatch = bundlePath.match(/\/([0-9a-fA-F-]+)\.pdf$/);
        bundleId = bundleId || (inferredMatch ? inferredMatch[1] : null);
      }
    }

    const { rows: finalStepRows } = await client.query(
      `SELECT handler_key, step_status, operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1
        ORDER BY sequence_order`,
      [workflowRunId]
    );

    expect(bundleId).toBeTruthy();
    expect(workflowStatus).toBe('completed');
    expect(finalStepRows.every((row) => row.step_status === 'completed')).toBe(true);

    if (bundlePath) {
      const { rows: storageRows } = await client.query(
        `SELECT bucket_id, name FROM storage.objects WHERE bucket_id = 'labels' AND name = $1`,
        [bundlePath]
      );
      expect(storageRows.length).toBe(1);
    }

    if ((!bundleResp?.signed_url) && bundlePath) {
      try {
        const minted = await generateSignedUrl(bundlePath, labelPrintContext?.options?.expires_seconds || 600);
        if (minted?.signedUrl) {
          bundleResp.signed_url = minted.signedUrl;
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('labels.print workflow signed URL mint failed', error.message);
      }
    }

    if (bundleResp?.signed_url) {
      const signedUrlInfo = await verifySignedUrl(bundleResp.signed_url);
      expect(signedUrlInfo.status).toBe(200);
      expect(signedUrlInfo.contentLength).toBeGreaterThan(0);
    }

    const { rows: decisionRows } = await client.query(
      `SELECT decision_outcome, decision_inputs
         FROM decision_log
        WHERE decision_category = 'label_print'
          AND resource_id = $1::uuid`,
      [bundleId]
    );
    if (decisionRows.length) {
      expect(decisionRows[0].decision_outcome).toBe('completed');
    }

    const { rows: actionRows } = await client.query(
      `SELECT action_type, action_data
         FROM shipment_actions
        WHERE shipment_id = $1::uuid
          AND action_type = 'label_printed'`,
      [shipmentId]
    );
    if (actionRows.length) {
      expect(actionRows[0].action_data?.bundle_id).toBe(bundleId);
    }

    const { rows: freshLabelRows } = await client.query(
      `SELECT
          l.id,
          l.generated_at,
          l.file_url,
          l.label_type,
          l.metadata,
          lj.id AS label_job_id,
          lj.workflow_run_step_id,
          wrs.workflow_run_id AS scoped_workflow_run_id
         FROM labels l
         LEFT JOIN public.label_jobs lj
           ON lj.label_id = l.id
         LEFT JOIN public.workflow_run_steps wrs
           ON wrs.id = lj.workflow_run_step_id
        WHERE l.shipment_id = $1::uuid
          AND l.barcode = $2
        ORDER BY l.generated_at DESC
        LIMIT 1`,
      [shipmentId, `${tracking}:1`]
    );

    expect(freshLabelRows).toHaveLength(1);
    expect(new Date(freshLabelRows[0].generated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(runCreatedAt).getTime()
    );
    expect(freshLabelRows[0].label_type).toBe('shipping');
    expect(freshLabelRows[0].label_job_id).toBeTruthy();
    expect(freshLabelRows[0].scoped_workflow_run_id).toBe(workflowRunId);
    expect(String(freshLabelRows[0].file_url || '')).toContain(freshLabelRows[0].label_job_id);

    const firstFreshLabelJobId = freshLabelRows[0].label_job_id;
    const firstFreshLabelFileUrl = String(freshLabelRows[0].file_url || '');
    const firstFreshGeneratedAtMs = new Date(freshLabelRows[0].generated_at).getTime();

    const secondStartContext = {
      ...startContext,
      requested_by: randomUUID(),
      correlation_id: randomUUID(),
    };

    const { rows: secondStartRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, secondStartContext]
    );
    const secondWorkflowRunId = secondStartRows[0].run_id;
    const { rows: secondWorkflowMetaRows } = await client.query(
      'SELECT created_at FROM workflow_runs WHERE id = $1::uuid',
      [secondWorkflowRunId]
    );
    const secondRunCreatedAt = secondWorkflowMetaRows[0]?.created_at;

    const secondRunCompletion = await waitForCompletedBundleRun({
      client,
      workflowRunId: secondWorkflowRunId,
    });
    expect(secondRunCompletion.workflowStatus).toBe('completed');

    const { rows: secondFreshLabelRows } = await client.query(
      `SELECT
          l.id,
          l.generated_at,
          l.file_url,
          lj.id AS label_job_id,
          wrs.workflow_run_id
         FROM labels l
         JOIN public.label_jobs lj
           ON lj.label_id = l.id
         JOIN public.workflow_run_steps wrs
           ON wrs.id = lj.workflow_run_step_id
        WHERE l.shipment_id = $1::uuid
          AND l.barcode = $2
          AND wrs.workflow_run_id = $3::uuid
        ORDER BY l.generated_at DESC
        LIMIT 1`,
      [shipmentId, `${tracking}:1`, secondWorkflowRunId]
    );

    expect(secondFreshLabelRows).toHaveLength(1);
    expect(secondFreshLabelRows[0].workflow_run_id).toBe(secondWorkflowRunId);
    expect(secondFreshLabelRows[0].label_job_id).toBeTruthy();
    expect(secondFreshLabelRows[0].label_job_id).not.toBe(firstFreshLabelJobId);
    expect(String(secondFreshLabelRows[0].file_url || '')).toContain(secondFreshLabelRows[0].label_job_id);
    expect(String(secondFreshLabelRows[0].file_url || '')).not.toBe(firstFreshLabelFileUrl);
    expect(new Date(secondFreshLabelRows[0].generated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(secondRunCreatedAt).getTime()
    );
    expect(new Date(secondFreshLabelRows[0].generated_at).getTime()).toBeGreaterThan(firstFreshGeneratedAtMs);

    expect(
      (labelPrintContext.ready || []).filter((row) => {
        const generatedAt = row?.generated_at ? new Date(row.generated_at).getTime() : null;
        return Number.isFinite(generatedAt) && generatedAt < new Date(runCreatedAt).getTime();
      })
    ).toHaveLength(0);
  });

  test('labels_print_workflow_v2 completes through label_print_execute and exposes execute-stage status metrics', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentBoxId = randomUUID();
    const requestedBy = randomUUID();
    const userId = randomUUID();
    const labelProviderSecret = resolveLabelProviderSecret();
    if (!labelProviderSecret) {
      throw new Error(
        'Label provider auth missing (LABEL_RENDERER_DB_JWT/LABEL_RENDERER_TOKEN/SUPABASE_SERVICE_ROLE_KEY)',
      );
    }

    const templateId = await getLabelsPrintTemplateId(client, 'labels_print_workflow_v2');
    const tracking = `HYB${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Labels Hybrid Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `labels-hybrid-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Labels Hybrid Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `labels-hybrid-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO users (
         id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id
       )
       VALUES (
         $1::uuid, $2::uuid, $3, 'Labels Hybrid User', 'ops_admin', 'active', 'tenant', NULL
       )
       ON CONFLICT (id) DO NOTHING`,
      [userId, organizationId, `labels-hybrid-${userId.slice(0, 8)}@example.com`]
    );

    await insertShipmentWithBox({
      client,
      organizationId,
      clientId,
      shipmentId,
      shipmentBoxId,
      tracking,
    });

    await upsertSettings(
      'label_provider',
      'tenant',
      organizationId,
      {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: `${process.env.SUPABASE_URL}/functions/v1/label-renderer`,
            invoke_secret: labelProviderSecret,
            timeout_ms: 20000,
          },
        ],
      },
      'labels hybrid integration provider',
      client,
    );

    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      {
        workflow_mode: 'print_sync_execute',
        execute_dispatch_mode: 'sync_wait',
        execute_wait_seconds: 12,
        execute_initial_defer_ms: 250,
        fresh_generation_required: true,
        fresh_resolve_mode: 'workflow_scope_only',
        prepare_inline_progress_enabled: true,
        prepare_inline_progress_budget_ms: 1200,
        prepare_inline_progress_max_steps: 10,
        print_sync_bundle_strategy: 'direct',
        single_file_passthrough_enabled: true,
        print_sync_compact_enabled: true,
        poll_interval_seconds: 1,
      },
      'labels hybrid policy for tests',
      client,
    );

    const startContext = {
      organization_id: organizationId,
      requested_by: requestedBy,
      correlation_id: randomUUID(),
      payload: {
        event: 'labels.print',
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
      transformed_payload: {
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
    };

    const { rows: startRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );
    const workflowRunId = startRows[0].run_id;
    const { rows: workflowMetaRows } = await client.query(
      'SELECT created_at FROM workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    const runCreatedAt = workflowMetaRows[0]?.created_at;

    const {
      workflowStatus,
      runRow,
      labelPrintContext,
      bundleResp,
    } = await waitForCompletedBundleRun({
      client,
      workflowRunId,
      maxAttempts: 40,
      settleAttempts: 10,
      sleepMs: 250,
    });

    expect(runRow).toBeTruthy();
    expect(workflowStatus).toBe('completed');
    expect(runRow?.failure_reason).toBeFalsy();
    expect(runRow?.last_error).toBeFalsy();
    expect(labelPrintContext?.bundle_response?.file_path || bundleResp?.file_path).toBeTruthy();

    const { rows: stepRows } = await client.query(
      `SELECT handler_key, step_status, operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order`,
      [workflowRunId]
    );
    const handlerKeys = stepRows.map((row) => row.handler_key);
    expect(handlerKeys).toContain('label_print_execute');
    expect(handlerKeys).toContain('label_print_finalize');
    expect(handlerKeys).not.toContain('label_print_prepare');
    expect(handlerKeys).not.toContain('label_bundle');
    expect(stepRows.every((row) => row.step_status === 'completed')).toBe(true);

    const executeStep = stepRows.find((row) => row.handler_key === 'label_print_execute');
    const executeResult = executeStep?.operation_result?.execute || executeStep?.operation_result || {};
    const effectiveDispatchMode =
      executeResult.dispatch_mode ||
      executeStep?.operation_result?.dispatch_mode ||
      labelPrintContext?.execute_dispatch_mode ||
      null;
    expect(executeStep?.step_status).toBe('completed');
    expect(executeResult.mode).toBe('print_sync');
    expect(effectiveDispatchMode).toBe('async');
    expect(executeResult.bundle?.file_path || executeResult.bundle?.signed_url).toBeTruthy();
    expect(
      executeResult.artifact_kind || executeResult.bundle?.artifact_kind
    ).toBeTruthy();

    const { rows: freshLabelRows } = await client.query(
      `SELECT
          l.id,
          l.generated_at,
          l.file_url,
          l.label_type,
          lj.id AS label_job_id,
          wrs.workflow_run_id AS scoped_workflow_run_id
         FROM labels l
         LEFT JOIN public.label_jobs lj
           ON lj.label_id = l.id
         LEFT JOIN public.workflow_run_steps wrs
           ON wrs.id = lj.workflow_run_step_id
        WHERE l.shipment_id = $1::uuid
          AND l.barcode = $2
        ORDER BY l.generated_at DESC
        LIMIT 1`,
      [shipmentId, `${tracking}:1`]
    );
    expect(freshLabelRows).toHaveLength(1);
    expect(new Date(freshLabelRows[0].generated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(runCreatedAt).getTime()
    );
    expect(freshLabelRows[0].label_type).toBe('shipping');
    expect(freshLabelRows[0].label_job_id).toBeTruthy();
    expect(freshLabelRows[0].scoped_workflow_run_id).toBe(workflowRunId);

    const statusPayload = await withAuthenticatedUser(client, userId, async (authClient) => {
      const { rows } = await authClient.query(
        `SELECT api.ui_get_workflow_run_output_status_v1($1::uuid, NULL) AS payload`,
        [workflowRunId]
      );
      return rows[0]?.payload || null;
    });

    expect(statusPayload).toBeTruthy();
    expect(statusPayload?.output_ready).toBe(true);
    expect(statusPayload?.artifact_persisted).toBe(true);
    expect(typeof statusPayload?.job_completion_pending).toBe('boolean');
    expect(String(statusPayload?.timing_source || '')).not.toBe('');
    expect(statusPayload?.print_mode).toBe('print_sync');
    expect(statusPayload?.artifact_kind || null).not.toBeNull();
    expect(statusPayload?.print_async_request_id || null).not.toBeNull();
    expect(statusPayload?.stage_execute_ms || null).not.toBeNull();
    expect(statusPayload?.stage_render_ms || null).not.toBeNull();
    expect(statusPayload?.stage_enqueue_ms || null).not.toBeNull();
  });

  test('labels_print_workflow_v2 keeps execute rechecks on quick-poll cadence after budget-aware async fallback', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentBoxId = randomUUID();
    const requestedBy = randomUUID();
    const labelProviderSecret = resolveLabelProviderSecret();
    if (!labelProviderSecret) {
      throw new Error(
        'Label provider auth missing (LABEL_RENDERER_DB_JWT/LABEL_RENDERER_TOKEN/SUPABASE_SERVICE_ROLE_KEY)',
      );
    }

    const templateId = await getLabelsPrintTemplateId(client, 'labels_print_workflow_v2');
    const tracking = `QCK${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Labels Quick Poll Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `labels-quick-poll-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Labels Quick Poll Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `labels-quick-poll-client-${clientId.slice(0, 8)}`]
    );

    await insertShipmentWithBox({
      client,
      organizationId,
      clientId,
      shipmentId,
      shipmentBoxId,
      tracking,
    });

    await upsertSettings(
      'label_provider',
      'tenant',
      organizationId,
      {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: `${process.env.SUPABASE_URL}/functions/v1/label-renderer`,
            invoke_secret: labelProviderSecret,
            timeout_ms: 20000,
          },
        ],
      },
      'labels quick poll integration provider',
      client,
    );

    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      {
        workflow_mode: 'print_sync_execute',
        execute_dispatch_mode: 'sync_wait',
        execute_wait_seconds: 12,
        execute_initial_defer_ms: 250,
        quick_poll_interval_ms: 75,
        fresh_generation_required: true,
        fresh_resolve_mode: 'workflow_scope_only',
        print_sync_bundle_strategy: 'direct',
        single_file_passthrough_enabled: true,
        print_sync_compact_enabled: true,
        poll_interval_seconds: 15,
      },
      'labels quick poll policy for tests',
      client,
    );

    const startContext = {
      organization_id: organizationId,
      requested_by: requestedBy,
      correlation_id: randomUUID(),
      payload: {
        event: 'labels.print',
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
      transformed_payload: {
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
    };

    const { rows: startRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );
    const workflowRunId = startRows[0].run_id;

    const { rows: progressRows } = await client.query(
      `SELECT public.progress_workflow_run_until_wait_v1(
         $1::uuid,
         '{}'::jsonb,
         300,
         4
       ) AS payload`,
      [workflowRunId]
    );
    const progressPayload = progressRows[0]?.payload || null;
    expect(progressPayload).toBeTruthy();

    const { rows: runRows } = await client.query(
      `SELECT context
         FROM workflow_runs
        WHERE id = $1::uuid`,
      [workflowRunId]
    );
    const executeRequestId = runRows[0]?.context?.label_print?.execute_async?.request_id || null;
    expect(executeRequestId).toBeTruthy();

    const { rows: stepRows } = await client.query(
      `SELECT
          handler_key,
          step_status,
          EXTRACT(EPOCH FROM (run_at - clock_timestamp())) * 1000 AS run_delay_ms
         FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND handler_key = 'label_print_execute'
        ORDER BY sequence_order DESC
        LIMIT 1`,
      [workflowRunId]
    );
    expect(stepRows[0]?.handler_key).toBe('label_print_execute');
    expect(stepRows[0]?.step_status).toBe('pending');
    expect(Number(stepRows[0]?.run_delay_ms || 0)).toBeLessThanOrEqual(1000);
  });

  test('accepts external execute step results through the generic workflow helper', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentBoxId = randomUUID();
    const requestedBy = randomUUID();
    const labelProviderSecret = resolveLabelProviderSecret();
    if (!labelProviderSecret) {
      throw new Error(
        'Label provider auth missing (LABEL_RENDERER_DB_JWT/LABEL_RENDERER_TOKEN/SUPABASE_SERVICE_ROLE_KEY)',
      );
    }

    const templateId = await getLabelsPrintTemplateId(client, 'labels_print_workflow_v2');
    const tracking = `CBK${shipmentId.slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Labels Callback Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `labels-callback-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Labels Callback Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `labels-callback-client-${clientId.slice(0, 8)}`]
    );

    await insertShipmentWithBox({
      client,
      organizationId,
      clientId,
      shipmentId,
      shipmentBoxId,
      tracking,
    });

    await upsertSettings(
      'label_provider',
      'tenant',
      organizationId,
      {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: `${process.env.SUPABASE_URL}/functions/v1/label-renderer`,
            invoke_secret: labelProviderSecret,
            timeout_ms: 20000,
          },
        ],
      },
      'labels callback integration provider',
      client,
    );

    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      {
        fresh_generation_required: true,
        fresh_resolve_mode: 'workflow_scope_only',
        prepare_inline_progress_enabled: true,
        prepare_inline_progress_budget_ms: 1200,
        prepare_inline_progress_max_steps: 10,
        bundle_inline_progress_enabled: false,
        quick_poll_attempts: 0,
        poll_interval_seconds: 1,
      },
      'labels callback policy for tests',
      client,
    );

    const startContext = {
      organization_id: organizationId,
      requested_by: requestedBy,
      correlation_id: randomUUID(),
      payload: {
        event: 'labels.print',
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
      transformed_payload: {
        organization_id: organizationId,
        shipments: [{ shipment_id: shipmentId }],
      },
    };

    const { rows: startRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );
    const workflowRunId = startRows[0].run_id;
    const { rows: executeStepRows } = await client.query(
      `SELECT id
         FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND handler_key = 'label_print_execute'
        ORDER BY sequence_order
        LIMIT 1`,
      [workflowRunId]
    );
    const executeStepId = executeStepRows[0]?.id || null;
    expect(executeStepId).toBeTruthy();

    const filePath = `${organizationId}/labels/${randomUUID()}.pdf`;
    await ensureLabelPdf(filePath);
    const bundleId = randomUUID();
    const operationResult = {
      status: 'completed',
      source: 'integration_test_external_execute_result',
      print_mode: 'print_sync',
      artifact_kind: 'single_file',
      execute: {
        status: 'ok',
        mode: 'print_sync',
        artifact_kind: 'single_file',
        timings: {
          total_ms: 5,
        },
      },
      bundle: {
        status: 'ok',
        bundle_id: bundleId,
        file_path: filePath,
        file_url: filePath,
        signed_url: null,
        counts: {
          requested: 1,
          bundled: 1,
          placeholders: 0,
        },
        timings: {
          total_ms: 5,
        },
      },
    };

    const { rows: progressRows } = await client.query(
      `SELECT public.progress_workflow_run_step_result_v1(
          $1::uuid,
          $2::uuid,
          $3::jsonb,
          1200,
          10
        ) AS payload`,
      [workflowRunId, executeStepId, operationResult]
    );
    const progressPayload = progressRows[0]?.payload || {};
    expect(['completed', 'waiting', 'pending']).toContain(progressPayload.status);

    const {
      workflowStatus,
      runRow,
      bundleResp,
    } = await waitForCompletedBundleRun({
      client,
      workflowRunId,
      maxAttempts: 10,
      settleAttempts: 5,
      sleepMs: 200,
    });
    expect(runRow).toBeTruthy();
    expect(workflowStatus).toBe('completed');
    expect(runRow?.failure_reason).toBeFalsy();
    expect(runRow?.last_error).toBeFalsy();
    expect(bundleResp?.bundle_id).toBeTruthy();
    expect(bundleResp?.file_path || bundleResp?.file_url).toBeTruthy();

    if (SERVICE_ROLE_KEY) {
      const apiClient = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'api' },
      });
      const { data: apiWrapperPayload, error: apiWrapperError } = await apiClient.rpc(
        'progress_workflow_run_step_result_v1',
        {
          p_workflow_run_id: workflowRunId,
          p_workflow_run_step_id: executeStepId,
          p_operation_result: operationResult,
          p_budget_ms: 1200,
          p_max_steps: 10,
        }
      );
      expect(apiWrapperError).toBeNull();
      expect(apiWrapperPayload?.workflow_run_id).toBe(workflowRunId);
      expect(apiWrapperPayload?.status).toBe('terminal');
      expect(apiWrapperPayload?.workflow_status).toBe('completed');
    }

    const { rows: finalStepRows } = await client.query(
      `SELECT handler_key, step_status
         FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order`,
      [workflowRunId]
    );
    expect(finalStepRows.every((row) => row.step_status === 'completed')).toBe(true);
  });

  test('status polling resolves current workflow output without waiting for cron progression', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const requestedBy = randomUUID();
    const userId = randomUUID();
    const shipmentCount = 3;
    const labelProviderSecret = resolveLabelProviderSecret();
    if (!labelProviderSecret) {
      throw new Error(
        'Label provider auth missing (LABEL_RENDERER_DB_JWT/LABEL_RENDERER_TOKEN/SUPABASE_SERVICE_ROLE_KEY)',
      );
    }

    const templateId = await getLabelsPrintTemplateId(client, 'labels_print_workflow_v2');

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Labels Status Reconcile Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `labels-status-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Labels Status Reconcile Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `labels-status-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO users (
         id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id
       )
       VALUES (
         $1::uuid, $2::uuid, $3, 'Labels Status User', 'ops_admin', 'active', 'tenant', NULL
       )
       ON CONFLICT (id) DO NOTHING`,
      [userId, organizationId, `labels-status-${userId.slice(0, 8)}@example.com`]
    );

    const shipmentIds = [];
    for (let index = 0; index < shipmentCount; index += 1) {
      const shipmentId = randomUUID();
      const shipmentBoxId = randomUUID();
      const tracking = `STS${shipmentId.slice(0, 8).toUpperCase()}`;
      shipmentIds.push(shipmentId);
      await insertShipmentWithBox({
        client,
        organizationId,
        clientId,
        shipmentId,
        shipmentBoxId,
        tracking,
      });
    }

    await upsertSettings(
      'label_provider',
      'tenant',
      organizationId,
      {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: `${process.env.SUPABASE_URL}/functions/v1/label-renderer`,
            invoke_secret: labelProviderSecret,
            timeout_ms: 20000,
          },
        ],
      },
      'labels status reconcile provider',
      client,
    );

    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      {
        workflow_mode: 'print_sync_execute',
        execute_dispatch_mode: 'sync_wait',
        execute_wait_seconds: 12,
        execute_initial_defer_ms: 250,
        fresh_generation_required: true,
        fresh_resolve_mode: 'workflow_scope_only',
        prepare_inline_progress_enabled: true,
        prepare_inline_progress_budget_ms: 1200,
        prepare_inline_progress_max_steps: 10,
        print_sync_bundle_strategy: 'direct',
        print_sync_compact_enabled: true,
        render_max_jobs: 2,
        render_max_calls: 4,
        render_job_concurrency: 3,
        poll_interval_seconds: 1,
      },
      'labels status reconcile policy',
      client,
    );

    const startContext = {
      organization_id: organizationId,
      requested_by: requestedBy,
      correlation_id: randomUUID(),
      payload: {
        event: 'labels.print',
        organization_id: organizationId,
        shipments: shipmentIds.map((shipmentId) => ({ shipment_id: shipmentId })),
      },
      transformed_payload: {
        organization_id: organizationId,
        shipments: shipmentIds.map((shipmentId) => ({ shipment_id: shipmentId })),
      },
    };

    const { rows: startRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );
    const workflowRunId = startRows[0].run_id;

    let statusPayload = null;
    let runRow = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      statusPayload = await withAuthenticatedUser(client, userId, async (authClient) => {
        const { rows } = await authClient.query(
          `SELECT api.ui_get_workflow_run_output_status_v1($1::uuid, NULL) AS payload`,
          [workflowRunId]
        );
        return rows[0]?.payload || null;
      });

      const { rows: refreshedRunRows } = await client.query(
        `SELECT workflow_status, context
           FROM workflow_runs
          WHERE id = $1::uuid`,
        [workflowRunId]
      );
      runRow = refreshedRunRows[0] || null;

      if (
        statusPayload?.output_ready &&
        statusPayload?.output_source !== 'async_response' &&
        runRow?.workflow_status === 'completed'
      ) {
        break;
      }

      await client.query('SELECT pg_sleep(0.2)');
    }

    expect(statusPayload).toBeTruthy();
    expect(statusPayload?.output_ready).toBe(true);
    expect(statusPayload?.output_source).not.toBe('async_response');
    expect(statusPayload?.artifact_persisted).toBe(true);
    expect(typeof statusPayload?.job_completion_pending).toBe('boolean');
    expect(String(statusPayload?.timing_source || '')).not.toBe('');
    expect(statusPayload?.print_mode).toBe('print_sync');
    expect(statusPayload?.print_async_request_id || null).not.toBeNull();
    expect(statusPayload?.async_progress_error || null).toBeNull();
    expect(runRow?.workflow_status).toBe('completed');
    expect(String(runRow?.context?.label_print?.bundle_response?.bundle_id || '')).not.toBe('');
  });

  test('bundles the full current scope across multiple render batches', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const requestedBy = randomUUID();
    const shipmentCount = 6;
    const labelProviderSecret = resolveLabelProviderSecret();
    if (!labelProviderSecret) {
      throw new Error(
        'Label provider auth missing (LABEL_RENDERER_DB_JWT/LABEL_RENDERER_TOKEN/SUPABASE_SERVICE_ROLE_KEY)',
      );
    }

    const templateId = await getLabelsPrintTemplateId(client, 'labels_print_workflow_v2');

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Labels Full Bundle Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `labels-full-bundle-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Labels Full Bundle Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `labels-full-bundle-client-${clientId.slice(0, 8)}`]
    );

    await upsertSettings(
      'label_provider',
      'tenant',
      organizationId,
      {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: `${process.env.SUPABASE_URL}/functions/v1/label-renderer`,
            invoke_secret: labelProviderSecret,
            timeout_ms: 20000,
          },
        ],
      },
      'labels full bundle integration provider',
      client,
    );

    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      {
        workflow_mode: 'print_sync_execute',
        execute_dispatch_mode: 'sync_wait',
        execute_wait_seconds: 12,
        execute_initial_defer_ms: 250,
        fresh_generation_required: true,
        fresh_resolve_mode: 'workflow_scope_only',
        render_invoke_enabled: true,
        render_max_jobs: 2,
        render_max_calls: 3,
        render_job_concurrency: 3,
        prepare_inline_progress_enabled: true,
        prepare_inline_progress_budget_ms: 1200,
        prepare_inline_progress_max_steps: 10,
        print_sync_bundle_strategy: 'direct',
        print_sync_compact_enabled: true,
        poll_interval_seconds: 1,
      },
      'labels full bundle policy for tests',
      client,
    );

    const shipments = [];
    for (let index = 0; index < shipmentCount; index += 1) {
      const shipmentId = randomUUID();
      const shipmentBoxId = randomUUID();
      const tracking = `FUL${index}${shipmentId.slice(0, 6).toUpperCase()}`;
      shipments.push({
        shipment_id: shipmentId,
        shipment_box_id: shipmentBoxId,
        tracking,
      });
      await insertShipmentWithBox({
        client,
        organizationId,
        clientId,
        shipmentId,
        shipmentBoxId,
        tracking,
      });
    }

    const startContext = {
      organization_id: organizationId,
      requested_by: requestedBy,
      correlation_id: randomUUID(),
      payload: {
        event: 'labels.print',
        organization_id: organizationId,
        shipments: shipments.map((shipment) => ({ shipment_id: shipment.shipment_id })),
      },
      transformed_payload: {
        organization_id: organizationId,
        shipments: shipments.map((shipment) => ({ shipment_id: shipment.shipment_id })),
      },
    };

    const { rows: startRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );
    const workflowRunId = startRows[0].run_id;
    const { rows: workflowMetaRows } = await client.query(
      'SELECT created_at FROM public.workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    const runCreatedAt = workflowMetaRows[0]?.created_at;

    const {
      workflowStatus,
      runRow,
      labelPrintContext,
      bundleResp,
    } = await waitForCompletedBundleRun({
      client,
      workflowRunId,
      maxAttempts: 80,
      settleAttempts: 30,
    });

    expect(runRow).toBeTruthy();
    expect(runRow?.failure_reason).toBeFalsy();
    expect(runRow?.last_error).toBeFalsy();
    expect(workflowStatus).toBe('completed');
    expect(bundleResp?.bundle_id).toBeTruthy();
    expect(bundleResp?.file_path || bundleResp?.file_url).toBeTruthy();

    const { rows: executeStepRows } = await client.query(
      `SELECT id, operation_result
         FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND handler_key = 'label_print_execute'
        ORDER BY sequence_order DESC
        LIMIT 1`,
      [workflowRunId]
    );
    const freshScopeStepId = executeStepRows[0]?.id || null;
    expect(freshScopeStepId).toBeTruthy();

    const { rows: freshScopeRows } = await client.query(
      `SELECT
          COUNT(*)::int AS total_count,
          COUNT(*) FILTER (WHERE status = 'succeeded' AND output_file_url IS NOT NULL)::int AS ready_count,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
         FROM public.label_jobs
        WHERE workflow_run_step_id = $1::uuid`,
      [freshScopeStepId]
    );
    expect(freshScopeRows[0].total_count).toBe(shipmentCount);
    expect(freshScopeRows[0].ready_count).toBe(shipmentCount);
    expect(freshScopeRows[0].failed_count).toBe(0);

    const executeOperation = executeStepRows[0]?.operation_result || {};
    expect(executeOperation?.dispatch_mode).toBe('async');
    const bundleCounts =
      executeOperation?.bundle?.counts ||
      executeOperation?.execute?.bundle?.counts ||
      executeOperation?.counts ||
      {};
    expect(Number(bundleCounts.requested || 0)).toBe(shipmentCount);
    expect(Number(bundleCounts.bundled || 0)).toBe(shipmentCount);

    const { rows: freshLabelRows } = await client.query(
      `SELECT
          COUNT(*)::int AS label_count,
          COUNT(DISTINCT l.shipment_id)::int AS shipment_count
         FROM public.labels l
         JOIN public.label_jobs lj
           ON lj.label_id = l.id
         JOIN public.workflow_run_steps wrs
           ON wrs.id = lj.workflow_run_step_id
        WHERE wrs.workflow_run_id = $1::uuid
          AND l.generated_at >= $2::timestamptz`,
      [workflowRunId, runCreatedAt]
    );
    expect(freshLabelRows[0].label_count).toBe(shipmentCount);
    expect(freshLabelRows[0].shipment_count).toBe(shipmentCount);
    expect(Number(labelPrintContext?.counts?.ready || 0)).toBe(shipmentCount);
    expect(Number(labelPrintContext?.counts?.pending || 0)).toBe(0);
    const renderStep = Array.isArray(executeOperation?.execute?.steps)
      ? executeOperation.execute.steps.find((step) => step?.step === 'render_label_jobs')
      : null;
    expect(Array.isArray(renderStep?.calls)).toBe(true);
    expect(renderStep?.calls?.length || 0).toBe(3);
    expect(Number(renderStep?.requested_jobs || 0)).toBe(shipmentCount);
    expect(Number(renderStep?.pending_remaining || 0)).toBe(0);
    expect(Number(renderStep?.failed_jobs || 0)).toBe(0);
  });

  test('targets current-scope pending jobs even when older tenant backlog exists', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const requestedBy = randomUUID();
    const labelProviderSecret = resolveLabelProviderSecret();
    if (!labelProviderSecret) {
      throw new Error(
        'Label provider auth missing (LABEL_RENDERER_DB_JWT/LABEL_RENDERER_TOKEN/SUPABASE_SERVICE_ROLE_KEY)',
      );
    }

    const templateId = await getLabelsPrintTemplateId(client, 'labels_print_workflow_v2');

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Labels Targeted Dispatch Org', $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, `labels-targeted-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Labels Targeted Dispatch Client', $3, 'standard', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, organizationId, `labels-targeted-client-${clientId.slice(0, 8)}`]
    );

    await upsertSettings(
      'label_provider',
      'tenant',
      organizationId,
      {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: `${process.env.SUPABASE_URL}/functions/v1/label-renderer`,
            invoke_secret: labelProviderSecret,
            timeout_ms: 20000,
          },
        ],
      },
      'labels targeted dispatch integration provider',
      client,
    );

    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      {
        fresh_generation_required: true,
        fresh_resolve_mode: 'workflow_scope_only',
        render_invoke_enabled: true,
        render_max_jobs: 10,
        render_job_concurrency: 5,
        prepare_inline_progress_enabled: true,
        prepare_inline_progress_budget_ms: 1200,
        prepare_inline_progress_max_steps: 10,
        poll_interval_seconds: 1,
      },
      'labels targeted dispatch policy for tests',
      client,
    );

    const backlogShipments = [];
    for (let index = 0; index < 10; index += 1) {
      const shipmentId = randomUUID();
      const shipmentBoxId = randomUUID();
      const tracking = `BLK${index}${shipmentId.slice(0, 6).toUpperCase()}`;
      backlogShipments.push({ shipment_id: shipmentId, box_ids: [shipmentBoxId] });
      await insertShipmentWithBox({
        client,
        organizationId,
        clientId,
        shipmentId,
        shipmentBoxId,
        tracking,
      });
    }

    const targetShipmentId = randomUUID();
    const targetShipmentBoxId = randomUUID();
    const targetTracking = `CUR${targetShipmentId.slice(0, 8).toUpperCase()}`;
    await insertShipmentWithBox({
      client,
      organizationId,
      clientId,
      shipmentId: targetShipmentId,
      shipmentBoxId: targetShipmentBoxId,
      tracking: targetTracking,
    });

    await client.query(
      `SELECT *
         FROM public.request_label_generation_bulk_v1(
           $1::jsonb,
           'shipping',
           $2::uuid,
           'integration.backlog.pending',
           'reprint'
         )`,
      [JSON.stringify(backlogShipments), requestedBy]
    );

    const { rows: backlogBeforeRows } = await client.query(
      `SELECT COUNT(*)::int AS pending_count,
              COALESCE(MAX(attempts), 0)::int AS max_attempts
         FROM public.label_jobs
        WHERE organization_id = $1::uuid
          AND requested_source = 'integration.backlog.pending'`,
      [organizationId]
    );
    expect(backlogBeforeRows[0].pending_count).toBe(10);
    expect(backlogBeforeRows[0].max_attempts).toBe(0);

    const startContext = {
      organization_id: organizationId,
      requested_by: requestedBy,
      correlation_id: randomUUID(),
      payload: {
        event: 'labels.print',
        organization_id: organizationId,
        shipments: [{ shipment_id: targetShipmentId }],
      },
      transformed_payload: {
        organization_id: organizationId,
        shipments: [{ shipment_id: targetShipmentId }],
      },
    };

    const { rows: startRows } = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );
    const workflowRunId = startRows[0].run_id;
    const { rows: runMetaRows } = await client.query(
      'SELECT created_at FROM public.workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    const runCreatedAt = runMetaRows[0]?.created_at;

    const freshLabel = await waitForFreshLabel({
      client,
      workflowRunId,
      shipmentId: targetShipmentId,
      barcode: `${targetTracking}:1`,
      runCreatedAt,
      attempts: 20,
    });

    expect(freshLabel).toBeTruthy();
    expect(freshLabel.workflow_run_id).toBe(workflowRunId);
    expect(freshLabel.label_job_id).toBeTruthy();
    expect(String(freshLabel.file_url || '')).toContain(freshLabel.label_job_id);

    const { rows: backlogAfterRows } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE attempts > 0)::int AS attempted_count,
              COUNT(*) FILTER (WHERE status <> 'pending')::int AS moved_count
         FROM public.label_jobs
        WHERE organization_id = $1::uuid
          AND requested_source = 'integration.backlog.pending'`,
      [organizationId]
    );

    expect(backlogAfterRows[0].attempted_count).toBe(0);
    expect(backlogAfterRows[0].moved_count).toBe(0);
  });
});

