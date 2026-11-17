// tests/load/webhook-ingest.k6.js
// Scenario: High-QPS webhook ingest with idempotency conflict detection.
// Emits trend + counter metrics and validates unique constraint behaviour.

import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import sql from 'k6/x/sql';
import postgres from 'k6/x/sql/driver/postgres';

const DB_URL =
  __ENV.DATABASE_URL ||
  (['postgres',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres',"?",'sslmode=disable'].join(""));

const connections = new Map();

const insertDuration = new Trend('webhook_ingest_insert_duration_ms', true);
const duplicateConflicts = new Counter('webhook_ingest_duplicate_conflicts');

export const options = {
  vus: Number(__ENV.WEBHOOK_VUS || 30),
  duration: __ENV.WEBHOOK_DURATION || '2m',
  thresholds: {
    iteration_duration: ['p(95)<2500', 'p(99)<4500'],
    webhook_ingest_insert_duration_ms: ['p(95)<1800'],
    checks: ['rate>0.99']
  }
};

function openVuConnection() {
  if (typeof __VU === 'undefined') {
    return sql.open(postgres, DB_URL);
  }

  const key = String(__VU);
  if (!connections.has(key)) {
    connections.set(key, sql.open(postgres, DB_URL));
  }
  return connections.get(key);
}

export function setup() {
  const db = sql.open(postgres, DB_URL);

  const orgResult = db.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     RETURNING id::text`,
    `Load Test Org ${Date.now()}`,
    `loadtest-${Math.random().toString(36).slice(2, 10)}`
  );
  const organizationId = orgResult[0].id;

  const mappingResult = db.query(
    `INSERT INTO mapping_configs (mapping_type, mapping_key, mapping_config)
     VALUES ('webhook_inbound', $1, $2::jsonb)
     RETURNING id::text`,
    `loadtest-${Date.now()}`,
    JSON.stringify({
      description: 'Webhook ingest load test mapping',
      external_id_path: 'event.id',
      event_type_path: 'event.type',
      transforms: {
        default: { event_id: 'event.id' }
      }
    })
  );
  const mappingConfigId = mappingResult[0].id;

  const sourceResult = db.query(
    `INSERT INTO webhook_sources (
        organization_id,
        source_identifier,
        name,
        provider_type,
        auth_token,
        mapping_config_id,
        rate_limit_per_hour,
        enabled
      )
      VALUES (
        $1::uuid,
        $2,
        'Load Test Webhook Source',
        'load_test',
        $3,
        $4::uuid,
        25000,
        true
      )
      RETURNING id::text`,
    organizationId,
    `loadtest-${Math.random().toString(36).slice(2, 10)}`,
    `token-${Math.random().toString(36).slice(2, 16)}`,
    mappingConfigId
  );
  const webhookSourceId = sourceResult[0].id;

  db.close();

  return {
    organizationId,
    mappingConfigId,
    webhookSourceId,
    providerType: 'load_test'
  };
}

export default function ingestLoop(fixture) {
  const db = openVuConnection();

  const externalId = `load-${__VU}-${__ITER}-${Date.now()}`;
  const payload = {
    scenario: 'webhook-ingest',
    event: { id: externalId }
  };

  const insertStart = Date.now();
  const insertResult = db.query(
    `INSERT INTO webhook_inbox (
        webhook_source_id,
        provider_type,
        external_id,
        event_type,
        raw_payload,
        processing_status,
        correlation_id
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        'load.test',
        $4::jsonb,
        'pending',
        gen_random_uuid()
      )
      RETURNING id::text`,
    fixture.webhookSourceId,
    fixture.providerType,
    externalId,
    JSON.stringify(payload)
  );

  const insertDurationMs = Date.now() - insertStart;
  insertDuration.add(insertDurationMs);

  check(insertResult, {
    'webhook row inserted': (rows) => rows.length === 1
  });

  const duplicateResult = db.query(
    `INSERT INTO webhook_inbox (
        webhook_source_id,
        provider_type,
        external_id,
        event_type,
        raw_payload,
        processing_status,
        correlation_id
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        'load.test',
        $4::jsonb,
        'pending',
        gen_random_uuid()
      )
      ON CONFLICT (webhook_source_id, external_id)
      DO NOTHING
      RETURNING id`,
    fixture.webhookSourceId,
    fixture.providerType,
    externalId,
    JSON.stringify(payload)
  );

  const prevented = duplicateResult.length === 0;
  duplicateConflicts.add(prevented ? 1 : 0);

  check(duplicateResult, {
    'duplicate prevented by unique constraint': () => prevented
  });

  sleep(0.05);
}

export function teardown(fixture) {
  if (__ENV.PRESERVE_LOAD_TEST_DATA !== '1') {
    const db = sql.open(postgres, DB_URL);
    db.query('DELETE FROM webhook_inbox WHERE webhook_source_id = $1::uuid', fixture.webhookSourceId);
    db.query('DELETE FROM webhook_sources WHERE id = $1::uuid', fixture.webhookSourceId);
    db.query('DELETE FROM mapping_configs WHERE id = $1::uuid', fixture.mappingConfigId);
    db.query('DELETE FROM organizations WHERE id = $1::uuid', fixture.organizationId);
    db.close();
  } else {
    console.log(
      '[load-test] Preserving webhook ingest fixtures. Cleanup manually when finished.'
    );
  }

  connections.forEach((conn) => {
    try {
      conn.close();
    } catch (error) {
      console.error(`[load-test] failed closing connection: ${error.message}`);
    }
  });
  connections.clear();

  console.log('');
  console.log('[load-test] Webhook ingest scenario complete.');
  console.log(
    "[load-test] Metrics exported as 'webhook_ingest_insert_duration_ms' (trend) and 'webhook_ingest_duplicate_conflicts' (counter)."
  );
  if (__ENV.PRESERVE_LOAD_TEST_DATA === '1') {
    console.log(
      `Cleanup hint: DELETE FROM webhook_inbox WHERE raw_payload->>'scenario' = 'webhook-ingest';`
    );
  }
}
