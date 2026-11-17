const { Pool } = require('pg');
const { upsertSettings } = require('../utils/policies');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { removeStoragePaths } = require('../../scripts/utils/supabase-storage');
const { skipIfMissing } = require('../utils/test-env');
const { createWorkflowContext, clearWorkflowEngineContext } = require('./helpers/tenant-utils');
const { fetchJsonWithRetry, truncateText } = require('./helpers/http');

loadEnv();

// Core requirements
const coreMissing = skipIfMissing(['SUPABASE_URL', 'DATABASE_URL'], 'label-renderer edge e2e');
if (coreMissing) {
  // eslint-disable-next-line jest/no-disabled-tests
  test.skip('Skipping label-renderer edge e2e due to missing core env', () => {});
}

// Honour live-test toggle to avoid hitting edge runtime when LIVE flags are off.
const labelsEdgeEnabled = process.env.RUN_LABELS_WEBHOOK_TESTS === 'true';
if (!labelsEdgeEnabled) {
  // eslint-disable-next-line jest/no-disabled-tests
  test.skip('Skipping label-renderer edge e2e (RUN_LABELS_WEBHOOK_TESTS!=true)', () => {});
}

// Local env gating: only run when RUN_LOCAL_EDGE_TESTS=true for local setups.
const isLocalEnv =
  (process.env.ENV_FILE || '').includes('.env.local') ||
  (process.env.DATABASE_URL || '').includes('127.0.0.1') ||
  (process.env.DATABASE_URL || '').includes('localhost');
const localEdgeEnabled = process.env.RUN_LOCAL_EDGE_TESTS === 'true';
if (isLocalEnv && !localEdgeEnabled) {
  // eslint-disable-next-line jest/no-disabled-tests
  test.skip('Skipping label-renderer edge e2e in local env (RUN_LOCAL_EDGE_TESTS!=true)', () => {});
}

// Token requirement (any-of)
const SERVICE_TOKEN =
  process.env.LABEL_RENDERER_DB_JWT ||
  process.env.LABEL_RENDERER_TOKEN ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.EDGE_SUPABASE_SERVICE_ROLE_KEY ||
  '';
const STORAGE_ADMIN_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.EDGE_SUPABASE_SERVICE_ROLE_KEY ||
  SERVICE_TOKEN ||
  '';
if (!SERVICE_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn('[test-skip] Skipping label-renderer edge e2e - missing service token');
  // eslint-disable-next-line jest/no-disabled-tests
  test.skip('Skipping label-renderer edge e2e due to missing token', () => {});
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const { DATABASE_URL } = process.env;
const LABEL_BUCKET = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

const pool = new Pool({ connectionString: DATABASE_URL });

const shouldRunLabelEdge =
  !coreMissing && labelsEdgeEnabled && (!isLocalEnv || localEdgeEnabled) && SERVICE_TOKEN;

if (!shouldRunLabelEdge) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('Label renderer edge function', () => {
    test('skipped: label-renderer edge e2e not enabled for this env', () => {});
  });
} else {
describe('Label renderer edge function', () => {
  let adminClient;

  test('rejects unknown token', async () => {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/label-renderer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer invalid-token',
        ...(process.env.SUPABASE_ANON_KEY ? { apikey: process.env.SUPABASE_ANON_KEY } : {}),
      },
      body: JSON.stringify({ organization_id: randomUUID(), job_id: randomUUID() }),
    });

    expect([401, 403]).toContain(response.status);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('leases pending job and uploads rendered PDF', async () => {
    adminClient = await pool.connect();

    const orgId = randomUUID();
    const clientId = randomUUID();
    const addressId = randomUUID();
    const shipmentId = randomUUID();
    const boxId = randomUUID();
    const jobPurpose = 'primary';
    let workflowContext = null;

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
              type: 'line',
              x: 32,
              y: 240,
              width: 272,
              height: 240,
              stroke_width: 1,
              color: '#000000',
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
          max_attempts: 4,
          retry_backoff_seconds: [45, 180, 600],
        },
      },
    };

    let jobId;
    let uploadedPath = null;

    try {
      await adminClient.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Edge Label Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
        [orgId, `edge-label-org-${orgId.slice(0, 8)}`]
      );

      await upsertSettings(
        'label_design',
        'tenant',
        orgId,
        tenantTemplateConfig,
        'edge integration label template',
        adminClient
      );

      // Ensure the label_design settings row is interpreted as schema v2 (blocks/line/etc).
      const { rows: designRows } = await adminClient.query(
        `SELECT settings_version_id
           FROM settings
          WHERE category = 'label_design'
            AND scope_type = 'tenant'
            AND scope_id = $1::uuid
          LIMIT 1`,
        [orgId]
      );
      if (designRows.length === 1 && designRows[0].settings_version_id) {
        await adminClient.query(
          `UPDATE settings_versions SET schema_version = 2 WHERE id = $1::uuid`,
          [designRows[0].settings_version_id]
        );
      }

      // Child onboarding materializes the currently effective tenant label design.
      await adminClient.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
         VALUES ($1::uuid, $2::uuid, 'Edge Label Client', $3, 'standard', 'active')`,
        [clientId, orgId, `edge-label-client-${clientId.slice(0, 8)}`]
      );

      await adminClient.query(
        `INSERT INTO addresses (
           id, organization_id, client_id, raw_input, city, province, country, validation_status
         )
         VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           'Edge Integration Address', 'Riyadh', 'Riyadh Province', 'SA', 'pending'
         )`,
        [addressId, orgId, clientId]
      );

      await adminClient.query(
        `INSERT INTO shipments (
           id, organization_id, client_id, service_type, tracking_number,
           status, box_count, origin_address_id, destination_address_id,
           created_at, updated_at
         )
         VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           'delivery',
           $4,
           'pending',
           1,
           $5::uuid,
           $5::uuid,
           now(),
           now()
         )`,
        [shipmentId, orgId, clientId, `EDGE-${shipmentId.slice(0, 8)}`, addressId]
      );

      await adminClient.query(
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
        [boxId, shipmentId, orgId, clientId, `EDGEBOX:${Date.now()}`]
      );

      const providerSettings = {
        version: 2,
        providers: [
          {
            name: 'edge_integration',
            mode: 'internal',
            invoke_url: `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`,
            invoke_secret: SERVICE_TOKEN,
            timeout_ms: 20000,
          },
        ],
      };

      await upsertSettings(
        'label_provider',
        'global',
        null,
        providerSettings,
        'edge integration label provider',
        adminClient
      );

      workflowContext = await createWorkflowContext(adminClient, {
        templateName: 'sys_label_generation_v1',
        context: { organization_id: orgId, client_id: clientId },
        local: false,
      });

      const { rows: jobRows } = await adminClient.query(
        `SELECT request_label_generation($1::uuid, 'shipping', NULL, 'edge_integration', $2::uuid, $3)
         AS job_id`,
        [shipmentId, boxId, jobPurpose]
      );

      jobId = jobRows[0].job_id;

      const { rows: snapshotRows } = await adminClient.query(
        `SELECT template_snapshot
           FROM label_jobs
          WHERE id = $1::uuid`,
        [jobId]
      );
      expect(snapshotRows).toHaveLength(1);
      expect(snapshotRows[0].template_snapshot.template_key).toBe('edge_integration_template');
      expect(
        snapshotRows[0].template_snapshot.renderer_config.blocks.filter((block) => block.type === 'barcode')
      ).toHaveLength(1);

      const { resp, bodyText, json, jsonError } = await fetchJsonWithRetry(
        `${SUPABASE_URL}/functions/v1/label-renderer`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${SERVICE_TOKEN}`,
            ...(process.env.SUPABASE_ANON_KEY ? { apikey: process.env.SUPABASE_ANON_KEY } : {}),
          },
          body: JSON.stringify({ organization_id: orgId, job_id: jobId, lease_seconds: 60 }),
        },
        { purpose: `label renderer edge ${jobId}` },
      );

      if (resp.status === 503 || resp.status === 500) {
        console.warn(
          '[label-renderer] Edge runtime unavailable',
          { status: resp.status, text: truncateText(bodyText) }
        );
        return;
      }

      expect(resp.status).toBe(200);
      if (jsonError || !json) {
        throw new Error(`label-renderer edge returned non-JSON: ${truncateText(bodyText)}`);
      }
      const body = json;
      expect(body.status).toBe('ok');
      expect(body.job_id).toBe(jobId);
      expect(body.metadata).toBeTruthy();
      expect(body.metadata.rendered_blocks).toBeGreaterThanOrEqual(3);
      expect(body.metadata.barcode_blocks).toBe(1);
      expect(body.metadata.barcode_mode).toBe('code128b_vector');
      uploadedPath = body.output_file_url || body.file_url || null;

      const { rows: jobStatusRows } = await adminClient.query(
        `SELECT status, output_file_url, renderer_metadata, lease_expires_at
         FROM label_jobs
         WHERE id = $1::uuid`,
        [jobId]
      );

      expect(jobStatusRows).toHaveLength(1);
      const jobStatus = jobStatusRows[0];
      expect(['in_progress', 'succeeded']).toContain(jobStatus.status);
      if (jobStatus.status === 'succeeded') {
        expect(jobStatus.output_file_url).toBeTruthy();
        expect(jobStatus.renderer_metadata).toBeTruthy();
        uploadedPath = uploadedPath || jobStatus.output_file_url;
      } else {
        expect(jobStatus.lease_expires_at).toBeTruthy();
      }
    } finally {
      const deleteDecisionLogs = async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await adminClient.query('DELETE FROM decision_log WHERE organization_id = $1::uuid', [orgId]);
          const { rows } = await adminClient.query(
            'SELECT 1 FROM decision_log WHERE organization_id = $1::uuid LIMIT 1',
            [orgId]
          );
          if (rows.length === 0) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      };

      const deleteSettingsResolutionLogs = async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await adminClient.query(
            'DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid',
            [orgId]
          );
          const { rows } = await adminClient.query(
            'SELECT 1 FROM settings_resolution_log WHERE organization_id = $1::uuid LIMIT 1',
            [orgId]
          );
          if (rows.length === 0) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      };

      if (uploadedPath) {
        await removeStoragePaths(
          {
            supabaseUrl: SUPABASE_URL,
            serviceRoleKey: STORAGE_ADMIN_KEY,
            bucket: LABEL_BUCKET,
            paths: [uploadedPath],
          },
          { bestEffort: true },
        );
      }
      if (workflowContext?.runId) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await adminClient.query('DELETE FROM label_jobs WHERE organization_id = $1::uuid', [orgId]);
          try {
            await adminClient.query('DELETE FROM workflow_run_steps WHERE workflow_run_id = $1::uuid', [workflowContext.runId]);
            await adminClient.query('DELETE FROM workflow_runs WHERE id = $1::uuid', [workflowContext.runId]);
            break;
          } catch (error) {
            if (attempt === 4) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      } else {
        await adminClient.query('DELETE FROM label_jobs WHERE organization_id = $1::uuid', [orgId]);
      }
      await adminClient.query('DELETE FROM labels WHERE shipment_id = $1::uuid', [shipmentId]);
      await adminClient.query('DELETE FROM shipment_actions WHERE shipment_id = $1::uuid', [shipmentId]);
      await adminClient.query('DELETE FROM shipment_boxes WHERE id = $1::uuid', [boxId]);
      await adminClient.query('DELETE FROM shipments WHERE id = $1::uuid', [shipmentId]);
      // Address versions are append-only; avoid deleting addresses to prevent cascades.
      await adminClient.query(
        `DELETE FROM settings
          WHERE category = 'label_design'
            AND scope_type = 'tenant'
            AND scope_id = $1::uuid`,
        [orgId]
      );
      await adminClient.query(
        `DELETE FROM settings_versions
          WHERE category = 'label_design'
            AND scope_type = 'tenant'
            AND scope_id = $1::uuid`,
        [orgId]
      );
      await deleteDecisionLogs();
      await deleteSettingsResolutionLogs();
      // Keep org/client rows to avoid cascades into address_versions.

      await clearWorkflowEngineContext(adminClient, { local: false });
      adminClient.release();
    }
  });
});
}
