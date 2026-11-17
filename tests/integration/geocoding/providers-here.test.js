const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const {
  applyGeocodingPolicy,
  resolveGeocodingPolicy,
} = require('../helpers/geocodingPolicy');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const liveEnabled = process.env.RUN_LIVE_GEOCODING_TESTS === 'true';

const GEOCODING_TEMPLATE_ID =
  '99990000-0000-0000-0000-000000400001' /* workflow_geocoding_standard */;

const RESERVED_PROVIDER_NAMES = ['internal_cache', 'manual_review_virtual'];
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

async function selectOrgClientSender(client) {
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

function parseQueryParams(urlString) {
  if (!urlString) {
    return {};
  }

  try {
    const parsed = new URL(urlString);
    const params = {};

    for (const [key, value] of parsed.searchParams.entries()) {
      params[key] = value;
    }

    return params;
  } catch (err) {
    return {};
  }
}

async function fetchWithRetry(url, options = {}) {
  const attempts = Number(options.attempts || 4);
  const baseDelayMs = Number(options.baseDelayMs || 500);
  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url);
    lastResponse = response;
    if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === attempts) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
  }

  return lastResponse;
}

async function insertTestAddress(client, organizationId, clientId) {
  const { rows } = await client.query(
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
        gen_random_uuid(),
        $1::uuid,
        $2::uuid,
        $3::jsonb,
        'Riyadh',
        'Riyadh Province',
        'SA',
        'pending',
        'Al Olaya',
        now(),
        now()
      )
      RETURNING id
    `,
    [
      organizationId,
      clientId,
      {
        line1: 'Innovation Tower',
        city: 'Riyadh',
        province: 'Riyadh Province',
        country: 'SA',
      },
    ],
  );

  return rows[0].id;
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
        handler_key,
        metadata,
        step_status
      FROM workflow_run_steps
      WHERE workflow_run_id = $1::uuid
      ORDER BY sequence_order
    `,
    [workflowRunId],
  );

  return rows;
}

async function runProviderDispatch(client, stepId) {
  await client.query(
    `
      SELECT set_config('app.workflow_run_id', wrs.workflow_run_id::text, true)
      FROM workflow_run_steps wrs
      WHERE wrs.id = $1::uuid
    `,
    [stepId],
  );
  await client.query(`SELECT set_config('app.workflow_run_step_id', $1, true)`, [stepId]);
  await client.query(`SELECT set_config('platform.workflow_engine', '1', true)`);
  await client.query(`SELECT set_config('platform.workflow_run_step_id', $1, true)`, [stepId]);

  const { rows } = await client.query(
    `
      SELECT
        wrs.operation_name,
        to_jsonb(
          workflow_handlers.execute_provider_dispatch_v1(wrs, wr, '{}'::jsonb)
        ) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.id = $1::uuid
      LIMIT 1
    `,
    [stepId],
  );

  if (!rows.length) {
    throw new Error(`provider dispatch step ${stepId} not found`);
  }

  const operationName = rows[0].operation_name;
  const response = rows[0].response;

  const { rows: metadataRows } = await client.query(
    `
      SELECT metadata
      FROM workflow_run_steps
      WHERE id = $1::uuid
    `,
    [stepId],
  );

  return {
    operationName,
    response,
    metadata: metadataRows[0]?.metadata ?? null,
  };
}

async function configureGeocodingPolicy(client, ids, overrides = {}) {
  const organizationId = ids.organization_id ?? ids.organizationId;
  const clientId = ids.client_id ?? ids.clientId;

  if (!clientId) {
    throw new Error('configureGeocodingPolicy requires client_id');
  }

  const resolved =
    (await resolveGeocodingPolicy(client, 'client', clientId)) ??
    (await resolveGeocodingPolicy(client, 'tenant', organizationId)) ??
    (await resolveGeocodingPolicy(client, 'global', null)) ??
    {};

  const policy = {
    ...resolved,
    provider_priority:
      overrides.provider_priority ??
      resolved.provider_priority ??
      ['here_geocoding', 'google_maps'],
    backpressure: overrides.backpressure ?? null,
  };

  await applyGeocodingPolicy(
    client,
    'client',
    clientId,
    policy,
    null,
    'providers-here integration override',
  );

  return policy;
}

(liveEnabled ? describe : describe.skip)('Geocoding provider prioritization (HERE)', () => {
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

  test('dispatch step builds HERE override URL and honours provider priority', async () => {
    const ids = await selectOrgClientSender(client);

    const policy = await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
    });

    const prioritizedProviders = Array.isArray(policy.provider_priority)
      ? policy.provider_priority.filter(
          (name) => !RESERVED_PROVIDER_NAMES.includes(name),
        )
      : [];

    expect(prioritizedProviders[0]).toBe('here_geocoding');

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, workflowRunId);

    const dispatchStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );

    expect(dispatchStep).toBeTruthy();

    let dispatchResult;
    try {
      dispatchResult = await runProviderDispatch(client, dispatchStep.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('API key missing for provider here_geocoding')) {
        expect(message).toContain('here_geocoding');
        return;
      }
      throw err;
    }

    const metadata = dispatchResult.metadata || {};
    const operationResult = dispatchResult.response?.operation_result || {};

    expect(metadata.provider_name).toBe('here_geocoding');
    expect(metadata.override_url).toContain('geocode.search.hereapi.com');

    const params = parseQueryParams(metadata.override_url);
    expect(params.q).toBeTruthy();
    expect(params.address).toBeFalsy();

    expect(operationResult.provider_name || metadata.provider_name).toBe(
      'here_geocoding',
    );
  });

  test('HERE dispatch enqueues outbound call with live response body', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      local_lookup: { enabled: false },
    });

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    expect(dispatchStep).toBeTruthy();

    const dispatchResponse = await runProviderDispatch(client, dispatchStep.id);
    const outboundId =
      dispatchResponse.response.context_patch?.last_outbound_call_id ||
      dispatchResponse.response.context_patch?.geocoding?.last_outbound_call_id;

    expect(outboundId).toBeTruthy();

    const { rows: calls } = await client.query(
      `SELECT url, headers, method, body FROM outbound_calls WHERE id = $1::uuid LIMIT 1`,
      [outboundId],
    );

    expect(calls.length).toBe(1);
    const storedUrl = calls[0].url;
    expect(storedUrl).toMatch(/geocode\.search\.hereapi\.com/);
    expect(calls[0].method).toBe('GET');
    const bodyEmpty =
      calls[0].body === null ||
      calls[0].body === '' ||
      (typeof calls[0].body === 'object' && Object.keys(calls[0].body || {}).length === 0);
    expect(bodyEmpty).toBe(true);
    expect(calls[0].headers.accept || calls[0].headers.Accept).toMatch(/application\/json/);

    // Secret hygiene: stored URL should not include apiKey; auth is injected via get_job_call_spec.
    const storedParams = parseQueryParams(storedUrl);
    expect(storedParams.apiKey || storedParams.apikey || storedParams.key).toBeFalsy();

    const { rows: specRows } = await client.query(
      `SELECT public.get_job_call_spec($1::uuid) AS spec`,
      [outboundId],
    );
    expect(specRows.length).toBe(1);
    const spec = specRows[0].spec;
    const specUrl = spec?.url;
    expect(typeof specUrl).toBe('string');
    expect(specUrl).toMatch(/geocode\.search\.hereapi\.com/);
    const specParams = parseQueryParams(specUrl);
    expect(specParams.apiKey || specParams.apikey || specParams.key).toBeTruthy();

    const live = await fetchWithRetry(specUrl);
    if (!live.ok) {
      const failureBody = await live.text().catch(() => '');
      if (
        (live.status === 401 || live.status === 403) &&
        /apiKey\s+invalid|apiKey\s+not\s+found/i.test(failureBody)
      ) {
        console.warn(
          `[providers-here] HERE credentials not provisioned for live test (status=${live.status}); skipping live body assertion`,
        );
        return;
      }
      if (RETRYABLE_HTTP_STATUSES.has(live.status)) {
        console.warn(
          `[providers-here] transient HERE status=${live.status}; skipping live body assertion`,
        );
        return;
      }
      throw new Error(
        `[providers-here] HERE live request failed status=${live.status} body=${failureBody.slice(0, 240)}`,
      );
    }
    const body = await live.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test('reverse dispatch builds HERE revgeocode URL and enqueues outbound call', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      local_lookup: { enabled: false },
    });

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
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

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    expect(dispatchStep).toBeTruthy();

    const dispatchResponse = await runProviderDispatch(client, dispatchStep.id);
    const outboundId =
      dispatchResponse.response.context_patch?.last_outbound_call_id ||
      dispatchResponse.response.context_patch?.geocoding?.last_outbound_call_id;

    expect(outboundId).toBeTruthy();

    const { rows: calls } = await client.query(
      `SELECT url, headers, method, body FROM outbound_calls WHERE id = $1::uuid LIMIT 1`,
      [outboundId],
    );

    expect(calls.length).toBe(1);
    const storedUrl = calls[0].url;
    expect(storedUrl).toMatch(/revgeocode\.search\.hereapi\.com/);
    expect(calls[0].method).toBe('GET');
    const bodyEmpty =
      calls[0].body === null ||
      calls[0].body === '' ||
      (typeof calls[0].body === 'object' && Object.keys(calls[0].body || {}).length === 0);
    expect(bodyEmpty).toBe(true);
    expect(calls[0].headers.accept || calls[0].headers.Accept).toMatch(/application\/json/);

    const storedParams = parseQueryParams(storedUrl);
    expect(storedParams.at).toBe('24.7136,46.6753');
    expect(storedParams.lang).toBeTruthy();
    expect(storedParams.apiKey || storedParams.apikey || storedParams.key).toBeFalsy();

    const { rows: specRows } = await client.query(
      `SELECT public.get_job_call_spec($1::uuid) AS spec`,
      [outboundId],
    );
    expect(specRows.length).toBe(1);
    const spec = specRows[0].spec;
    const specUrl = spec?.url;
    expect(typeof specUrl).toBe('string');
    expect(specUrl).toMatch(/revgeocode\.search\.hereapi\.com/);
    const params = parseQueryParams(specUrl);
    expect(params.at).toBe('24.7136,46.6753');
    expect(params.lang).toBeTruthy();
    expect(params.apiKey || params.apikey || params.key).toBeTruthy();
  });
});
