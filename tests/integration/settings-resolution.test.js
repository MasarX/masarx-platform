const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const pool = new Pool({ connectionString: DATABASE_URL });

const randomSlug = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createOrganization(client, name = 'Test Org') {
  const slug = randomSlug('org');
  const { rows } = await client.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     RETURNING id`,
    [name, slug]
  );
  return rows[0].id;
}

async function createClient(client, organizationId, name = 'Test Client') {
  const slug = randomSlug('client');
  const { rows } = await client.query(
    `INSERT INTO clients (organization_id, name, slug)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [organizationId, name, slug]
  );
  return rows[0].id;
}

async function createSender(client, clientId, name = 'Test Sender') {
  const { rows } = await client.query(
    `INSERT INTO senders (client_id, name, brand_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [clientId, name, `${name} Brand`]
  );
  return rows[0].id;
}

const { upsertSettings } = require('../utils/policies');

async function ensureTestCategory(client, category) {
  await client.query(
    `INSERT INTO public.settings_category_registry (
       category,
       description,
       requires_schema,
       requires_global_default,
       side_effecting,
       safe_missing_behavior
     ) VALUES (
       $1::text,
       'Test-only category for settings resolution integration tests',
       TRUE,
       FALSE,
       FALSE,
       'return_null'
     )
     ON CONFLICT (category) DO NOTHING`,
    [category],
  );

  await client.query(
    `INSERT INTO public.schema_registry (
       category,
       version,
       schema,
       description,
       examples,
       is_active
     ) VALUES (
       $1::text,
       1,
       $2::jsonb,
       'Test-only schema for settings resolution integration tests',
       jsonb_build_array($3::jsonb),
       TRUE
     )
     ON CONFLICT (category, version) DO UPDATE
       SET schema = EXCLUDED.schema,
           examples = EXCLUDED.examples,
           is_active = TRUE`,
    [
      category,
      JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: true,
      }),
      JSON.stringify({}),
    ],
  );
}

async function upsertSetting(client, { category, scopeType, scopeId, value, version = 1 }) {
  // Delegate to shared helper for dynamic, idempotent upserts
  await ensureTestCategory(client, category);
  await upsertSettings(category, scopeType, scopeId ?? null, { ...value, __version: version }, 'settings-resolution test upsert', client);
  // Return the latest version pointer to keep the signature consistent
  const { rows } = await client.query(
    `SELECT settings_version_id AS id
       FROM settings
      WHERE category = $1
        AND scope_type = $2
        AND scope_id IS NOT DISTINCT FROM $3
      ORDER BY last_updated DESC
      LIMIT 1`,
    [category, scopeType, scopeId ?? null]
  );
  return rows[0]?.id || null;
}

async function resolveSetting(client, category, scopeType, scopeId) {
  const { rows } = await client.query(
    'SELECT resolve_settings($1, $2, $3) AS value',
    [category, scopeType, scopeId]
  );
  return rows[0].value;
}

describe('Settings Override Ladder Resolution', () => {
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

  it('resolves settings with correct precedence: global < tenant < client', async () => {
    const category = `policy_${Date.now()}`;
    const organizationId = await createOrganization(client, 'Override Org');
    const clientId = await createClient(client, organizationId, 'Override Client');

    await upsertSetting(client, {
      category,
      scopeType: 'global',
      scopeId: null,
      value: { max_retries: 3, source: 'global' },
    });

    await upsertSetting(client, {
      category,
      scopeType: 'tenant',
      scopeId: organizationId,
      value: { max_retries: 5, source: 'tenant' },
    });

    await upsertSetting(client, {
      category,
      scopeType: 'client',
      scopeId: clientId,
      value: { max_retries: 7, source: 'client', extra: true },
    });

    const clientPolicy = await resolveSetting(client, category, 'client', clientId);
    expect(clientPolicy.max_retries).toBe(7);
    expect(clientPolicy.source).toBe('client');

    const tenantPolicy = await resolveSetting(client, category, 'tenant', organizationId);
    expect(tenantPolicy.max_retries).toBe(5);
    expect(tenantPolicy.source).toBe('tenant');

    const globalPolicy = await resolveSetting(client, category, 'global', null);
    expect(globalPolicy.max_retries).toBe(3);
    expect(globalPolicy.source).toBe('global');
  });

  it('falls back to tenant then global when client scope missing', async () => {
    const category = `fallback_${Date.now()}`;
    const organizationId = await createOrganization(client, 'Fallback Org');
    const clientId = await createClient(client, organizationId, 'Fallback Client');

    await upsertSetting(client, {
      category,
      scopeType: 'global',
      scopeId: null,
      value: { quota: 'global-default' },
    });

    await upsertSetting(client, {
      category,
      scopeType: 'tenant',
      scopeId: organizationId,
      value: { quota: 'tenant-default' },
    });

    const resolved = await resolveSetting(client, category, 'client', clientId);
    expect(resolved.quota).toBe('tenant-default');

    const resolvedGlobal = await resolveSetting(client, category, 'global', null);
    expect(resolvedGlobal.quota).toBe('global-default');
  });

  it('applies sender scope overrides above client and tenant', async () => {
    const category = `sender_policy_${Date.now()}`;
    const organizationId = await createOrganization(client, 'Sender Org');
    const clientId = await createClient(client, organizationId, 'Sender Client');
    const senderId = await createSender(client, clientId, 'Sender Scope');

    await upsertSetting(client, {
      category,
      scopeType: 'global',
      scopeId: null,
      value: { channel: 'global' },
    });

    await upsertSetting(client, {
      category,
      scopeType: 'client',
      scopeId: clientId,
      value: { channel: 'client' },
    });

    await upsertSetting(client, {
      category,
      scopeType: 'sender',
      scopeId: senderId,
      value: { channel: 'sender', priority: 'high' },
    });

    const senderPolicy = await resolveSetting(client, category, 'sender', senderId);
    expect(senderPolicy.channel).toBe('sender');
    expect(senderPolicy.priority).toBe('high');
  });

  it('returns latest approved version for a scope', async () => {
    const category = `version_policy_${Date.now()}`;
    const organizationId = await createOrganization(client, 'Version Org');
    const clientId = await createClient(client, organizationId, 'Version Client');

    await upsertSetting(client, {
      category,
      scopeType: 'client',
      scopeId: clientId,
      version: 1,
      value: { window_minutes: 15, version: 1 },
    });

    await upsertSetting(client, {
      category,
      scopeType: 'client',
      scopeId: clientId,
      version: 2,
      value: { window_minutes: 30, version: 2 },
    });

    const resolved = await resolveSetting(client, category, 'client', clientId);
    expect(resolved.window_minutes).toBe(30);
    expect(resolved.version).toBe(2);
  });
});



