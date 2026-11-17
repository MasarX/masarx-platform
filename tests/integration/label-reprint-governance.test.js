const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { upsertSettings } = require('../utils/policies');
const { loadEnv } = require('../../scripts/utils/load-env');
const { createWorkflowContext } = require('./helpers/tenant-utils');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""))
});

const TEMPLATE_CONFIG = {
  version: '2026-04-07',
  templates: {
    shipping: {
      version: '2.0.0',
      template_key: 'uc184_reprint_template',
      label_type: 'shipping',
      page: {
        width_inch: 4,
        height_inch: 6,
        margin_inch: 0.125,
        dpi: 203,
        orientation: 'portrait'
      },
      assets: [],
      blocks: [
        {
          type: 'text',
          x: 32,
          y: 400,
          font: 'Helvetica-Bold',
          font_size: 18,
          value_path: 'shipment.tracking_number',
          fallback: 'TRACKING-UNKNOWN'
        },
        {
          type: 'text',
          x: 32,
          y: 360,
          font: 'Helvetica',
          font_size: 12,
          value_path: 'recipient.name',
          fallback: 'NO-RECIPIENT'
        }
      ],
      barcode: {
        type: 'CODE128',
        value_path: 'shipment.tracking_number'
      },
      max_attempts: 3,
      retry_backoff_seconds: [30, 120]
    }
  }
};

describe('Label reprint governance', () => {
  let client;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  test('request_label_reprint stores reason and supersedes the prior active label version', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const addressId = randomUUID();
    const shipmentId = randomUUID();
    const shipmentBoxId = randomUUID();
    const actorId = randomUUID();
    const reprintReason = 'barcode_damaged';

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'UC184 Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `uc184-org-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
       VALUES ($1::uuid, $2::uuid, 'UC184 Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
      [clientId, organizationId, `uc184-client-${clientId.slice(0, 8)}`]
    );

    await upsertSettings(
      'label_design',
      'client',
      clientId,
      TEMPLATE_CONFIG,
      'uc184 reprint governance template',
      client
    );

    await client.query(
      `INSERT INTO addresses (
         id, organization_id, client_id, raw_input, city, province, country, validation_status
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'UC184 Address', 'Riyadh', 'Riyadh', 'SA', 'pending'
       )`,
      [addressId, organizationId, clientId]
    );

    await client.query(
      `INSERT INTO shipments (
         id, organization_id, client_id, service_type, tracking_number, status,
         box_count, origin_address_id, destination_address_id, created_at, updated_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'delivery',
         'UC184' || upper(substring($1::text, 1, 8)),
         'pending',
         1,
         $4::uuid,
         $4::uuid,
         now(),
         now()
       )`,
      [shipmentId, organizationId, clientId, addressId]
    );

    await client.query(
      `INSERT INTO shipment_boxes (
         id, shipment_id, organization_id, client_id, box_number, barcode, created_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         1,
         'UC184' || upper(substring($2::text, 1, 8)) || ':1',
         now()
       )`,
      [shipmentBoxId, shipmentId, organizationId, clientId]
    );

    await createWorkflowContext(client, {
      templateName: 'sys_label_generation_v1',
      context: { organization_id: organizationId, client_id: clientId },
      local: true,
    });

    const {
      rows: [{ job_id: initialJobId }],
    } = await client.query(
      `SELECT request_label_generation(
         $1::uuid,
         'shipping',
         NULL,
         'integration_test',
         $2::uuid,
         'primary'
       ) AS job_id`,
      [shipmentId, shipmentBoxId]
    );

    await client.query(
      `SELECT complete_label_job(
         $1::uuid,
         'succeeded',
         $2::text,
         512,
         $3::jsonb,
         NULL
       )`,
      [initialJobId, `labels/${initialJobId}.pdf`, JSON.stringify({ renderer: 'uc184-initial' })]
    );

    const {
      rows: [initialLabel],
    } = await client.query(
      `SELECT id, shipment_id, active_version_id, active_version_number, file_url
         FROM labels
        WHERE shipment_id = $1::uuid`,
      [shipmentId]
    );

    expect(initialLabel).toBeTruthy();
    expect(initialLabel.active_version_id).toBeTruthy();
    expect(initialLabel.active_version_number).toBe(1);

    const {
      rows: [{ job_id: reprintJobId }],
    } = await client.query(
      `SELECT public.request_label_reprint(
         $1::uuid,
         $2::text,
         $3::uuid,
         $4::text
       ) AS job_id`,
      [initialLabel.id, reprintReason, actorId, 'console']
    );

    const {
      rows: [reprintJob],
    } = await client.query(
      `SELECT job_purpose, reprint_reason, source_label_version_id
         FROM label_jobs
        WHERE id = $1::uuid`,
      [reprintJobId]
    );

    expect(reprintJob.job_purpose).toBe('reprint');
    expect(reprintJob.reprint_reason).toBe(reprintReason);
    expect(reprintJob.source_label_version_id).toBe(initialLabel.active_version_id);

    await client.query(
      `SELECT complete_label_job(
         $1::uuid,
         'succeeded',
         $2::text,
         1024,
         $3::jsonb,
         NULL
       )`,
      [reprintJobId, `labels/${reprintJobId}.pdf`, JSON.stringify({ renderer: 'uc184-reprint' })]
    );

    const {
      rows: [activeLabel],
    } = await client.query(
      `SELECT id, active_version_id, active_version_number, file_url, metadata
         FROM labels
        WHERE id = $1::uuid
          AND shipment_id = $2::uuid`,
      [initialLabel.id, shipmentId]
    );

    expect(activeLabel.id).toBe(initialLabel.id);
    expect(activeLabel.active_version_id).not.toBe(initialLabel.active_version_id);
    expect(activeLabel.active_version_number).toBe(2);
    expect(activeLabel.file_url).toBe(`labels/${reprintJobId}.pdf`);
    expect(activeLabel.metadata.reprint_reason).toBe(reprintReason);

    const { rows: versionRows } = await client.query(
      `SELECT
          id,
          label_job_id,
          version_number,
          version_status,
          reprint_reason,
          supersedes_version_id,
          superseded_by_version_id
         FROM label_versions
        WHERE label_id = $1::uuid
        ORDER BY version_number`,
      [initialLabel.id]
    );

    expect(versionRows).toHaveLength(2);
    expect(versionRows[0].version_number).toBe(1);
    expect(versionRows[0].version_status).toBe('superseded');
    expect(versionRows[0].superseded_by_version_id).toBe(versionRows[1].id);
    expect(versionRows[1].label_job_id).toBe(reprintJobId);
    expect(versionRows[1].version_number).toBe(2);
    expect(versionRows[1].version_status).toBe('active');
    expect(versionRows[1].reprint_reason).toBe(reprintReason);
    expect(versionRows[1].supersedes_version_id).toBe(versionRows[0].id);

    const {
      rows: [actionRow],
    } = await client.query(
      `SELECT action_data
         FROM shipment_actions
        WHERE shipment_id = $1::uuid
          AND action_data->>'label_job_id' = $2::text
        ORDER BY created_at DESC
        LIMIT 1`,
      [shipmentId, reprintJobId]
    );

    expect(actionRow.action_data.reprint_reason).toBe(reprintReason);
    expect(actionRow.action_data.label_version_number).toBe(2);
    expect(actionRow.action_data.label_version_id).toBe(versionRows[1].id);
  });
});
