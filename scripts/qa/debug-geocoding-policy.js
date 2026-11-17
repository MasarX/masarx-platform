#!/usr/bin/env node
/* eslint-disable no-console */
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { resolveGeocodingPolicy } = require('../../tests/integration/helpers/geocodingPolicy');

loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `
        SELECT
          o.id AS organization_id,
          c.id AS client_id,
          s.id AS sender_id
        FROM organizations o
        JOIN clients c ON c.organization_id = o.id
        JOIN senders s ON s.client_id = c.id
        ORDER BY o.created_at
        LIMIT 1
      `
    );
    if (!rows.length) {
      throw new Error('No org/client/sender found');
    }
    const { client_id } = rows[0];
    const policy = await resolveGeocodingPolicy(client, 'client', client_id);
    console.log(
      'client geocoding_policy.auto_learning.components.district =',
      JSON.stringify(policy?.auto_learning?.components?.district || null, null, 2)
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

