const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { assertEnv } = require('../utils/test-env');

assertEnv(['DATABASE_URL'], 'sensitive configuration RLS');
const pool = new Pool({ connectionString: process.env.DATABASE_URL.trim() });

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

async function insertProviderAuthConfigVault(client, { id, providerId, authType, credentials }) {
  const { rows } = await client.query(
    `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
    [
      JSON.stringify(credentials || {}),
      `provider_auth_configs/${id}`,
      `integration test provider_auth_configs (${authType})`,
    ],
  );

  const vaultId = rows[0]?.id;
  if (!vaultId) {
    throw new Error('vault.create_secret returned no id');
  }

  await client.query(
    `INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::uuid, NULL, NULL)`,
    [id, providerId, authType, vaultId],
  );
}

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
    if (!IDENTIFIER_REGEX.test(partition)) {
      throw new Error(`Invalid partition name: ${partition}`);
    }
    await client.query(`GRANT SELECT ON ${partition} TO authenticated`);
  }
}

async function createOrganization(client, name) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
  const { rows } = await client.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     RETURNING id`,
    [name, slug]
  );
  return rows[0].id;
}

async function createClient(client, organizationId, name) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
  const { rows } = await client.query(
    `INSERT INTO clients (organization_id, name, slug)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [organizationId, name, slug]
  );
  return rows[0].id;
}

async function createUser(client, organizationId, email) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, organization_id, email, full_name)
     VALUES ($1, $2, $3, $4)`,
    [id, organizationId, email, `Test User ${email}`]
  );
  return id;
}

async function assignRbacRoleFromTemplate(client, { organizationId, userId, templateKey }) {
  const { rows } = await client.query(
    `SELECT public.provision_rbac_roles_from_templates_v1($1::uuid, ARRAY[$2::text], $3::uuid) AS template_key`,
    [organizationId, templateKey, userId],
  );

  if (!rows.length) {
    throw new Error('Expected RBAC role provisioning to return a row');
  }

  await client.query(
    `INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
     SELECT $1::uuid, $2::uuid, r.id, $2::uuid, jsonb_build_object('seed', true, 'source', 'integration', 'template_key', r.key)
     FROM public.rbac_roles r
     WHERE r.organization_id = $1::uuid
       AND r.key = $3::text
     ON CONFLICT DO NOTHING`,
    [organizationId, userId, templateKey],
  );
}

async function setAuthContext(client, userId) {
  await client.query('SET LOCAL ROLE authenticated');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);
}

async function clearAuthContext(client) {
  await client.query('RESET ROLE');
  await client.query("SELECT set_config('request.jwt.claims', '', true)");
}

async function createMappingConfig(client, mappingType) {
  const mappingConfigId = randomUUID();
  await client.query(
    `INSERT INTO mapping_configs (
       id,
       mapping_type,
       mapping_key,
       mapping_config,
       mapping_version,
       notes
     )
     VALUES (
       $1::uuid,
       $2,
       $3,
       $4::jsonb,
       1,
       'RLS sensitive configs test'
     )`,
    [
      mappingConfigId,
      mappingType,
      `${mappingType}::${mappingConfigId}`,
      JSON.stringify({}),
    ]
  );
  return mappingConfigId;
}

async function createAddress(client, organizationId, clientId) {
  const addressId = randomUUID();
  await client.query(
    `INSERT INTO addresses (
       id,
       organization_id,
       client_id,
       raw_input,
       city,
       province,
       country,
       validation_status
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::jsonb,
       'Riyadh',
       'Riyadh Province',
       'SA',
       'pending'
     )`,
    [addressId, organizationId, clientId, JSON.stringify({ line1: 'Test Address' })]
  );
  return addressId;
}

describe('RLS sensitive configuration coverage', () => {
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
    await grantSelectRecursive(client, 'webhook_sources');
    await grantSelectRecursive(client, 'geocoding_attempts');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  test('authenticated role cannot read provider_auth_configs', async () => {
    const { rows: providerRows } = await client.query(
      `SELECT id, organization_id FROM providers ORDER BY created_at LIMIT 1`
    );
    expect(providerRows.length).toBe(1);
    const { id: providerId, organization_id: providerOrgId } = providerRows[0];

    const secretId = randomUUID();
    await insertProviderAuthConfigVault(client, {
      id: secretId,
      providerId,
      authType: 'api_key',
      credentials: { api_key: 'super-secret-key' },
    });

    const userId = await createUser(client, providerOrgId, `denied-${Date.now()}@example.com`);
    await setAuthContext(client, userId);
    await client.query('SAVEPOINT provider_auth_denied');

    try {
      await client.query('SELECT credentials FROM provider_auth_configs WHERE id = $1::uuid', [secretId]);
      throw new Error('Expected permission denied for authenticated role');
    } catch (error) {
      expect(error.message).toMatch(/permission denied/);
      await client.query('ROLLBACK TO SAVEPOINT provider_auth_denied');
    } finally {
      await clearAuthContext(client);
    }

    await client.query('RELEASE SAVEPOINT provider_auth_denied');
  });

  test('service_role can read provider_auth_configs', async () => {
    const { rows: providerRows } = await client.query(
      `SELECT id, organization_id FROM providers ORDER BY created_at LIMIT 1`
    );
    expect(providerRows.length).toBe(1);
    const { id: providerId } = providerRows[0];

    const secretId = randomUUID();
    await insertProviderAuthConfigVault(client, {
      id: secretId,
      providerId,
      authType: 'api_key',
      credentials: { api_key: 'service-secret' },
    });

    await client.query('SET LOCAL ROLE service_role');
    const { rows } = await client.query(
      `SELECT auth_type, credentials, credentials_vault_id
       FROM provider_auth_configs
       WHERE id = $1::uuid`,
      [secretId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].auth_type).toBe('api_key');
    expect(rows[0].credentials).toBeNull();
    expect(rows[0].credentials_vault_id).toBeTruthy();

    const { rows: credentialRows } = await client.query(
      `SELECT public.get_provider_auth_credentials($1::uuid) AS credentials`,
      [secretId],
    );
    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].credentials.api_key).toBe('service-secret');
    await client.query('RESET ROLE');
  });

  test('webhook_sources limited to authenticated user organization', async () => {
    const orgA = await createOrganization(client, 'Webhook Org A');
    const orgB = await createOrganization(client, 'Webhook Org B');
    const sourceIdentifierA = `org-a-${Date.now()}`;
    const sourceIdentifierB = `org-b-${Date.now()}`;

    const mappingConfigId = await createMappingConfig(client, 'webhook_inbound');

    await client.query(
      `INSERT INTO webhook_sources (
         id,
         organization_id,
         source_identifier,
         name,
         provider_type,
         auth_token,
         mapping_config_id
       )
       VALUES
         ($1::uuid, $2::uuid, $3, 'Org A Source', 'async_3pl', $4, $5::uuid),
         ($6::uuid, $7::uuid, $8, 'Org B Source', 'async_3pl', $9, $5::uuid)`,
      [
        randomUUID(),
        orgA,
        sourceIdentifierA,
        `token-a-${Date.now()}`,
        mappingConfigId,
        randomUUID(),
        orgB,
        sourceIdentifierB,
        `token-b-${Date.now()}`,
      ]
    );

    const userA = await createUser(client, orgA, 'webhook-a@example.com');
    await assignRbacRoleFromTemplate(client, {
      organizationId: orgA,
      userId: userA,
      templateKey: 'agreements_admin',
    });
    await setAuthContext(client, userA);

    const { rows: sourcesForA } = await client.query(
      `SELECT organization_id, source_identifier
       FROM webhook_sources
       ORDER BY source_identifier`
    );
    expect(sourcesForA.length).toBeGreaterThanOrEqual(1);
    expect(sourcesForA.every((row) => row.organization_id === orgA)).toBe(true);
    expect(sourcesForA.some((row) => row.source_identifier === sourceIdentifierA)).toBe(true);
    expect(sourcesForA.some((row) => row.source_identifier === sourceIdentifierB)).toBe(false);

    await clearAuthContext(client);
  });

  test('geocoding_attempts limited to authenticated user organization', async () => {
    const orgA = await createOrganization(client, 'Geo Org A');
    const orgB = await createOrganization(client, 'Geo Org B');

    const clientA = await createClient(client, orgA, 'Geo Client A');
    const clientB = await createClient(client, orgB, 'Geo Client B');

    const addressA = await createAddress(client, orgA, clientA);
    const addressB = await createAddress(client, orgB, clientB);

    await client.query(
      `INSERT INTO geocoding_attempts (
         organization_id,
         client_id,
         sender_id,
         address_id,
         workflow_run_step_id,
         outbound_call_id,
         provider_name,
         attempt_order,
         attempt_type,
         status,
         confidence,
         metadata
       )
       VALUES
         ($1::uuid, $2::uuid, NULL, $3::uuid, NULL, NULL, 'here_geocoding', 1, 'primary', 'succeeded', 0.92, '{}'::jsonb),
         ($4::uuid, $5::uuid, NULL, $6::uuid, NULL, NULL, 'here_geocoding', 1, 'primary', 'succeeded', 0.88, '{}'::jsonb)`,
      [orgA, clientA, addressA, orgB, clientB, addressB]
    );

    const userA = await createUser(client, orgA, 'geo-a@example.com');
    await setAuthContext(client, userA);

    const { rows: attemptsForA } = await client.query(
      `SELECT organization_id, address_id
       FROM geocoding_attempts
       ORDER BY created_at`
    );
    expect(attemptsForA).toHaveLength(1);
    expect(attemptsForA[0].organization_id).toBe(orgA);
    expect(attemptsForA[0].address_id).toBe(addressA);

    await clearAuthContext(client);
  });
});
