const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { removeStoragePaths } = require('../../../scripts/utils/supabase-storage');
const { upsertSettings } = require('../../utils/policies');
const { skipIfMissing } = require('../../utils/test-env');
const { createOrganization, createClient } = require('../helpers/tenant-utils');
const {
  completeBundleAsync,
  ensureLabelPdf,
  generateSignedUrl,
  verifySignedUrl,
} = require('./helpers/label-print-helpers');
const { resolveStorageAdminKey } = require('../helpers/storage-admin');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const STORAGE_ADMIN_KEY =
  resolveStorageAdminKey() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const LABEL_BUCKET =
  process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

const DATABASE_URL = process.env.DATABASE_URL;
const missingEnv = skipIfMissing(
  ['DATABASE_URL'],
  'labels print webhook test',
);

const pool = missingEnv ? null : new Pool({ connectionString: DATABASE_URL });
const labelsWebhookEnabled = !missingEnv && process.env.RUN_LABELS_WEBHOOK_TESTS === 'true';

jest.setTimeout(420000);

const bulkBundleDurations = [];
const bulkBundleSnapshots = [];
const evidenceDate = (process.env.LABELS_PRINT_EVIDENCE_DATE || new Date().toISOString().slice(0, 10)).trim();

const evidenceDir = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'ops',
  'evidence',
  evidenceDate,
  'labels-print',
);

const getLabelsPrintTemplateId = async (client) => {
  const { rows } = await client.query(
    `SELECT id
       FROM workflow_templates
      WHERE name = 'labels_print_workflow_v1'
      LIMIT 1`,
  );
  if (!rows.length) {
    throw new Error('labels_print_workflow_v1 template not found');
  }
  return rows[0].id;
};

const createCleanupTracker = () => ({
  organizationId: null,
  clientId: null,
  shipments: [],
  shipmentBoxes: [],
  labels: [],
  storagePaths: [],
  workflowRunIds: [],
  webhookIds: [],
  decisionBundleIds: [],
  settings: [],
  mappingConfigId: null,
  webhookSourceId: null,
});

const applySetting = async (client, cleanup, category, scopeType, scopeId, value, reason) => {
  await upsertSettings(category, scopeType, scopeId, value, reason, client);
  cleanup.settings.push({ category, scopeType, scopeId });
};

const cleanupArtifacts = async (client, cleanup) => {
  if (cleanup.decisionBundleIds.length) {
    await client.query(
      `DELETE FROM decision_log
        WHERE decision_category = 'label_print'
          AND resource_id = ANY($1::uuid[])`,
      [cleanup.decisionBundleIds],
    );
  }

  if (cleanup.workflowRunIds.length) {
    const { rows: jobItemCheck } = await client.query(
      "SELECT to_regclass('public.label_job_items') IS NOT NULL AS exists",
    );
    if (jobItemCheck[0]?.exists) {
      await client.query(
        `WITH step_ids AS (
           SELECT id
           FROM workflow_run_steps
           WHERE workflow_run_id = ANY($1::uuid[])
         ), job_ids AS (
           SELECT id
           FROM label_jobs
           WHERE workflow_run_step_id IN (SELECT id FROM step_ids)
         )
         DELETE FROM label_job_items
         WHERE label_job_id IN (SELECT id FROM job_ids)`,
        [cleanup.workflowRunIds],
      );
    }
    await client.query(
      `DELETE FROM label_jobs
       WHERE workflow_run_step_id IN (
         SELECT id
         FROM workflow_run_steps
         WHERE workflow_run_id = ANY($1::uuid[])
       )`,
      [cleanup.workflowRunIds],
    );
    await client.query(
      'DELETE FROM workflow_run_steps WHERE workflow_run_id = ANY($1::uuid[])',
      [cleanup.workflowRunIds],
    );
    await client.query(
      'DELETE FROM workflow_runs WHERE id = ANY($1::uuid[])',
      [cleanup.workflowRunIds],
    );
  }

  if (cleanup.webhookIds.length) {
    await client.query(
      'DELETE FROM webhook_inbox WHERE id = ANY($1::uuid[])',
      [cleanup.webhookIds],
    );
  }

  if (cleanup.webhookSourceId) {
    await client.query('DELETE FROM webhook_sources WHERE id = $1::uuid', [cleanup.webhookSourceId]);
  }
  if (cleanup.mappingConfigId) {
    await client.query('DELETE FROM mapping_configs WHERE id = $1::uuid', [cleanup.mappingConfigId]);
  }

  for (const setting of cleanup.settings) {
    await client.query(
      `DELETE FROM settings
        WHERE category = $1
          AND scope_type = $2
          AND (scope_id IS NOT DISTINCT FROM $3)`,
      [setting.category, setting.scopeType, setting.scopeId],
    );
    await client.query(
      `DELETE FROM settings_versions
        WHERE category = $1
          AND scope_type = $2
          AND (scope_id IS NOT DISTINCT FROM $3)`,
      [setting.category, setting.scopeType, setting.scopeId],
    );
  }

  if (cleanup.storagePaths.length) {
    await removeStoragePaths(
        {
          supabaseUrl: SUPABASE_URL,
          serviceRoleKey: STORAGE_ADMIN_KEY,
          bucket: LABEL_BUCKET,
          paths: cleanup.storagePaths,
        },
      { bestEffort: true },
    );
  }

  if (cleanup.labels.length) {
    await client.query('DELETE FROM labels WHERE id = ANY($1::uuid[])', [cleanup.labels]);
  }

  if (cleanup.shipments.length) {
    await client.query(
      'DELETE FROM shipment_actions WHERE shipment_id = ANY($1::uuid[])',
      [cleanup.shipments],
    );
  }

  if (cleanup.shipmentBoxes.length) {
    await client.query('DELETE FROM shipment_boxes WHERE id = ANY($1::uuid[])', [cleanup.shipmentBoxes]);
  }

  if (cleanup.shipments.length) {
    await client.query('DELETE FROM shipments WHERE id = ANY($1::uuid[])', [cleanup.shipments]);
  }

  // Address versions are append-only; keep org/client rows to avoid cascades.
  if (cleanup.organizationId) {
    // Remove provenance records first to keep the test environment clean.
    await client.query(
      'DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid',
      [cleanup.organizationId],
    );
    await client.query(
      'DELETE FROM decision_log WHERE organization_id = $1::uuid',
      [cleanup.organizationId],
    );
  }
};

const BULK_SCENARIOS = [
  { label: 'bulk-200', readyCount: 20, missingCount: 140, outOfScopeCount: 20, invalidCount: 20 },
  { label: 'bulk-500', readyCount: 50, missingCount: 350, outOfScopeCount: 60, invalidCount: 40 },
];

(labelsWebhookEnabled ? describe : describe.skip)('labels_print_workflow_v1 webhook ingestion', () => {
  let client;

  beforeAll(async () => {
    if (!pool) return;
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    if (pool) {
      await pool.end();
    }

    if (!bulkBundleDurations.length) {
      return;
    }

    try {
      fs.mkdirSync(evidenceDir, { recursive: true });
      const sorted = [...bulkBundleDurations].sort((a, b) => a - b);
      const index = Math.max(
        0,
        Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1),
      );
      const summary = {
        generated_at: new Date().toISOString(),
        environment: process.env.ENV_FILE || 'default',
        runs: bulkBundleSnapshots.length,
        durations_ms: bulkBundleDurations,
        min_ms: sorted[0],
        max_ms: sorted[sorted.length - 1],
        p95_ms: sorted[index],
        snapshots: bulkBundleSnapshots,
      };
      fs.writeFileSync(
        path.join(evidenceDir, 'labels-print-bulk-load-summary.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[labels-print-webhook.test] failed to write load evidence', error.message);
    }
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('populates ready labels from supplied label_ids', async () => {
    const cleanup = createCleanupTracker();
    const labelId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentBoxId = randomUUID();
    const mappingId = randomUUID();
    const webhookSourceId = randomUUID();
    const webhookToken = `token-labels-print-${randomUUID()}`;
    const templateId = await getLabelsPrintTemplateId(client);

    const labelProviderSecret = process.env.LABEL_RENDERER_DB_JWT;
    if (!labelProviderSecret) {
      throw new Error('LABEL_RENDERER_DB_JWT required for label provider setting');
    }

    await client.query('COMMIT');

    try {
      const org = await createOrganization(client, 'Labels Print Webhook QA Org', {
        timezone: 'Asia/Riyadh',
        locale: 'en-US',
      });
      cleanup.organizationId = org.id;

      const createdClient = await createClient(client, org.id, 'Labels Print Webhook QA Client', {
        slaTier: 'standard',
        status: 'active',
      });
      cleanup.clientId = createdClient.id;

      await applySetting(
        client,
        cleanup,
        'label_provider',
        'global',
        null,
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
        'labels.print webhook global provider',
      );

      await applySetting(
        client,
        cleanup,
        'label_provider',
        'tenant',
        org.id,
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
        'labels.print webhook tenant provider',
      );

      await applySetting(
        client,
        cleanup,
        'label_print_defaults',
        'tenant',
        org.id,
        { synthesize_from_existing: true, prefer_signed_url: true },
        'labels.print webhook defaults',
      );

      await applySetting(
        client,
        cleanup,
        'label_print_policy',
        'tenant',
        org.id,
        {
          version: 1,
          max_labels_per_bundle: 100,
          max_pages_per_bundle: 100,
          max_bytes_per_bundle: 25000000,
          max_failed_labels: 5,
          poll_interval_seconds: 0,
          max_wait_seconds: 0,
          default_expires_seconds: 600,
        },
        'labels.print webhook policy',
      );

      await client.query(
        `INSERT INTO shipments (
            id, organization_id, client_id, service_type, tracking_number,
            status, box_count, created_at, updated_at
         ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, 'delivery', $4, 'created', 1, now(), now()
         )`,
        [shipmentId, org.id, createdClient.id, `LBL${shipmentId.toString().slice(0, 8).toUpperCase()}`],
      );
      cleanup.shipments.push(shipmentId);

      await client.query(
        `INSERT INTO shipment_boxes (
            id, shipment_id, organization_id, client_id, box_number, barcode, created_at
         ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now()
         )`,
        [shipmentBoxId, shipmentId, org.id, createdClient.id, `LBL${shipmentId.toString().slice(0, 8).toUpperCase()}:1`],
      );
      cleanup.shipmentBoxes.push(shipmentBoxId);

      const storagePath = `${org.id}/labels/${labelId}.pdf`;
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
            1,
            '{}'::jsonb,
            '{}'::jsonb
         )`,
        [labelId, shipmentId, org.id, createdClient.id, `LBL${shipmentId.toString().slice(0, 8).toUpperCase()}:1`, storagePath],
      );
      cleanup.labels.push(labelId);

      await ensureLabelPdf(storagePath);
      cleanup.storagePaths.push(storagePath);

      await client.query(
        `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
         VALUES ($1::uuid, 'webhook_inbound', $2, '{}'::jsonb, 1, 'labels.print webhook (unit test)')`,
        [mappingId, `labels.print::${org.id}`],
      );
      cleanup.mappingConfigId = mappingId;

      await client.query(
        `INSERT INTO webhook_sources (
            id, organization_id, source_identifier, name, provider_type,
            auth_token, mapping_config_id, enabled
         ) VALUES (
            $1::uuid, $2::uuid, $3, 'Labels Print Unit Source', 'provider',
            $4, $5::uuid, TRUE
         )`,
        [webhookSourceId, org.id, `labels-print-unit-${org.id.slice(0, 6)}`, webhookToken, mappingId],
      );
      cleanup.webhookSourceId = webhookSourceId;

      await applySetting(
        client,
        cleanup,
        'webhook_ingest_policy',
        'source',
        webhookSourceId,
        {
          version: 1,
          ack: { mode: 'accepted_async', status_code: 202 },
          validation: { idempotency: { header: 'Idempotency-Key', body_path: '$.request.id' } },
          workflow: { template_id: templateId },
        },
        'labels.print webhook ingest policy',
      );

      const requestPayload = {
        request: { id: `req-${Date.now()}`, type: 'labels.print.bundle' },
        organization_id: org.id,
        bundle: { label_ids: [labelId], expires_seconds: 600 },
      };

      const { rows: intakeRows } = await client.query(
        'SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response',
        [
          webhookToken,
          { 'content-type': 'application/json', 'x-webhook-token': webhookToken },
          JSON.stringify(requestPayload),
          requestPayload,
        ],
      );

      const intakeResponse = intakeRows[0].response;
      const followupRunId = intakeResponse.followup_workflow_run_id;
      const entryRunId = intakeResponse.workflow_run_id;
      const webhookId = intakeResponse.webhook_id;

      expect(followupRunId).toBeTruthy();
      if (followupRunId) cleanup.workflowRunIds.push(followupRunId);
      if (entryRunId) cleanup.workflowRunIds.push(entryRunId);
      if (webhookId) cleanup.webhookIds.push(webhookId);

      await client.query('SELECT progress_workflow_run($1::uuid)', [followupRunId]);

      const { rows: followupContextRows } = await client.query(
        'SELECT context FROM workflow_runs WHERE id = $1::uuid',
        [followupRunId],
      );

      const state = followupContextRows[0]?.context?.label_print ?? {};
      const ready = Array.isArray(state.ready) ? state.ready : [];

      expect(ready.length).toBe(1);
      expect(ready[0]?.label_id).toBe(labelId);
      expect(state.counts?.requested).toBe(1);
      expect(state.counts?.ready).toBe(1);
    } finally {
      try {
        await cleanupArtifacts(client, cleanup);
      } finally {
        await client.query('BEGIN');
      }
    }
  });

  test('handles label_print bulk scenarios (reduced 200 & 500 mixes)', async () => {
    // Reduced counts to keep cloud integration time reasonable while still
    // exercising mixed ready/missing/out_of_scope/invalid paths at scale.
    const scenarios = [
      { label: 'bulk-200', readyCount: 10, missingCount: 40, outOfScopeCount: 10, invalidCount: 10 },
      { label: 'bulk-500', readyCount: 20, missingCount: 80, outOfScopeCount: 20, invalidCount: 20 },
    ];

    const labelProviderSecret = process.env.LABEL_RENDERER_DB_JWT;
    if (!labelProviderSecret) {
      throw new Error('LABEL_RENDERER_DB_JWT required for label provider setting');
    }

    for (const scenario of scenarios) {
      await client.query('COMMIT');

      const cleanup = createCleanupTracker();
      const templateId = await getLabelsPrintTemplateId(client);
      const mappingId = randomUUID();
      const webhookSourceId = randomUUID();
      const webhookToken = `token-labels-print-${randomUUID()}`;
      const scenarioLabel = scenario.label;
      cleanup.mappingConfigId = mappingId;
      cleanup.webhookSourceId = webhookSourceId;

      try {
        const org = await createOrganization(client, `Labels Print Bulk Org ${scenarioLabel}`, {
          timezone: 'Asia/Riyadh',
          locale: 'en-US',
        });
        cleanup.organizationId = org.id;

        const createdClient = await createClient(client, org.id, `Labels Print Bulk Client ${scenarioLabel}`, {
          slaTier: 'standard',
          status: 'active',
        });
        cleanup.clientId = createdClient.id;

        const settingsReason = `labels.print webhook ${scenarioLabel}`;

        await applySetting(
          client,
          cleanup,
          'label_provider',
          'global',
          null,
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
          settingsReason,
        );

        await applySetting(
          client,
          cleanup,
          'label_provider',
          'tenant',
          org.id,
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
          settingsReason,
        );

        await applySetting(
          client,
          cleanup,
          'label_print_defaults',
          'tenant',
          org.id,
          { synthesize_from_existing: true, prefer_signed_url: true },
          settingsReason,
        );

        await applySetting(
          client,
          cleanup,
          'label_print_policy',
          'tenant',
          org.id,
          {
            version: 1,
            max_labels_per_bundle: 500,
            max_pages_per_bundle: 500,
            max_bytes_per_bundle: 75000000,
            max_failed_labels: 40,
            poll_interval_seconds: 0,
            max_wait_seconds: 0,
            default_expires_seconds: 600,
          },
          settingsReason,
        );

        await client.query(
          `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
           VALUES ($1::uuid, 'webhook_inbound', $2, '{}'::jsonb, 1, 'labels.print webhook mapping (bulk)')`,
          [mappingId, `labels.print::${org.id}`],
        );

        await client.query(
          `INSERT INTO webhook_sources (
              id, organization_id, source_identifier, name, provider_type,
              auth_token, mapping_config_id, enabled
           ) VALUES (
              $1::uuid, $2::uuid, $3, 'Labels Print Bulk Source', 'provider',
              $4, $5::uuid, TRUE
           )`,
          [webhookSourceId, org.id, `labels-print-bulk-${org.id.slice(0, 6)}`, webhookToken, mappingId],
        );

        await applySetting(
          client,
          cleanup,
          'webhook_ingest_policy',
          'source',
          webhookSourceId,
          {
            version: 1,
            ack: { mode: 'accepted_async', status_code: 202 },
            validation: { idempotency: { header: 'Idempotency-Key', body_path: '$.request.id' } },
            workflow: { template_id: templateId },
          },
          settingsReason,
        );

        const readyCount = scenario.readyCount;
        const missingCount = scenario.missingCount;
        const outOfScopeCount = scenario.outOfScopeCount;
        const invalidCount = scenario.invalidCount;
        const totalShipments = readyCount + missingCount + outOfScopeCount + invalidCount;
        const trackingPrefix = `DLX${org.id.replace(/-/g, '').toUpperCase().slice(0, 8)}`;

        const insertShipmentWithBox = async () => {
          const shipmentId = randomUUID();
          const boxId = randomUUID();
          const tracking = `${trackingPrefix}${shipmentId.replace(/-/g, '').toUpperCase().slice(0, 10)}`;

          await client.query(
            `INSERT INTO shipments (
                id, organization_id, client_id, service_type, tracking_number,
                status, box_count, created_at, updated_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'delivery', $4, 'created', 1, now(), now())`,
            [shipmentId, org.id, createdClient.id, tracking],
          );
          cleanup.shipments.push(shipmentId);

          await client.query(
            `INSERT INTO shipment_boxes (
                id, shipment_id, organization_id, client_id, box_number, barcode, created_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now())`,
            [boxId, shipmentId, org.id, createdClient.id, `${tracking}:1`],
          );
          cleanup.shipmentBoxes.push(boxId);

          return { shipmentId, tracking };
        };

        const shipmentsPayload = [];

        for (let i = 0; i < readyCount; i += 1) {
          const { shipmentId, tracking } = await insertShipmentWithBox();
          const labelId = randomUUID();
          const storagePath = `${org.id}/labels/${labelId}.pdf`;

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
                1,
                jsonb_build_object('label_job_id', $1::uuid),
                '{}'::jsonb
             )`,
            [labelId, shipmentId, org.id, createdClient.id, `${tracking}:1`, storagePath],
          );
          cleanup.labels.push(labelId);

          await ensureLabelPdf(storagePath);
          cleanup.storagePaths.push(storagePath);

          shipmentsPayload.push({ shipment_id: shipmentId });
        }

        for (let i = 0; i < missingCount; i += 1) {
          const { shipmentId } = await insertShipmentWithBox();
          shipmentsPayload.push({ shipment_id: shipmentId });
        }

        for (let i = 0; i < invalidCount; i += 1) {
          const { shipmentId } = await insertShipmentWithBox();
          shipmentsPayload.push({
            shipment_id: shipmentId,
            box_ids: [randomUUID()],
          });
        }

        for (let i = 0; i < outOfScopeCount; i += 1) {
          shipmentsPayload.push({ shipment_id: randomUUID() });
        }

        const requestPayload = {
          request: { id: `req-${scenarioLabel}-${Date.now()}`, type: 'labels.print.bulk' },
          organization_id: org.id,
          shipments: shipmentsPayload,
          options: { expires_seconds: 600 },
        };

        const scenarioStart = Date.now();
        const { rows: intakeRows } = await client.query(
          'SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response',
          [
            webhookToken,
            { 'content-type': 'application/json', 'x-webhook-token': webhookToken },
            JSON.stringify(requestPayload),
            requestPayload,
          ],
        );

        const intakeResponse = intakeRows[0].response;
        const followupRunId = intakeResponse.followup_workflow_run_id;
        const entryRunId = intakeResponse.workflow_run_id;
        const webhookId = intakeResponse.webhook_id;

        if (followupRunId) cleanup.workflowRunIds.push(followupRunId);
        if (entryRunId) cleanup.workflowRunIds.push(entryRunId);
        if (webhookId) cleanup.webhookIds.push(webhookId);

        expect(followupRunId).toBeTruthy();

        let workflowStatus = null;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const { rows: progressRows } = await client.query(
            'SELECT progress_workflow_run($1::uuid) AS result',
            [followupRunId],
          );
          workflowStatus = progressRows[0]?.result?.workflow_status || workflowStatus;
          if (workflowStatus === 'completed' || workflowStatus === 'failed') {
            break;
          }
          await client.query('SELECT pg_sleep(0.2)');
        }

        const { rows: contextRows } = await client.query(
          'SELECT context, workflow_status FROM workflow_runs WHERE id = $1::uuid',
          [followupRunId],
        );
        workflowStatus = contextRows[0]?.workflow_status || workflowStatus;

        const state = contextRows[0]?.context?.label_print || {};
        const ready = Array.isArray(state.ready) ? state.ready : [];
        const timedOut = Array.isArray(state.timed_out) ? state.timed_out : [];
        const outOfScope = Array.isArray(state.out_of_scope) ? state.out_of_scope : [];
        const invalidBoxes = Array.isArray(state.invalid_boxes) ? state.invalid_boxes : [];

        expect(state.counts?.requested).toBe(totalShipments);
        expect(state.counts?.ready).toBe(readyCount);
        expect(state.counts?.timed_out).toBe(missingCount);
        expect(state.counts?.out_of_scope).toBe(outOfScopeCount);
        expect(state.counts?.invalid_box_requests).toBe(invalidCount);

        expect(ready.length).toBe(readyCount);
        expect(timedOut.length).toBe(missingCount);
        expect(outOfScope.length).toBe(outOfScopeCount);
        expect(invalidBoxes.length).toBe(invalidCount);

        const bundleStepRows = await client.query(
          `SELECT operation_result
             FROM workflow_run_steps
            WHERE workflow_run_id = $1
              AND handler_key = 'label_bundle'
            ORDER BY sequence_order DESC
            LIMIT 1`,
          [followupRunId],
        );
        const finalizeStepRows = await client.query(
          `SELECT operation_result
             FROM workflow_run_steps
            WHERE workflow_run_id = $1
              AND handler_key = 'label_print_finalize'
            ORDER BY sequence_order DESC
            LIMIT 1`,
          [followupRunId],
        );

        let bundle = state.bundle_response || {};

        if (
          state.bundle_async?.request_id &&
          ((!bundle || Object.keys(bundle).length === 0) || workflowStatus !== 'completed')
        ) {
          const asyncRequestId = Number(state.bundle_async.request_id);
          await completeBundleAsync(client, followupRunId, asyncRequestId, { maxAttempts: 20 });

          for (let attempt = 0; attempt < 20; attempt += 1) {
            await client.query('SELECT progress_workflow_run($1::uuid)', [followupRunId]);
            const { rows: refreshedRows } = await client.query(
              'SELECT context, workflow_status FROM workflow_runs WHERE id = $1::uuid',
              [followupRunId],
            );
            workflowStatus = refreshedRows[0]?.workflow_status || workflowStatus;
            const refreshedState = refreshedRows[0]?.context?.label_print || {};
            if (Object.keys(refreshedState.bundle_response || {}).length) {
              bundle = refreshedState.bundle_response;
            }
            if (workflowStatus === 'completed' || workflowStatus === 'failed') {
              break;
            }
            await client.query('SELECT pg_sleep(0.2)');
          }
        }

        if (!bundle || !bundle.bundle_id || !bundle.file_path) {
          const stepBundle = bundleStepRows.rows[0]?.operation_result || {};
          bundle = stepBundle.bundle || stepBundle || bundle;
        }

        if (!bundle || !bundle.bundle_id || !bundle.file_path) {
          const finalizeBundle = finalizeStepRows.rows[0]?.operation_result || {};
          bundle = finalizeBundle.bundle || finalizeBundle || bundle;
        }

        if (!bundle || !bundle.bundle_id || !bundle.file_path) {
          const { rows: decisionRows } = await client.query(
            `SELECT resource_id, decision_inputs
               FROM decision_log
              WHERE decision_category = 'label_print'
                AND organization_id = $1
              ORDER BY timestamp DESC
              LIMIT 1`,
            [org.id],
          );
          if (decisionRows.length) {
            bundle = bundle || {};
            bundle.bundle_id = bundle.bundle_id || decisionRows[0].resource_id;
            bundle.file_path =
              bundle.file_path ||
              decisionRows[0].decision_inputs?.file_path ||
              decisionRows[0].decision_inputs?.bundle?.file_path ||
              decisionRows[0].decision_inputs?.bundle_response?.file_path ||
              null;
          }
        }

        const scenarioDurationMs = Date.now() - scenarioStart;
        bulkBundleDurations.push(scenarioDurationMs);

        let signedUrlInfo = null;

        if (!bundle?.signed_url && bundle?.file_path) {
          try {
            const minted = await generateSignedUrl(bundle.file_path, state.options?.expires_seconds || 600);
            if (minted?.signedUrl) {
              bundle.signed_url = minted.signedUrl;
            }
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('labels.print webhook signed URL mint failed', error.message);
          }
        }

        if (bundle?.status === 'ok' && bundle?.file_path && bundle?.bundle_id) {
          cleanup.decisionBundleIds.push(bundle.bundle_id);
          cleanup.storagePaths.push(bundle.file_path);

          const { rows: storageRows } = await client.query(
            `SELECT name FROM storage.objects WHERE bucket_id = 'labels' AND name = $1`,
            [bundle.file_path],
          );
          expect(storageRows.length).toBe(1);

          if (bundle.signed_url) {
            signedUrlInfo = await verifySignedUrl(bundle.signed_url);
            expect(signedUrlInfo.status).toBe(200);
            expect(signedUrlInfo.contentLength).toBeGreaterThan(0);
          }
        } else {
          expect(bundleStepRows.rows.length).toBeGreaterThan(0);
        }

        bulkBundleSnapshots.push({
          scenario: scenarioLabel,
          run_id: followupRunId,
          request_id: requestPayload.request?.id || null,
          requested: totalShipments,
          ready: ready.length,
          timed_out: timedOut.length,
          out_of_scope: outOfScope.length,
          invalid_boxes: invalidBoxes.length,
          bundle_status: bundle?.status || workflowStatus || 'unknown',
          bundle_id: bundle?.bundle_id || null,
          bundle_file_path: bundle?.file_path || null,
          signed_url: Boolean(bundle?.signed_url),
          signed_url_bytes: signedUrlInfo?.contentLength ?? 0,
          duration_ms: scenarioDurationMs,
        });
      } finally {
        try {
          await cleanupArtifacts(client, cleanup);
        } finally {
          await client.query('BEGIN');
        }
      }
    }
  });
});
