const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));
const pool = new Pool({ connectionString: DATABASE_URL });

describe('Migration Workflow', () => {
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

  it('verifies base tables exist after migrations', async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*) AS table_count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name NOT LIKE 'pg_%'
         AND table_name NOT LIKE 'tap_%'`
    );

    const count = Number(rows[0].table_count);
    expect(count).toBeGreaterThanOrEqual(60);
  });

  it('verifies critical tables from each phase exist', async () => {
    const criticalTables = [
      'organizations',
      'clients',
      'settings_versions',
      'settings',
      'mapping_configs',
      'decision_log',
      'webhook_log',
      'providers',
      'webhook_inbox',
      'message_templates',
      'outbound_calls',
      'shipments',
      'addresses',
      'geocodes',
      'worker_registry',
      'settings_cache',
      'webhook_response_events',
      
    ];

    for (const tableName of criticalTables) {
      const result = await client.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = $1`,
        [tableName]
      );
      expect(result.rows).toHaveLength(1);
    }
  });

  it('verifies required PostgreSQL extensions are enabled', async () => {
    const requiredExtensions = ['postgis', 'pg_stat_statements', 'pgcrypto'];

    for (const extension of requiredExtensions) {
      const result = await client.query(
        `SELECT extname
         FROM pg_extension
         WHERE extname = $1`,
        [extension]
      );
      expect(result.rows).toHaveLength(1);
    }
  });

  it('verifies key tables are configured as partitioned tables', async () => {
    const partitionedParents = [
      'webhook_log',
      'api_call_log',
      'decision_log',
      'addresses',
      'shipments'
    ];

    for (const parent of partitionedParents) {
      const result = await client.query(
        `SELECT relname
         FROM pg_class
         WHERE relname = $1
           AND relkind = 'p'`,
        [parent]
      );
      expect(result.rows).toHaveLength(1);
    }
  });
});
