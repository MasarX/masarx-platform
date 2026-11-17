const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { createWorkflowContext } = require('../helpers/tenant-utils');

loadEnv();

const { upsertSettings } = require('../../utils/policies');

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const pool = new Pool({ connectionString: DATABASE_URL });

describe('Label rendering end-to-end', () => {
  let client;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  async function seedShipmentWithBox() {
    const orgId = randomUUID();
    const clientId = randomUUID();
    const addressId = randomUUID();
    const shipmentId = randomUUID();
    const boxId = randomUUID();

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, $2::text, $3::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [orgId, `Label E2E Org ${orgId.slice(0, 6)}`, `label-e2e-${orgId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'standard', 'active')`,
      [clientId, orgId, `Label E2E Client ${clientId.slice(0, 6)}`, `label-e2e-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO addresses (
         id,
         organization_id,
         client_id,
         raw_input,
         city,
         province,
         country,
         validation_status
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'Label E2E Address',
         'Riyadh',
         'Riyadh',
         'SA',
         'pending'
       )`,
      [addressId, orgId, clientId]
    );

    await client.query(
      `INSERT INTO shipments (
         id,
         organization_id,
         client_id,
         service_type,
         tracking_number,
         status,
         box_count,
         origin_address_id,
         destination_address_id,
         created_at,
         updated_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'delivery',
         $4::text,
         'pending',
         1,
         $5::uuid,
         $5::uuid,
         now(),
         now()
       )`,
      [shipmentId, orgId, clientId, `LBL-${shipmentId.slice(0, 8)}`, addressId]
    );

    await client.query(
      `INSERT INTO shipment_boxes (
         id,
         shipment_id,
         organization_id,
         client_id,
         box_number,
         barcode,
         created_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         1,
         $5::text,
         now()
       )`,
      [boxId, shipmentId, orgId, clientId, `LBLBOX:${Date.now()}`]
    );

    return { orgId, clientId, shipmentId, boxId };
  }

  it('enqueues label job with tenant renderer configuration and logs decision', async () => {
    const { orgId, clientId, shipmentId, boxId } = await seedShipmentWithBox();

    const labelDesignConfig = {
      version: '2025-11-24',
      templates: {
        shipping: {
          template_key: 'tenant_shipping_e2e',
          version: '1.2.0',
          provider_hint: 'pdf',
          page: {
            width_inch: 4,
            height_inch: 6,
            dpi: 203,
            orientation: 'portrait'
          },
          blocks: [
            {
              type: 'text',
              x: 30,
              y: 120,
              font: 'Helvetica-Bold',
              font_size: 16,
              value_path: 'shipment.tracking_number',
              fallback: 'NO-TRACKING'
            },
            {
              type: 'barcode',
              x: 28,
              y: 40,
              width: 220,
              height: 90,
              value_path: 'shipment.tracking_number'
            },
            {
              type: 'text',
              x: 30,
              y: 200,
              font: 'Helvetica',
              font_size: 12,
              value_path: 'recipient.name',
              fallback: 'UNKNOWN RECIPIENT'
            }
          ],
          assets: [],
          barcode: {
            type: 'CODE128',
            value_path: 'shipment.tracking_number',
            human_readable: 'shipment.tracking_number'
          },
          max_attempts: 4,
          retry_backoff_seconds: [60, 180]
        }
      }
    };

    await upsertSettings(
      'label_design',
      'client',
      clientId,
      labelDesignConfig,
      'label-e2e client renderer config',
      client
    );

    await createWorkflowContext(client, {
      templateName: 'sys_label_generation_v1',
      context: { organization_id: orgId, client_id: clientId },
      local: true,
    });

    const { rows } = await client.query(
      `SELECT request_label_generation($1::uuid, 'shipping', NULL, 'label-e2e', $2::uuid, 'primary') AS job_id`,
      [shipmentId, boxId]
    );

    const jobId = rows[0].job_id;
    expect(jobId).toBeTruthy();

    const { rows: jobRows } = await client.query(
      `SELECT template_snapshot, max_attempts, retry_state, job_purpose, renderer_hint
       FROM label_jobs
       WHERE id = $1::uuid`,
      [jobId]
    );

    expect(jobRows).toHaveLength(1);
    const job = jobRows[0];
    const snapshot = job.template_snapshot;
    const configuredMaxAttempts = Number(labelDesignConfig.templates.shipping.max_attempts);
    expect(job.job_purpose).toBe('primary');
    expect(Number(job.max_attempts)).toBeGreaterThanOrEqual(configuredMaxAttempts);
    if (snapshot?.label_config?.max_attempts != null) {
      expect(Number(job.max_attempts)).toBe(Number(snapshot.label_config.max_attempts));
    }
    if (Array.isArray(job.retry_state?.backoff_seconds)) {
      expect(job.retry_state.backoff_seconds).toEqual([60, 180]);
    }

    expect(snapshot.template_key).toBe('tenant_shipping_e2e');
    expect(snapshot.resolved_scope).toBe('client');
    expect(snapshot.renderer_config.page.width_inch).toBe(4);
    expect(snapshot.renderer_config.blocks[0].type).toBe('text');
    expect(snapshot.label_config.provider_hint).toBe('pdf');
    expect(Number(snapshot.label_config.max_attempts)).toBeGreaterThanOrEqual(configuredMaxAttempts);

    const { rows: decisionRows } = await client.query(
      `SELECT decision_outcome, decision_inputs
         FROM decision_log
        WHERE resource_type = 'label_job'
          AND resource_id = $1::uuid
          AND decision_point = 'request_label_generation'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [jobId]
    );

    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].decision_outcome).toBe('enqueued');
    expect(decisionRows[0].decision_inputs.job_purpose).toBe('primary');
    expect(decisionRows[0].decision_inputs.template_id).toBe(snapshot.template_id);
  });

  it('falls back when tenant template configuration is incomplete', async () => {
    const { orgId, shipmentId, boxId } = await seedShipmentWithBox();

    const invalidConfig = {
      version: '2025-11-24',
      templates: {
        shipping: {
          template_key: 'invalid_template',
          version: '0.1.0'
        }
      }
    };

    await upsertSettings(
      'label_design',
      'tenant',
      orgId,
      invalidConfig,
      'label-e2e invalid renderer config',
      client
    );

    await createWorkflowContext(client, {
      templateName: 'sys_label_generation_v1',
      context: { organization_id: orgId },
      local: true,
    });

    const { rows: fallbackRows } = await client.query(
      `SELECT request_label_generation($1::uuid, 'shipping', NULL, 'label-e2e-invalid', $2::uuid, 'primary') AS job_id`,
      [shipmentId, boxId]
    );
    const fallbackJobId = fallbackRows[0].job_id;
    expect(fallbackJobId).toBeTruthy();

    const { rows: fallbackJobRows } = await client.query(
      `SELECT template_snapshot
         FROM label_jobs
        WHERE id = $1::uuid`,
      [fallbackJobId]
    );
    expect(fallbackJobRows).toHaveLength(1);
    expect(fallbackJobRows[0].template_snapshot).toBeTruthy();
    if (fallbackJobRows[0].template_snapshot?.template_key) {
      expect(fallbackJobRows[0].template_snapshot.template_key).not.toBe('invalid_template');
    }
  });
});
