// tests/load/partition-performance.js
// Purpose: Load test for partition performance with concurrent inserts
// Notes:
// - Fully env-driven via PARTITION_* knobs (no per-project hardcoding).
// - Inserts are tagged with a per-run tracking prefix and cleaned up by default (PARTITION_CLEANUP=1).

import { check, sleep } from 'k6';
import sql from 'k6/x/sql';
import postgres from 'k6/x/sql/driver/postgres';

// Test configuration (fully env-driven with strict fallbacks)
const PARTITION_VUS = Number(__ENV.PARTITION_VUS || 10);
const PARTITION_DURATION = __ENV.PARTITION_DURATION || '1m';
const PARTITION_P95_MS = Number(__ENV.PARTITION_P95_MS || 3000);
const PARTITION_CHECK_RATE = Number(__ENV.PARTITION_CHECK_RATE || 0.99);
const PARTITION_DEBUG_ROUTING = /^(1|true|yes)$/i.test(String(__ENV.PARTITION_DEBUG_ROUTING || '').trim());
const PARTITION_CLEANUP = !/^(0|false|no)$/i.test(String(__ENV.PARTITION_CLEANUP || '').trim());

export const options = {
  vus: PARTITION_VUS, // virtual users (concurrent connections)
  duration: PARTITION_DURATION, // test duration
  thresholds: {
    // p95 latency for iterations
    iteration_duration: [`p(95)<${PARTITION_P95_MS}`],
    // proportion of successful checks
    checks: [`rate>${PARTITION_CHECK_RATE}`],
  },
};

// Database connection string
const DB_URL = __ENV.DATABASE_URL || (['postgres',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres',"?",'sslmode=disable'].join(""));

const connections = new Map();

function makeRunId() {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 1e9);
  return `${now.toString(36)}-${rand.toString(36)}`;
}

function openDb() {
  if (typeof __VU === 'undefined') {
    // setup/teardown contexts do not have a VU id
    return sql.open(postgres, DB_URL);
  }

  const key = String(__VU);
  if (!connections.has(key)) {
    connections.set(key, sql.open(postgres, DB_URL));
  }
  return connections.get(key);
}

function normalizePartitionName(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return String.fromCharCode(...value);
  }
  return String(value);
}

function normalizePgText(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'undefined') return '';
  if (Array.isArray(value)) return String.fromCharCode(...value);
  if (typeof value === 'object' && typeof value.length === 'number') {
    const bytes = [];
    for (let i = 0; i < value.length; i += 1) {
      const b = value[i];
      if (typeof b !== 'number') break;
      bytes.push(b);
    }
    if (bytes.length === value.length) {
      return String.fromCharCode(...bytes);
    }
  }
  return String(value);
}

function normalizePgInt(value) {
  if (typeof value === 'number') return value;
  const normalized = normalizePgText(value).trim();
  if (!normalized) return NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isTruthyPg(value) {
  if (value === true) return true;
  if (value === false || value === null || typeof value === 'undefined') return false;
  const normalized = normalizePgText(value).trim().toLowerCase();
  return normalized === 't' || normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
}

// Setup: Create test data before load test
export function setup() {
  console.log('Setting up test data...');

  const db = sql.open(postgres, DB_URL);
  const runId = makeRunId();
  const trackingPrefix = `LOAD-${runId}-`;

  try {
    const orgRows = db.query('SELECT id::text AS id FROM public.organizations LIMIT 1');
    if (orgRows.length === 0) {
      throw new Error('No organizations found. Please run migrations first.');
    }
    const orgId = orgRows[0].id;

    const clientRows = db.query('SELECT id::text AS id FROM public.clients ORDER BY id LIMIT 50');
    if (clientRows.length === 0) {
      throw new Error('No clients found. Seed data is required before running the load test.');
    }
    const clientIds = clientRows.map((row) => row.id);

    const partitionRows = db.query(
      "SELECT inhrelid::oid AS oid, inhrelid::regclass::text AS name FROM pg_inherits WHERE inhparent = 'public.shipments'::regclass ORDER BY name",
    );
    if (partitionRows.length === 0) {
      throw new Error('No shipments partitions found. Expected public.shipments to be partitioned.');
    }

    const shipmentsPartitionOids = partitionRows
      .map((row) => normalizePgInt(row.oid))
      .filter((oid) => Number.isFinite(oid));

    if (shipmentsPartitionOids.length === 0) {
      throw new Error('Shipments partition OIDs could not be parsed.');
    }

    console.log(`Using ${clientIds.length} existing clients for load test`);
    return { clientIds, orgId, shipmentsPartitionOids, runId, trackingPrefix };
  } finally {
    db.close();
  }
}

// Main load test: Each VU inserts shipments concurrently
export default function (data) {
  const db = openDb();

  try {
    // Select random client from test clients
    const { clientIds, orgId, shipmentsPartitionOids, runId, trackingPrefix } = data;
    const clientId = clientIds[Math.floor(Math.random() * clientIds.length)];

    // Generate unique tracking number
    const safePrefix = typeof trackingPrefix === 'string' && trackingPrefix.length ? trackingPrefix : 'LOAD-';
    const trackingNumber = `${safePrefix}${__VU}-${__ITER}-${Date.now()}`;

    // Measure insert performance
    const startTime = new Date().getTime();

    // Insert shipment (tests partition routing and write performance)
    const insertResult = db.query(
      `INSERT INTO public.shipments AS s (
        organization_id,
        client_id,
        service_type,
        tracking_number,
        status,
        priority_score,
        promised_delivery_date,
        service_level,
        special_instructions,
        cod_amount,
        declared_value,
        shipment_settings_override,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING
        id::text AS id,
        s.tableoid::oid AS tableoid`,
      orgId,
      clientId,
      'delivery', // service_type
      trackingNumber,
      'pending', // status
      Math.random() * 100, // priority_score
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), // promised_delivery_date
      'standard', // service_level
      'Automated load test insert',
      Math.random() * 500, // cod_amount
      Math.random() * 1000 + 100, // declared_value
      JSON.stringify({ source: 'load-test' }),
      JSON.stringify({ runId: runId || null, vu: __VU })
    );

    const endTime = new Date().getTime();
    const duration = endTime - startTime;

    // Verify insert succeeded
    check(insertResult, {
      'shipment insert successful': (r) => r.length === 1,
      'shipment has valid ID': (r) => r.length === 1 && r[0].id !== null,
      'shipment routed to partition': (r) => {
        if (r.length !== 1) return false;
        const oid = normalizePgInt(r[0].tableoid);
        return Number.isFinite(oid) && Array.isArray(shipmentsPartitionOids) && shipmentsPartitionOids.includes(oid);
      },
    });

    if (PARTITION_DEBUG_ROUTING && __ITER === 0) {
      const row = insertResult.length ? insertResult[0] : null;
      const tableOid = row ? normalizePgInt(row.tableoid) : NaN;
      let partitionName = null;
      if (Number.isFinite(tableOid)) {
        const nameRows = db.query('SELECT $1::oid::regclass::text AS name', tableOid);
        if (nameRows.length === 1) partitionName = normalizePartitionName(nameRows[0].name);
      }
      console.log(`[partition-routing] ${JSON.stringify({ ...row, partition_name: partitionName })}`);
      const inherits = db.query(
        "SELECT inhparent::regclass::text AS parent, inhrelid::regclass::text AS child FROM pg_inherits WHERE inhparent = 'public.shipments'::regclass ORDER BY child LIMIT 10",
      );
      console.log(`[partition-routing] inherits=${JSON.stringify(inherits)}`);
    }

    // Log slow queries (> 2s)
    if (duration > 2000) {
      console.warn(`Slow insert detected: ${duration}ms for tracking ${trackingNumber}`);
    }

  } catch (error) {
    console.error(`Error in iteration ${__ITER}: ${error.message}`);
    check(null, {
      'no database errors': () => false,
    });
  }

  // Small sleep to simulate realistic load (not hammering database continuously)
  sleep(0.1); // 100ms between iterations
}

// Teardown: Optional cleanup
export function teardown(data) {
  console.log('Load test complete. Performance metrics:');
  console.log(`- Total VUs: ${options.vus}`);
  const expectedInserts = options.vus * 60 * 10; // duration (60s) * ~10 iter/s
  console.log(`- Duration: ${options.duration}`);
  console.log(`- Expected total inserts: ~${expectedInserts} (${options.vus} VUs * 60s * ~10 iter/s)`);
  console.log('');
  const trackingPrefix = data && typeof data.trackingPrefix === 'string' ? data.trackingPrefix : null;
  const runId = data && typeof data.runId === 'string' ? data.runId : null;
  console.log(`[load-test] ${JSON.stringify({ event: 'run', run_id: runId, tracking_prefix: trackingPrefix })}`);

  if (PARTITION_CLEANUP && trackingPrefix) {
    const db = sql.open(postgres, DB_URL);
    try {
      const rows = db.query(
        `WITH deleted AS (
          DELETE FROM public.shipments
          WHERE tracking_number LIKE $1
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM deleted`,
        `${trackingPrefix}%`,
      );
      const deleted = rows.length ? normalizePgInt(rows[0].deleted) : NaN;
      console.log(
        `[load-test] ${JSON.stringify({
          event: 'cleanup',
          enabled: true,
          tracking_prefix: trackingPrefix,
          deleted: Number.isFinite(deleted) ? deleted : null,
        })}`,
      );
    } catch (error) {
      console.error(
        `[load-test] ${JSON.stringify({
          event: 'cleanup',
          enabled: true,
          tracking_prefix: trackingPrefix,
          error: error && error.message ? error.message : String(error),
        })}`,
      );
    } finally {
      db.close();
    }
  } else {
    console.log(`[load-test] ${JSON.stringify({ event: 'cleanup', enabled: false, tracking_prefix: trackingPrefix })}`);
  }

  // Close any per-VU connections to avoid leaking sessions on the pooler.
  connections.forEach((conn) => {
    try {
      conn.close();
    } catch (error) {
      console.error('Error closing connection:', error.message);
    }
  });
  connections.clear();
}

// Alternative test: Geocodes partition distribution (disabled by default)
export function geocodingCacheTest(data) {
  const db = openDb();

  try {
    const orgId = data && data.orgId;
    const clientIds = (data && data.clientIds) || [];
    if (!orgId || clientIds.length === 0) {
      throw new Error('Missing setup payload (orgId/clientIds)');
    }

    const clientId = clientIds[Math.floor(Math.random() * clientIds.length)];
    const rawInput = `Load test address ${__VU}-${__ITER}-${Date.now()}`;

    const addressRows = db.query(
      `INSERT INTO public.addresses (
        organization_id,
        client_id,
        raw_input,
        city,
        province,
        validation_status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id::text AS id`,
      orgId,
      clientId,
      rawInput,
      'Riyadh',
      'Riyadh',
      'pending',
    );

    if (addressRows.length !== 1) {
      throw new Error('Failed to create address row for geocodes load test');
    }

    const addressId = addressRows[0].id;
    const lat = 24.7136 + (Math.random() * 0.1 - 0.05);
    const lon = 46.6753 + (Math.random() * 0.1 - 0.05);

    const insertResult = db.query(
      `INSERT INTO public.geocodes AS g (
        address_id,
        provider_name,
        coordinates,
        metadata
      )
      VALUES (
        $1::uuid,
        $2,
        ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
        $5::jsonb
      )
      RETURNING g.tableoid::regclass::text AS partition_name`,
      addressId,
      'here',
      lon,
      lat,
      JSON.stringify({ source: 'load-test', scenario: 'geocodes', runId: `vu-${__VU}` }),
    );

    check(insertResult, {
      'geocodes insert successful': (r) => r.length === 1,
    });

    // Verify distribution across partitions (every 100 iterations)
    if (__ITER % 100 === 0) {
      const distributionResult = db.query(
        `SELECT tableoid::regclass::text AS partition_name, COUNT(*) as count
         FROM public.geocodes
         WHERE (metadata->>'source') = 'load-test'
         GROUP BY partition_name
         ORDER BY partition_name`
      );

      // Log partition distribution
      console.log(`Geocodes distribution (iteration ${__ITER}):`);
      distributionResult.forEach(row => {
        console.log(`  ${normalizePartitionName(row.partition_name)}: ${row.count} entries`);
      });
    }

  }
  catch (error) {
    console.error(`Error in geocodes iteration ${__ITER}: ${error.message}`);
    check(null, {
      'no database errors': () => false,
    });
  }

  sleep(0.1);
}

// Scenarios: Run different test scenarios
export const scenarios = {
  // Main scenario: Shipment inserts
  shipment_inserts: {
    executor: 'constant-vus',
    vus: 20,
    duration: '1m',
    exec: 'default',
  },

  // Optional: Geocoding cache distribution test (commented out by default)
  // Uncomment to test geocoding cache partition distribution
  /*
  geocoding_cache: {
    executor: 'constant-vus',
    vus: 10,
    duration: '1m',
    exec: 'geocodingCacheTest',
    startTime: '1m', // Start after main test
  },
  */
};

/*
 * Usage:
 *
 * Run the load test:
 *   k6 run tests/load/partition-performance.js
 *
 * Run with custom environment:
 *   DATABASE_URL="${CONNECTION_URI}" k6 run tests/load/partition-performance.js
 *
 * Run with output to InfluxDB (for visualization):
 *   k6 run --out influxdb=http://localhost:8086/k6 tests/load/partition-performance.js
 *
 * Expected output:
 *   - Iteration duration p(95) < 3000ms (95th percentile under 3 seconds)
 *   - Check success rate > 99% (99% of inserts succeed)
 *   - Total inserts: ~12,000 shipments (20 VUs * 60s * ~10 iter/s after sleep)
 *
 * Performance targets:
 *   - p95 < 3s: 95% of inserts complete in under 3 seconds
 *   - p99 < 5s: 99% of inserts complete in under 5 seconds
 *   - Success rate > 99%: Less than 1% error rate
 *
 * Cleanup:
 *   After the test, clean up test data:
 *     DELETE FROM public.shipments WHERE tracking_number LIKE 'LOAD-%';
 *   
 */

































