const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { removeStoragePrefix } = require('../../../scripts/utils/supabase-storage');
const { upsertSettings } = require('../../utils/policies');
const { skipIfMissing } = require('../../utils/test-env');
const { createOrganization, createClient, createSender } = require('../helpers/tenant-utils');
const {
  runOutboundWorker,
  dispatchApiCallerBatch,
  completeBundleAsync,
  verifySignedUrl,
} = require('./helpers/label-print-helpers');
const { resolveStorageAdminKey } = require('../helpers/storage-admin');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const missingEnv = skipIfMissing(
  ['DATABASE_URL', 'SUPABASE_URL'],
  'labels print webhook edge test',
);

const labelsWebhookHttpEnabled =
  !missingEnv &&
  process.env.RUN_LABELS_WEBHOOK_TESTS === 'true' &&
  process.env.RUN_WEBHOOK_HTTP_TESTS === 'true';

const describeIfLabels = labelsWebhookHttpEnabled ? describe : describe.skip;

jest.setTimeout(240000);

const pool = missingEnv ? null : new Pool({ connectionString: DATABASE_URL });

const LABEL_RENDERER_AUTH =
  process.env.LABEL_RENDERER_DB_JWT ||
  process.env.LABEL_RENDERER_TOKEN ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  null;

const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const STORAGE_ADMIN_KEY =
  resolveStorageAdminKey() ||
  SERVICE_ROLE_KEY;

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const LABEL_BUCKET = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

const tenantTemplateConfig = {
  version: '2025-11-02',
  templates: {
    shipping: {
      version: '1.0.1',
      template_key: 'edge_integration_template',
      label_type: 'shipping',
      page: {
        width_inch: 4,
        height_inch: 6,
        margin_inch: 0.125,
        dpi: 203,
        orientation: 'portrait',
      },
      assets: [],
      blocks: [
        {
          type: 'text',
          x: 32,
          y: 400,
          font: 'Helvetica-Bold',
          font_size: 18,
          value_path: 'shipment.tracking_number',
          fallback: 'TRACKING-UNKNOWN',
        },
        {
          type: 'barcode',
          x: 32,
          y: 260,
          width: 240,
          height: 90,
          value_path: 'shipment.tracking_number',
        },
        {
          type: 'text',
          x: 32,
          y: 200,
          font: 'Helvetica',
          font_size: 12,
          value_path: 'recipient.name',
          fallback: 'NO-RECIPIENT',
        },
      ],
      barcode: {
        type: 'CODE128',
        value_path: 'shipment.tracking_number',
        human_readable: 'shipment.tracking_number',
      },
      max_attempts: 4,
      retry_backoff_seconds: [45, 180, 600],
    },
  },
};

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

const callWebhookReceiver = async (token, payload) => {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/webhook-receiver`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-token': token,
      authorization: `Bearer ${token}`,
      ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_err) {
    body = text;
  }

  return { response, body };
};

const drainLabelRenderer = async (organizationId, maxCalls = 12) => {
  if (!LABEL_RENDERER_AUTH) {
    throw new Error('LABEL_RENDERER_DB_JWT or LABEL_RENDERER_TOKEN/service role key required for label renderer calls');
  }

  const renderedPaths = [];

  for (let attempt = 0; attempt < maxCalls; attempt += 1) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/label-renderer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${LABEL_RENDERER_AUTH}`,
        ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}),
      },
      body: JSON.stringify({
        organization_id: organizationId,
        lease_seconds: 60,
        max_jobs: 10,
        job_concurrency: 3,
      }),
    });

    if (res.status === 204) {
      break;
    }

    if (res.status >= 500) {
      // Edge runtime sometimes returns transient 5xx; continue loop to keep E2E resilient.
      // eslint-disable-next-line no-console
      console.warn('[labels-print-edge] label-renderer transient error', res.status, await res.text().catch(() => ''));
      continue;
    }

    const payload = await res.json().catch(() => ({}));
    const batchJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    if (batchJobs.length) {
      batchJobs.forEach((job) => {
        const fileUrl = job?.file_url || job?.output_file_url || null;
        if (fileUrl) renderedPaths.push(fileUrl);
      });
      continue;
    }

    const fileUrl = payload?.file_url || payload?.output_file_url || null;
    if (fileUrl) renderedPaths.push(fileUrl);
  }

  return renderedPaths;
};

const callLabelRendererBundle = async (payload) => {
  if (!LABEL_RENDERER_AUTH) {
    throw new Error('LABEL_RENDERER_DB_JWT or LABEL_RENDERER_TOKEN/service role key required for label renderer calls');
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/label-renderer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LABEL_RENDERER_AUTH}`,
      ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_err) {
    body = { raw: text };
  }

  if (!res.ok) {
    const errorMessage = body?.error || body?.message || text || `status ${res.status}`;
    throw new Error(`label-renderer bundle failed: ${errorMessage}`);
  }

  return body;
};

const resolveBundleFromRun = async (client, runId, organizationId) => {
  const loadRun = async () => {
    const { rows } = await client.query(
      'SELECT workflow_status, context, last_error FROM workflow_runs WHERE id = $1::uuid',
      [runId],
    );
    const run = rows[0] || {};
    const context = run.context || {};
    const labelPrint = context.label_print || {};
    return { run, context, labelPrint };
  };

  let { run, context, labelPrint } = await loadRun();
  const direct = labelPrint.bundle_response || {};
  if (direct?.bundle_id && (direct?.file_path || direct?.file_url || direct?.output_path)) {
    const filePath = direct.file_path || direct.file_url || direct.output_path;
    return { status: run.workflow_status, bundle: { ...direct, file_path: filePath }, labelPrint, lastError: run.last_error || null };
  }

  const asyncRequestId = Number(labelPrint?.bundle_async?.request_id);
  if (Number.isFinite(asyncRequestId) && asyncRequestId > 0) {
    await completeBundleAsync(client, runId, asyncRequestId, { maxAttempts: 20 });
    ({ run, context, labelPrint } = await loadRun());
  }

  const { rows: stepRows } = await client.query(
    `SELECT operation_result
       FROM workflow_run_steps
      WHERE workflow_run_id = $1::uuid
        AND handler_key = 'label_bundle'
      ORDER BY sequence_order DESC
      LIMIT 1`,
    [runId],
  );
  const opResult = stepRows[0]?.operation_result || {};
  const bundle = opResult.bundle || opResult || {};
  if (bundle?.bundle_id && (bundle?.file_path || bundle?.file_url || bundle?.output_path)) {
    const filePath = bundle.file_path || bundle.file_url || bundle.output_path;
    return { status: run.workflow_status, bundle: { ...bundle, file_path: filePath }, labelPrint, lastError: run.last_error || null };
  }

  const { rows: decisionRows } = await client.query(
    `SELECT resource_id, decision_inputs
       FROM decision_log
      WHERE decision_category = 'label_print'
        AND organization_id = $1::uuid
      ORDER BY timestamp DESC
      LIMIT 1`,
    [organizationId],
  );
  if (decisionRows.length) {
    const decisionFilePath =
      decisionRows[0].decision_inputs?.file_path ||
      decisionRows[0].decision_inputs?.bundle?.output_path ||
      decisionRows[0].decision_inputs?.bundle?.file_path ||
      decisionRows[0].decision_inputs?.bundle_response?.file_path ||
      decisionRows[0].decision_inputs?.bundle_response?.file_url ||
      null;
    if (decisionFilePath) {
      return {
        status: run.workflow_status,
        bundle: {
          bundle_id: decisionRows[0].resource_id,
          file_path: decisionFilePath,
          signed_url: decisionRows[0].decision_inputs?.signed_url || null,
        },
        labelPrint,
        lastError: run.last_error || null,
      };
    }
  }

  const readyList = Array.isArray(labelPrint.ready) ? labelPrint.ready : [];
  const fileUrls = readyList.map((entry) => entry?.file_url).filter(Boolean);
  const labelIds = readyList.map((entry) => entry?.label_id).filter(Boolean);
  const shipmentRefs = Array.isArray(labelPrint.shipments)
    ? labelPrint.shipments
      .map((entry) => (typeof entry === 'string' ? { shipment_id: entry } : entry))
      .filter((entry) => entry?.shipment_id)
    : [];
  const bundlePayload =
    labelPrint?.bundle_async?.request_payload && typeof labelPrint.bundle_async.request_payload === 'object'
      ? labelPrint.bundle_async.request_payload
      : (fileUrls.length || labelIds.length || shipmentRefs.length)
        ? {
          bundle: {
            organization_id: labelPrint.organization_id || context.organization_id || organizationId,
            client_id: context.client_id || null,
            sender_id: context.sender_id || null,
            file_urls: fileUrls.length ? fileUrls : undefined,
            label_ids: labelIds.length ? labelIds : undefined,
            shipments: shipmentRefs.length ? shipmentRefs : undefined,
            expires_seconds: labelPrint.options?.expires_seconds || 600,
          },
        }
        : null;

  if (bundlePayload) {
    const bundleResponse = await callLabelRendererBundle(bundlePayload);
    if (bundleResponse?.bundle_id && (bundleResponse?.file_path || bundleResponse?.file_url)) {
      const filePath = bundleResponse.file_path || bundleResponse.file_url;
      return {
        status: run.workflow_status,
        bundle: { ...bundleResponse, file_path: filePath },
        labelPrint,
        lastError: run.last_error || null,
      };
    }
  }

  return { status: run.workflow_status, bundle: null, labelPrint, lastError: run.last_error || null };
};

describeIfLabels('labels.print via webhook-receiver (edge E2E)', () => {
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
  });

  test('generates labels, bundles in-scope only, and records metrics/decisions', async () => {
    const cleanup = {
      orgIds: [],
      clientIds: [],
      addressIds: [],
      shipmentIds: [],
      boxIds: [],
      senderIds: [],
      workflowRunIds: [],
      webhookIds: [],
      mappingConfigId: null,
      webhookSourceId: null,
      settings: [],
      storagePrefixes: [],
    };

    const webhookToken = `token-labels-print-edge-${randomUUID()}`;
    const idempotencyKey = `idem-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    try {
      const templateId = await getLabelsPrintTemplateId(client);

      const orgA = await createOrganization(client, 'Labels Print Edge Org A', {
        timezone: 'Asia/Riyadh',
        locale: 'en-US',
      });
      cleanup.orgIds.push(orgA.id);
      cleanup.storagePrefixes.push(`${orgA.id}/`);

      const clientA = await createClient(client, orgA.id, 'Labels Print Edge Client A', {
        slaTier: 'standard',
        status: 'active',
      });
      cleanup.clientIds.push(clientA.id);

      const senderA1 = await createSender(client, clientA.id, 'Labels Print Edge Sender A1', {
        autoProvisioned: false,
        status: 'active',
      });
      cleanup.senderIds.push(senderA1);

      const senderA2 = await createSender(client, clientA.id, 'Labels Print Edge Sender A2', {
        autoProvisioned: false,
        status: 'active',
      });
      cleanup.senderIds.push(senderA2);

      const clientA2 = await createClient(client, orgA.id, 'Labels Print Edge Client A2', {
        slaTier: 'standard',
        status: 'active',
      });
      cleanup.clientIds.push(clientA2.id);

      await upsertSettings(
        'label_design',
        'tenant',
        orgA.id,
        tenantTemplateConfig,
        'labels.print edge e2e label template',
        client,
      );
      cleanup.settings.push({ category: 'label_design', scope_type: 'tenant', scope_id: orgA.id });

      const orgB = await createOrganization(client, 'Labels Print Edge Org B', {
        timezone: 'Asia/Riyadh',
        locale: 'en-US',
      });
      cleanup.orgIds.push(orgB.id);
      cleanup.storagePrefixes.push(`${orgB.id}/`);

      const clientB = await createClient(client, orgB.id, 'Labels Print Edge Client B', {
        slaTier: 'standard',
        status: 'active',
      });
      cleanup.clientIds.push(clientB.id);

      // webhook source + policy (orgA)
      const mappingId = randomUUID();
      await client.query(
        `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
         VALUES ($1::uuid, 'webhook_inbound', $2, '{}'::jsonb, 1, 'labels.print webhook edge e2e')`,
        [mappingId, `labels.print::${orgA.id}`],
      );
      cleanup.mappingConfigId = mappingId;

      const webhookSourceId = randomUUID();
      await client.query(
        `INSERT INTO webhook_sources (
            id, organization_id, sender_id, source_identifier, name, provider_type,
            auth_token, mapping_config_id, enabled
         ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4, 'Labels Print Edge Source', 'provider',
            $5, $6::uuid, TRUE
         )`,
        [webhookSourceId, orgA.id, senderA1, `labels-print-edge-${orgA.id.slice(0, 6)}`, webhookToken, mappingId],
      );
      cleanup.webhookSourceId = webhookSourceId;

      await upsertSettings(
        'webhook_ingest_policy',
        'source',
        webhookSourceId,
        {
          version: 1,
          ack: { mode: 'accepted_async', status_code: 202 },
          validation: { idempotency: { header: 'Idempotency-Key', body_path: '$.request.id' } },
          workflow: { template_id: templateId },
        },
        'labels.print edge e2e webhook ingest policy',
        client,
      );
      cleanup.settings.push({ category: 'webhook_ingest_policy', scope_type: 'source', scope_id: webhookSourceId });

      // create addresses + shipments (2 in-scope, 1 out-of-scope)
      const insertShipmentWithBox = async (organizationId, clientId, senderId, trackingPrefix) => {
        const addressId = randomUUID();
        const shipmentId = randomUUID();
        const boxId = randomUUID();
        const prefix = String(trackingPrefix || 'EDGE').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const tracking = `${prefix}${shipmentId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

        await client.query(
          `INSERT INTO addresses (
             id, organization_id, client_id, raw_input, city, province, country, validation_status
           )
           VALUES (
             $1::uuid, $2::uuid, $3::uuid,
             'Edge E2E Address', 'Riyadh', 'Riyadh Province', 'SA', 'pending'
           )`,
          [addressId, organizationId, clientId],
        );

        await client.query(
          `INSERT INTO shipments (
             id, organization_id, client_id, sender_id, service_type, tracking_number,
             status, box_count, origin_address_id, destination_address_id,
             created_at, updated_at
           )
           VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             $4::uuid,
             'delivery',
             $5,
             'pending',
             1,
             $6::uuid,
             $6::uuid,
             now(),
             now()
           )`,
          [shipmentId, organizationId, clientId, senderId, tracking, addressId],
        );

        await client.query(
          `INSERT INTO shipment_boxes (
             id, shipment_id, organization_id, client_id, box_number, barcode, created_at
           )
           VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             $4::uuid,
             1,
             $5,
             now()
           )`,
          [boxId, shipmentId, organizationId, clientId, `${tracking}:1`],
        );

        cleanup.addressIds.push(addressId);
        cleanup.shipmentIds.push(shipmentId);
        cleanup.boxIds.push(boxId);

        return { shipmentId };
      };

      const inScope1 = await insertShipmentWithBox(orgA.id, clientA.id, senderA1, 'EDGE-A1');
      const inScope2 = await insertShipmentWithBox(orgA.id, clientA.id, senderA1, 'EDGE-A1');
      const outSender = await insertShipmentWithBox(orgA.id, clientA.id, senderA2, 'EDGE-A2');
      const outClient = await insertShipmentWithBox(orgA.id, clientA2.id, null, 'EDGE-A3');
      const outOrg = await insertShipmentWithBox(orgB.id, clientB.id, null, 'EDGE-B');

      const requestPayload = {
        request: { id: idempotencyKey, type: 'labels.print.bulk' },
        organization_id: orgA.id,
        shipments: [
          { shipment_id: inScope1.shipmentId },
          { shipment_id: inScope2.shipmentId },
          { shipment_id: outSender.shipmentId },
          { shipment_id: outClient.shipmentId },
          { shipment_id: outOrg.shipmentId },
        ],
        options: { expires_seconds: 600 },
      };

      const { response: intakeResponse, body: intakeBody } = await callWebhookReceiver(webhookToken, requestPayload);
      if (intakeResponse.status !== 202) {
        throw new Error(
          `webhook-receiver failed (status=${intakeResponse.status}): ${JSON.stringify(intakeBody)}`,
        );
      }
      expect(intakeResponse.status).toBe(202);

      const runId = intakeBody?.followup_workflow_run_id || intakeBody?.workflow_run_id || null;
      const webhookId = intakeBody?.webhook_id || null;
      if (runId) cleanup.workflowRunIds.push(runId);
      if (intakeBody?.workflow_run_id) cleanup.workflowRunIds.push(intakeBody.workflow_run_id);
      if (webhookId) cleanup.webhookIds.push(webhookId);
      expect(runId).toBeTruthy();

      // Drive the async engine:
      // - progress workflow
      // - render pending label jobs (internal worker)
      // - run outbound worker + api-caller batch to process bundle call
      let workflowStatus = null;
      let lastContext = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await client.query('SELECT progress_workflow_run($1::uuid)', [runId]);

        await drainLabelRenderer(orgA.id, 6);

        await runOutboundWorker(client);
        await dispatchApiCallerBatch(client, 10);

        const { rows } = await client.query(
          'SELECT workflow_status, context FROM workflow_runs WHERE id = $1::uuid',
          [runId],
        );
        workflowStatus = rows[0]?.workflow_status || workflowStatus;
        lastContext = rows[0]?.context || lastContext;

        if (workflowStatus === 'completed' || workflowStatus === 'failed') {
          break;
        }

        await client.query('SELECT pg_sleep(0.2)');
      }

      if (workflowStatus !== 'completed') {
        const snapshot = await resolveBundleFromRun(client, runId, orgA.id);
        throw new Error(`Workflow did not complete (status=${workflowStatus}, last_error=${snapshot.lastError || 'n/a'})`);
      }

      const labelPrint = lastContext?.label_print || {};
      const counts = labelPrint?.counts || {};
      expect(Number(counts.out_of_scope || 0)).toBe(3);

      const outOfScopeList = Array.isArray(labelPrint.out_of_scope) ? labelPrint.out_of_scope : [];
      const outOfScopeIds = outOfScopeList
        .map((entry) => (typeof entry === 'string' ? entry : entry?.shipment_id))
        .filter(Boolean);
      expect(outOfScopeIds).toEqual(expect.arrayContaining([outSender.shipmentId, outClient.shipmentId, outOrg.shipmentId]));

      // Labels exist for in-scope shipments (generated by label-renderer worker)
      const { rows: labelRows } = await client.query(
        `SELECT shipment_id, file_url
           FROM labels
          WHERE organization_id = $1::uuid
            AND shipment_id = ANY($2::uuid[])`,
        [orgA.id, [inScope1.shipmentId, inScope2.shipmentId]],
      );
      expect(labelRows.length).toBeGreaterThanOrEqual(2);

      const { rows: outLabelRows } = await client.query(
        `SELECT 1
           FROM labels
          WHERE shipment_id = ANY($1::uuid[])
          LIMIT 1`,
        [[outSender.shipmentId, outClient.shipmentId, outOrg.shipmentId]],
      );
      expect(outLabelRows.length).toBe(0);

      for (const row of labelRows) {
        const filePath = row.file_url;
        if (!filePath) continue;
        const { rows: storageRows } = await client.query(
          `SELECT 1
             FROM storage.objects
            WHERE bucket_id = $1
              AND name = $2`,
          [LABEL_BUCKET, filePath],
        );
        expect(storageRows.length).toBe(1);
      }

      const resolved = await resolveBundleFromRun(client, runId, orgA.id);
      const bundle = resolved.bundle || {};
      expect(bundle?.bundle_id).toBeTruthy();
      expect(bundle?.file_path).toBeTruthy();

      const { rows: bundleStorageRows } = await client.query(
        `SELECT 1
           FROM storage.objects
          WHERE bucket_id = $1
            AND name = $2`,
        [LABEL_BUCKET, bundle.file_path],
      );
      expect(bundleStorageRows.length).toBe(1);

      if (bundle.signed_url) {
        const signed = await verifySignedUrl(bundle.signed_url);
        expect(signed.status).toBe(200);
        expect(signed.contentLength).toBeGreaterThan(0);
      }

      const { rows: decisionRows } = await client.query(
        `SELECT 1
           FROM decision_log
          WHERE decision_category = 'label_print'
            AND organization_id = $1::uuid
          LIMIT 1`,
        [orgA.id],
      );
      expect(decisionRows.length).toBe(1);

      const { rows: metricRows } = await client.query(
        `SELECT metric
           FROM metrics_webhook_events
          WHERE labels->>'org' = $1
          ORDER BY created_at DESC
          LIMIT 5`,
        [orgA.id],
      );
      expect(metricRows.length).toBeGreaterThan(0);
    } finally {
      // Cleanup should run even when assertions fail to keep the shared cloud environment tidy.
      for (const prefix of cleanup.storagePrefixes) {
        await removeStoragePrefix(
          {
            supabaseUrl: SUPABASE_URL,
            serviceRoleKey: STORAGE_ADMIN_KEY,
            bucket: LABEL_BUCKET,
            prefix: `${prefix}`,
          },
          { bestEffort: true },
        );
      }

      if (cleanup.webhookSourceId) {
        await client.query(
          `DELETE FROM webhook_response_events
            WHERE webhook_inbox_id IN (
              SELECT id FROM webhook_inbox WHERE webhook_source_id = $1::uuid
            )`,
          [cleanup.webhookSourceId],
        );
        await client.query(
          `DELETE FROM webhook_ack_history
            WHERE webhook_inbox_id IN (
              SELECT id FROM webhook_inbox WHERE webhook_source_id = $1::uuid
            )`,
          [cleanup.webhookSourceId],
        ).catch(() => {});
        await client.query(
          'DELETE FROM webhook_inbox WHERE webhook_source_id = $1::uuid',
          [cleanup.webhookSourceId],
        );
      } else if (cleanup.webhookIds.length) {
        await client.query('DELETE FROM webhook_inbox WHERE id = ANY($1::uuid[])', [cleanup.webhookIds]);
      }

      // Delete shipments/labels before workflow runs because label_jobs may FK to workflow_run_steps.
      if (cleanup.shipmentIds.length) {
        await client.query('DELETE FROM shipment_actions WHERE shipment_id = ANY($1::uuid[])', [cleanup.shipmentIds]);
      }
      if (cleanup.boxIds.length) {
        await client.query('DELETE FROM shipment_boxes WHERE id = ANY($1::uuid[])', [cleanup.boxIds]);
      }
      if (cleanup.shipmentIds.length) {
        await client.query('DELETE FROM label_jobs WHERE shipment_id = ANY($1::uuid[])', [cleanup.shipmentIds]);
        await client.query('DELETE FROM labels WHERE shipment_id = ANY($1::uuid[])', [cleanup.shipmentIds]);
        await client.query('DELETE FROM shipments WHERE id = ANY($1::uuid[])', [cleanup.shipmentIds]);
      }
      // Address versions are append-only; avoid deleting addresses and parent rows.

      if (cleanup.workflowRunIds.length) {
        await client.query('DELETE FROM workflow_run_steps WHERE workflow_run_id = ANY($1::uuid[])', [cleanup.workflowRunIds]);
        await client.query('DELETE FROM workflow_runs WHERE id = ANY($1::uuid[])', [cleanup.workflowRunIds]);
      }

      for (const setting of cleanup.settings) {
        await client.query(
          `DELETE FROM settings
            WHERE category = $1
              AND scope_type = $2
              AND scope_id = $3::uuid`,
          [setting.category, setting.scope_type, setting.scope_id],
        );
        await client.query(
          `DELETE FROM settings_versions
            WHERE category = $1
              AND scope_type = $2
              AND scope_id = $3::uuid`,
          [setting.category, setting.scope_type, setting.scope_id],
        );
      }

      if (cleanup.webhookSourceId) {
        await client.query('DELETE FROM webhook_sources WHERE id = $1::uuid', [cleanup.webhookSourceId]);
      }
      if (cleanup.mappingConfigId) {
        await client.query('DELETE FROM mapping_configs WHERE id = $1::uuid', [cleanup.mappingConfigId]);
      }

      // Keep sender/client rows to avoid cascades into address_versions.

      for (const orgId of cleanup.orgIds) {
        await client.query("DELETE FROM metrics_webhook_events WHERE labels->>'org' = $1", [orgId]);
        await client.query('DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid', [orgId]);
        await client.query('DELETE FROM decision_log WHERE organization_id = $1::uuid', [orgId]);
        // Keep org rows to avoid cascades into address_versions.
      }
    }
  });
});
