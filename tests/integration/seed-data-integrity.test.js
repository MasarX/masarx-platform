const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));
const pool = new Pool({ connectionString: DATABASE_URL });

describe('Seed Data Integrity', () => {
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
  });

  afterEach(async () => {
    if (client) {
      client.release();
    }
  });

  it('seeds partitioning_config with expected tables and strategies', async () => {
    const { rows } = await client.query(
      `SELECT table_name, partition_strategy
       FROM partitioning_config
       ORDER BY table_name`
    );

    const tableStrategy = Object.fromEntries(rows.map((row) => [row.table_name, row.partition_strategy]));
    const expected = {
      addresses: 'HASH',
      api_call_log: 'HASH+RANGE',
      decision_log: 'HASH+RANGE',
      geocodes: 'HASH',
      labels: 'HASH',
      shipment_boxes: 'NONE',
      settings_versions: 'HASH',
      shipments: 'HASH',
      webhook_log: 'HASH+RANGE'
    };

    Object.entries(expected).forEach(([tableName, strategy]) => {
      expect(tableStrategy[tableName]).toBe(strategy);
    });
  });

  it('seeds worker_registry with active baseline workers', async () => {
    const { rows } = await client.query(
      `SELECT worker_name, is_active
       FROM worker_registry`
    );

    const workerState = Object.fromEntries(rows.map((row) => [row.worker_name, row.is_active]));
    const expectedWorkers = [
      'outbound_worker',
      'webhook_processor_worker',
      'campaign_enrollment_worker',
      'campaign_dispatcher_worker',
      'alert_aggregation_worker',
      'circuit_breaker_recovery_worker',
      'cache_cleanup_worker'
    ];

    expectedWorkers.forEach((name) => {
      expect(workerState[name]).toBe(true);
    });
  });

  it('seeds schema_registry and settings for webhook ingest policy', async () => {
    const schemaResult = await client.query(
      `SELECT version, is_active
       FROM schema_registry
       WHERE category = 'webhook_ingest_policy'
       ORDER BY version DESC`
    );
    expect(schemaResult.rows.length).toBeGreaterThan(0);

    const activeRows = schemaResult.rows.filter((row) => row.is_active);
    expect(activeRows).toHaveLength(1);
    const maxVersion = Math.max(...schemaResult.rows.map((row) => row.version));
    expect(activeRows[0].version).toBe(maxVersion);

    const settingsResult = await client.query(
      `SELECT cached_value
       FROM settings
       WHERE category = 'webhook_ingest_policy'
         AND scope_type = 'global'`
    );
    expect(settingsResult.rows).toHaveLength(1);
    const policy = settingsResult.rows[0].cached_value;
    expect(policy).toHaveProperty('ack');
    expect(policy.ack).toHaveProperty('mode');
    expect(Number.isInteger(Number(policy.version))).toBe(true);
    expect(Number(policy.version)).toBeGreaterThan(0);

    const allPolicies = await client.query(
      `SELECT cached_value
       FROM settings
       WHERE category = 'webhook_ingest_policy'`
    );
    allPolicies.rows.forEach((row) => {
      expect(row.cached_value).toHaveProperty('version');
    });
  });

  it('seeds mapping_configs with default webhook response templates', async () => {
    const { rows } = await client.query(
      `SELECT mapping_key
       FROM mapping_configs
       WHERE mapping_type = 'webhook_response'`
    );

    const keys = rows.map((row) => row.mapping_key);
    expect(keys).toEqual(expect.arrayContaining(['global::ack_success_v1', 'global::ack_async_v1']));
  });
});
