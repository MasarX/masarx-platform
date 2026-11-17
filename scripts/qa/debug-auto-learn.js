#!/usr/bin/env node
/* eslint-disable no-console */
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const orgRes = await client.query(
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
    if (!orgRes.rows.length) {
      throw new Error('No org/client/sender found');
    }
    const { organization_id, client_id, sender_id } = orgRes.rows[0];

    const cityName = 'AUTO_LEARN_CITY_TEST';
    const provinceName = 'AUTO_LEARN_PROVINCE_TEST';
    const districtName = 'AUTO_LEARN_DISTRICT_TEST';
    const countryCode = 'SA';

    await client.query('BEGIN');

    await client.query(
      `DELETE FROM canonical_districts WHERE name_canonical = $1`,
      [districtName]
    );
    await client.query(
      `DELETE FROM canonical_cities WHERE name_canonical = $1`,
      [cityName]
    );
    await client.query(
      `DELETE FROM manual_review_tasks WHERE reason = 'Auto-learn district requires approval'`
    );

    const addressRes = await client.query(
      `
        INSERT INTO addresses (
          organization_id,
          client_id,
          raw_input,
          city,
          province,
          country,
          validation_status,
          district,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3::jsonb,
          $4,
          $5,
          $6,
          $7,
          $8,
          now(),
          now()
        )
        RETURNING id
      `,
      [
        organization_id,
        client_id,
        {
          line1: 'Test',
          city: cityName,
          province: provinceName,
          country: countryCode,
        },
        cityName,
        provinceName,
        countryCode,
        'pending',
        districtName,
      ]
    );
    const addressId = addressRes.rows[0].id;

    const providerPayload = {
      address_components: {
        city: cityName,
        district: districtName,
        countryCode,
      },
    };

    const callRes = await client.query(
      `
        SELECT auto_learn_geography(
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::jsonb,
          $6::jsonb,
          $7::numeric,
          $8::text
        ) AS outcome
      `,
      [
        organization_id,
        client_id,
        sender_id,
        addressId,
        {
          city: cityName,
          district: districtName,
          country: countryCode,
        },
        providerPayload,
        0.95,
        'here_geocoding',
      ]
    );

    console.log('auto_learn_geography outcome:', callRes.rows[0].outcome);

    const cityRows = await client.query(
      `SELECT * FROM canonical_cities WHERE organization_id = $1 AND name_canonical = $2`,
      [organization_id, cityName]
    );
    console.log('canonical_cities rows:', cityRows.rowCount);

    const taskRows = await client.query(
      `SELECT * FROM manual_review_tasks WHERE reason = 'Auto-learn district requires approval' AND address_id = $1`,
      [addressId]
    );
    console.log('manual_review_tasks rows:', taskRows.rowCount);

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

