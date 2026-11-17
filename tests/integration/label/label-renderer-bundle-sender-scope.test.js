const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { removeStoragePrefix } = require('../../../scripts/utils/supabase-storage');
const { upsertSettings } = require('../../utils/policies');
const { ensureLabelPdf, waitForMetricRow } = require('../workflows/helpers/label-print-helpers');
const { fetchJsonWithRetry, truncateText } = require('../helpers/http');
const { ensureStorageBucket, resolveStorageAdminKey } = require('../helpers/storage-admin');
const {
  isAuthSignatureModeError,
  logAuthSignatureModeSkip,
} = require('../helpers/auth-signature-mode');

loadEnv();

jest.setTimeout(180000);

const { SUPABASE_URL, DATABASE_URL } = process.env;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const STORAGE_ADMIN_KEY =
  resolveStorageAdminKey() || SERVICE_ROLE_KEY;
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

function skipForAuthSignatureMode(errorLike) {
  if (!isAuthSignatureModeError(errorLike)) {
    return false;
  }
  logAuthSignatureModeSkip('label-renderer-bundle-sender-scope.test', errorLike);
  return true;
}

if (!SUPABASE_URL || !DATABASE_URL || !SUPABASE_ANON_KEY || !LABEL_RENDERER_JWT || !STORAGE_ADMIN_KEY || skipInPreviewFallback || skipForStrictDbJwtLocal) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('label renderer bundle sender scope', () => {
    test.skip('skipped: missing env', () => {});
  });
} else {
  const LABEL_BUCKET =
    process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

  const pool = new Pool({ connectionString: DATABASE_URL });

  describe('label renderer bundle sender scope', () => {
    afterAll(async () => {
      await pool.end();
    });

    test('bundles only in-scope sender when sender_id is provided', async () => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const addressId = randomUUID();
      const senderA = randomUUID();
      const senderB = randomUUID();

      const shipmentA = randomUUID();
      const shipmentB = randomUUID();
      const boxA = randomUUID();
      const boxB = randomUUID();
      const labelA = randomUUID();
      const labelB = randomUUID();

      const trackingA = `SND${shipmentA.slice(0, 8).toUpperCase()}`;
      const trackingB = `SND${shipmentB.slice(0, 8).toUpperCase()}`;
      const fileUrlA = `${orgId}/labels/${labelA}.pdf`;
      const fileUrlB = `${orgId}/labels/${labelB}.pdf`;
      const labelPrintPolicy = {
        version: 1,
        max_labels_per_bundle: 10,
        default_expires_seconds: 120,
        max_failed_labels: 5,
      };

      const db = await pool.connect();
      try {
        await db.query(
          `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
           VALUES ($1::uuid, 'Bundle Sender Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
          [orgId, `bundle-sender-org-${orgId.slice(0, 8)}`],
        );

        await db.query(
          `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
           VALUES ($1::uuid, $2::uuid, 'Bundle Sender Client', $3, 'standard', 'active')`,
          [clientId, orgId, `bundle-sender-client-${clientId.slice(0, 8)}`],
        );
        await upsertSettings(
          'label_print_policy',
          'global',
          null,
          labelPrintPolicy,
          'bundle sender test policy global fallback',
          db,
        );
        await upsertSettings('label_print_policy', 'tenant', orgId, labelPrintPolicy, 'bundle sender test policy', db);

        await db.query(
          `INSERT INTO addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Test Address', 'Riyadh', 'Riyadh', 'SA', 'pending')`,
          [addressId, orgId, clientId],
        );

        await db.query(
          `INSERT INTO senders (id, client_id, name, status)
           VALUES ($1::uuid, $2::uuid, 'Sender A', 'active'),
                  ($3::uuid, $2::uuid, 'Sender B', 'active')`,
          [senderA, clientId, senderB],
        );

        await db.query(
          `INSERT INTO shipments (
             id, organization_id, client_id, sender_id, service_type, tracking_number, status,
             box_count, origin_address_id, destination_address_id, created_at, updated_at
           ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'delivery', $5, 'pending', 1, $6::uuid, $6::uuid, now(), now()),
           ($7::uuid, $2::uuid, $3::uuid, $8::uuid, 'delivery', $9, 'pending', 1, $6::uuid, $6::uuid, now(), now())`,
          [shipmentA, orgId, clientId, senderA, trackingA, addressId, shipmentB, senderB, trackingB],
        );

        await db.query(
          `INSERT INTO shipment_boxes (
             id, shipment_id, organization_id, client_id, box_number, barcode, created_at
           ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now()),
           ($6::uuid, $7::uuid, $3::uuid, $4::uuid, 1, $8, now())`,
          [boxA, shipmentA, orgId, clientId, `${trackingA}:1`, boxB, shipmentB, `${trackingB}:1`],
        );

        await db.query(
          `INSERT INTO labels (
             id, shipment_id, organization_id, client_id,
             label_type, barcode, barcode_format, layout_template_id,
             file_url, file_size_bytes, generated_by, generated_at, print_count, metadata, renderer_metadata
           ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shipping', $5, 'CODE128', NULL, $6, 0, NULL, now(), 1, '{}'::jsonb, '{}'::jsonb),
           ($7::uuid, $8::uuid, $3::uuid, $4::uuid, 'shipping', $9, 'CODE128', NULL, $10, 0, NULL, now(), 1, '{}'::jsonb, '{}'::jsonb)`,
          [labelA, shipmentA, orgId, clientId, `${trackingA}:1`, fileUrlA, labelB, shipmentB, `${trackingB}:1`, fileUrlB],
        );

        // Ensure label bucket exists via storage API (idempotent).
        try {
          await ensureStorageBucket({
            supabaseUrl: SUPABASE_URL,
            bucket: LABEL_BUCKET,
            storageAdminKey: STORAGE_ADMIN_KEY,
          });
        } catch (error) {
          if (skipForAuthSignatureMode(error)) return;
          throw error;
        }

        await ensureLabelPdf(fileUrlA);
        await ensureLabelPdf(fileUrlB);

        await db.query(`DELETE FROM metrics_webhook_events WHERE metric LIKE 'label_bundle.%'`);

        const { resp, bodyText, json, jsonError } = await fetchJsonWithRetry(
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
              organization_id: orgId,
              bundle: {
                organization_id: orgId,
                client_id: clientId,
                sender_id: senderA,
                file_urls: [fileUrlA, fileUrlB],
              },
            }),
          },
          { purpose: `bundle sender scope ${orgId}` },
        );

        const body = jsonError || !json ? { raw: truncateText(bodyText) } : json;
        if (resp.status !== 200) {
          if (skipForAuthSignatureMode(body)) return;
          throw new Error(`bundle failed: ${resp.status} ${JSON.stringify(body)}`);
        }

        expect(body.status).toBe('ok');
        expect(body.organization_id).toBe(orgId);
        expect(body.client_id).toBe(clientId);
        expect(body.counts.requested).toBe(2);
        expect(body.counts.bundled).toBe(1);
        expect(body.counts.placeholders).toBeGreaterThanOrEqual(1);

        const { rows: decisions } = await db.query(
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

        const metricRow = await waitForMetricRow(db, {
          metric: 'label_bundle.completed',
          whereSql: "labels->>'org' = $2",
          params: [orgId],
          selectSql: 'labels',
        });
        expect(metricRow).toBeTruthy();
        expect(metricRow.labels.org).toBe(orgId);
        expect(metricRow.labels.client).toBe(clientId);
        expect(metricRow.labels.sender).toBe(senderA);
    } finally {
      try {
        await removeStoragePrefix(
          {
            supabaseUrl: SUPABASE_URL,
            serviceRoleKey: STORAGE_ADMIN_KEY,
            bucket: LABEL_BUCKET,
            prefix: `${orgId}/`,
          },
          { bestEffort: true },
        );
        await db.query("DELETE FROM metrics_webhook_events WHERE labels->>'org' = $1", [orgId]);
        await db.query('DELETE FROM decision_log WHERE organization_id = $1::uuid', [orgId]);
        await db.query('DELETE FROM labels WHERE shipment_id = ANY($1::uuid[])', [[shipmentA, shipmentB]]);
        await db.query('DELETE FROM shipment_boxes WHERE id = ANY($1::uuid[])', [[boxA, boxB]]);
          await db.query('DELETE FROM shipments WHERE id = ANY($1::uuid[])', [[shipmentA, shipmentB]]);
          // Address versions are append-only; avoid deleting addresses and parent rows.
          // Keep org/client/sender rows to avoid cascades into address_versions.
        } finally {
          db.release();
        }
      }
    });
  });
}
