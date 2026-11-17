#!/usr/bin/env node
/* eslint-disable no-console */
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const {
  applyGeocodingPolicy,
  fetchScopedGeocodingPolicy,
  resolveGeocodingPolicy,
} = require('../../tests/integration/helpers/geocodingPolicy');

loadEnv();

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
      `,
    );

    if (!rows.length) {
      throw new Error('No organization/client/sender found to target auto-learn policy override');
    }

    const { organization_id, client_id } = rows[0];

    const existing = await fetchScopedGeocodingPolicy(client, 'client', client_id);
    let basePolicy = existing?.value;

    if (!basePolicy) {
      basePolicy =
        (await resolveGeocodingPolicy(client, 'client', client_id)) ??
        (await resolveGeocodingPolicy(client, 'tenant', organization_id)) ??
        (await resolveGeocodingPolicy(client, 'global', null)) ??
        {};
    }

    const components = (basePolicy.auto_learning && basePolicy.auto_learning.components) || {};
    const policy = {
      ...basePolicy,
      auto_learning: {
        ...(basePolicy.auto_learning || {}),
        enabled: true,
        confidence_threshold_for_auto_learn: 0.9,
        components: {
          ...components,
          city: {
            ...(components.city || {}),
            action_lookup: '{{LOOKUP:auto_learn_action.add_immediately}}',
          },
          district: {
            ...(components.district || {}),
            action_lookup: '{{LOOKUP:auto_learn_action.queue_for_review}}',
          },
        },
      },
    };

    await applyGeocodingPolicy(
      client,
      'client',
      client_id,
      policy,
      existing?.settingsVersionId,
      'Integration test auto-learn policy override (client)',
    );

    console.log('[override-auto-learn-policy] Updated client auto_learning configuration for test subject');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[override-auto-learn-policy] Failed:', err.message);
  process.exit(1);
});

