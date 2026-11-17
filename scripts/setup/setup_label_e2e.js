#!/usr/bin/env node
/**
 * Seed data for end-to-end label generation tests.
 *
 * Usage:
 *   node scripts/setup/setup_label_e2e.js --organization-slug <slug> --client-slug <slug>
 *
 * Ensure DATABASE_URL (or local Supabase defaults) is reachable before running.
 */

const { randomUUID } = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const path = require('path');

const { loadEnv } = require('../utils/load-env');
const { parseFlagArgs } = require('../utils/cli-args');

loadEnv();

if (!process.env.DATABASE_URL) { throw new Error('[setup_label_e2e] DATABASE_URL is required.'); }
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({ connectionString });

function usage() {
  // eslint-disable-next-line no-console
  console.log(`
[setup_label_e2e] Usage:
  node scripts/setup/setup_label_e2e.js --organization-slug <slug> --client-slug <slug> [--template-key <key>] [--request-source <source>]

Environment:
  DATABASE_URL is required (ENV_FILE is honored via scripts/utils/load-env.js)
`);
}

const flags = parseFlagArgs(process.argv.slice(2));
const ORG_SLUG = String(
  flags['organization-slug'] || process.env.ORGANIZATION_SLUG || process.env.ORG_SLUG || ''
).trim();
const CLIENT_SLUG = String(flags['client-slug'] || process.env.CLIENT_SLUG || '').trim();
const TEMPLATE_KEY = String(
  flags['template-key'] || process.env.TEMPLATE_KEY || 'standard_4x6'
).trim();
const REQUEST_SOURCE = String(
  flags['request-source'] || process.env.REQUEST_SOURCE || 'label_e2e_setup'
).trim();

if (!ORG_SLUG || !CLIENT_SLUG) {
  usage();
  throw new Error('[setup_label_e2e] --organization-slug and --client-slug are required.');
}

async function upsertRecords(client) {
  const insertedOrgId = randomUUID();
  const orgRes = await client.query(
    `
      INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
      VALUES ($1::uuid, 'Label E2E Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')
      ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name
      RETURNING id
    `,
    [insertedOrgId, ORG_SLUG]
  );
  const organizationId = orgRes.rows[0].id;

  const insertedClientId = randomUUID();
  const clientRes = await client.query(
    `
      INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
      VALUES ($1::uuid, $2::uuid, 'Label E2E Client', $3::text, 'standard', 'active', '{}'::jsonb)
      ON CONFLICT (organization_id, slug) DO UPDATE
        SET name = EXCLUDED.name,
            organization_id = EXCLUDED.organization_id
      RETURNING id
    `,
    [insertedClientId, organizationId, CLIENT_SLUG]
  );
  const clientId = clientRes.rows[0].id;

  await client.query(
    `
      INSERT INTO label_template_specs (
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
        $3::text,
        1,
        'tenant',
        $2::uuid,
        jsonb_build_object(
          'page', jsonb_build_object('width_mm', 100, 'height_mm', 150, 'dpi', 203, 'orientation', 'portrait'),
          'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'box.barcode'),
          'zones', jsonb_build_array(
            jsonb_build_object('type', 'text', 'binding', 'tracking_number', 'x', 16, 'y', 140, 'font', 'open_sans_regular', 'size', 14),
            jsonb_build_object('type', 'text', 'binding', 'recipient_name', 'x', 16, 'y', 120, 'font', 'open_sans_bold', 'size', 12),
            jsonb_build_object('type', 'text', 'binding', 'recipient_phone', 'x', 16, 'y', 100, 'font', 'open_sans_regular', 'size', 12)
          )
        ),
        '[]'::jsonb,
        NULL
      )
      ON CONFLICT DO NOTHING
    `,
    [randomUUID(), organizationId, TEMPLATE_KEY]
  );

  return { organizationId, clientId };
}

async function seedShipment(client, organizationId, clientId) {
  const originAddressId = randomUUID();
  const destinationAddressId = randomUUID();
  const shipmentId = randomUUID();
  const shipmentBoxId = randomUUID();
  const trackingNumber = `LBL${Date.now()}`;
  const boxBarcode = `${trackingNumber}:1`;

  await client.query(
    `
      INSERT INTO addresses (
        id, organization_id, client_id, raw_input,
        city, province, country, validation_status
      )
      VALUES
        ($1::uuid, $2::uuid, $3::uuid, 'Label E2E Origin',
         'Riyadh', 'Riyadh', 'SA', 'validated'),
        ($4::uuid, $2::uuid, $3::uuid, 'Label E2E Destination',
         'Jeddah', 'Makkah', 'SA', 'pending')
      ON CONFLICT (id, client_id) DO NOTHING
    `,
    [originAddressId, organizationId, clientId, destinationAddressId]
  );

  const { rows: shipmentRows } = await client.query(
    `
	      INSERT INTO shipments (
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
	      )
	      VALUES (
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
	      )
      ON CONFLICT (tracking_number, client_id) DO UPDATE
        SET updated_at = EXCLUDED.updated_at
      RETURNING id
    `,
    [shipmentId, organizationId, clientId, trackingNumber, originAddressId, destinationAddressId]
  );

  const resolvedShipmentId = shipmentRows[0].id;

  await client.query(
    `
      INSERT INTO shipment_boxes (
        id,
        shipment_id,
        organization_id,
        client_id,
        box_number,
        barcode,
        weight_kg,
        created_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        1,
        $5::text,
        1.5,
        now()
      )
      ON CONFLICT (shipment_id, box_number) DO UPDATE
        SET
          barcode = EXCLUDED.barcode,
          weight_kg = EXCLUDED.weight_kg,
          created_at = EXCLUDED.created_at
      RETURNING id
    `,
    [shipmentBoxId, resolvedShipmentId, organizationId, clientId, boxBarcode]
  );

  return { shipmentId: resolvedShipmentId, shipmentBoxId };
}

async function queueLabelJob(client, shipmentId, shipmentBoxId) {
  const { rows } = await client.query(
    `
      SELECT request_label_generation(
        $1::uuid,
        'shipping',
        NULL,
        $2::text,
        $3::uuid,
        'primary'
      ) AS job_id
    `,
    [shipmentId, REQUEST_SOURCE, shipmentBoxId]
  );
  return rows[0].job_id;
}

async function main() {
  console.log('Connecting to DATABASE_URL');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { organizationId, clientId } = await upsertRecords(client);
    console.log(`Using organization ${organizationId} / client ${clientId}`);

    const { shipmentId, shipmentBoxId } = await seedShipment(client, organizationId, clientId);
    console.log(`Shipment ${shipmentId} ready (box ${shipmentBoxId})`);

    const jobId = await queueLabelJob(client, shipmentId, shipmentBoxId);
    console.log(`Queued label job ${jobId}`);

    const { rows: payloadRows } = await client.query(
      `SELECT compose_label_payload($1::uuid) AS payload`,
      [jobId]
    );

    await client.query('COMMIT');

    const logsDir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const previewPath = path.join(logsDir, `label_payload_preview_${jobId}.json`);
    fs.writeFileSync(previewPath, JSON.stringify(payloadRows[0].payload, null, 2));

    console.log(`Payload preview written to ${previewPath}`);
    console.log('\nNext steps:');
    console.log(
      `  1. Run the label renderer edge function (local or Supabase) so it leases job ${jobId}.`
    );
    console.log(
      `  2. Verify output in storage bucket 'labels' or table labels (shipment_id = ${shipmentId}).`
    );
    console.log('  3. Record evidence under docs/ops/evidence/<date>/label_generation_e2e.log.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to prepare label E2E data:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Unexpected failure:', err);
  process.exitCode = 1;
});


