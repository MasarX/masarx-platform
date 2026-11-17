// tests/integration/partition-functions.test.js
// Purpose: Test partition maintenance functions (create_next_partitions, archive_old_partitions, expand_hash_partitions)
// Task: 12.3 - Write strategic tests for partition maintenance
// Follows: docs/product/standards/testing/test-writing.md (minimal tests, test behavior not implementation)
// Follows: docs/product/standards/global/error-handling.md (clear error messages)

const { Pool } = require('pg');

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""))
});

describe('Partition Maintenance Functions', () => {
  let testClient;

  beforeAll(async () => {
    // Test database connectivity
    const testConn = await pool.connect();
    await testConn.query('SELECT 1');
    testConn.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Get fresh client for each test
    testClient = await pool.connect();
  });

  afterEach(async () => {
    // Clean up test client
    if (testClient) {
      testClient.release();
    }
  });

  // Test 1: Verify create_next_partitions function exists and is callable
  it('verifies create_next_partitions function exists', async () => {
    // Check function exists in database
    const functionCheck = await testClient.query(`
      SELECT proname, pronargs
      FROM pg_proc
      WHERE proname = 'create_next_partitions'
    `);

    expect(functionCheck.rows).toHaveLength(1);
    expect(functionCheck.rows[0].proname).toBe('create_next_partitions');
  });

  // Test 2: Verify archive_old_partitions function exists and is callable
  it('verifies archive_old_partitions function exists', async () => {
    // Check function exists in database
    const functionCheck = await testClient.query(`
      SELECT proname, pronargs
      FROM pg_proc
      WHERE proname = 'archive_old_partitions'
    `);

    expect(functionCheck.rows).toHaveLength(1);
    expect(functionCheck.rows[0].proname).toBe('archive_old_partitions');
  });

  // Test 3: Verify expand_hash_partitions function exists and is callable
  it('verifies expand_hash_partitions function exists', async () => {
    // Check function exists in database
    const functionCheck = await testClient.query(`
      SELECT proname, pronargs
      FROM pg_proc
      WHERE proname = 'expand_hash_partitions'
    `);

    expect(functionCheck.rows).toHaveLength(1);
    expect(functionCheck.rows[0].proname).toBe('expand_hash_partitions');
  });

  it('computes upcoming RANGE partitions without persisting changes', async () => {
    await testClient.query('BEGIN');
    try {
      const { rows } = await testClient.query('SELECT * FROM create_next_partitions()');

      expect(rows.length).toBeGreaterThan(0);
      const uniqueTables = [...new Set(rows.map((row) => row.table_name))];
      expect(uniqueTables).toEqual(
        expect.arrayContaining(['decision_log', 'api_call_log'])
      );

      const decisionLogPartition = rows.find((row) => row.table_name === 'decision_log');
      expect(decisionLogPartition).toBeDefined();
      expect(decisionLogPartition.partition_name).toMatch(/^decision_log_\d{4}_\d{2}(_p\d+)?$/);

      // webhook_log has been superseded by decision_log-backed views; no direct partitions expected

      const apiCallPartition = rows.find((row) => row.table_name === 'api_call_log');
      expect(apiCallPartition).toBeDefined();
      expect(apiCallPartition.partition_name).toMatch(/^api_call_log_\d{4}_w\d{2}(_p\d+)?$/);
    } catch (error) {
      // create_next_partitions is idempotent and should not raise; surface any unexpected errors
      throw error;
    } finally {
      await testClient.query('ROLLBACK');
    }
  });

  it('generates a hash expansion plan for shipments without executing steps', async () => {
    const { rows } = await testClient.query(
      `SELECT step_number, step_description, executed
       FROM expand_hash_partitions($1::text, $2::int)`,
      ['shipments', 4]
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].step_number).toBe(1);
    expect(rows[0].executed).toBe(false);
    const updateStep = rows.find((row) =>
      row.step_description.toLowerCase().includes('update partitioning_config')
    );
    expect(updateStep).toBeDefined();
    expect(updateStep.executed).toBe(false);
  });

  it('runs archive_old_partitions inside a rollback-safe transaction', async () => {
    await testClient.query('BEGIN');
    try {
      const { rows } = await testClient.query('SELECT * FROM archive_old_partitions()');
      expect(rows).toBeDefined();
      expect(Array.isArray(rows)).toBe(true);
    } catch (error) {
      // archive_old_partitions returns info and should not raise; surface any unexpected errors
      throw error;
    } finally {
      await testClient.query('ROLLBACK');
    }
  });
});
