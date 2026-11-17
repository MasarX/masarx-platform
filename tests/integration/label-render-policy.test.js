const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { createWorkflowContext, clearWorkflowEngineContext, cleanupWorkflowForLabelJobs } = require('./helpers/tenant-utils');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

describe('label_render_policy (settings ladder) defaults', () => {
  jest.setTimeout(60_000);

  afterAll(async () => {
    await pool.end();
  });

  test('compose_label_payload applies header_brand_mode from ladder unless shipment explicitly overrides', async () => {
    const client = await pool.connect();
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const addressId = randomUUID();
    const shipmentA = randomUUID();
    const shipmentB = randomUUID();
    const boxA = randomUUID();
    const boxB = randomUUID();
    let workflowContext = null;
    const jobIds = [];
    const trackingA = `POLICYA${shipmentA.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const trackingB = `POLICYB${shipmentB.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const barcodeA = `${trackingA}:1`;
    const barcodeB = `${trackingB}:1`;

    const senderPolicyValue = {
      version: 1,
      header_brand_mode: 'text',
      text_defaults: {
        font_regular: 'Helvetica',
        font_bold: 'Helvetica-Bold',
        min_font_size: 6,
        hard_min_font_size: 4,
        line_height_factor: 1.1,
        overflow: 'shrink',
      },
      metrics: { window_minutes: 60, min_samples: 25, slo_p95_render_ms: 4000, slo_p95_total_ms: 8000 },
      arabic: { enabled: false },
    };

    try {
      await client.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Label Policy Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
        [orgId, `label-policy-${orgId.slice(0, 8)}`]
      );

      await client.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
         VALUES ($1::uuid, $2::uuid, 'Label Policy Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
        [clientId, orgId, `label-policy-client-${clientId.slice(0, 8)}`]
      );

      await client.query(
        `INSERT INTO senders (id, client_id, name, brand_name, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Policy Sender', 'Policy Brand', 'active', now(), now())`,
        [senderId, clientId]
      );

      await client.query(
        `INSERT INTO addresses (id, organization_id, client_id, raw_input, city, province, country, validation_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '123 Policy St', 'Riyadh', 'Riyadh', 'SA', 'pending')`,
        [addressId, orgId, clientId]
      );

      // Sender-level override: header_brand_mode=text
      await client.query(
        `SELECT settings_version_id
           FROM upsert_settings_value_v1(
             'label_render_policy',
             'sender',
             $1::uuid,
             $2::jsonb,
             1,
             'test sender override'
           )`,
        [senderId, JSON.stringify(senderPolicyValue)]
      );

      // Shipment A: no explicit header mode -> should use sender policy ("text")
      await client.query(
        `INSERT INTO shipments (
           id, organization_id, client_id, sender_id,
           service_type, tracking_number, status, box_count,
           origin_address_id, destination_address_id,
           metadata, created_at, updated_at
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                  'delivery', $6::text, 'pending', 1,
                 $5::uuid, $5::uuid,
                 '{}'::jsonb, now(), now())`,
        [shipmentA, orgId, clientId, senderId, addressId, trackingA]
      );

      await client.query(
         `INSERT INTO shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode, created_at)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::text, now())`,
        [boxA, shipmentA, orgId, clientId, barcodeA]
      );

      // Shipment B: explicit header mode should win (logo)
      await client.query(
        `INSERT INTO shipments (
           id, organization_id, client_id, sender_id,
           service_type, tracking_number, status, box_count,
           origin_address_id, destination_address_id,
           metadata, created_at, updated_at
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                  'delivery', $6::text, 'pending', 1,
                 $5::uuid, $5::uuid,
                 $7::jsonb, now(), now())`,
        [shipmentB, orgId, clientId, senderId, addressId, trackingB, JSON.stringify({ header_brand_mode: 'logo' })]
      );

      await client.query(
         `INSERT INTO shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode, created_at)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::text, now())`,
        [boxB, shipmentB, orgId, clientId, barcodeB]
      );

      workflowContext = await createWorkflowContext(client, {
        templateName: 'sys_label_generation_v1',
        context: { organization_id: orgId, client_id: clientId, sender_id: senderId },
        local: false,
      });

      const { rows: jobRowsA } = await client.query(
        `SELECT request_label_generation($1::uuid, 'shipping', NULL, 'policy_test', $2::uuid, 'primary') AS job_id`,
        [shipmentA, boxA]
      );
      const jobA = jobRowsA[0].job_id;
      jobIds.push(jobA);

      const { rows: composedA } = await client.query('select compose_label_payload($1) as c', [jobA]);
      expect(composedA[0].c.payload.label_render_policy).toBeTruthy();
      expect(composedA[0].c.payload.shipment_metadata.header_brand_mode).toBe('text');

      const { rows: jobRowsB } = await client.query(
        `SELECT request_label_generation($1::uuid, 'shipping', NULL, 'policy_test', $2::uuid, 'primary') AS job_id`,
        [shipmentB, boxB]
      );
      const jobB = jobRowsB[0].job_id;
      jobIds.push(jobB);
      const { rows: composedB } = await client.query('select compose_label_payload($1) as c', [jobB]);
      expect(composedB[0].c.payload.shipment_metadata.header_brand_mode).toBe('logo');
    } finally {
      const keep = process.env.KEEP_LABEL_POLICY_TEST === '1';
      if (!keep) {
        await cleanupWorkflowForLabelJobs(client, {
          jobIds,
          workflowRunIds: workflowContext?.runId ? [workflowContext.runId] : [],
        });
        await client.query(`DELETE FROM label_jobs WHERE organization_id = $1::uuid`, [orgId]);
        await client.query(`DELETE FROM settings WHERE category='label_render_policy' AND scope_type='sender' AND scope_id = $1::uuid`, [senderId]);
        await client.query(`DELETE FROM settings_versions WHERE category='label_render_policy' AND scope_type='sender' AND scope_id = $1::uuid`, [senderId]);
        await client.query(`DELETE FROM shipment_boxes WHERE shipment_id IN ($1::uuid,$2::uuid)`, [shipmentA, shipmentB]);
        await client.query(`DELETE FROM shipments WHERE id IN ($1::uuid,$2::uuid)`, [shipmentA, shipmentB]);
        // Address versions are append-only; keep org/client/sender records to avoid cascade deletes.
        await client.query(`DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid`, [orgId]);
        await client.query(`DELETE FROM decision_log WHERE organization_id = $1::uuid`, [orgId]);
      }
      await clearWorkflowEngineContext(client, { local: false });
      client.release();
    }
  });
});
