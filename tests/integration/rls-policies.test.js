const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const {
  assertDatabaseUrl,
  grantSelectRecursive,
  createOrganization,
  createClient,
  createSender,
  createUser,
  setAuthContext
} = require('./helpers/tenant-utils');

const pool = new Pool({ connectionString: assertDatabaseUrl('Row-Level Security (RLS) Policies') });

describe('Row-Level Security (RLS) Policies', () => {
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
    await grantSelectRecursive(client, 'shipments');
    await grantSelectRecursive(client, 'addresses');
    await grantSelectRecursive(client, 'recipients');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('tenant scope isolates shipments by organization', async () => {
    const { id: orgA } = await createOrganization(client, 'RLS Org A');
    const { id: orgB } = await createOrganization(client, 'RLS Org B');
    const { id: clientA } = await createClient(client, orgA, 'Client Org A');
    const { id: clientB } = await createClient(client, orgB, 'Client Org B');

    await client.query(
      `INSERT INTO shipments (organization_id, client_id, tracking_number, service_type, status)
       VALUES
         ($1, $2, 'ORG-A-1', 'delivery', 'pending'),
         ($3, $4, 'ORG-B-1', 'delivery', 'pending')`,
      [orgA, clientA, orgB, clientB],
    );

    const userA = await createUser(client, orgA, 'tenant-a@example.com', { accessScopeType: 'tenant' });
    await setAuthContext(client, userA);

    const shipmentsForA = await client.query(
      'SELECT tracking_number FROM shipments ORDER BY tracking_number',
    );
    expect(shipmentsForA.rows).toHaveLength(1);
    expect(shipmentsForA.rows[0].tracking_number).toBe('ORG-A-1');
  });

  it('platform scope can read cross-organization shipments', async () => {
    const { id: orgA } = await createOrganization(client, 'Platform Org A');
    const { id: orgB } = await createOrganization(client, 'Platform Org B');
    const { id: clientA } = await createClient(client, orgA, 'Platform Client A');
    const { id: clientB } = await createClient(client, orgB, 'Platform Client B');
    const trackingA = `PLAT-A-${randomUUID().slice(0, 8).toUpperCase()}`;
    const trackingB = `PLAT-B-${randomUUID().slice(0, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO shipments (organization_id, client_id, tracking_number, service_type, status)
       VALUES
         ($1, $2, $5, 'delivery', 'pending'),
         ($3, $4, $6, 'delivery', 'pending')`,
      [orgA, clientA, orgB, clientB, trackingA, trackingB],
    );

    const platformUser = await createUser(client, orgA, 'platform@example.com', { accessScopeType: 'platform' });
    await setAuthContext(client, platformUser);

    const shipments = await client.query(
      'SELECT tracking_number FROM shipments WHERE tracking_number = ANY($1::text[]) ORDER BY tracking_number',
      [[trackingA, trackingB]],
    );
    expect(shipments.rows).toHaveLength(2);
    expect(shipments.rows.map((r) => r.tracking_number)).toEqual([trackingA, trackingB].sort());
  });

  it('client scope restricts shipments to a single client', async () => {
    const { id: org } = await createOrganization(client, 'Client Scope Org');
    const { id: clientA } = await createClient(client, org, 'Client Scope A');
    const { id: clientB } = await createClient(client, org, 'Client Scope B');

    await client.query(
      `INSERT INTO shipments (organization_id, client_id, tracking_number, service_type, status)
       VALUES
         ($1, $2, 'CLIENT-A-1', 'delivery', 'pending'),
         ($1, $3, 'CLIENT-B-1', 'delivery', 'pending')`,
      [org, clientA, clientB],
    );

    const clientUser = await createUser(client, org, 'client@example.com', {
      accessScopeType: 'client',
      accessScopeId: clientA,
    });
    await setAuthContext(client, clientUser);

    const shipments = await client.query(
      'SELECT tracking_number FROM shipments ORDER BY tracking_number',
    );
    expect(shipments.rows).toHaveLength(1);
    expect(shipments.rows[0].tracking_number).toBe('CLIENT-A-1');
  });

  it('sender scope restricts shipments and linked addresses/recipients', async () => {
    const { id: org } = await createOrganization(client, 'Sender Scope Org');
    const { id: clientId } = await createClient(client, org, 'Sender Scope Client');
    const senderA = await createSender(client, clientId, 'Sender A');
    const senderB = await createSender(client, clientId, 'Sender B');

    const recipientA = (await client.query(
      `INSERT INTO recipients (organization_id, client_id, name, phone_number, created_at, updated_at)
       VALUES ($1, $2, 'Recipient A', '+966555000111', now(), now())
       RETURNING id`,
      [org, clientId],
    )).rows[0].id;

    const recipientB = (await client.query(
      `INSERT INTO recipients (organization_id, client_id, name, phone_number, created_at, updated_at)
       VALUES ($1, $2, 'Recipient B', '+966555000222', now(), now())
       RETURNING id`,
      [org, clientId],
    )).rows[0].id;

    const originA = (await client.query(
      `INSERT INTO addresses (
         organization_id, client_id, raw_input, normalized_line1,
         city, province, validation_status
       ) VALUES ($1, $2, 'Origin A', 'Origin A', 'Riyadh', 'Riyadh Province', 'valid')
       RETURNING id`,
      [org, clientId],
    )).rows[0].id;

    const destA = (await client.query(
      `INSERT INTO addresses (
         organization_id, client_id, raw_input, normalized_line1,
         city, province, validation_status
       ) VALUES ($1, $2, 'Dest A', 'Dest A', 'Riyadh', 'Riyadh Province', 'valid')
       RETURNING id`,
      [org, clientId],
    )).rows[0].id;

    const originB = (await client.query(
      `INSERT INTO addresses (
         organization_id, client_id, raw_input, normalized_line1,
         city, province, validation_status
       ) VALUES ($1, $2, 'Origin B', 'Origin B', 'Riyadh', 'Riyadh Province', 'valid')
       RETURNING id`,
      [org, clientId],
    )).rows[0].id;

    const destB = (await client.query(
      `INSERT INTO addresses (
         organization_id, client_id, raw_input, normalized_line1,
         city, province, validation_status
       ) VALUES ($1, $2, 'Dest B', 'Dest B', 'Riyadh', 'Riyadh Province', 'valid')
       RETURNING id`,
      [org, clientId],
    )).rows[0].id;

    await client.query(
      `INSERT INTO shipments (
         organization_id, client_id, sender_id, recipient_id,
         origin_address_id, destination_address_id,
         tracking_number, service_type, status
       )
       VALUES
         ($1, $2, $3, $4, $5, $6, 'SENDER-A-1', 'delivery', 'pending'),
         ($1, $2, $7, $8, $9, $10, 'SENDER-B-1', 'delivery', 'pending')`,
      [org, clientId, senderA, recipientA, originA, destA, senderB, recipientB, originB, destB],
    );

    const senderUser = await createUser(client, org, 'sender@example.com', {
      accessScopeType: 'sender',
      accessScopeId: senderA,
    });
    await setAuthContext(client, senderUser);

    const shipments = await client.query('SELECT tracking_number FROM shipments ORDER BY tracking_number');
    expect(shipments.rows).toHaveLength(1);
    expect(shipments.rows[0].tracking_number).toBe('SENDER-A-1');

    const addresses = await client.query('SELECT raw_input FROM addresses ORDER BY raw_input');
    expect(addresses.rows).toHaveLength(2);
    expect(addresses.rows.map((r) => r.raw_input)).toEqual(['Dest A', 'Origin A']);

    const recipients = await client.query('SELECT phone_number FROM recipients ORDER BY phone_number');
    expect(recipients.rows).toHaveLength(1);
    expect(recipients.rows[0].phone_number).toBe('+966555000111');
  });
});
