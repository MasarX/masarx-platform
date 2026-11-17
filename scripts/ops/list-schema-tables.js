#!/usr/bin/env node

/**
 * Utility: list tables in a schema (optionally filtered by prefix).
 *
 * Usage:
 *   node scripts/ops/list-schema-tables.js --schema=public --prefix=label
 *
 * Reads DATABASE_URL from the standard environment loader so it works for
 * both local and cloud databases. Outputs a JSON array to stdout.
 */

const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const args = process.argv.slice(2);
const options = {};

for (const arg of args) {
  const [key, value] = arg.split('=');
  if (!key.startsWith('--')) continue;
  const optionKey = key.slice(2);
  options[optionKey] = value ?? true;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[list-schema-tables] DATABASE_URL is not set. Load config/env/.env.cloud or provide ENV_FILE.');
  process.exit(1);
}

const schema = options.schema || 'public';
const prefix = options.prefix || '';

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const text = `
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = $1
      AND ($2 = '' OR tablename ILIKE $2 || '%')
    ORDER BY tablename;
  `;

  const values = [schema, prefix];
  const result = await client.query(text, values);
  await client.end();

  const tables = result.rows.map((row) => row.tablename);
  console.log(JSON.stringify({ schema, prefix, tables }, null, 2));
}

main().catch((error) => {
  console.error('[list-schema-tables] Failed to list tables:', error.message);
  process.exit(1);
});
