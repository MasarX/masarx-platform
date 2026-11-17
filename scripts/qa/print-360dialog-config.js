#!/usr/bin/env node
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { parseFlagArgs } = require('../utils/cli-args');
const { resolveProvider } = require('../utils/provider-resolver');

async function main() {
  loadEnv();
  const flags = parseFlagArgs(process.argv.slice(2));
  const orgOptions = {
    organizationId: flags['organization-id'] || process.env.ORGANIZATION_ID,
    organizationSlug: flags['organization-slug'] || process.env.ORGANIZATION_SLUG,
  };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { providerId } = await resolveProvider(
      client,
      'dialog360_whatsapp',
      orgOptions,
    );

    const auth = await client.query(
      `SELECT public.get_provider_auth_credential(pac.id, 'api_key') AS api_key
       FROM provider_auth_configs pac
       WHERE pac.provider_id = $1 AND pac.auth_type = 'api_key'
       ORDER BY created_at DESC LIMIT 1`,
      [providerId]
    );

    const defaults = await client.query(
      `SELECT cached_value->>'default_recipient' AS default_recipient
       FROM settings
       WHERE category = 'provider_defaults' AND scope_type = 'resource' AND scope_id = $1
       LIMIT 1`,
      [providerId]
    );

    const config = { providerId, api_key: auth.rows[0]?.api_key, default_recipient: defaults.rows[0]?.default_recipient };
    console.log(JSON.stringify(config, null, 2));

    // Also show runtime-config view from client module
    const { dialog360 } = require('../clients');
    const runtime = await dialog360.getConfig();
    console.log('\nRuntime config:');
    console.log(JSON.stringify(runtime, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

