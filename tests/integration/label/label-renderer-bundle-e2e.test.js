const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertSettings } = require('../../utils/policies');
const { fetchJsonWithRetry, truncateText } = require('../helpers/http');
const { createWorkflowContext, clearWorkflowEngineContext, cleanupWorkflowForLabelJobs } = require('../helpers/tenant-utils');
const { ensureStorageBucket, resolveStorageAdminKey } = require('../helpers/storage-admin');
const {
  isAuthSignatureModeError,
  logAuthSignatureModeSkip,
} = require('../helpers/auth-signature-mode');
const { waitForMetricRow } = require('../workflows/helpers/label-print-helpers');

loadEnv();

const { SUPABASE_URL, DATABASE_URL } = process.env;
jest.setTimeout(180000);
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const STORAGE_ADMIN_KEY =
  resolveStorageAdminKey() ||
  SERVICE_ROLE_KEY;
const isTruthy = (value) => /^(1|true|yes)$/i.test(String(value || '').trim());
const previewMode = isTruthy(process.env.PREVIEW_MODE) || isTruthy(process.env.CI_PREVIEW);
const edgeRequireDbJwt = String(process.env.EDGE_REQUIRE_DB_JWT || '').trim() === '1';
const skipInPreviewFallback = previewMode && !edgeRequireDbJwt;
const labelRendererDbJwt =
  String(process.env.LABEL_RENDERER_DB_JWT || process.env.EDGE_DB_JWT || '').trim();
const skipForStrictDbJwtLocal = edgeRequireDbJwt && !labelRendererDbJwt;
const LABEL_RENDERER_JWT = previewMode && !edgeRequireDbJwt
  ? SERVICE_ROLE_KEY
  : (process.env.LABEL_RENDERER_DB_JWT || SERVICE_ROLE_KEY || '');
const LABEL_BUCKET =
  process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

function skipForAuthSignatureMode(errorLike) {
  if (!isAuthSignatureModeError(errorLike)) {
    return false;
  }
  logAuthSignatureModeSkip('label-renderer-bundle-e2e.test', errorLike);
  return true;
}

if (!SUPABASE_URL || !DATABASE_URL || !SUPABASE_ANON_KEY || !LABEL_RENDERER_JWT || !STORAGE_ADMIN_KEY || skipInPreviewFallback || skipForStrictDbJwtLocal) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('label renderer bundle E2E via webhook + workflow', () => {
    test.skip('skipped: missing env', () => {});
  });
} else {
  const pool = new Pool({ connectionString: DATABASE_URL });

  describe('label renderer bundle E2E via webhook + workflow', () => {
    let client;

    beforeAll(async () => {
      client = await pool.connect();
      client.on('error', (err) => {
        // Avoid unhandled pg client errors during long-running cloud integration tests.
        // Connection drops can happen; cleanup will attempt recovery where safe.
        // eslint-disable-next-line no-console
        console.warn('[bundle-e2e] pg client error:', err?.message || String(err));
      });
    });

    afterAll(async () => {
      if (client) await client.release();
      await pool.end();
    });

    const makeOrgClientSender = async (client, slugPrefix, labelDesign) => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const addressId = randomUUID();
      const slugOrg = `${slugPrefix}-org-${orgId.slice(0, 8)}`;
      const slugClient = `${slugPrefix}-client-${clientId.slice(0, 8)}`;

      await client.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, $2, $3, 'Asia/Riyadh', 'en-US', 'active')`,
        [orgId, `Org ${slugPrefix}`, slugOrg],
      );

      // Child onboarding materializes the currently effective tenant label design.
      await upsertSettings(
        'label_design',
        'tenant',
        orgId,
        labelDesign,
        `e2e design ${slugPrefix}`,
        client,
      );

      await client.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'standard', 'active')`,
        [clientId, orgId, `Client ${slugPrefix}`, slugClient],
      );

      await client.query(
        `INSERT INTO addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Test Address', 'Riyadh', 'Riyadh', 'SA', 'pending')`,
        [addressId, orgId, clientId],
      );

      return { orgId, clientId, addressId };
    };

    const createShipmentWithBox = async (client, orgId, clientId, addressId) => {
      const shipmentId = randomUUID();
      const boxId = randomUUID();
      await client.query(
        `INSERT INTO shipments (
           id, organization_id, client_id, service_type, tracking_number, status,
           box_count, origin_address_id, destination_address_id, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'delivery', $4, 'pending',
           1, $5::uuid, $5::uuid, now(), now()
         )`,
        [shipmentId, orgId, clientId, `E2E-${shipmentId.slice(0, 8)}`, addressId],
      );
      await client.query(
        `INSERT INTO shipment_boxes (
           id, shipment_id, organization_id, client_id, box_number, barcode, created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now()
         )`,
        [boxId, shipmentId, orgId, clientId, `EDGEBOX:${Date.now()}`],
      );
      return { shipmentId, boxId };
    };

    const triggerRenderViaWorkflow = async (shipmentId, boxId, templateKey, orgId, clientId, workflowRuns) => {
      const workflowContext = await createWorkflowContext(client, {
        templateName: 'sys_label_generation_v1',
        context: { organization_id: orgId, client_id: clientId },
        local: false,
      });
      workflowRuns.push(workflowContext.runId);

      const { rows } = await client.query(
        `SELECT request_label_generation($1::uuid, 'shipping', NULL, $2, $3::uuid, 'primary') AS job_id`,
        [shipmentId, templateKey, boxId],
      );
      return rows[0].job_id;
    };

    const ensureLabelBucket = async () => {
      await ensureStorageBucket({
        supabaseUrl: SUPABASE_URL,
        bucket: LABEL_BUCKET,
        storageAdminKey: STORAGE_ADMIN_KEY,
      });
    };

    const waitForJobFile = async (jobId, attempts = 40, sleepMs = 1000) => {
      for (let i = 0; i < attempts; i += 1) {
        const { rows } = await client.query(
          `SELECT status, output_file_url, error_reason FROM label_jobs WHERE id = $1::uuid`,
          [jobId],
        );
        if (rows.length === 1 && rows[0].status === 'succeeded' && rows[0].output_file_url) {
          return rows[0].output_file_url;
        }
        if (rows.length === 1 && rows[0].status === 'failed') {
          throw new Error(`Job ${jobId} failed: ${rows[0].error_reason || 'unknown reason'}`);
        }
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
      throw new Error(`Timed out waiting for job ${jobId} to succeed`);
    };

    test('bundles only in-scope labels; cross-tenant/client are excluded', async () => {
      const workflowRuns = [];
      const jobIds = [];
      try {
        const design = {
          version: '2025-11-24',
          templates: {
            shipping: {
              template_key: 'e2e_internal_shipping',
              version: '1.0.0',
              provider_hint: 'pdf',
              page: { width_inch: 4, height_inch: 6, dpi: 203 },
              blocks: [
                { type: 'text', x: 20, y: 200, font: 'Helvetica-Bold', font_size: 12, value_path: 'shipment.tracking_number' },
              ],
              max_attempts: 3,
              retry_backoff_seconds: [60, 180],
            },
          },
        };

        // Seed two tenants/clients/senders after their effective designs exist.
        const a = await makeOrgClientSender(client, 'e2e-a', design);
        const b = await makeOrgClientSender(client, 'e2e-b', design);

        const labelPrintPolicy = {
          version: 1,
          max_labels_per_bundle: 10,
          default_expires_seconds: 120,
          max_failed_labels: 5,
        };

        await upsertSettings(
          'label_print_policy',
          'global',
          null,
          labelPrintPolicy,
          'bundle e2e policy global fallback',
          client,
        );
        await upsertSettings('label_print_policy', 'tenant', a.orgId, labelPrintPolicy, 'e2e policy A', client);
        await upsertSettings('label_print_policy', 'tenant', b.orgId, labelPrintPolicy, 'e2e policy B', client);

        try {
          await ensureLabelBucket();
        } catch (error) {
          if (skipForAuthSignatureMode(error)) return;
          throw error;
        }
        await client.query(`DELETE FROM metrics_webhook_events WHERE metric LIKE 'label_bundle.%'`);

        const { shipmentId: shipmentA, boxId: boxA } = await createShipmentWithBox(client, a.orgId, a.clientId, a.addressId);
        const { shipmentId: shipmentB, boxId: boxB } = await createShipmentWithBox(client, b.orgId, b.clientId, b.addressId);

        await client.query(`DELETE FROM label_jobs WHERE shipment_id IN ($1::uuid, $2::uuid)`, [shipmentA, shipmentB]);

        const jobA = await triggerRenderViaWorkflow(shipmentA, boxA, 'e2e_internal_shipping', a.orgId, a.clientId, workflowRuns);
        const jobB = await triggerRenderViaWorkflow(shipmentB, boxB, 'e2e_internal_shipping', b.orgId, b.clientId, workflowRuns);
        jobIds.push(jobA, jobB);

        const { rows: snapshotRows } = await client.query(
          `SELECT template_snapshot
             FROM label_jobs
            WHERE id IN ($1::uuid, $2::uuid)
            ORDER BY id`,
          [jobA, jobB],
        );
        expect(snapshotRows).toHaveLength(2);
        for (const row of snapshotRows) {
          expect(row.template_snapshot.template_key).toBe('e2e_internal_shipping');
          expect(row.template_snapshot.renderer_config.blocks).toEqual(design.templates.shipping.blocks);
        }

        await client.query(
          `UPDATE label_jobs
              SET status = 'pending', attempts = 0, lease_expires_at = now()
            WHERE id IN ($1::uuid, $2::uuid)`,
          [jobA, jobB],
        );

        // Render both jobs through the edge renderer (service-role, scoped per org)
        const renderUrl = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`;
        const renderJob = async (jobId, orgId) => {
          const { resp, bodyText, json, jsonError } = await fetchJsonWithRetry(
            renderUrl,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${LABEL_RENDERER_JWT}`,
                apikey: SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({ organization_id: orgId, job_id: jobId, lease_seconds: 60 }),
            },
            { purpose: `render job ${jobId}` },
          );

          const debug = bodyText ? truncateText(bodyText) : json ? JSON.stringify(json) : '';
          if (jsonError || !json) {
            throw new Error(`render job ${jobId} non-JSON response (${resp.status}): ${debug}`);
          }
          if (resp.status !== 200 || json.status !== 'ok') {
            throw new Error(`render job ${jobId} failed: ${resp.status} ${debug}`);
          }
          return json.file_url;
        };

        let fileUrlA;
        let fileUrlB;
        try {
          [fileUrlA, fileUrlB] = await Promise.all([
            renderJob(jobA, a.orgId),
            renderJob(jobB, b.orgId),
          ]);
        } catch (error) {
          if (skipForAuthSignatureMode(error)) return;
          throw error;
        }

        // eslint-disable-next-line no-console
        console.log('[bundle-e2e] rendered files', { fileUrlA, fileUrlB });

        await Promise.all([
          waitForJobFile(jobA, 10, 500),
          waitForJobFile(jobB, 10, 500),
        ]);

        // Bundle only tenant A (client A) labels
        const { resp: bundleResp, bodyText: bundleText, json: body, jsonError } =
          await fetchJsonWithRetry(
            `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${LABEL_RENDERER_JWT}`,
                apikey: SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({
                mode: 'bundle',
                organization_id: a.orgId,
                bundle: {
                  organization_id: a.orgId,
                  client_id: a.clientId,
                  file_urls: [fileUrlA, fileUrlB], // cross-tenant URL should be excluded
                },
              }),
            },
            { purpose: 'bundle labels' },
          );

        const bundleDebug = bundleText ? truncateText(bundleText) : body ? JSON.stringify(body) : '';
        if (jsonError || !body) {
          throw new Error(`bundle non-JSON response (${bundleResp.status}): ${bundleDebug}`);
        }
        if (bundleResp.status !== 200) {
          if (skipForAuthSignatureMode(body || bundleDebug)) return;
          throw new Error(`bundle failed: ${bundleResp.status} ${bundleDebug}`);
        }

        // eslint-disable-next-line no-console
        console.log('[bundle-e2e] bundle counts', body.counts);

        expect(body.status).toBe('ok');
        expect(body.organization_id).toBe(a.orgId);
        expect(body.client_id).toBe(a.clientId);
        expect(body.counts.requested).toBe(2);
        // Only in-scope label should be bundled; cross-tenant should be placeholder
        expect(body.counts.bundled).toBe(1);
        expect(body.counts.placeholders).toBeGreaterThanOrEqual(1);

        const { rows: decisions } = await client.query(
          `SELECT decision_outcome, decision_inputs
             FROM decision_log
            WHERE resource_type = 'label_bundle'
              AND resource_id = $1::uuid
            ORDER BY timestamp DESC
            LIMIT 1`,
          [body.bundle_id],
        );
        expect(decisions.length).toBe(1);
        expect(decisions[0].decision_outcome).toBe('completed');
        expect(decisions[0].decision_inputs.bucket).toBeTruthy();

        const metricRow = await waitForMetricRow(client, { metric: 'label_bundle.completed' });
        expect(metricRow).toBeTruthy();
        expect(metricRow.labels.org).toBe(a.orgId);
        expect(metricRow.labels.client).toBe(a.clientId);
        expect(Number(metricRow.data.bundle_size_bytes || 0)).toBeGreaterThan(0);
      } finally {
        const isPgConnectionError = (err) => {
          const msg = String(err?.message || err || '');
          return (
            msg.includes('Connection terminated unexpectedly') ||
            msg.includes('not queryable') ||
            msg.includes('ECONNRESET') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('EPIPE')
          );
        };

        try {
          await cleanupWorkflowForLabelJobs(client, { jobIds, workflowRunIds: workflowRuns });
        } catch (err) {
          if (!isPgConnectionError(err)) throw err;
          const recovery = await pool.connect();
          try {
            recovery.on('error', (e) => {
              // eslint-disable-next-line no-console
              console.warn('[bundle-e2e] pg recovery client error:', e?.message || String(e));
            });
            await cleanupWorkflowForLabelJobs(recovery, { jobIds, workflowRunIds: workflowRuns });
          } finally {
            recovery.release();
          }
        }

        try {
          await clearWorkflowEngineContext(client, { local: false });
        } catch (err) {
          if (!isPgConnectionError(err)) throw err;
        }
      }
    }, 120000);
  });
}
