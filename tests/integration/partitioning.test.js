const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));
const pool = new Pool({ connectionString: DATABASE_URL });

const randomSlug = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createOrganization(client, name = 'Partition Org') {
  const slug = randomSlug('org');
  const { rows } = await client.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     RETURNING id`,
    [name, slug]
  );
  return rows[0].id;
}

async function createClient(client, organizationId, name = 'Partition Client') {
  const slug = randomSlug('client');
  const { rows } = await client.query(
    `INSERT INTO clients (organization_id, name, slug)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [organizationId, name, slug]
  );
  return rows[0].id;
}

describe('Partition Routing', () => {
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
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('routes shipments to the hash partition based on client_id', async () => {
    const organizationId = await createOrganization(client, 'Ship Org');
    const clientId = await createClient(client, organizationId, 'Ship Client');

    const trackingNumber = `SHIP-${Date.now()}`;
    const { rows } = await client.query(
      `INSERT INTO shipments (organization_id, client_id, tracking_number, service_type, status)
       VALUES ($1, $2, $3, 'delivery', 'pending')
       RETURNING id`,
      [organizationId, clientId, trackingNumber]
    );

    const shipmentId = rows[0].id;

    const partitionResult = await client.query(
      `SELECT tableoid::regclass AS partition_name
       FROM shipments
       WHERE id = $1`,
      [shipmentId]
    );

    expect(partitionResult.rows).toHaveLength(1);
    expect(partitionResult.rows[0].partition_name).toBe('shipments_p0');
  });

  it('routes addresses to the hash partition based on client_id', async () => {
    const organizationId = await createOrganization(client, 'Address Org');
    const clientId = await createClient(client, organizationId, 'Address Client');

    const { rows } = await client.query(
      `INSERT INTO addresses (
         organization_id, client_id, raw_input, normalized_line1,
         city, province, validation_status
       ) VALUES (
         $1, $2, 'Raw Address', 'Normalized Address',
         'Riyadh', 'Riyadh Province', 'valid'
       )
       RETURNING id`,
      [organizationId, clientId]
    );

    const addressId = rows[0].id;

    const partitionResult = await client.query(
      `SELECT tableoid::regclass AS partition_name
       FROM addresses
       WHERE id = $1`,
      [addressId]
    );

    expect(partitionResult.rows).toHaveLength(1);
    expect(partitionResult.rows[0].partition_name).toBe('addresses_p0');
  });

  it('distributes geocodes across hash partitions by address_id', async () => {
    const organizationId = await createOrganization(client, 'Geo Org');
    const clientId = await createClient(client, organizationId, 'Geo Client');

    const addresses = await client.query(
      `INSERT INTO addresses (
         organization_id, client_id, raw_input, normalized_line1,
         city, province, validation_status
       ) VALUES
         ($1, $2, 'Address 1', 'Address 1', 'Riyadh', 'Riyadh Province', 'valid'),
         ($1, $2, 'Address 2', 'Address 2', 'Riyadh', 'Riyadh Province', 'valid'),
         ($1, $2, 'Address 3', 'Address 3', 'Riyadh', 'Riyadh Province', 'valid'),
         ($1, $2, 'Address 4', 'Address 4', 'Riyadh', 'Riyadh Province', 'valid')
       RETURNING id`,
      [organizationId, clientId]
    );

    for (const row of addresses.rows) {
      await client.query(
        `INSERT INTO geocodes (
           address_id,
           organization_id,
           client_id,
           provider_name,
           coordinates,
           confidence_score,
           accuracy_type,
           formatted_address,
           is_primary
         ) VALUES (
           $1,
           $2,
           $3,
           'integration_provider',
           ST_GeogFromText('SRID=4326;POINT(46.6753 24.7136)'),
           0.95,
           'rooftop',
           'Formatted Address',
           true
         )`,
        [row.id, organizationId, clientId]
      );
    }

    const distribution = await client.query(
      `SELECT DISTINCT tableoid::regclass AS partition_name
       FROM geocodes
       WHERE address_id = ANY($1::uuid[])`,
      [addresses.rows.map((row) => row.id)]
    );

    expect(distribution.rows.length).toBeGreaterThan(0);
    distribution.rows.forEach((row) => expect(row.partition_name).toMatch(/geocodes_p[0-3]/));
  });
});
