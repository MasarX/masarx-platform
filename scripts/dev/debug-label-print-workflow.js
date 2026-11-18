#!/usr/bin/env node
/* eslint-disable no-console */
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../utils/load-env');
const { parseFlagArgs } = require('../utils/cli-args');
const { upsertSettings } = require('../utils/settings-upsert');
const {
  completeBundleAsync,
  ensureLabelPdf,
  generateSignedUrl,
  verifySignedUrl,
} = require('../../tests/integration/workflows/helpers/label-print-helpers');

async function main() {
  loadEnv();
  const flags = parseFlagArgs(process.argv.slice(2));

  const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LABEL_RENDERER_TOKEN } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL must be defined for debug script');

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const providerSecret =
      LABEL_RENDERER_TOKEN ||
      SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SERVICE_ROLE_KEY;
    if (!providerSecret) {
      throw new Error('LABEL_RENDERER_TOKEN or service role key required for label provider setting');
    }
    if (!SUPABASE_URL) {
      throw new Error('SUPABASE_URL must be set in ENV_FILE for debug script');
    }

    const templateName = String(
      flags['workflow-template-name'] || process.env.WORKFLOW_TEMPLATE_NAME || 'labels_print_workflow_v1'
    ).trim();
    if (!templateName) {
      throw new Error('workflow template name required (set --workflow-template-name or WORKFLOW_TEMPLATE_NAME)');
    }

    // Look up template id (name is UNIQUE)
    const tmplRes = await client.query(
      `SELECT id FROM workflow_templates WHERE name = $1::text LIMIT 1`,
      [templateName]
    );
    if (!tmplRes.rows.length) {
      throw new Error(`Workflow template not found: ${templateName}`);
    }
    const templateId = tmplRes.rows[0].id;

    console.log('Using template:', templateId);

    const organizationId = randomUUID();
    const clientId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentBoxId = randomUUID();
    const labelId = randomUUID();

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

    const labelPath = `${organizationId}/labels/${labelId}.pdf`;
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
          now(),
          0,
          '{}'::jsonb,
          '{}'::jsonb
       )
       ON CONFLICT DO NOTHING`,
      [labelId, shipmentId, organizationId, clientId, `${tracking}:1`, labelPath]
    );

    // Seed placeholder PDF
    await ensureLabelPdf(labelPath);
    console.log('Seeded label PDF at', labelPath);

    // Configure internal renderer
    const invokeUrl = SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/label-renderer';

    await upsertSettings({
      db: client,
      category: 'label_provider',
      scopeType: 'tenant',
      scopeId: organizationId,
      value: {
        providers: [
          {
            name: 'internal_renderer',
            invoke_url: invokeUrl,
            invoke_secret: providerSecret,
            timeout_ms: 20000,
          },
        ],
      },
      changeReason: 'labels print integration provider (debug)',
    });

    await upsertSettings({
      db: client,
      category: 'label_print_defaults',
      scopeType: 'tenant',
      scopeId: organizationId,
      value: {
        synthesize_from_existing: true,
        prefer_signed_url: true,
      },
      changeReason: 'labels print defaults for tests (debug)',
    });

    const startContext = {
      trigger_source: 'manual',
      trigger_type: 'debug_label_print_workflow',
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

    const startRes = await client.query(
      'SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id',
      [templateId, startContext]
    );
    const workflowRunId = startRes.rows[0].run_id;
    console.log('Started workflow run:', workflowRunId);

    // Drive workflow forward a few times and inspect after each tick
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { rows } = await client.query(
        'SELECT progress_workflow_run($1::uuid) AS result',
        [workflowRunId]
      );
      const tickStatus = rows[0].result?.status ?? rows[0].result?.workflow_status;
      console.log('Progress attempt', attempt, 'tickStatus=', tickStatus);
      const runSnapshot = await client.query(
        'SELECT workflow_status, failure_reason, last_error FROM workflow_runs WHERE id = $1::uuid',
        [workflowRunId]
      );
      console.log('  workflow_status=', runSnapshot.rows[0].workflow_status);
      await client.query('SELECT pg_sleep(0.5)');
    }

    const stepRes = await client.query(
      `SELECT sequence_order, handler_key, step_status, operation_name, operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1
        ORDER BY sequence_order`,
      [workflowRunId]
    );
    console.log('Final steps:');
    for (const row of stepRes.rows) {
      console.log(
        `  seq=${row.sequence_order} handler=${row.handler_key} status=${row.step_status} op=${row.operation_name}`
      );
    }

    const runRes = await client.query(
      'SELECT workflow_status, context, failure_reason, last_error FROM workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    console.log('Run row:', JSON.stringify(runRes.rows[0], null, 2));

    // Optionally, try to complete any async bundle
    const labelPrintContext = runRes.rows[0].context?.label_print || {};
    const asyncRequestId = labelPrintContext.bundle_async?.request_id
      ? Number(labelPrintContext.bundle_async.request_id)
      : null;
    if (asyncRequestId) {
      console.log('Found async bundle request id', asyncRequestId, '- attempting completion');
      await completeBundleAsync(client, workflowRunId, asyncRequestId, { maxAttempts: 4 });
      const refreshed = await client.query(
        'SELECT workflow_status, context FROM workflow_runs WHERE id = $1::uuid',
        [workflowRunId]
      );
      console.log('Refreshed run after async completion:', JSON.stringify(refreshed.rows[0], null, 2));
    }

    // Check storage object exists
    const storageRes = await client.query(
      `SELECT bucket_id, name FROM storage.objects WHERE bucket_id = 'labels' AND name LIKE $1 ORDER BY created_at DESC LIMIT 5`,
      [`${organizationId}/%`]
    );
    console.log('Storage objects for org:', JSON.stringify(storageRes.rows, null, 2));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[debug-label-print-workflow] Failed:', err);
  process.exit(1);
});
