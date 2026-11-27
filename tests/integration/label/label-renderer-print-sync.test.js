const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { removeStoragePaths } = require('../../../scripts/utils/supabase-storage');
const { upsertSettings } = require('../../utils/policies');
const { verifySignedUrl } = require('../workflows/helpers/label-print-helpers');
const { ensureStorageBucket, resolveStorageAdminKey } = require('../helpers/storage-admin');
const { fetchJsonWithRetry, truncateText } = require('../helpers/http');
const { signedRendererHeaders } = require('../helpers/renderer-request');

loadEnv();

const { SUPABASE_URL, DATABASE_URL } = process.env;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const STORAGE_ADMIN_KEY =
  resolveStorageAdminKey() ||
  SERVICE_ROLE_KEY;

jest.setTimeout(240000);

const labelsEdgeEnabled = process.env.RUN_LABELS_WEBHOOK_TESTS === 'true';

if (
  !SUPABASE_URL ||
  !DATABASE_URL ||
  !SUPABASE_ANON_KEY ||
  !STORAGE_ADMIN_KEY ||
  !labelsEdgeEnabled
) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('label renderer print_sync waybill 185 (edge)', () => {
    test.skip('skipped: missing env or RUN_LABELS_WEBHOOK_TESTS!=true', () => {});
  });
} else {
  const pool = new Pool({ connectionString: DATABASE_URL });

  describe('label renderer print_sync waybill 185 (edge)', () => {
    let client;

    beforeAll(async () => {
      client = await pool.connect();
    });

    afterAll(async () => {
      if (client) await client.release();
      await pool.end();
    });

    const deleteDecisionLogs = async (organizationId) => {
      await client.query('DELETE FROM decision_log WHERE organization_id = $1::uuid', [organizationId]);
    };

    const deleteSettingsResolutionLogs = async (organizationId) => {
      await client.query('DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid', [organizationId]);
    };

    test('renders + bundles 100 labels synchronously (waybill_v1 v1.8.5/185)', async () => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const addressId = randomUUID();
      const shipmentId = randomUUID();
      const trackingNumber = `DLX${shipmentId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

      const labelBucket =
        process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

      try {
        await client.query(
          `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
           VALUES ($1::uuid, 'Print Sync Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
          [orgId, `print-sync-org-${orgId.slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
           VALUES ($1::uuid, $2::uuid, 'Print Sync Client', $3, 'standard', 'active')`,
          [clientId, orgId, `print-sync-client-${clientId.slice(0, 8)}`],
        );
        await upsertSettings(
          'label_print_policy',
          'tenant',
          orgId,
          { print_sync_bundle_return_mode: 'signed_url' },
          'test: print sync signed URL return',
          client,
        );
        await client.query(
          `INSERT INTO addresses (
             id, organization_id, client_id, raw_input, city, province, country, validation_status
           )
           VALUES (
             $1::uuid, $2::uuid, $3::uuid,
             'Print Sync Address', 'Riyadh', 'Riyadh', 'SA', 'pending'
           )`,
          [addressId, orgId, clientId],
        );
        await client.query(
          `INSERT INTO shipments (
             id, organization_id, client_id, service_type, tracking_number, status,
             box_count, origin_address_id, destination_address_id, created_at, updated_at
           )
           VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'delivery', $4, 'pending',
             $5, $6::uuid, $6::uuid, now(), now()
           )`,
          [shipmentId, orgId, clientId, trackingNumber, 100, addressId],
        );

        const { rows: boxRows } = await client.query(
          `INSERT INTO shipment_boxes (
             id, shipment_id, organization_id, client_id, box_number, barcode, created_at
           )
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, gs, $4 || ':' || gs, now()
             FROM generate_series(1, 100) AS gs
           RETURNING id, box_number`,
          [shipmentId, orgId, clientId, trackingNumber],
        );
        const stableBoxes = boxRows
          .map((row) => ({ id: row.id, box_number: Number(row.box_number) }))
          .sort((a, b) => a.box_number - b.box_number);
        const stableBoxIds = stableBoxes.map((row) => row.id);

        // Deliberately scramble order (odds then evens) so we can assert the PDF
        // page ordering strictly follows the request input.
        const boxIds = [];
        for (let idx = 0; idx < stableBoxIds.length; idx += 2) {
          boxIds.push(stableBoxIds[idx]);
        }
        for (let idx = 1; idx < stableBoxIds.length; idx += 2) {
          boxIds.push(stableBoxIds[idx]);
        }

        const expectedPageIndexByBoxId = new Map();
        boxIds.forEach((id, idx) => expectedPageIndexByBoxId.set(id, idx + 1));

        // Ensure labels bucket exists via storage API (idempotent).
        await ensureStorageBucket({
          supabaseUrl: SUPABASE_URL,
          bucket: labelBucket,
          storageAdminKey: STORAGE_ADMIN_KEY,
        });

        const { resp, bodyText, json, jsonError } = await fetchJsonWithRetry(
          `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`,
          {
            method: 'POST',
            headers: await signedRendererHeaders(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`),
            body: JSON.stringify({
              mode: 'print',
              organization_id: orgId,
              job_purpose: 'manual',
              shipments: [{ shipment_id: shipmentId, box_ids: boxIds }],
              output_name: 'print_sync_waybill185_100.pdf',
              expires_seconds: 600,
            }),
          },
          { attempts: 1, purpose: `print sync ${orgId}` },
        );

        const payload = jsonError || !json ? { raw: truncateText(bodyText) } : json;
        if (!resp.ok) {
          throw new Error(`print_sync failed: ${resp.status} ${JSON.stringify(payload)}`);
        }

        expect(payload.status).toBe('ok');
        expect(payload.mode).toBe('print_sync');
        expect(payload.job_purpose).toBe('manual');
        expect(payload.steps.find((step) => step.step === 'enqueue_label_jobs').job_purpose).toBe('manual');
        expect(payload.bundle?.status).toBe('ok');
        expect(payload.bundle?.signed_url).toBeTruthy();

        const signed = await verifySignedUrl(payload.bundle.signed_url);
        expect(signed.contentType).toContain('application/pdf');
        expect(signed.contentLength).toBeGreaterThan(200);

        expect(payload.bundle?.timings?.build_preloaded_count).toBe(100);
        expect(payload.bundle?.timings?.build_downloaded_count).toBe(0);

        const pdfRes = await fetch(payload.bundle.signed_url);
        const bytes = new Uint8Array(await pdfRes.arrayBuffer());
        const pdfDoc = await PDFDocument.load(bytes);
        expect(pdfDoc.getPageCount()).toBe(100);

        const { rows: pageIndexRows } = await client.query(
          `SELECT
             shipment_box_id,
             (renderer_metadata #>> '{bundle,page_index}')::int AS page_index
           FROM label_jobs
           WHERE shipment_id = $1::uuid`,
          [shipmentId],
        );
        expect(pageIndexRows.length).toBe(100);
        pageIndexRows.forEach((row) => {
          const expected = expectedPageIndexByBoxId.get(row.shipment_box_id);
          expect(expected).toBeTruthy();
          expect(Number(row.page_index)).toBe(expected);
        });

        const { rows: jobRows } = await client.query(
          `SELECT status, job_purpose, renderer_metadata
             FROM label_jobs
            WHERE shipment_id = $1::uuid
            ORDER BY created_at`,
          [shipmentId],
        );
        expect(jobRows.length).toBe(100);
        jobRows.forEach((row) => {
          expect(row.status).toBe('succeeded');
          expect(row.job_purpose).toBe('manual');
        });
        const meta = jobRows[0]?.renderer_metadata || {};
        expect(meta.barcode_mode || meta.barcodeMode).toBe('code128b_vector');
        expect(meta.template_version || meta.templateVersion).toBe(185);
      } finally {
        try {
          const { rows: bundleRows } = await client.query(
            `SELECT output_file_url
               FROM label_jobs
              WHERE shipment_id = $1::uuid
                AND output_file_url IS NOT NULL
              LIMIT 1`,
            [shipmentId],
          );
          const bundlePath = bundleRows[0]?.output_file_url;
          if (bundlePath) {
            await removeStoragePaths(
              {
                supabaseUrl: SUPABASE_URL,
                serviceRoleKey: STORAGE_ADMIN_KEY,
                bucket: labelBucket,
                paths: [bundlePath],
              },
              { bestEffort: true },
            );
          }

          await client.query(`DELETE FROM labels WHERE shipment_id = $1::uuid`, [shipmentId]);
          await client.query(`DELETE FROM label_jobs WHERE shipment_id = $1::uuid`, [shipmentId]);
          await client.query(`DELETE FROM shipment_actions WHERE shipment_id = $1::uuid`, [shipmentId]);
          await client.query(`DELETE FROM shipment_boxes WHERE shipment_id = $1::uuid`, [shipmentId]);
          await client.query(`DELETE FROM shipments WHERE id = $1::uuid`, [shipmentId]);
          // Address versions are append-only; avoid deleting addresses and parent rows.
          await client.query(
            `DELETE FROM settings WHERE category = 'label_print_policy' AND scope_type = 'tenant' AND scope_id = $1::uuid`,
            [orgId],
          );
          await client.query(
            `DELETE FROM settings_versions WHERE category = 'label_print_policy' AND scope_type = 'tenant' AND scope_id = $1::uuid`,
            [orgId],
          );
          await deleteDecisionLogs(orgId);
          await deleteSettingsResolutionLogs(orgId);
          // Keep org/client rows to avoid cascades into address_versions.
        } catch (_err) {
          // ignore cleanup errors
        }
      }
    });
  });
}
