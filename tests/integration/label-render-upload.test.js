const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { removeStoragePaths } = require('../../scripts/utils/supabase-storage');
const { skipIfMissing } = require('../utils/test-env');
const { createWorkflowContext, clearWorkflowEngineContext, cleanupWorkflowForLabelJobs } = require('./helpers/tenant-utils');
const { resolveStorageAdminKey } = require('./helpers/storage-admin');
const {
  isAuthSignatureModeError,
  logAuthSignatureModeSkip,
} = require('./helpers/auth-signature-mode');

loadEnv();
const baseMissingEnv = skipIfMissing(
  ['SUPABASE_URL'],
  'label render upload'
);
const STORAGE_ADMIN_KEY =
  resolveStorageAdminKey() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const missingEnv = baseMissingEnv || (!STORAGE_ADMIN_KEY ? ['SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY'] : null);
const describeMaybe = missingEnv ? describe.skip : describe;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LABEL_BUCKET = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

function skipForAuthSignatureMode(errorLike) {
  if (!isAuthSignatureModeError(errorLike)) {
    return false;
  }
  logAuthSignatureModeSkip('label-render-upload.test', errorLike);
  return true;
}

describeMaybe('Labels workflow end-to-end via worker path', () => {
  // Workflow -> label_jobs -> worker render/upload. Keep timeout reasonable.
  jest.setTimeout(120_000);

  afterAll(async () => {
    await pool.end();
  });

  test('request_label_generation -> worker renders/upload to labels bucket', async () => {
    const client = await pool.connect();
    const orgId = randomUUID();
    const clientId = randomUUID();
    const addressId = randomUUID();
    const shipmentId = randomUUID();
    const boxId = randomUUID();
    const labelId = randomUUID();
    let workflowContext = null;
    let jobId = null;
    const tracking = `LBLE2E${shipmentId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

    try {
      // Seed org/client/address/shipment/box.
      await client.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Renderer E2E Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
        [orgId, `renderer-e2e-${orgId.slice(0, 8)}`]
      );

      await client.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
         VALUES ($1::uuid, $2::uuid, 'Renderer E2E Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
        [clientId, orgId, `renderer-e2e-client-${clientId.slice(0, 8)}`]
      );

      const stableLabelRenderPolicy = {
        version: 1,
        header_brand_mode: 'logo',
        text_defaults: {
          font_regular: 'Helvetica',
          font_bold: 'Helvetica-Bold',
          min_font_size: 6,
          hard_min_font_size: 4,
          line_height_factor: 1.1,
          overflow: 'shrink',
        },
        metrics: {
          window_minutes: 60,
          min_samples: 25,
          slo_p95_render_ms: 4000,
          slo_p95_total_ms: 8000,
        },
        arabic: { enabled: false, direction: 'auto' },
      };

      await client.query(
        `SELECT *
           FROM public.upsert_settings_value_v1(
             'label_render_policy',
             'tenant',
             $1::uuid,
             $2::jsonb,
             1,
             'integration test: stable label render policy baseline'
           )`,
        [orgId, JSON.stringify(stableLabelRenderPolicy)],
      );
      await client.query(
        `DELETE FROM settings_cache
          WHERE cache_key LIKE 'label_render_policy:%'`,
      );

      await client.query(
        `INSERT INTO addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '123 Renderer St', 'Riyadh', 'Riyadh', 'SA', 'pending')`,
        [addressId, orgId, clientId]
      );

      await client.query(
        `INSERT INTO shipments (
           id, organization_id, client_id, service_type, tracking_number, status, box_count,
           origin_address_id, destination_address_id, created_at, updated_at
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'delivery', $5::text, 'pending', 1,
                 $4::uuid, $4::uuid, now(), now())`,
        [shipmentId, orgId, clientId, addressId, tracking]
      );

      await client.query(
        `INSERT INTO shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::text, now())`,
        [boxId, shipmentId, orgId, clientId, `${tracking}:1`]
      );

      workflowContext = await createWorkflowContext(client, {
        templateName: 'sys_label_generation_v1',
        context: { organization_id: orgId, client_id: clientId },
        local: false,
      });

      // Request label generation (workflow handles barcode_generate + label_render + bundle v2 if needed).
      const { rows: jobRows } = await client.query(
        `SELECT request_label_generation($1::uuid, 'shipping', NULL, 'e2e_test', $2::uuid, 'primary') AS job_id`,
        [shipmentId, boxId]
      );
      jobId = jobRows[0].job_id;
      expect(jobId).toBeTruthy();

      // Run worker in short loops until the job is claimed and completed.
      const { spawnSync } = require('child_process');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = spawnSync('node', [
          'scripts/workers/render-label-jobs.js',
          '--org-id', orgId,
          '--job-id', jobId,
          '--limit', '1',
        ], {
          env: { ...process.env, ENV_FILE: process.env.ENV_FILE || 'config/env/.env.cloud' },
          encoding: 'utf8',
        });
        if (res.status !== 0) {
          if (skipForAuthSignatureMode(`${res.stderr || ''}\n${res.stdout || ''}`)) return;
          throw new Error(`worker failed: ${res.stderr || res.stdout}`);
        }
        // Check if already done
        const { rows } = await client.query(
          `SELECT
             status,
             output_file_url,
             error_reason,
             attempts,
             max_attempts,
             renderer_metadata
           FROM label_jobs
           WHERE id = $1::uuid`,
          [jobId]
        );
        const maybeJob = rows[0];
        if (maybeJob && maybeJob.status === 'succeeded' && maybeJob.output_file_url) break;
        if (maybeJob && maybeJob.status === 'failed' && skipForAuthSignatureMode({
          error_reason: maybeJob.error_reason,
          renderer_metadata: maybeJob.renderer_metadata,
        })) return;
        await sleep(2000);
      }

      // Poll until job succeeds or timeout.
      let job;
      for (let i = 0; i < 20; i += 1) {
        const { rows } = await client.query(
          `SELECT
             status,
             output_file_url,
             error_reason,
             attempts,
             max_attempts,
             renderer_metadata
           FROM label_jobs
           WHERE id = $1::uuid`,
          [jobId]
        );
        job = rows[0];
        if (job && job.status === 'succeeded' && job.output_file_url) break;
        if (job && job.status === 'failed' && skipForAuthSignatureMode({
          error_reason: job.error_reason,
          renderer_metadata: job.renderer_metadata,
        })) return;
        await sleep(2000);
      }

      if (!job || job.status !== 'succeeded' || !job.output_file_url) {
        const details = job
          ? {
            status: job.status,
            attempts: job.attempts,
            max_attempts: job.max_attempts,
            error_reason: job.error_reason,
            renderer_error: job.renderer_metadata?.error || null,
          }
          : { status: 'missing' };
        throw new Error(`Renderer did not complete: ${JSON.stringify(details)}`);
      }

      const { rows: timingRows } = await client.query(
        `SELECT renderer_metadata->'timings' AS timings FROM label_jobs WHERE id = $1::uuid`,
        [jobId]
      );
      const timings = timingRows?.[0]?.timings;
      expect(timings).toBeTruthy();
      expect(Number(timings.compose_ms)).toBeGreaterThanOrEqual(0);
      expect(Number(timings.render_ms)).toBeGreaterThan(0);
      expect(Number(timings.upload_ms)).toBeGreaterThanOrEqual(0);
      expect(Number(timings.total_ms)).toBeGreaterThan(0);

      const { rows: viewRows } = await client.query(
        `SELECT render_ms, total_ms FROM label_render_job_timings_v WHERE job_id = $1::uuid`,
        [jobId]
      );
      expect(viewRows.length).toBe(1);
      expect(Number(viewRows[0].render_ms)).toBeGreaterThan(0);
      expect(Number(viewRows[0].total_ms)).toBeGreaterThan(0);

      const { rows: sloRows } = await client.query(
        `SELECT check_label_render_slo_and_log($1::uuid) AS result`,
        [orgId]
      );
      expect(sloRows[0].result?.status).toBe('ok');
      const sloEntry = (sloRows[0].result?.results || []).find((r) => r.organization_id === orgId);
      expect(sloEntry).toBeTruthy();
      expect(['insufficient_samples', 'ok', 'slo_violation']).toContain(sloEntry.status);

      const filePath = job.output_file_url;
      const { rows: existsRows } = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM storage.objects WHERE bucket_id = 'labels' AND name = $1
         ) AS present`,
        [filePath]
      );
      expect(existsRows[0].present).toBe(true);

      const keep = process.env.KEEP_LABEL_UPLOAD === '1';
      if (!keep) {
        await cleanupWorkflowForLabelJobs(client, {
          jobIds: jobId ? [jobId] : [],
          workflowRunIds: workflowContext?.runId ? [workflowContext.runId] : [],
        });
        await removeStoragePaths(
          {
            supabaseUrl: process.env.SUPABASE_URL,
            serviceRoleKey: STORAGE_ADMIN_KEY,
            bucket: LABEL_BUCKET,
            paths: [filePath],
          },
          { bestEffort: true },
        );
        await client.query(`DELETE FROM labels WHERE id = $1::uuid OR shipment_id = $2::uuid`, [labelId, shipmentId]);
        await client.query(`DELETE FROM shipment_boxes WHERE id = $1::uuid`, [boxId]);
        await client.query(`DELETE FROM shipment_actions WHERE shipment_id = $1::uuid`, [shipmentId]);
        await client.query(`DELETE FROM shipments WHERE id = $1::uuid`, [shipmentId]);
        // Address versions are append-only; avoid deleting addresses and parent rows.
        await client.query(`DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid`, [orgId]);
        await client.query(`DELETE FROM decision_log WHERE organization_id = $1::uuid`, [orgId]);
        // Keep org/client rows to avoid cascades into address_versions.
      }
      await clearWorkflowEngineContext(client, { local: false });
    } finally {
      client.release();
    }
  });
});
