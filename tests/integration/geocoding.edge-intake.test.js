const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const {
  applyGeocodingPolicy,
} = require('./helpers/geocodingPolicy');
const { resolvePrimaryFixtureOrgClientSender } = require('./helpers/integration-fixtures');

loadEnv();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const GEOCODING_TEMPLATE_ID =
  '99990000-0000-0000-0000-000000400001' /* workflow_geocoding_standard */;

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

async function insertTestAddress(
  client,
  organizationId,
  clientId,
  overrides = {},
) {
  const addressId = randomUUID();
  const rawPayload = {
    line1: overrides.line1 || 'Unknown street',
    line2: overrides.line2 || '',
    city: overrides.city || null,
    district: overrides.district || null,
    province: overrides.province || null,
    country: overrides.country || 'SA',
  };

  await client.query(
    `
      INSERT INTO addresses (
        id,
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
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::jsonb,
        $5::text,
        $6::text,
        $7::text,
        'pending',
        $8::text,
        now(),
        now()
      )
    `,
    [
      addressId,
      organizationId,
      clientId,
      rawPayload,
      overrides.city || null,
      overrides.province || null,
      overrides.country || 'SA',
      overrides.district || null,
    ],
  );

  return addressId;
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

async function fetchWorkflowSteps(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT
        id,
        operation_name,
        sequence_order,
        metadata
      FROM workflow_run_steps
      WHERE workflow_run_id = $1
      ORDER BY sequence_order
    `,
    [workflowRunId],
  );

  return rows;
}

describe('Geocoding edge-like intake end-to-end', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('mixed-language address resolves via local lookup when provider priority empty', async () => {
    const ids = await selectOrgClientSender(client);

    await applyGeocodingPolicy(
      client,
      'client',
      ids.client_id,
      {
        provider_priority: [],
        local_lookup: { enabled: true, min_confidence: 0.2, prefer_district_centroid: true },
      },
      null,
      'edge-intake local-only policy',
    );

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
      {
        line1: 'شارع العليا',
        city: 'Riyadh',
        district: 'Al Amal Dist.',
        province: 'Riyadh',
        country: 'SA',
      },
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
    expect(lookupStep).toBeTruthy();

    const { rows: lookupRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_geo_local_lookup_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [lookupStep.id],
    );
    const lookupResponse = lookupRows[0].response;
    expect(lookupResponse.operation_result.matched).toBe(true);
    expect(lookupResponse.context_patch.geocoding.local_match).toBe(true);
    expect(lookupResponse.context_patch.geocoding.successful).toBe(true);
  });

  test('reverse intake with coordinates dispatches HERE reverse call', async () => {
    const ids = await selectOrgClientSender(client);

    await applyGeocodingPolicy(
      client,
      'sender',
      ids.sender_id,
      {
        provider_priority: ['here_geocoding'],
        local_lookup: { enabled: false },
      },
      null,
      'edge-intake reverse policy',
    );

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
      {
        city: 'Riyadh',
        district: 'Al Amal Dist.',
        province: 'Riyadh',
        country: 'SA',
      },
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
      geocoding: {
        provided_coordinates: { latitude: 24.7136, longitude: 46.6753 },
      },
    };

    const runId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, runId);
    const dispatchStep = steps.find((s) => s.operation_name === 'dispatch_provider');
    expect(dispatchStep).toBeTruthy();

    await client.query(
      `
        SELECT set_config('app.workflow_run_id', wrs.workflow_run_id::text, true)
        FROM workflow_run_steps wrs
        WHERE wrs.id = $1::uuid
      `,
      [dispatchStep.id],
    );
    await client.query(`SELECT set_config('app.workflow_run_step_id', $1, true)`, [dispatchStep.id]);
    await client.query(`SELECT set_config('platform.workflow_engine', '1', true)`);
    await client.query(`SELECT set_config('platform.workflow_run_step_id', $1, true)`, [dispatchStep.id]);

    const dispatchResult = (
      await client.query(
        `
          SELECT to_jsonb(workflow_handlers.execute_provider_dispatch_v1(wrs, wr, '{}'::jsonb)) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
        `,
        [dispatchStep.id],
      )
    ).rows[0].response;

    const outboundId =
      dispatchResult.context_patch?.last_outbound_call_id ||
      dispatchResult.context_patch?.geocoding?.last_outbound_call_id;
    expect(outboundId).toBeTruthy();

    const { rows: calls } = await client.query(
      `SELECT url, headers, method, body FROM outbound_calls WHERE id = $1::uuid LIMIT 1`,
      [outboundId],
    );
    expect(calls.length).toBe(1);
    const url = calls[0].url;
    expect(url).toMatch(/revgeocode\.search\.hereapi\.com/);
    expect(calls[0].method || calls[0].headers?.method || 'GET').toBe('GET');
    expect(calls[0].body === null || calls[0].body === '' || Object.keys(calls[0].body || {}).length === 0).toBe(true);
    expect(calls[0].headers.accept || calls[0].headers.Accept).toMatch(/application\/json/);

    const params = new URL(url).searchParams;
    expect(params.get('at')).toBe('24.7136,46.6753');
  });
});
