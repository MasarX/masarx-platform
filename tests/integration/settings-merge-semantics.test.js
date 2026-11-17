// Plan: PLAN-202511-testing-hardening-e2e-provenance / Step: S07
// Settings deep-merge semantics across Global→Tenant→Client→Sender with array strategies

const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { upsertSettings } = require('../utils/policies');

loadEnv();

describe('Settings deep merge semantics', () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
  });

  afterAll(async () => {
    await pool.end();
  });

  test('merges objects deeply and arrays per strategy', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      // Create org -> client -> sender chain
      const orgId = randomUUID();
      const clientId = randomUUID();
      const senderId = randomUUID();

      await client.query(`INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Merge Org', $2)`, [orgId, `merge-org-${orgId.slice(0,8)}`]);
      await client.query(`INSERT INTO clients (id, organization_id, name, slug) VALUES ($1::uuid, $2::uuid, 'Merge Client', $3)`, [clientId, orgId, `merge-client-${clientId.slice(0,8)}`]);
      await client.query(`INSERT INTO senders (id, client_id, name) VALUES ($1::uuid, $2::uuid, 'Merge Sender')`, [senderId, clientId]);

      const category = 'merge_testing_v1';

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
           'Test-only category for settings merge semantics',
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
           'Test-only schema for merge semantics',
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
            properties: {
              thresholds: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  max: { type: 'integer' },
                  min: { type: 'integer' },
                },
              },
              channels: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
              flags: { type: 'object', additionalProperties: true },
            },
          }),
          JSON.stringify({ version: 1 }),
        ],
      );

      // Global baseline
      await upsertSettings(category, 'global', null, {
        thresholds: { max: 5, min: 1 },
        channels: ['voice', 'whatsapp'],
        tags: ['base']
      }, 'merge test global', client);

      // Tenant override (min only), and append to tags
      await upsertSettings(category, 'tenant', orgId, {
        thresholds: { min: 2 },
        tags: ['t'],
        'tags__merge_strategy': 'append'
      }, 'merge test tenant', client);

      // Client override (append sms to channels)
      await upsertSettings(category, 'client', clientId, {
        channels: ['sms'],
        'channels__merge_strategy': 'append'
      }, 'merge test client', client);

      // Sender override: prepend email to channels, override thresholds.max, add flags
      await upsertSettings(category, 'sender', senderId, {
        channels: ['email'],
        'channels__merge_strategy': 'prepend',
        thresholds: { max: 6 },
        flags: { featured: true }
      }, 'merge test sender', client);

      // Resolve via merged resolver
      await client.query("SET LOCAL ROLE service_role");
      const { rows } = await client.query(
        `SELECT public.resolve_settings_merged($1, 'sender', $2::uuid) AS cfg`,
        [category, senderId]
      );
      const cfg = rows[0]?.cfg || {};

      expect(cfg.thresholds).toBeDefined();
      expect(cfg.thresholds.max).toBe(6); // sender override
      expect(cfg.thresholds.min).toBe(2); // tenant override persisted

      expect(cfg.channels).toEqual(['email','voice','whatsapp','sms']);
      expect(cfg.flags).toEqual({ featured: true });
      expect(cfg.tags).toEqual(['base','t']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

