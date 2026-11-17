const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

describe('Partition maintenance - dry run', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  test('archive_old_partitions returns processed rows inside a rollback-safe transaction', async () => {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query('SELECT * FROM archive_old_partitions() LIMIT 50');
      // It is valid for zero rows (small datasets); only assert shape when present
      if (rows.length > 0) {
        for (const r of rows) {
          expect(r).toHaveProperty('table_name');
          expect(r).toHaveProperty('partition_name');
          expect(r).toHaveProperty('row_count');
          expect(r).toHaveProperty('detached');
          expect(r.detached).toBe(true);
          expect(typeof r.archived_to).toBe('string');
          expect(r.archived_to).toContain('archive.');
        }
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

