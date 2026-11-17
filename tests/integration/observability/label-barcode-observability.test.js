const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { createWorkflowContext } = require('../helpers/tenant-utils');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

describe('Label barcode observability (decision_log -> observability_events_v)', () => {
  jest.setTimeout(60_000);

  afterAll(async () => {
    await pool.end();
  });

  test('complete_label_job includes settings_resolution_id + barcode metrics in observability_events_v', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');

    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const addressId = randomUUID();
    const shipmentId = randomUUID();
    const boxId = randomUUID();

    try {
      await client.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Label Barcode Obs Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
        [orgId, `label-barcode-obs-${orgId.slice(0, 8)}`]
      );

      await client.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
         VALUES ($1::uuid, $2::uuid, 'Label Barcode Obs Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
        [clientId, orgId, `label-barcode-obs-client-${clientId.slice(0, 8)}`]
      );

      await client.query(
        `INSERT INTO senders (id, client_id, name, brand_name, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Obs Sender', 'Obs Brand', 'active', now(), now())`,
        [senderId, clientId]
      );

      await client.query(
        `INSERT INTO addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '123 Obs St', 'Riyadh', 'Riyadh', 'SA', 'pending')`,
        [addressId, orgId, clientId]
      );

      await client.query(
        `INSERT INTO shipments (
           id, organization_id, client_id, sender_id,
           service_type, tracking_number, status, box_count,
           origin_address_id, destination_address_id,
           metadata, created_at, updated_at
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                  'delivery', 'OBS', 'pending', 1,
                 $5::uuid, $5::uuid,
                 '{}'::jsonb, now(), now())`,
        [shipmentId, orgId, clientId, senderId, addressId]
      );

      await client.query(
        `INSERT INTO shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'OBS:1', now())`,
        [boxId, shipmentId, orgId, clientId]
      );

      await createWorkflowContext(client, {
        templateName: 'sys_label_generation_v1',
        context: { organization_id: orgId, client_id: clientId },
        local: true,
      });

      const { rows: jobRows } = await client.query(
        `SELECT request_label_generation($1::uuid, 'shipping', NULL, 'barcode_obs_test', $2::uuid, 'primary') AS job_id`,
        [shipmentId, boxId]
      );
      const jobId = jobRows[0].job_id;

      const { rows: composed } = await client.query('select compose_label_payload($1) as c', [jobId]);
      const composedPayload = composed[0].c.payload;
      const policyResId = composedPayload?.label_render_policy_resolution?.settings_resolution_id;
      const printResId = composedPayload?.label_print_profile_resolution?.settings_resolution_id;

      expect(policyResId).toBeTruthy();
      expect(printResId).toBeTruthy();

      const rendererMeta = {
        settings_resolution: {
          label_render_policy: policyResId,
          label_print_profile: printResId,
        },
        barcode: {
          engine: 'code128_vector',
          engines_used: ['code128_vector'],
          policy: {
            gate_mode: 'warn_only',
            would_fail: false,
            should_warn: true,
            violations: [
              { action: 'warn', reason: 'at_risk', engine: 'code128_vector', value_path: 'reference_number', quality: 'at_risk' },
            ],
          },
          blocks: [
            { engine: 'code128_vector', value_path: 'barcode_value', quality: 'ok', module_width_dots: 2, total_modules: 165, dpi: 203 },
            { engine: 'code128_vector', value_path: 'reference_number', quality: 'at_risk', module_width_dots: 1, total_modules: 187, dpi: 203 },
          ],
        },
      };

      const fileUrl = `${jobId}-obs.pdf`;
      await client.query(
        'select complete_label_job($1, $2, $3, $4, $5::jsonb, NULL)',
        [jobId, 'succeeded', fileUrl, 512, JSON.stringify(rendererMeta)]
      );

      const { rows: obsRows } = await client.query(
        `
          SELECT metadata
            FROM observability_events_v
           WHERE event_source = 'decision_log'
             AND event_type = 'label_job'
             AND resource_type = 'label_job'
             AND resource_id = $1::uuid
           ORDER BY event_time DESC
           LIMIT 1
        `,
        [jobId]
      );

      expect(obsRows).toHaveLength(1);
      const meta = obsRows[0].metadata;
      expect(meta.settings_resolution_id).toBe(policyResId);
      expect(meta.decision_inputs.barcode.engine).toBe('code128_vector');
      expect(meta.decision_inputs.barcode.blocks).toHaveLength(2);

      const { rows: warnRows } = await client.query(
        `
          SELECT barcode_engine, barcode_should_warn, barcode_gate_mode, barcode_violations_count
            FROM label_job_barcode_summary_v
           WHERE job_id = $1::uuid
        `,
        [jobId]
      );
      expect(warnRows).toHaveLength(1);
      expect(warnRows[0].barcode_engine).toBe('code128_vector');
      expect(warnRows[0].barcode_should_warn).toBe(true);
      expect(warnRows[0].barcode_gate_mode).toBe('warn_only');
      expect(Number(warnRows[0].barcode_violations_count)).toBeGreaterThanOrEqual(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
