const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertSettings } = require('../../utils/policies');
const { fetchJsonWithRetry, truncateText } = require('../helpers/http');
const { createWorkflowContext, clearWorkflowEngineContext } = require('../helpers/tenant-utils');
const { removeStoragePaths } = require('../../../scripts/utils/supabase-storage');
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
const STORAGE_ADMIN_KEY = resolveStorageAdminKey() || SERVICE_ROLE_KEY;
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
const LABEL_BUCKET = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';

function skipForAuthSignatureMode(errorLike) {
  if (!isAuthSignatureModeError(errorLike)) {
    return false;
  }
  logAuthSignatureModeSkip('label-renderer-targets-request.test', errorLike);
  return true;
}

if (
  !SUPABASE_URL ||
  !DATABASE_URL ||
  !SUPABASE_ANON_KEY ||
  !LABEL_RENDERER_JWT ||
  !STORAGE_ADMIN_KEY ||
  skipInPreviewFallback ||
  skipForStrictDbJwtLocal
) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('label renderer target requests', () => {
    test.skip('skipped: missing env', () => {});
  });
} else {
  const pool = new Pool({ connectionString: DATABASE_URL });

  describe('label renderer target requests', () => {
    let client;

    beforeAll(async () => {
      client = await pool.connect();
    });

    afterAll(async () => {
      if (client) await client.release();
      await pool.end();
    });

    const cleanupOrg = async (organizationId, workflowRunId, targetIds = {}) => {
      const { routeRunId = null, handlingUnitId = null, transferId = null, branchIds = [] } = targetIds;

      try {
        await client.query('DELETE FROM decision_log WHERE organization_id = $1::uuid', [organizationId]);
        await client.query('DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid', [organizationId]);
        await client.query('DELETE FROM label_jobs WHERE organization_id = $1::uuid', [organizationId]);
        await client.query('DELETE FROM labels WHERE shipment_id IN (SELECT id FROM shipments WHERE organization_id = $1::uuid)', [organizationId]).catch(() => {});
        await client.query('DELETE FROM route_runs WHERE id = $1::uuid', [routeRunId]).catch(() => {});
        await client.query('DELETE FROM handling_units WHERE id = $1::uuid', [handlingUnitId]).catch(() => {});
        await client.query('DELETE FROM warehouse_transfers WHERE id = $1::uuid', [transferId]).catch(() => {});
        if (branchIds.length > 0) {
          await client.query('DELETE FROM branches WHERE id = ANY($1::uuid[])', [branchIds]).catch(() => {});
        }
        await client.query('DELETE FROM label_design_drafts WHERE organization_id = $1::uuid', [organizationId]).catch(() => {});
        await client.query(
          'DELETE FROM settings WHERE category IN (\'label_design\', \'label_print_policy\') AND scope_type = \'tenant\' AND scope_id = $1::uuid',
          [organizationId],
        ).catch(() => {});
        await client.query(
          'DELETE FROM settings_versions WHERE category IN (\'label_design\', \'label_print_policy\') AND scope_type = \'tenant\' AND scope_id = $1::uuid',
          [organizationId],
        ).catch(() => {});
        if (workflowRunId) {
          await client.query('DELETE FROM workflow_run_steps WHERE workflow_run_id = $1::uuid', [workflowRunId]).catch(() => {});
          await client.query('DELETE FROM workflow_runs WHERE id = $1::uuid', [workflowRunId]).catch(() => {});
        }
      } catch (_err) {
        // Best effort cleanup only.
      }
    };

    test('routes target print requests through the target RPC path', async () => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const routeBranchId = randomUUID();
      const transferFromBranchId = randomUUID();
      const transferToBranchId = randomUUID();
      const routeRunId = randomUUID();
      const handlingUnitId = randomUUID();
      const transferId = randomUUID();
      let workflowContext = null;
      let responseBody = null;
      let responseStatus = null;
      let uploadedPath = null;

      const targetTemplate = {
        version: 1,
        templates: {
          route: {
            template_key: 'standard_4x6',
            version: 1,
            provider_hint: 'internal_renderer',
          },
          container: {
            template_key: 'standard_4x6',
            version: 1,
            provider_hint: 'internal_renderer',
          },
          transfer: {
            template_key: 'standard_4x6',
            version: 1,
            provider_hint: 'internal_renderer',
          },
        },
      };

      const labelPrintPolicy = {
        version: 1,
        default_expires_seconds: 900,
        fresh_generation_required: true,
        print_sync_compact_enabled: true,
        print_sync_bundle_strategy: 'direct',
        print_sync_bundle_return_mode: 'file_path_only',
        render_max_jobs: 4,
        render_job_concurrency: 1,
        render_lease_seconds: 60,
        render_max_calls: 4,
        max_wait_seconds: 120,
      };

      try {
        await client.query(
          `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
           VALUES ($1::uuid, 'Target Label Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
          [orgId, `target-label-org-${orgId.slice(0, 8)}`],
        );

        await client.query(
          `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
           VALUES ($1::uuid, $2::uuid, 'Target Label Client', $3, 'standard', 'active')`,
          [clientId, orgId, `target-label-client-${clientId.slice(0, 8)}`],
        );

        await client.query(
          `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
           VALUES
             ($1::uuid, $2::uuid, $3, 'Target Route Branch', 'Asia/Riyadh', TRUE),
             ($4::uuid, $2::uuid, $5, 'Target Transfer From Branch', 'Asia/Riyadh', TRUE),
             ($6::uuid, $2::uuid, $7, 'Target Transfer To Branch', 'Asia/Riyadh', TRUE)`,
          [
            routeBranchId,
            orgId,
            `target-route-${routeBranchId.slice(0, 8)}`,
            transferFromBranchId,
            `target-transfer-from-${transferFromBranchId.slice(0, 8)}`,
            transferToBranchId,
            `target-transfer-to-${transferToBranchId.slice(0, 8)}`,
          ],
        );

        await client.query(
          `INSERT INTO route_runs (id, organization_id, branch_id, status, planned_date, metadata)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'planned', CURRENT_DATE, '{}'::jsonb)`,
          [routeRunId, orgId, routeBranchId],
        );

        await client.query(
          `INSERT INTO handling_units (id, organization_id, branch_id, unit_type, status, code)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'bag', 'open', $4::text)`,
          [handlingUnitId, orgId, routeBranchId, `HU-${handlingUnitId.slice(0, 8)}`],
        );

        await client.query(
          `INSERT INTO warehouse_transfers (id, organization_id, from_branch_id, to_branch_id, status, transfer_code)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'draft', $5::text)`,
          [transferId, orgId, transferFromBranchId, transferToBranchId, `TR-${transferId.slice(0, 8)}`],
        );

        await client.query(
          `INSERT INTO label_template_specs (
             id,
             organization_id,
             template_key,
             version,
             template_scope_type,
             template_scope_id,
             renderer_config,
             asset_refs,
             created_by
           )
           VALUES (
             $1::uuid,
             $2::uuid,
             'standard_4x6',
             1,
             'tenant',
             $2::uuid,
             jsonb_build_object(
               'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203, 'orientation', 'portrait'),
               'blocks', jsonb_build_array(
                jsonb_build_object('type', 'text', 'x', 24, 'y', 120, 'width', 220, 'height', 24, 'font', 'Helvetica-Bold', 'font_size', 16, 'value_path', 'target.code', 'fallback', 'TARGET'),
                 jsonb_build_object('type', 'barcode', 'x', 24, 'y', 40, 'width', 220, 'height', 72, 'value_path', 'target.code')
               ),
               'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'target.code')
             ),
             '[]'::jsonb,
             NULL
           )`,
          [randomUUID(), orgId],
        );

        await upsertSettings(
          'label_design',
          'tenant',
          orgId,
          targetTemplate,
          'target label template config',
          client,
        );

        await upsertSettings(
          'label_print_policy',
          'tenant',
          orgId,
          labelPrintPolicy,
          'target label print policy',
          client,
        );

        workflowContext = await createWorkflowContext(client, {
          templateName: 'sys_label_generation_v1',
          context: { organization_id: orgId, client_id: clientId },
          local: true,
        });

        await ensureStorageBucket({
          supabaseUrl: SUPABASE_URL,
          bucket: LABEL_BUCKET,
          storageAdminKey: STORAGE_ADMIN_KEY,
        });
      } catch (error) {
        if (skipForAuthSignatureMode(error)) return;
        throw error;
      }

      const requestUrl = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/label-renderer`;
      try {
        const { resp, bodyText, json, jsonError } = await fetchJsonWithRetry(
          requestUrl,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${LABEL_RENDERER_JWT}`,
              apikey: SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({
              mode: 'print',
              organization_id: orgId,
              workflow_run_id: workflowContext.runId,
              workflow_run_step_id: workflowContext.stepId,
              targets: [
                { target_type: 'route', target_id: routeRunId, label_type: 'route' },
                { target_type: 'container', target_id: handlingUnitId, label_type: 'container' },
                { target_type: 'transfer', target_id: transferId, label_type: 'transfer' },
              ],
              expires_seconds: 900,
              output_name: 'target-labels.pdf',
            }),
          },
          { purpose: `target print request ${orgId}` },
        );

        responseStatus = resp.status;
        responseBody = jsonError || !json ? { raw: truncateText(bodyText) } : json;

        const queuedJobs = await client.query(
          `SELECT target_type, target_id, label_type
             FROM label_jobs
            WHERE organization_id = $1::uuid
              AND target_id = ANY($2::uuid[])
            ORDER BY target_type, target_id`,
          [orgId, [routeRunId, handlingUnitId, transferId]],
        );

        expect(queuedJobs.rows).toHaveLength(3);
        expect(queuedJobs.rows.map((row) => row.target_type).sort()).toEqual([
          'handling_unit',
          'route_run',
          'warehouse_transfer',
        ]);

        if (responseStatus === 200) {
          expect(responseBody.status).toBe('ok');
          expect(responseBody.mode).toBe('print_sync');
          expect(responseBody.bundle?.counts?.requested).toBe(3);
          expect(responseBody.bundle?.counts?.bundled).toBeGreaterThanOrEqual(1);
          uploadedPath =
            responseBody.bundle?.file_path ||
            responseBody.bundle?.file_url ||
            responseBody.file_path ||
            responseBody.file_url ||
            null;
        } else {
          expect([500, 503]).toContain(responseStatus);
          const failureText = String(
            responseBody?.error ||
            responseBody?.message ||
            responseBody?.raw ||
            '',
          );
          expect(failureText).toMatch(
            /request_label_generation_target_for_step_v1|request_label_generation_target_v1|label bucket unavailable|storage request failed|bucket/i,
          );
        }
      } catch (error) {
        if (skipForAuthSignatureMode(error)) return;
        throw error;
      } finally {
        if (uploadedPath) {
          await removeStoragePaths(
            {
              supabaseUrl: SUPABASE_URL,
              serviceRoleKey: STORAGE_ADMIN_KEY,
              bucket: LABEL_BUCKET,
              paths: [uploadedPath],
            },
            { bestEffort: true },
          ).catch(() => {});
        }

        await cleanupOrg(orgId, workflowContext?.runId || null, {
          routeRunId,
          handlingUnitId,
          transferId,
          branchIds: [routeBranchId, transferFromBranchId, transferToBranchId],
        });
        await clearWorkflowEngineContext(client, { local: true }).catch(() => {});
      }
    });
  });
}
