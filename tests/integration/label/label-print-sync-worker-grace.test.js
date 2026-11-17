const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertSettings } = require('../../utils/policies');

loadEnv();

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('label print_sync worker grace', () => {
    test.skip('skipped: missing DATABASE_URL', () => {});
  });
} else {
  const pool = new Pool({ connectionString: DATABASE_URL });

  describe('label print_sync worker grace', () => {
    afterAll(async () => {
      await pool.end();
    });

    const seedPrintSyncJob = async (
      client,
      {
        orgId,
        clientId,
        templateId,
        shipmentId,
        shipmentBoxId,
        originAddressId,
        destAddressId,
        trackingNumber,
        idempotencyKey,
      },
    ) => {
      await client.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Print Sync Grace Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
        [orgId, `print-sync-org-${orgId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
         VALUES ($1::uuid, $2::uuid, 'Print Sync Grace Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
        [clientId, orgId, `print-sync-client-${clientId.slice(0, 8)}`],
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
         ) VALUES (
           $1::uuid,
           $2::uuid,
           'print_sync_grace',
           1,
           'tenant',
           $2::uuid,
           jsonb_build_object(
             'page', jsonb_build_object('width_mm', 100, 'height_mm', 150, 'dpi', 203, 'orientation', 'portrait'),
             'blocks', jsonb_build_array()
           ),
           '[]'::jsonb,
           NULL
         )`,
        [templateId, orgId],
      );
      await client.query(
        `INSERT INTO addresses (
           id, organization_id, client_id, raw_input,
           city, province, country, validation_status
         ) VALUES
           ($1::uuid, $3::uuid, $4::uuid, 'Print Sync Origin', 'Riyadh', 'Riyadh', 'SA', 'validated'),
           ($2::uuid, $3::uuid, $4::uuid, 'Print Sync Destination', 'Jeddah', 'Makkah', 'SA', 'pending')`,
        [originAddressId, destAddressId, orgId, clientId],
      );
      await client.query(
         `INSERT INTO shipments (
           id,
           organization_id,
           client_id,
           service_type,
           service_level,
           tracking_number,
           status,
           box_count,
           origin_address_id,
           destination_address_id,
           created_at,
           updated_at
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           'delivery',
           'standard',
           $4::text,
           'pending_dispatch',
           1,
           $5::uuid,
           $6::uuid,
           now(),
           now()
         )`,
        [shipmentId, orgId, clientId, trackingNumber, originAddressId, destAddressId],
      );
      await client.query(
        `INSERT INTO shipment_boxes (
           id,
           shipment_id,
           organization_id,
           client_id,
           box_number,
           barcode,
           weight_kg,
           created_at
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::uuid,
           1,
           $5::text,
           1.5,
           now()
         )`,
        [shipmentBoxId, shipmentId, orgId, clientId, `${trackingNumber}:1`],
      );

      const { rows: workflowRows } = await client.query(
        `SELECT workflow_run_id, workflow_run_step_id
         FROM public.ensure_label_job_workflow_context($1::jsonb)
         LIMIT 1`,
        [JSON.stringify({ organization_id: orgId, client_id: clientId })],
      );
      if (!workflowRows[0]?.workflow_run_step_id) {
        throw new Error('ensure_label_job_workflow_context did not return a workflow step id');
      }

      await client.query(
        `INSERT INTO label_jobs (
           organization_id,
           client_id,
           shipment_id,
           shipment_box_id,
           label_type,
           template_id,
           template_version,
           template_snapshot,
           status,
           attempts,
           max_attempts,
           scheduled_at,
           job_purpose,
           idempotency_key,
           requested_source
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::uuid,
           'shipping',
           $5::uuid,
           1,
           '{}'::jsonb,
           'pending',
           0,
           5,
           now(),
           'primary',
           $6::text,
           'label_print_sync'
         )`,
        [orgId, clientId, shipmentId, shipmentBoxId, templateId, idempotencyKey],
      );
    };

    test('worker leasing skips recent print_sync jobs within grace', async () => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const templateId = randomUUID();
      const shipmentId = randomUUID();
      const shipmentBoxId = randomUUID();
      const originAddressId = randomUUID();
      const destAddressId = randomUUID();
      const trackingNumber = `LBL${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const idempotencyKey = `print-sync-grace:${randomUUID()}`;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await upsertSettings(
          'label_print_policy',
          'tenant',
          orgId,
          {
            version: 1,
            max_labels_per_bundle: 400,
            default_expires_seconds: 900,
            print_sync_worker_grace_seconds: 600,
          },
          'label print sync grace test policy',
          client,
        );

        await seedPrintSyncJob(client, {
          orgId,
          clientId,
          templateId,
          shipmentId,
          shipmentBoxId,
          originAddressId,
          destAddressId,
          trackingNumber,
          idempotencyKey,
        });

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const leaseClient = await pool.connect();
      try {
        const leaseAttempt = await leaseClient.query(
          `SELECT id FROM lease_label_jobs($1::uuid, 120, 1)`,
          [orgId],
        );
        expect(leaseAttempt.rows.length).toBe(0);

        await leaseClient.query(
          `UPDATE label_jobs
           SET created_at = now() - interval '15 minutes'
           WHERE organization_id = $1::uuid AND idempotency_key = $2::text`,
          [orgId, idempotencyKey],
        );

        const leaseAfterGrace = await leaseClient.query(
          `SELECT id FROM lease_label_jobs($1::uuid, 120, 1)`,
          [orgId],
        );
        expect(leaseAfterGrace.rows.length).toBe(1);
        expect(leaseAfterGrace.rows[0].id).toBeTruthy();
      } finally {
        leaseClient.release();
      }
    });

    test('worker leasing honors global grace when tenant policy missing', async () => {
      const orgId = randomUUID();
      const clientId = randomUUID();
      const templateId = randomUUID();
      const shipmentId = randomUUID();
      const shipmentBoxId = randomUUID();
      const originAddressId = randomUUID();
      const destAddressId = randomUUID();
      const trackingNumber = `LBL${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const idempotencyKey = `print-sync-grace-global:${randomUUID()}`;

      const client = await pool.connect();
      let previousGrace = 0;
      try {
        await client.query('BEGIN');
        const { rows: policyRows } = await client.query(
          `SELECT resolve_settings('label_print_policy', 'global', NULL) AS value`,
        );
        const policyValue = policyRows[0]?.value || {};
        previousGrace = Number(policyValue.print_sync_worker_grace_seconds || 0);

        await upsertSettings(
          'label_print_policy',
          'global',
          null,
          {
            version: 1,
            default_expires_seconds: Number(policyValue.default_expires_seconds || 900),
            print_sync_worker_grace_seconds: 600,
          },
          'label print sync grace global test policy',
          client,
        );

        await seedPrintSyncJob(client, {
          orgId,
          clientId,
          templateId,
          shipmentId,
          shipmentBoxId,
          originAddressId,
          destAddressId,
          trackingNumber,
          idempotencyKey,
        });

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const leaseClient = await pool.connect();
      try {
        const leaseAttempt = await leaseClient.query(
          `SELECT id FROM lease_label_jobs($1::uuid, 120, 1)`,
          [orgId],
        );
        expect(leaseAttempt.rows.length).toBe(0);

        await leaseClient.query(
          `UPDATE label_jobs
           SET created_at = now() - interval '15 minutes'
           WHERE organization_id = $1::uuid AND idempotency_key = $2::text`,
          [orgId, idempotencyKey],
        );

        const leaseAfterGrace = await leaseClient.query(
          `SELECT id FROM lease_label_jobs($1::uuid, 120, 1)`,
          [orgId],
        );
        expect(leaseAfterGrace.rows.length).toBe(1);
        expect(leaseAfterGrace.rows[0].id).toBeTruthy();
      } finally {
        await upsertSettings(
          'label_print_policy',
          'global',
          null,
          { print_sync_worker_grace_seconds: previousGrace },
          'restore global grace',
          leaseClient,
        ).catch(() => {});
        leaseClient.release();
      }
    });
  });
}
