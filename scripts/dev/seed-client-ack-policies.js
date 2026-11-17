#!/usr/bin/env node
/* eslint-disable no-console */
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { upsertWebhookPolicy } = require('../../tests/utils/policies');

loadEnv();

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const mappingRows = await client.query(
      `
        SELECT id, mapping_key
        FROM mapping_configs
        WHERE mapping_type = 'webhook_response'
          AND mapping_key IN ('client_ack::logestechs_v1', 'client_ack::jarad_v1')
      `,
    );

    const mappingByKey = Object.fromEntries(
      mappingRows.rows.map((r) => [r.mapping_key, r.id]),
    );

    const mappingAId = mappingByKey['client_ack::logestechs_v1'];
    const mappingBId = mappingByKey['client_ack::jarad_v1'];

    if (!mappingAId || !mappingBId) {
      throw new Error(
        'Expected client_ack::logestechs_v1 and client_ack::jarad_v1 mapping_configs to exist',
      );
    }

    const { rows: sources } = await client.query(
      `
        SELECT id, organization_id, source_identifier
        FROM webhook_sources
        WHERE source_identifier IN ('test-client-a-ack', 'test-client-b-ack')
        ORDER BY created_at DESC
      `,
    );

    const sourcesByIdentifier = sources.reduce((acc, row) => {
      const key = row.source_identifier;
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    const pickSourceId = (identifier) => {
      const matches = sourcesByIdentifier[identifier] || [];
      if (!matches.length) {
        throw new Error(`Expected webhook_sources for ${identifier} to exist`);
      }
      if (matches.length > 1) {
        // eslint-disable-next-line no-console
        console.warn(
          `[seed-client-ack-policies] Multiple webhook_sources found for ${identifier}; using latest (${matches[0].id})`
        );
      }
      return matches[0].id;
    };

    const sourceAId = pickSourceId('test-client-a-ack');
    const sourceBId = pickSourceId('test-client-b-ack');

    if (!sourceAId || !sourceBId) {
      throw new Error(
        'Expected webhook_sources for test-client-a-ack and test-client-b-ack to exist',
      );
    }

    const baseHeaders = { 'content-type': 'application/json' };

    const policyA = {
      ack: {
        mode: 'synchronous_success',
        status_code: 200,
        default_headers: { ...baseHeaders, 'x-client-ack': 'logestechs' },
        response_mapping_id: mappingAId,
      },
    };

    const policyB = {
      ack: {
        mode: 'synchronous_success',
        status_code: 200,
        default_headers: { ...baseHeaders, 'x-client-ack': 'jarad' },
        response_mapping_id: mappingBId,
      },
    };

    await client.query('BEGIN');
    await upsertWebhookPolicy(
      'source',
      sourceAId,
      policyA,
      'Seed per-client ACK mapping for Client A (tests)',
      client,
    );
    await upsertWebhookPolicy(
      'source',
      sourceBId,
      policyB,
      'Seed per-client ACK mapping for Client B (tests)',
      client,
    );
    await client.query('COMMIT');

    console.log('[seed-client-ack-policies] Upserted ACK policies for Client A and B sources');
  } catch (err) {
    console.error('[seed-client-ack-policies] Failed:', err.message);
    try {
      await client.query('ROLLBACK');
    } catch (e) {
      // ignore
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
