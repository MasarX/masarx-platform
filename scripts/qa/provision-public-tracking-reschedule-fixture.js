#!/usr/bin/env node
/*
  Provision a slot-backed local fixture so the public tracking page can exercise
  the live reschedule-date request flow against the real local backend.

  Usage:
    ENV_FILE=path/to/local-config node scripts/qa/provision-public-tracking-reschedule-fixture.js
    ENV_FILE=path/to/local-config node scripts/qa/provision-public-tracking-reschedule-fixture.js --tracking PT-TRACK-002
*/
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const {
  deterministicUuid,
  readDemoManifest,
  ensureBasePublicTrackingFixtures,
} = require('./lib/public-tracking-fixtures');

loadEnv();

function getArg(name, fallback = '') {
  const argv = process.argv.slice(2);
  const directIndex = argv.indexOf(name);
  if (directIndex >= 0) return argv[directIndex + 1] || fallback;
  const prefix = `${name}=`;
  const prefixed = argv.find((entry) => entry.startsWith(prefix));
  if (prefixed) return prefixed.slice(prefix.length) || fallback;
  return fallback;
}

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.error('[provision-public-tracking-reschedule-fixture] DATABASE_URL is required');
  process.exit(2);
}

const TARGET_TRACKING = String(getArg('--tracking', 'PT-TRACK-002')).trim().toUpperCase();
const pool = new Pool({ connectionString: DATABASE_URL });

async function provisionWithClient(client, trackingNumber = TARGET_TRACKING) {
  await ensureBasePublicTrackingFixtures(client, readDemoManifest());

  const shipmentResult = await client.query(
    `
      select
        s.id,
        s.organization_id,
        s.client_id,
        s.sender_id,
        s.tracking_number,
        s.service_level,
        s.zone_id
      from public.shipments s
      where s.tracking_number = $1
      limit 1
    `,
    [String(trackingNumber || TARGET_TRACKING).trim().toUpperCase()]
  );
  const shipment = shipmentResult.rows[0];
  if (!shipment) {
    throw new Error(`Shipment not found for tracking number ${trackingNumber}`);
  }

  const trackingKey = shipment.tracking_number.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const zoneId = deterministicUuid(`public-tracking-reschedule-zone:${shipment.organization_id}:${trackingKey}`);
  const branchId = deterministicUuid(`public-tracking-reschedule-branch:${shipment.organization_id}:${trackingKey}`);
  const capacityWindowId = deterministicUuid(
    `public-tracking-reschedule-window:${shipment.organization_id}:${trackingKey}`
  );
  const zoneSlug = `public-tracking-reschedule-${trackingKey}`;
  const branchCode = `ptr-${trackingKey}`.slice(0, 32);
  const timezone = 'UTC';

  await client.query(
    `
      insert into public.zones (
        id,
        organization_id,
        name,
        slug,
        is_active,
        created_at,
        updated_at
      )
      values (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        true,
        now(),
        now()
      )
      on conflict (id)
      do update set
        organization_id = excluded.organization_id,
        name = excluded.name,
        slug = excluded.slug,
        is_active = true,
        updated_at = now()
    `,
    [zoneId, shipment.organization_id, `Public tracking reschedule ${shipment.tracking_number}`, zoneSlug]
  );

  await client.query(
    `
      insert into public.branches (
        id,
        organization_id,
        code,
        name,
        timezone,
        is_active,
        created_at,
        updated_at
      )
      values (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        $5,
        true,
        now(),
        now()
      )
      on conflict (id)
      do update set
        organization_id = excluded.organization_id,
        code = excluded.code,
        name = excluded.name,
        timezone = excluded.timezone,
        is_active = true,
        updated_at = now()
    `,
    [branchId, shipment.organization_id, branchCode, `Public tracking branch ${shipment.tracking_number}`, timezone]
  );

  await client.query(
    `
      insert into public.branch_zones (branch_id, zone_id)
      values ($1::uuid, $2::uuid)
      on conflict do nothing
    `,
    [branchId, zoneId]
  );

    const promisePolicy = {
      version: 3,
      enabled: true,
      timezone,
      use_branch_timezone: true,
      cutoff_time: '18:00',
      default_service_level: 'standard',
      default_transit_days: 1,
      service_level_transit_days: { standard: 1 },
      delivery_window_start: '09:00',
      delivery_window_end: '18:00',
      calendar_enabled: true,
      calendar_blackout_event_types: ['holiday'],
      calendar_max_shift_days: 7,
      capacity_enabled: true,
      capacity_behavior: 'shift',
      capacity_usage_mode: 'shipments_by_promised_date',
      capacity_limit_key: 'max_shipments',
      capacity_demand: 1,
      capacity_max_shift_days: 7,
    };

  await client.query(
    `
      select public.upsert_settings_value_v1(
        $1::text,
        $2::text,
        $3::uuid,
        $4::jsonb,
        $5::int,
        $6::text
      )
    `,
    [
      'shipment_promise_policy',
      'sender',
      shipment.sender_id,
      JSON.stringify(promisePolicy),
      3,
      'qa public tracking reschedule fixture',
    ]
  );

  await client.query(
    `
      insert into public.branch_capacity_windows (
        id,
        branch_id,
        zone_id,
        effective_from,
        effective_to,
        window_start_local,
        window_end_local,
        capacity,
        is_active,
        metadata,
        created_at,
        updated_at
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        now() - interval '1 day',
        null,
        '09:00'::time,
        '18:00'::time,
        jsonb_build_object('max_shipments', 20),
        true,
        jsonb_build_object('source', 'qa_public_tracking_reschedule_fixture', 'tracking_number', $4::text),
        now(),
        now()
      )
      on conflict (id)
      do update set
        branch_id = excluded.branch_id,
        zone_id = excluded.zone_id,
        effective_from = excluded.effective_from,
        effective_to = excluded.effective_to,
        window_start_local = excluded.window_start_local,
        window_end_local = excluded.window_end_local,
        capacity = excluded.capacity,
        is_active = true,
        metadata = excluded.metadata,
        updated_at = now()
    `,
    [capacityWindowId, branchId, zoneId, String(shipment.tracking_number || '')]
  );

  await client.query(
    `
      update public.shipments
      set
        zone_id = $2::uuid,
        service_level = coalesce(service_level, 'standard'),
        updated_at = now()
      where id = $1::uuid
    `,
    [shipment.id, zoneId]
  );

  const slotsResult = await client.query(
    `
      select slot_date, is_available, reason
      from public.list_delivery_slots_v1(
        jsonb_build_object(
          'shipment_id', $1::uuid,
          'client_id', $2::uuid,
          'start_date', workflow_now()::date,
          'days', 7,
          'include_unavailable', false
        )
      )
      order by slot_date asc
    `,
    [shipment.id, shipment.client_id]
  );

  return {
    tracking_number: shipment.tracking_number,
    zone_id: zoneId,
    branch_id: branchId,
    available_dates: slotsResult.rows.filter((row) => row.is_available === true).map((row) => row.slot_date),
  };
}

async function provision(trackingNumber = TARGET_TRACKING) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await provisionWithClient(client, trackingNumber);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  provision()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error('[provision-public-tracking-reschedule-fixture] error', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

module.exports = {
  provision,
  provisionWithClient,
};
