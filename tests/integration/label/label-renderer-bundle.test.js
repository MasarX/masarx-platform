const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { readJsonOrText } = require('../helpers/http');
const {
  ensureLabelPdf,
  fetchWithRetry,
  waitForMetricRow,
} = require('../workflows/helpers/label-print-helpers');
const { ensureStorageBucket, resolveStorageAdminKey } = require('../helpers/storage-admin');
const {
  isAuthSignatureModeError,
  logAuthSignatureModeSkip,
} = require('../helpers/auth-signature-mode');

loadEnv();
jest.setTimeout(300000);

const { SUPABASE_URL, DATABASE_URL } = process.env;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';
const STORAGE_ADMIN_KEY = resolveStorageAdminKey() || SERVICE_ROLE_KEY;
const isTruthy = (value) => /^(1|true|yes)$/i.test(String(value || '').trim());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  logAuthSignatureModeSkip('label-renderer-bundle.test', errorLike);
  return true;
}

if (!SUPABASE_URL || !DATABASE_URL || !SUPABASE_ANON_KEY || !LABEL_RENDERER_JWT || !STORAGE_ADMIN_KEY || skipInPreviewFallback || skipForStrictDbJwtLocal) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('label renderer bundle scope/logging', () => {
    test.skip('skipped: missing env', () => {});
  });
} else {
  const pool = new Pool({ connectionString: DATABASE_URL });

  describe('label renderer bundle scope/logging', () => {
    afterAll(async () => {
      await pool.end();
    });

    test('rejects bundle when organization_id mismatches source token scope', async () => {
      const orgA = randomUUID();
      const orgB = randomUUID();
      const sourceId = randomUUID();
      const mappingId = randomUUID();
      const token = `token-${randomUUID()}`;

      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
           VALUES ($1::uuid, 'Bundle Org A', $2, 'Asia/Riyadh', 'en-US', 'active'),
                  ($3::uuid, 'Bundle Org B', $4, 'Asia/Riyadh', 'en-US', 'active')`,
          [orgA, `bundle-org-a-${orgA.slice(0, 8)}`, orgB, `bundle-org-b-${orgB.slice(0, 8)}`],
        );

        await client.query(
          `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
           VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'bundle scope test mapping')`,
          [mappingId, `bundle-scope-${Date.now()}`],
        );

        await client.query(
          `INSERT INTO webhook_sources (
             id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
           ) VALUES (
             $1::uuid, $2::uuid, $3::text, 'Bundle Scope Source', 'client', $4::text, $5::uuid, TRUE
           )`,
          [sourceId, orgA, `bundle-scope-${sourceId.slice(0, 8)}`, token, mappingId],
        );
      } finally {
        client.release();
      }

      const requestUrl = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`;
      let lastStatus = null;
      let lastBody = null;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await fetchWithRetry(requestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            organization_id: orgB,
            bundle: { organization_id: orgB, file_urls: [] },
          }),
        }, {
          attempts: 6,
          timeoutMs: 30000,
          baseDelayMs: 500,
        });

        lastStatus = response.status;
        lastBody = await readJsonOrText(response);
        if ([401, 403].includes(lastStatus)) {
          expect([401, 403]).toContain(lastStatus);
          return;
        }

        if (![502, 503, 504].includes(lastStatus) || attempt === 3) {
          break;
        }

        await sleep(500 * attempt);
      }

      throw new Error(
        `expected auth rejection status 401/403, received ${lastStatus}: ${JSON.stringify(lastBody)}`,
      );
    });

    test('logs bundle decision and clamps expiry via label_print_policy', async () => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const bundleToken = LABEL_RENDERER_JWT;
      const labelBucket = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';
      // eslint-disable-next-line no-console
      console.log('[bundle-test] Using label bucket:', labelBucket);
      let expectedExpiresSeconds = 120;

      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
           VALUES ($1::uuid, 'Bundle Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
          [orgId, `bundle-org-${orgId.slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
           VALUES ($1::uuid, $2::uuid, 'Bundle Client', $3, 'standard', 'active')`,
          [clientId, orgId, `bundle-client-${clientId.slice(0, 8)}`],
        );

        const { rows: policyRows } = await client.query(
          `SELECT COALESCE(
                    (resolve_settings('label_print_policy', 'tenant', $1::uuid)->>'default_expires_seconds')::int,
                    120
                  ) AS expires_seconds`,
          [orgId],
        );
        expectedExpiresSeconds = Number(policyRows[0]?.expires_seconds || 120);
        await client.query(`DELETE FROM metrics_webhook_events WHERE metric LIKE 'label_bundle.%'`);
      } finally {
        client.release();
      }

      // Ensure storage bucket exists via storage API (idempotent).
      try {
        await ensureStorageBucket({
          supabaseUrl: SUPABASE_URL,
          bucket: labelBucket,
          storageAdminKey: STORAGE_ADMIN_KEY,
        });
      } catch (error) {
        if (skipForAuthSignatureMode(error)) return;
        throw error;
      }

      const filePath = `${orgId}/labels/${randomUUID()}.pdf`;
      await ensureLabelPdf(filePath);
      const response = await fetchWithRetry(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bundleToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          mode: 'bundle',
          organization_id: orgId,
          bundle: { organization_id: orgId, file_urls: [filePath], expires_seconds: 1000000 },
        }),
      });

      const body = await readJsonOrText(response);
      if (response.status !== 200) {
        if (skipForAuthSignatureMode(body)) return;
        // Surface failure reason to help diagnose
        throw new Error(`bundle request failed (${response.status}): ${JSON.stringify(body)}`);
      }
      expect(body.status).toBe('ok');
      expect(body.expires_seconds).toBe(expectedExpiresSeconds);
      expect(body.bundle_id).toBeTruthy();
      const bundleId = body.bundle_id;

      const { rows } = await pool.query(
        `SELECT decision_outcome, decision_inputs FROM decision_log
         WHERE decision_category = 'label_print'
           AND resource_type = 'label_bundle'
           AND resource_id = $1::uuid
         ORDER BY timestamp DESC
         LIMIT 1`,
        [bundleId],
      );

      expect(rows.length).toBe(1);
      expect(rows[0].decision_outcome).toBe('completed');
      expect(rows[0].decision_inputs.bucket).toBe(labelBucket);
      expect(Number(rows[0].decision_inputs.bundle_size_bytes || 0)).toBeGreaterThan(0);
      expect(rows[0].decision_inputs.counts.requested).toBe(1);
      expect(rows[0].decision_inputs.counts.placeholders).toBeGreaterThanOrEqual(0);

      const metricRow = await waitForMetricRow(pool, { metric: 'label_bundle.completed' });
      expect(metricRow).toBeTruthy();
      expect(metricRow.labels.bucket).toBe(labelBucket);
      expect(metricRow.labels.integration).toBe('provider');
      expect(Number(metricRow.data.bundle_size_bytes || 0)).toBeGreaterThan(0);
    });
  });
}
