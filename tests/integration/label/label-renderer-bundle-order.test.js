const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { removeStoragePaths } = require('../../../scripts/utils/supabase-storage');
const { verifySignedUrl } = require('../workflows/helpers/label-print-helpers');
const { ensureStorageBucket, uploadStorageObject, resolveStorageAdminKey } = require('../helpers/storage-admin');
const { fetchJsonWithRetry, truncateText } = require('../helpers/http');

loadEnv();

const { SUPABASE_URL, DATABASE_URL } = process.env;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const LABEL_RENDERER_AUTH =
  process.env.LABEL_RENDERER_DB_JWT ||
  process.env.LABEL_RENDERER_TOKEN ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  '';
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
  !LABEL_RENDERER_AUTH ||
  !STORAGE_ADMIN_KEY ||
  !labelsEdgeEnabled
) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('label renderer bundle preserves order (edge)', () => {
    test.skip('skipped: missing env or RUN_LABELS_WEBHOOK_TESTS!=true', () => {});
  });
} else {
  const pool = new Pool({ connectionString: DATABASE_URL });

  const createSinglePagePdf = async (width, height) => {
    const doc = await PDFDocument.create();
    doc.addPage([width, height]);
    return Buffer.from(await doc.save());
  };

  const uploadPdfToStorage = async ({ bucket, storagePath, pdfBytes }) => {
    await uploadStorageObject({
      supabaseUrl: SUPABASE_URL,
      bucket,
      storagePath,
      body: pdfBytes,
      contentType: 'application/pdf',
      storageAdminKey: STORAGE_ADMIN_KEY,
    });
  };

  describe('label renderer bundle preserves order (edge)', () => {
    let client;

    beforeAll(async () => {
      client = await pool.connect();
    });

    afterAll(async () => {
      if (client) await client.release();
      await pool.end();
    });

    const deleteDecisionLogs = async (organizationId) => {
      await client.query('DELETE FROM decision_log WHERE organization_id = $1::uuid', [
        organizationId,
      ]);
    };

    const deleteSettingsResolutionLogs = async (organizationId) => {
      await client.query(
        'DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid',
        [organizationId],
      );
    };

    test('bundle output page order matches file_urls (even with high concurrency + chunking)', async () => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const addressId = randomUUID();
      const shipmentId = randomUUID();
      const trackingNumber = `DLX${shipmentId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      const labelBucket =
        process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

      const settingsVersionId = randomUUID();
      const storageFiles = [];
      let bundlePath = null;

      try {
        await client.query(
          `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
           VALUES ($1::uuid, 'Bundle Order Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
          [orgId, `bundle-order-org-${orgId.slice(0, 8)}`],
        );

        await client.query(
          `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
           VALUES ($1::uuid, $2::uuid, 'Bundle Order Client', $3, 'standard', 'active')`,
          [clientId, orgId, `bundle-order-client-${clientId.slice(0, 8)}`],
        );

        await client.query(
          `INSERT INTO addresses (
             id, organization_id, client_id, raw_input, city, province, country, validation_status
           )
           VALUES (
             $1::uuid, $2::uuid, $3::uuid,
             'Bundle Order Address', 'Riyadh', 'Riyadh', 'SA', 'pending'
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
             3, $5::uuid, $5::uuid, now(), now()
           )`,
          [shipmentId, orgId, clientId, trackingNumber, addressId],
        );

        const { rows: boxRows } = await client.query(
          `INSERT INTO shipment_boxes (
             id, shipment_id, organization_id, client_id, box_number, barcode, created_at
           )
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, gs, $4 || ':' || gs, now()
             FROM generate_series(1, 3) AS gs
           RETURNING id, box_number, barcode`,
          [shipmentId, orgId, clientId, trackingNumber],
        );

        // Ensure labels bucket exists via storage API (idempotent).
        await ensureStorageBucket({
          supabaseUrl: SUPABASE_URL,
          bucket: labelBucket,
          storageAdminKey: STORAGE_ADMIN_KEY,
        });

        // Override label_print_policy for this tenant to force high download concurrency and chunking.
        const { rows: policyRows } = await client.query(
          `SELECT cached_value
             FROM settings
            WHERE category = 'label_print_policy'
              AND scope_type = 'global'
              AND scope_id IS NULL
            ORDER BY last_updated DESC
            LIMIT 1`,
        );
        const globalPolicy = policyRows[0]?.cached_value || {};
        const tenantPolicy = {
          ...(globalPolicy && typeof globalPolicy === 'object' ? globalPolicy : {}),
          bundle_download_concurrency: 25,
          bundle_chunk_size: 1,
        };

        await client.query(
          `INSERT INTO settings_versions (
             id, category, scope_type, scope_id, version, value, schema_version,
             change_reason, approved_at, effective_from
           )
           VALUES (
             $1::uuid, 'label_print_policy', 'tenant', $2::uuid, 1, $3::jsonb, 1,
             'test: bundle order concurrency/chunking', now(), now()
           )`,
          [settingsVersionId, orgId, JSON.stringify(tenantPolicy)],
        );
        await client.query(
          `INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
           VALUES ('label_print_policy', 'tenant', $1::uuid, $2::uuid, $3::jsonb, now())`,
          [orgId, settingsVersionId, JSON.stringify(tenantPolicy)],
        );

        // Upload three PDFs with distinct page sizes so we can assert order without text extraction.
        const files = [
          { name: 'a.pdf', size: [200, 300] },
          { name: 'b.pdf', size: [210, 310] },
          { name: 'c.pdf', size: [220, 320] },
        ];

        const boxesByNumber = new Map(boxRows.map((row) => [Number(row.box_number), row]));
        for (let idx = 0; idx < files.length; idx += 1) {
          const entry = files[idx];
          const box = boxesByNumber.get(idx + 1);
          if (!box) {
            throw new Error(`Missing shipment box ${idx + 1} for bundle-order test`);
          }
          const [w, h] = entry.size;
          const pdfBytes = await createSinglePagePdf(w, h);
          const storagePath = `${orgId}/labels/order-test-${entry.name}`;
          await uploadPdfToStorage({ bucket: labelBucket, storagePath, pdfBytes });

          await client.query(
            `INSERT INTO labels (
               shipment_id, organization_id, client_id, label_type,
               barcode, barcode_format, file_url, file_size_bytes
             )
             VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'shipping',
               $4, 'CODE128', $5, $6
             )`,
            [shipmentId, orgId, clientId, box.barcode, storagePath, pdfBytes.length],
          );
          storageFiles.push({ storagePath, size: entry.size });
        }

        // Intentionally scramble input order.
        const fileUrls = [
          storageFiles[1].storagePath,
          storageFiles[0].storagePath,
          storageFiles[2].storagePath,
        ];
        const expectedSizes = [
          storageFiles[1].size,
          storageFiles[0].size,
          storageFiles[2].size,
        ];

        const { resp, bodyText, json, jsonError } = await fetchJsonWithRetry(
          `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${LABEL_RENDERER_AUTH}`,
              apikey: SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({
              bundle: {
                organization_id: orgId,
                file_urls: fileUrls,
                output_name: 'bundle_order_test.pdf',
                expires_seconds: 600,
              },
            }),
          },
          { purpose: `bundle order ${orgId}` },
        );

        const payload = jsonError || !json ? { raw: truncateText(bodyText) } : json;
        if (!resp.ok) {
          throw new Error(`bundle failed: ${resp.status} ${JSON.stringify(payload)}`);
        }

        expect(payload.status).toBe('ok');
        expect(payload.signed_url).toBeTruthy();
        expect(payload.timings?.build_download_concurrency).toBe(25);
        expect(payload.timings?.build_chunk_size).toBe(1);
        expect(payload.counts?.placeholders).toBe(0);
        expect(payload.bundled_labels?.map((row) => row.fileUrl)).toEqual(fileUrls);

        bundlePath = payload.file_path || payload.file_url || null;

        const signed = await verifySignedUrl(payload.signed_url);
        expect(signed.contentType).toContain('application/pdf');
        expect(signed.contentLength).toBeGreaterThan(200);

        const pdfRes = await fetch(payload.signed_url);
        const bytes = new Uint8Array(await pdfRes.arrayBuffer());
        const pdfDoc = await PDFDocument.load(bytes);
        expect(pdfDoc.getPageCount()).toBe(3);

        const pages = pdfDoc.getPages();
        const actualSizes = pages.map((page) => [
          Math.round(page.getWidth()),
          Math.round(page.getHeight()),
        ]);
        expect(actualSizes).toEqual(expectedSizes);
      } finally {
        try {
          const storagePaths = [];
          if (bundlePath) storagePaths.push(bundlePath);
          for (const row of storageFiles) {
            if (row?.storagePath) storagePaths.push(row.storagePath);
          }
          if (storagePaths.length) {
            await removeStoragePaths(
              {
                supabaseUrl: SUPABASE_URL,
                serviceRoleKey: STORAGE_ADMIN_KEY,
                bucket: labelBucket,
                paths: storagePaths,
              },
              { bestEffort: true },
            );
          }

          await client.query(`DELETE FROM labels WHERE shipment_id = $1::uuid`, [shipmentId]);
          await client.query(`DELETE FROM shipment_boxes WHERE shipment_id = $1::uuid`, [shipmentId]);
          await client.query(`DELETE FROM shipments WHERE id = $1::uuid`, [shipmentId]);
          // Address versions are append-only; avoid deleting addresses and parent rows.

          await client.query(
            `DELETE FROM settings WHERE category = 'label_print_policy' AND scope_type = 'tenant' AND scope_id = $1::uuid`,
            [orgId],
          );
          await client.query(
            `DELETE FROM settings_versions WHERE id = $1::uuid AND scope_id = $2::uuid`,
            [settingsVersionId, orgId],
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
