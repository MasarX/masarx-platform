#!/usr/bin/env node
/*
  Provision reproducible local QA fixtures for the customer shipment change
  review workspace. Creates:
    - one auto-applied reschedule_date request
    - two pending_review location_change requests

  Usage:
    ENV_FILE=config/env/.env.local node scripts/qa/provision-customer-shipment-change-review-fixtures.js
*/
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { withCustomerShipmentChangeFixtureLock } = require('./lib/customer-shipment-change-fixtures');
const {
  readDemoManifest,
  ensureBasePublicTrackingFixtures,
} = require('./lib/public-tracking-fixtures');
const {
  provisionWithClient: provisionRescheduleFixtureWithClient,
} = require('./provision-public-tracking-reschedule-fixture');

loadEnv();

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.error('[provision-customer-shipment-change-review-fixtures] DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function rpcOne(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

async function getShipment(client, trackingNumber) {
  const row = await rpcOne(
    client,
    `
      select id, organization_id, client_id, sender_id, tracking_number
      from public.shipments
      where tracking_number = $1
      limit 1
    `,
    [trackingNumber]
  );
  if (!row) throw new Error(`shipment not found: ${trackingNumber}`);
  return row;
}

async function verifySession(client, reference, phoneLast3, ipHash) {
  const row = await rpcOne(
    client,
    `
      select public.public_tracking_verify_v1(
        jsonb_build_object(
          'reference', $1::text,
          'phone_last3', $2::text,
          'ip_hash', $3::text
        )
      ) as data
    `,
    [reference, phoneLast3, ipHash]
  );
  const payload = row?.data || {};
  if (payload.ok !== true || !payload.session_token) {
    throw new Error(`verify failed for ${reference}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function submitRequest(client, sessionToken, ipHash, requestType, payload) {
  const row = await rpcOne(
    client,
    `
      select public.public_tracking_submit_request_v2(
        jsonb_build_object(
          'session_token', $1::text,
          'ip_hash', $2::text,
          'request_type', $3::text,
          'payload', $4::jsonb
        )
      ) as data
    `,
    [sessionToken, ipHash, requestType, JSON.stringify(payload)]
  );
  return row?.data || {};
}

async function setReviewRequiredPolicy(client, shipment) {
  await client.query(
    `
      select public.upsert_settings_value_v1(
        'public_tracking_policy',
        'sender',
        $1::uuid,
        public.deep_merge_jsonb(
          public.public_tracking_policy_v1(
            jsonb_build_object(
              'organization_id', $2::uuid,
              'client_id', $3::uuid,
              'sender_id', $1::uuid
            )
          ),
          jsonb_build_object(
            'actions',
            jsonb_build_object(
              'location_change',
              jsonb_build_object('execution_mode', 'review_required')
            )
          )
        ),
        1,
        'qa customer shipment change review fixtures'
      )
    `,
    [shipment.sender_id, shipment.organization_id, shipment.client_id]
  );
}

async function restoreDefaultPolicy(client, shipment) {
  await client.query(
    `
      select public.upsert_settings_value_v1(
        'public_tracking_policy',
        'sender',
        $1::uuid,
        public.deep_merge_jsonb(
          public.public_tracking_policy_v1(
            jsonb_build_object(
              'organization_id', $2::uuid,
              'client_id', $3::uuid,
              'sender_id', $1::uuid
            )
          ),
          jsonb_build_object(
            'actions',
            jsonb_build_object(
              'location_change',
              jsonb_build_object('execution_mode', 'auto_apply_with_fallback_to_review')
            )
          )
        ),
        1,
        'restore public tracking location change execution mode after qa fixtures'
      )
    `,
    [shipment.sender_id, shipment.organization_id, shipment.client_id]
  );
}

async function fetchCaseSummary(client, supportCaseId) {
  if (!supportCaseId) {
    throw new Error('support_case_id is required to fetch case summary');
  }
  const row = await rpcOne(
    client,
    `
      select
        sc.id,
        sc.status,
        sc.status_reason,
        sc.request_type_key,
        sc.request_outcome,
        sc.tracking_number,
        sc.change_summary,
        sc.changed_fields,
        sc.metadata #> array['review_task'] as review_task
      from public.support_cases sc
      where sc.id = $1::uuid
      limit 1
    `,
    [supportCaseId]
  );

  const notifications = await client.query(
    `
      select body->>'stage' as stage
      from public.outbound_calls
      where context->>'support_case_id' = $1::text
      order by created_at asc
    `,
    [supportCaseId]
  );

  const tasks = await client.query(
    `
      select id
      from public.tasks
      where resource_type = 'support_case'
        and resource_id = $1::uuid
      order by created_at desc
    `,
    [supportCaseId]
  );

  return {
    ...row,
    notification_stages: notifications.rows.map((entry) => entry.stage),
    task_ids: tasks.rows.map((entry) => entry.id),
  };
}

async function withFixtureProvisionLock(client, fn) {
  const lockKey = "qa:customer-shipment-change-review-fixtures";
  await client.query(`select pg_advisory_lock(hashtextextended($1::text, 0))`, [lockKey]);
  try {
    return await fn();
  } finally {
    await client.query(`select pg_advisory_unlock(hashtextextended($1::text, 0))`, [lockKey]);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query(
      `select pg_advisory_lock(hashtext('qa.provision_customer_shipment_change_review_fixtures_v1'))`
    );

    const demo = readDemoManifest();
    const provision = async () => {
      await ensureBasePublicTrackingFixtures(client, demo);
      const rescheduleFixture = await provisionRescheduleFixtureWithClient(client, 'PT-TRACK-002');
      const shipmentOne = await getShipment(client, 'PT-TRACK-001');
      const shipmentTwo = await getShipment(client, 'PT-TRACK-002');
      const runToken = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const runDigits = runToken.slice(-4);

      const rescheduleSession = await verifySession(
        client,
        'PT-TRACK-002',
        '456',
        `qa-reschedule-verify-${runToken}`
      );
      const verifiedAvailableDates = Array.isArray(
        rescheduleSession?.tracking?.actions?.reschedule?.available_dates
      )
        ? rescheduleSession.tracking.actions.reschedule.available_dates
            .map((value) => String(value || '').trim().slice(0, 10))
            .filter(Boolean)
        : [];
      const promisedDate = String(
        rescheduleSession?.tracking?.shipment?.promised_delivery_date || ''
      ).trim();
      const rescheduleDate =
        verifiedAvailableDates.find((value) => value && value !== promisedDate) ||
        (Array.isArray(rescheduleFixture.available_dates)
          ? String(rescheduleFixture.available_dates[0] || '').trim().slice(0, 10)
          : '');
      if (!rescheduleDate) {
        throw new Error('reschedule fixture did not expose an available delivery date');
      }
      const timingChange = await submitRequest(
        client,
        rescheduleSession.session_token,
        `qa-reschedule-request-${runToken}`,
        'reschedule_date',
        { requested_date: rescheduleDate }
      );
      const appliedLocation = await submitRequest(
        client,
        rescheduleSession.session_token,
        `qa-location-applied-${runToken}`,
        'location_change',
        {
          address_text: `Customer applied fixture ${runToken}`,
          short_national_address: `QAPL${runDigits}`,
          map_pin: { lat: 24.7061, lng: 46.6818 },
          landmark: `Applied landmark ${runToken}`,
          drop_point: `Applied drop point ${runToken}`,
          notes: `Applied location fixture ${runToken}`,
        }
      );

      await setReviewRequiredPolicy(client, shipmentOne);
      const reviewSession = await verifySession(
        client,
        'PT-TRACK-001',
        '123',
        `qa-review-verify-${runToken}`
      );

      const pendingA = await submitRequest(
        client,
        reviewSession.session_token,
        `qa-review-request-a-${runToken}`,
        'location_change',
        {
          address_text: `Customer review fixture A ${runToken}`,
          short_national_address: `QARE${runDigits}`,
          map_pin: { lat: 24.7136, lng: 46.6753 },
          landmark: `Review landmark A ${runToken}`,
          drop_point: `Review drop point A ${runToken}`,
          notes: `Review queue fixture A ${runToken}`,
        }
      );

      const pendingB = await submitRequest(
        client,
        reviewSession.session_token,
        `qa-review-request-b-${runToken}`,
        'location_change',
        {
          address_text: `Customer review fixture B ${runToken}`,
          short_national_address: `QBRV${runDigits}`,
          map_pin: { lat: 24.7192, lng: 46.6891 },
          landmark: `Review landmark B ${runToken}`,
          drop_point: `Review drop point B ${runToken}`,
          notes: `Review queue fixture B ${runToken}`,
        }
      );

      await restoreDefaultPolicy(client, shipmentOne);

      return {
        generated_at: new Date().toISOString(),
        tracking_numbers: {
          timing_change: shipmentTwo.tracking_number,
          applied_location_change: shipmentTwo.tracking_number,
          pending_review_primary: shipmentOne.tracking_number,
          pending_review_secondary: shipmentOne.tracking_number,
        },
        support_cases: {
          timing_change: await fetchCaseSummary(client, timingChange.support_case_id),
          applied_location_change: await fetchCaseSummary(client, appliedLocation.support_case_id),
          pending_review_primary: await fetchCaseSummary(client, pendingA.support_case_id),
          pending_review_secondary: await fetchCaseSummary(client, pendingB.support_case_id),
        },
        available_dates: rescheduleFixture.available_dates,
      };
    };
    const summary = await withCustomerShipmentChangeFixtureLock(client, () =>
      withFixtureProvisionLock(client, provision),
    );

    const outputPath = path.resolve(
      process.cwd(),
      'tmp',
      'customer-shipment-change-review-fixtures.json'
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify(summary, null, 2));
    console.error(`[provision-customer-shipment-change-review-fixtures] wrote ${outputPath}`);
  } finally {
    try {
      await client.query(
        `select pg_advisory_unlock(hashtext('qa.provision_customer_shipment_change_review_fixtures_v1'))`
      );
    } catch (_error) {
      // Ignore unlock failures during local fixture teardown.
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    '[provision-customer-shipment-change-review-fixtures] error',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
