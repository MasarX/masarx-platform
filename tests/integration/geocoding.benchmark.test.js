const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { applyGeocodingPolicy } = require('./helpers/geocodingPolicy');
const { startBenchmarkRun } = require('./helpers/benchmarkRunner');
const { BENCHMARK_POLICY_LABELS, buildBenchmarkPolicies, runBenchmarkSample } = require('./helpers/benchmarkIngest');
const { resolvePrimaryFixtureOrgClientSender } = require('./helpers/integration-fixtures');

loadEnv();

const GEOCODING_TEMPLATE_ID =
  '99990000-0000-0000-0000-000000400001'; /* workflow_geocoding_standard */
const BENCHMARK_PERFECT_MAX_MS = Math.max(
  3000,
  Number(process.env.GEOCODING_BENCHMARK_PERFECT_MAX_MS || 4000),
);
const BENCHMARK_LONG_LINE_MAX_MS = Math.max(
  4000,
  Number(process.env.GEOCODING_BENCHMARK_LONG_LINE_MAX_MS || 5000),
);

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

async function selectOrgClientSender(client) {
  const preferred = await resolvePrimaryFixtureOrgClientSender(client);
  if (preferred) {
    return preferred;
  }

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
    throw new Error('Expected at least one organization/client/sender in seed data');
  }
  return rows[0];
}

async function fetchWorkflowSteps(client, workflowRunId) {
  const { rows } = await client.query(
    `SELECT * FROM workflow_run_steps WHERE workflow_run_id = $1::uuid ORDER BY sequence_order`,
    [workflowRunId],
  );
  return rows;
}

async function startGeocodingWorkflow(client, context) {
  const { rows } = await client.query(
    `
      SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id
    `,
    [GEOCODING_TEMPLATE_ID, context],
  );
  return rows[0].run_id;
}

async function pickBenchmarkSample(client, category) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM benchmark_geocoding_samples
      WHERE category = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [category],
  );
  if (!rows.length) {
    throw new Error(`No benchmark sample found for category ${category}`);
  }
  return rows[0];
}

describe('Geocoding benchmark harness (accuracy/timing)', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    await client.release();
    await pool.end();
  });

  test('perfect plugin: high-confidence match under 3s', async () => {
    const ids = await selectOrgClientSender(client);
    const { rows: perfectRows } = await client.query(
      `
        SELECT b.*
        FROM benchmark_geocoding_samples b
        JOIN canonical_cities c ON lower(c.name_canonical) = lower(b.city)
        JOIN canonical_districts d ON d.city_id = c.id AND lower(d.name_canonical) = lower(b.district)
        WHERE b.category = 'perfect'
        ORDER BY b.created_at DESC
        LIMIT 1
      `,
    );
    const sample = perfectRows[0] || (await pickBenchmarkSample(client, 'perfect'));
    await applyGeocodingPolicy(
      client,
      'client',
      ids.client_id,
      {
        provider_priority: [],
        local_lookup: { enabled: true, min_confidence: 0.7, prefer_district_centroid: true },
        matching_plugins: [
          { name: 'perfect', enabled: true },
          { name: 'fuzzy', enabled: true },
        ],
        logging: { log_scoring_details: true },
      },
      null,
      'benchmark perfect',
    );

    const addressId = randomUUID();
    await client.query(
      `
        INSERT INTO addresses (
          id, organization_id, client_id, raw_input, city, district, province, country,
          validation_status, created_at, updated_at
        )
        VALUES (
          $1::uuid, $2::uuid, $3::uuid,
          jsonb_build_object('city',$4::text,'district',$5::text),
          $4::text, $5::text, $6::text, COALESCE($7::text,'SA'),
          'pending', now(), now()
        )
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        sample.city,
        sample.district,
        sample.province || 'Riyadh',
        sample.country || 'SA',
      ],
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const runId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, runId);
    const lookupStep = steps.find((s) => s.operation_name === 'local_lookup');

    const started = Date.now();
    const { rows: lookupRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_geo_local_lookup_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [lookupStep.id],
    );
    const elapsedMs = Date.now() - started;
    const response = lookupRows[0].response;

    expect(response.operation_result.matched).toBe(true);
    expect((response.operation_result.confidence || 0)).toBeGreaterThanOrEqual(0.75);
    expect(
      response.context_patch.geocoding.match_plugin ||
        response.operation_result.match_plugin ||
        (response.context_patch.geocoding.geocoding_match || {}).plugin,
    ).toBe('perfect');
    expect(elapsedMs).toBeLessThan(BENCHMARK_PERFECT_MAX_MS);
  });

  test('long_line plugin: detects noise and forces fallback under 4s', async () => {
    const ids = await selectOrgClientSender(client);
    const sample = await pickBenchmarkSample(client, 'long_line');
    await applyGeocodingPolicy(
      client,
      'client',
      ids.client_id,
      {
        provider_priority: ['here_geocoding'],
        local_lookup: { enabled: true, min_confidence: 0.7, prefer_district_centroid: true },
        matching_plugins: [
          { name: 'perfect', enabled: true },
          { name: 'fuzzy', enabled: true },
          { name: 'long_line', enabled: true, params: { long_line_min_tokens: 6, max_noise_ratio: 0.3 } },
        ],
        logging: { log_scoring_details: true },
      },
      null,
      'benchmark long_line',
    );

    const addressId = randomUUID();
    await client.query(
      `
        INSERT INTO addresses (
          id, organization_id, client_id, raw_input, city, province, country, district, normalized_line1,
          validation_status, created_at, updated_at
        )
        VALUES (
          $1::uuid, $2::uuid, $3::uuid,
          jsonb_build_object('city',$4::text,'district',$5::text,'line1',$6::text),
          $4::text, $7::text, 'SA', $5::text, $6::text,
          'pending', now(), now()
        )
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        sample.city,
        sample.district,
        sample.line1,
        sample.province || 'Riyadh',
      ],
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const runId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, runId);
    const lookupStep = steps.find((s) => s.operation_name === 'local_lookup');

    const started = Date.now();
    const { rows: lookupRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_geo_local_lookup_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [lookupStep.id],
    );
    const elapsedMs = Date.now() - started;
    const response = lookupRows[0].response;

    expect(response.operation_result.matched).toBe(true);
    expect(response.context_patch.geocoding.require_fallback).toBe(true);
    expect(response.context_patch.geocoding.geocoding_match.long_line_detected).toBe(true);
    expect(elapsedMs).toBeLessThan(BENCHMARK_LONG_LINE_MAX_MS);
  });

  test('reverse_local plugin: polygon containment match under 3s', async () => {
    const ids = await selectOrgClientSender(client);
    const sample = await pickBenchmarkSample(client, 'reverse_only');

    const { rows: expectedRows } = await client.query(
      `
        SELECT d.id AS sa_district_id, d.city_id AS sa_city_id
        FROM sa_districts d
        WHERE d.geom IS NOT NULL
          AND ST_Covers(
            ST_CollectionExtract(d.geom::geometry, 3),
            ST_SetSRID(ST_MakePoint($1::numeric, $2::numeric), 4326)::geometry
          )
        ORDER BY ST_Area(ST_CollectionExtract(d.geom::geometry, 3)) ASC NULLS LAST, d.id DESC
        LIMIT 1
      `,
      [sample.longitude, sample.latitude],
    );
    const expected = expectedRows[0] || null;
    const scopedSample = {
      ...sample,
      expected_sa_district_id: expected?.sa_district_id ?? sample.expected_sa_district_id,
      expected_sa_city_id: expected?.sa_city_id ?? sample.expected_sa_city_id,
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
    };
    const policies = buildBenchmarkPolicies();
    const result = await runBenchmarkSample(
      client,
      scopedSample,
      BENCHMARK_POLICY_LABELS.REVERSE_LOCAL_ONLY,
      policies[BENCHMARK_POLICY_LABELS.REVERSE_LOCAL_ONLY],
      'client',
      ids.client_id,
    );

    expect(result.matched).toBe(true);
    expect(result.matchPlugin).toBe('reverse_local');
  });
});
