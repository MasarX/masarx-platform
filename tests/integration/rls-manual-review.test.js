const { Pool } = require('pg');
const { assertEnv } = require('../utils/test-env');

assertEnv(['DATABASE_URL'], 'manual review task RLS');
const pool = new Pool({ connectionString: process.env.DATABASE_URL.trim() });

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

async function grantSelectRecursive(client, tableName) {
  if (!IDENTIFIER_REGEX.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  await client.query(`GRANT SELECT ON ${tableName} TO authenticated`);
  const { rows } = await client.query(
    `SELECT inhrelid::regclass::text AS partition
       FROM pg_inherits
      WHERE inhparent = $1::regclass`,
    [tableName]
  );
  for (const { partition } of rows) {
    if (!IDENTIFIER_REGEX.test(partition)) throw new Error(`Invalid partition name: ${partition}`);
    await client.query(`GRANT SELECT ON ${partition} TO authenticated`);
  }
}

async function createOrganization(client, name) {
  const slug = `org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await client.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     RETURNING id`,
    [name, slug]
  );
  return rows[0].id;
}

async function createClient(client, organizationId, name) {
  const slug = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await client.query(
    `INSERT INTO clients (organization_id, name, slug)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [organizationId, name, slug]
  );
  return rows[0].id;
}

async function createUser(client, organizationId, email) {
  const userIdResult = await client.query('SELECT gen_random_uuid()::uuid AS id');
  const userId = userIdResult.rows[0].id;
  await client.query(
    `INSERT INTO users (id, organization_id, email, full_name)
     VALUES ($1, $2, $3, $4)`,
    [userId, organizationId, email, `RLS User ${email}`]
  );
  return userId;
}

async function setAuthContext(client, userId) {
  await client.query('SET LOCAL ROLE authenticated');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);
}

describe('RLS: manual_review_tasks', () => {
  let client;

  beforeAll(async () => {
    const c = await pool.connect();
    await c.query('SELECT 1');
    c.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    // Grant read for test role to target tables (RLS still applies)
    await grantSelectRecursive(client, 'manual_review_tasks');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('isolates manual_review_tasks by organization for authenticated role', async () => {
    const orgA = await createOrganization(client, 'RLS MRT Org A');
    const orgB = await createOrganization(client, 'RLS MRT Org B');
    const clientA = await createClient(client, orgA, 'MRT Client A');
    const clientB = await createClient(client, orgB, 'MRT Client B');

    await client.query(
      `INSERT INTO manual_review_tasks (
         id, organization_id, client_id, task_type, status, metadata
       ) VALUES
         (gen_random_uuid(), $1::uuid, $2::uuid, 'geocoding', 'pending', '{}'::jsonb),
         (gen_random_uuid(), $3::uuid, $4::uuid, 'geocoding', 'pending', '{}'::jsonb)`,
      [orgA, clientA, orgB, clientB]
    );

    const userA = await createUser(client, orgA, 'mrt-a@example.com');
    await setAuthContext(client, userA);

    const { rows } = await client.query('SELECT id, organization_id FROM manual_review_tasks ORDER BY created_at');
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgA);
  });
});

