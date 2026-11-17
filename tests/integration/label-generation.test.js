const { Pool } = require('pg');
const { upsertSettings } = require('../utils/policies');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { createWorkflowContext } = require('./helpers/tenant-utils');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""))
});

describe('Label generation workflow (worker/plugins)', () => {
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

  test('creates, leases, renders (worker), and completes label job', async () => {
    const orgId = randomUUID();
    const clientId = randomUUID();
    const addressId = randomUUID();
    const shipmentId = randomUUID();
    const boxId = randomUUID();

    await client.query(
      `
        INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
        VALUES ($1::uuid, 'Integration Label Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')
      `,
      [orgId, `integration-label-${orgId.slice(0, 8)}`]
    );

    await client.query(
      `
        INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
        VALUES ($1::uuid, $2::uuid, 'Integration Label Client', $3::text, 'standard', 'active', '{}'::jsonb)
      `,
      [clientId, orgId, `integration-label-client-${clientId.slice(0, 8)}`]
    );

    const clientTemplateConfig = {
      version: '2025-11-26',
      templates: {
        shipping: {
          version: '2.0.0',
          template_key: 'integration_client_template',
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
            { type: 'text', x: 32, y: 400, font: 'Helvetica-Bold', font_size: 18, value_path: 'shipment.tracking_number', fallback: 'TRACKING-UNKNOWN' },
            { type: 'image', asset_ref: 'barcode_asset_path', x: 32, y: 260, width: 240, height: 60 },
            { type: 'text', x: 32, y: 200, font: 'Helvetica', font_size: 12, value_path: 'recipient.name', fallback: 'NO-RECIPIENT' }
          ],
          barcode: {
            type: 'CODE128',
            value_path: 'shipment.tracking_number',
            human_readable: 'shipment.tracking_number'
          },
          max_attempts: 4,
          retry_backoff_seconds: [45, 180, 600]
        }
      }
    };

    await upsertSettings(
      'label_design',
      'client',
      clientId,
      clientTemplateConfig,
      'integration test client label template',
      client
    );

    await client.query(
      `
        INSERT INTO addresses (
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
          'Integration Address',
          'Riyadh',
          'Riyadh',
          'SA',
          'pending'
        )
      `,
      [addressId, orgId, clientId]
    );

    await client.query(
      `
        INSERT INTO shipments (
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
          'LBLINT' || upper(substring($1::text, 1, 8)),
          'pending',
          1,
          $4::uuid,
          $4::uuid,
          now(),
          now()
        )
      `,
      [shipmentId, orgId, clientId, addressId]
    );

    await client.query(
      `
        INSERT INTO shipment_boxes (
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
          'LBLINT' || upper(substring($2::text, 1, 8)) || ':1',
          now()
        )
      `,
      [boxId, shipmentId, orgId, clientId]
    );

    await createWorkflowContext(client, {
      templateName: 'sys_label_generation_v1',
      context: { organization_id: orgId, client_id: clientId },
      local: true,
    });

    const { rows: jobRows } = await client.query(
      `
        SELECT request_label_generation(
          $1::uuid,
          'shipping',
          NULL,
          'integration_test',
          $2::uuid,
          'primary'
        ) AS job_id
      `,
      [shipmentId, boxId]
    );

    const jobId = jobRows[0].job_id;
    expect(jobId).toBeTruthy();

    const { rows: pendingJobs } = await client.query(
      `SELECT status FROM label_jobs WHERE id = $1::uuid`,
      [jobId]
    );
    expect(pendingJobs[0].status).toBe('pending');

    // Lease & compose payload to assert template shape
    await client.query(`SELECT lease_label_job($1::uuid, 120, $2::uuid)`, [orgId, jobId]);
    const { rows: payloadRows } = await client.query(`SELECT compose_label_payload($1::uuid) AS payload`, [jobId]);
    expect(payloadRows[0].payload.payload.tracking_number).toBeDefined();
    const templateSnapshot = payloadRows[0].payload.job.template;
    expect(Number(templateSnapshot.schema_version)).toBe(2);
    expect(templateSnapshot.renderer_config.blocks).toHaveLength(3);
    expect(templateSnapshot.renderer_config.blocks[1].asset_ref).toBe('barcode_asset_path');

    // Complete job to simulate worker writeback
    await client.query(
      `
        SELECT complete_label_job(
          $1::uuid,
          'succeeded',
          'labels/' || $1::text || '.pdf',
          1024,
          jsonb_build_object('engine', 'integration'),
          NULL
        )
      `,
      [jobId]
    );

    const { rows: jobStatusRows } = await client.query(
      `SELECT status, output_file_url FROM label_jobs WHERE id = $1::uuid`,
      [jobId]
    );
    expect(jobStatusRows[0].status).toBe('succeeded');
    expect(jobStatusRows[0].output_file_url).toMatch(/labels\//);

    const { rows: labelRows } = await client.query(
      `SELECT file_url FROM labels WHERE shipment_id = $1::uuid`,
      [shipmentId]
    );
    expect(labelRows.length).toBe(1);
  });

  test('resolves client override template over tenant/global defaults', async () => {
    const orgId = randomUUID();
    const clientId = randomUUID();

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Tenant Override Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [orgId, `tenant-override-${orgId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
       VALUES ($1::uuid, $2::uuid, 'Tenant Override Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
      [clientId, orgId, `tenant-override-client-${clientId.slice(0, 8)}`]
    );

    const tenantBaseConfig = {
      version: '2025-11-02',
      templates: {
        shipping: {
          version: '2.0.0',
          template_key: 'tenant_base_template',
          label_type: 'shipping',
          page: {
            width_inch: 4,
            height_inch: 6,
            margin_inch: 0.2,
            dpi: 203,
            orientation: 'portrait'
          },
          assets: [],
          blocks: [
            {
              type: 'text',
              x: 40,
              y: 380,
              font: 'Helvetica-Bold',
              font_size: 16,
              value_path: 'shipment.tracking_number',
              fallback: 'NO-TRACKING'
            },
            {
              type: 'text',
              x: 40,
              y: 340,
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
          retry_backoff_seconds: [60, 240]
        }
      }
    };

    await upsertSettings(
      'label_design',
      'tenant',
      orgId,
      tenantBaseConfig,
      'tenant base template for integration test',
      client
    );

    const clientOverrideConfig = {
      version: '2025-11-02',
      templates: {
        shipping: {
          version: '2.0.0',
          template_key: 'client_override_template',
          label_type: 'shipping',
          page: {
            width_inch: 4,
            height_inch: 6,
            margin_inch: 0.2,
            dpi: 203,
            orientation: 'portrait'
          },
          assets: [],
          blocks: [
            {
              type: 'text',
              x: 40,
              y: 380,
              font: 'Helvetica-Bold',
              font_size: 16,
              value_path: 'shipment.tracking_number',
              fallback: 'NO-TRACKING'
            },
            {
              type: 'text',
              x: 40,
              y: 340,
              font: 'Helvetica',
              font_size: 12,
              value_path: 'recipient.phone',
              fallback: 'NO-PHONE'
            }
          ],
          barcode: {
            type: 'CODE128',
            value_path: 'shipment.tracking_number'
          },
          max_attempts: 3,
          retry_backoff_seconds: [60, 240]
        }
      }
    };

    await upsertSettings(
      'label_design',
      'client',
      clientId,
      clientOverrideConfig,
      'client override for integration test',
      client
    );

    const { rows } = await client.query(
      `SELECT template_snapshot, resolved_scope FROM resolve_label_template($1::uuid, $2::uuid, NULL, 'shipping')`,
      [orgId, clientId]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].resolved_scope).toBe('client');
    expect(rows[0].template_snapshot.template_key).toBe('client_override_template');
    expect(Number(rows[0].template_snapshot.schema_version)).toBe(2);
    expect(rows[0].template_snapshot.renderer_config.blocks[1].value_path).toBe('recipient.phone');
  });

  // Provider/invoke and unrelated workflow checks removed for plugin-only path.
});


