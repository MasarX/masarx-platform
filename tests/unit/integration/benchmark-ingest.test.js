jest.mock('../../integration/helpers/benchmarkRunner', () => ({
  startBenchmarkRun: jest.fn(),
}));
jest.mock('../../integration/helpers/geocodingPolicy', () => ({
  applyGeocodingPolicy: jest.fn(),
}));
jest.mock('https', () => ({ get: jest.fn() }));

const { startBenchmarkRun } = require('../../integration/helpers/benchmarkRunner');
const https = require('https');
const {
  BENCHMARK_POLICY_LABELS,
  buildBenchmarkPolicies,
  runBenchmarkSample,
} = require('../../integration/helpers/benchmarkIngest');

const CITY_ID = '10000000-0000-0000-0000-000000000001';
const DISTRICT_ID = '20000000-0000-0000-0000-000000000001';
const OTHER_DISTRICT_ID = '20000000-0000-0000-0000-000000000002';
const SAMPLE = {
  id: '30000000-0000-0000-0000-000000000001',
  city: 'Riyadh',
  district: 'Expected district',
  expected_city_id: CITY_ID,
  expected_district_id: DISTRICT_ID,
  expected_sa_city_id: 1,
  expected_sa_district_id: 2,
};

function success(selectedGeocode, extra = {}) {
  return {
    status: 'completed',
    operation_result: { decision: 'success' },
    context_patch: { geocoding: { successful: true, selected_geocode: selectedGeocode } },
    ...extra,
  };
}

function makeClient({ coordinate = {}, lookup = {}, provider = {}, decision = {} } = {}) {
  const responses = {
    execute_geo_coordinate_v1: coordinate,
    execute_geo_local_lookup_v1: lookup,
    execute_provider_dispatch_v1: provider,
    execute_geo_decision_v1: decision,
  };
  const client = {
    query: jest.fn(async (sql, values) => {
      if (sql.includes('SELECT * FROM workflow_run_steps')) {
        return {
          rows: ['validate_coordinates', 'local_lookup', 'provider_dispatch', 'decision']
            .map((operation_name) => ({ operation_name, id: operation_name })),
        };
      }
      for (const [name, response] of Object.entries(responses)) {
        if (sql.includes(`workflow_handlers.${name}(`)) return { rows: [{ response }] };
      }
      if (sql.includes('SELECT set_config(')) return { rows: [] };
      if (sql.includes('benchmark_record_result_v2(')) {
        client.recorded = values;
        return { rows: [] };
      }
      throw new Error(`Unexpected benchmark SQL: ${sql}`);
    }),
  };
  return client;
}

async function run(client, sample = SAMPLE, policyLabel = BENCHMARK_POLICY_LABELS.PROVIDER_ONLY) {
  return runBenchmarkSample(
    client, sample, policyLabel, buildBenchmarkPolicies()[policyLabel],
    'client', '40000000-0000-0000-0000-000000000001', null, { skipPolicyApply: true },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  startBenchmarkRun.mockResolvedValue({ runId: 'workflow-run', addressId: 'address' });
});

test('missing provider output is recorded as a failed prediction without using expected labels', async () => {
  const client = makeClient({
    provider: { status: 'failed' },
    decision: {
      status: 'failed',
      operation_result: { decision: 'failed', reason: 'provider_failed' },
      context_patch: { geocoding: { successful: false } },
    },
  });

  await expect(run(client)).resolves.toMatchObject({ matched: false, failureReason: 'provider_failed' });
  expect(client.recorded[6]).toBe(false);
  expect(client.recorded.slice(8, 10)).toEqual([null, null]);
});

test('input coordinates cannot manufacture provider accuracy when no handler selected a geocode', async () => {
  const client = makeClient({ decision: { operation_result: { decision: 'manual_review' } } });

  await expect(run(client, { ...SAMPLE, latitude: 24.7, longitude: 46.7 }))
    .resolves.toMatchObject({ matched: false });
});

test('a correct city cannot hide the wrong expected district', async () => {
  const client = makeClient({
    decision: success({ city_id: CITY_ID, district_id: OTHER_DISTRICT_ID }),
  });

  await expect(run(client, { ...SAMPLE, expected_sa_city_id: null, expected_sa_district_id: null },
    BENCHMARK_POLICY_LABELS.LOCAL_ONLY))
    .resolves.toMatchObject({ matched: false, failureReason: 'mismatch' });
  expect(client.recorded.slice(8, 10)).toEqual([CITY_ID, OTHER_DISTRICT_ID]);
});

test.each([
  ['failed', { status: 'failed', operation_result: { decision: 'failed' } }],
  ['empty', success(null)],
  ['manual review', {
    status: 'completed',
    operation_result: { decision: 'manual_review' },
    context_patch: { geocoding: { successful: false, selected_geocode: { city_id: CITY_ID, district_id: DISTRICT_ID } } },
  }],
])('%s decisions cannot reuse a stale local prediction', async (_label, decision) => {
  const client = makeClient({
    coordinate: { operation_result: { local_reverse_match: { city_id: 1, district_id: 2 } } },
    lookup: {
      operation_result: { matched: true, confidence: 0.99 },
      context_patch: { geocoding: { selected_geocode: { city_id: CITY_ID, district_id: DISTRICT_ID } } },
    },
    decision,
  });

  await expect(run(client, SAMPLE, BENCHMARK_POLICY_LABELS.LOCAL_ONLY))
    .resolves.toMatchObject({ matched: false });
});

test('real local handler results retain their plugin, canonical IDs, and zero confidence', async () => {
  const geocode = {
    provider_name: 'canonical_lookup',
    confidence_score: 0,
    metadata: { city_id: CITY_ID, district_id: DISTRICT_ID, match_plugin: 'perfect' },
  };
  const client = makeClient({ decision: success(geocode) });

  await expect(run(client, { ...SAMPLE, expected_sa_city_id: null, expected_sa_district_id: null },
    BENCHMARK_POLICY_LABELS.LOCAL_ONLY))
    .resolves.toMatchObject({ matched: true, matchPlugin: 'perfect', confidence: 0 });
  expect(client.recorded.slice(8, 10)).toEqual([CITY_ID, DISTRICT_ID]);
});

test('real reverse-local polygon IDs are graded without expected-label or polygon queries', async () => {
  const client = makeClient({
    decision: success({ provider_name: 'reverse_local', metadata: { sa_city_id: 1, sa_district_id: 2 } }),
  });

  await expect(run(client, SAMPLE, BENCHMARK_POLICY_LABELS.REVERSE_LOCAL_ONLY))
    .resolves.toMatchObject({ matched: true, matchPlugin: 'reverse_local' });
});

test('explicit context success can reuse the actual coordinate handler result', async () => {
  const client = makeClient({
    coordinate: {
      context_patch: { geocoding: { selected_geocode: {
        provider_name: 'reverse_local', metadata: { sa_city_id: 1, sa_district_id: 2 },
      } } },
    },
    decision: {
      status: 'completed',
      operation_result: { decision: 'success', source: 'context' },
      context_patch: { geocoding: { successful: true } },
    },
  });

  await expect(run(client, SAMPLE, BENCHMARK_POLICY_LABELS.REVERSE_LOCAL_ONLY))
    .resolves.toMatchObject({ matched: true, matchPlugin: 'reverse_local' });
});

test('city-only ground truth accepts an actual city result', async () => {
  const client = makeClient({ decision: success({ city_id: CITY_ID }) });

  await expect(run(client, {
    ...SAMPLE, expected_district_id: null, expected_sa_district_id: null, expected_sa_city_id: null,
  }, BENCHMARK_POLICY_LABELS.LOCAL_ONLY))
    .resolves.toMatchObject({ matched: true });
});

test.each([
  ['Jeddah', false],
  ['  RIYADH  ', true],
])('name-only ground truth checks both city and district (%s)', async (city, matched) => {
  const client = makeClient({ decision: success({ city, district: 'Expected district' }) });

  await expect(run(client, {
    ...SAMPLE,
    expected_city_id: null, expected_district_id: null,
    expected_sa_city_id: null, expected_sa_district_id: null,
  }, BENCHMARK_POLICY_LABELS.LOCAL_ONLY))
    .resolves.toMatchObject({ matched });
});

test('an earlier reverse-local match cannot override the actual decision district', async () => {
  const client = makeClient({
    coordinate: { operation_result: { local_reverse_match: { city_id: 1, district_id: 2 } } },
    decision: success({ metadata: { sa_city_id: 1, sa_district_id: 3 } }),
  });

  await expect(run(client, SAMPLE, BENCHMARK_POLICY_LABELS.REVERSE_LOCAL_ONLY))
    .resolves.toMatchObject({ matched: false });
});

test('provider dispatch time is recorded separately from local and decision latency', async () => {
  let now = 0;
  const time = jest.spyOn(Date, 'now').mockImplementation(() => now);
  const client = makeClient({ decision: success({ city_id: CITY_ID, district_id: DISTRICT_ID }) });
  const originalQuery = client.query.getMockImplementation();
  client.query.mockImplementation(async (sql, values) => {
    const result = await originalQuery(sql, values);
    if (sql.includes('execute_geo_coordinate_v1(')) now += 10;
    if (sql.includes('execute_geo_local_lookup_v1(')) now += 20;
    if (sql.includes('execute_provider_dispatch_v1(')) now += 1000;
    if (sql.includes('execute_geo_decision_v1(')) now += 5;
    return result;
  });
  try {
    await expect(run(client)).resolves.toMatchObject({
      matched: true, localLatencyMs: 30, decisionLatencyMs: 5, providerLatencyMs: 1000,
    });
    expect(client.recorded.slice(12, 14)).toEqual([35, 1000]);
  } finally {
    time.mockRestore();
  }
});

test.each([
  {
    status: 'in_progress',
    operation_result: { outbound_call_id: 'outbound-call', headers: {}, body: {} },
    context_patch: { last_outbound_call_id: 'outbound-call' },
  },
  { status: 'pending' },
  { status: 'completed', operation_result: { status: 'queued', outbound_call_id: 'outbound-call' } },
])('unfinished provider dispatch is incomplete, not an accuracy result (%j)', async (provider) => {
  const client = makeClient({ provider, decision: success({ city_id: CITY_ID, district_id: DISTRICT_ID }) });

  await expect(run(client)).rejects.toMatchObject({ code: 'BENCHMARK_PROVIDER_PENDING' });
  const sql = client.query.mock.calls.map(([query]) => query).join('\n');
  expect(sql).not.toContain('execute_geo_decision_v1(');
  expect(sql).not.toContain('benchmark_record_result_v2(');
  expect(client.recorded).toBeUndefined();
});

test('a completed provider response with an outbound reference can still be graded', async () => {
  const client = makeClient({
    provider: { status: 'completed', operation_result: { outbound_call_id: 'outbound-call', status: 'succeeded' } },
    decision: success({ city_id: CITY_ID, district_id: DISTRICT_ID }),
  });

  await expect(run(client)).resolves.toMatchObject({ matched: true });
  expect(client.recorded[6]).toBe(true);
});

test('actual provider output is graded without a second HERE request', async () => {
  const previous = { live: process.env.RUN_LIVE_GEOCODING_TESTS, key: process.env.HERE_API_KEY };
  process.env.RUN_LIVE_GEOCODING_TESTS = 'true';
  process.env.HERE_API_KEY = 'hermetic-test-key';
  const client = makeClient({ decision: success({
    provider_name: 'here_geocoding', metadata: { sa_city_id: 1, sa_district_id: 2 },
  }) });
  try {
    await expect(run(client)).resolves.toMatchObject({ matched: true, matchPlugin: 'provider' });
    expect(https.get).not.toHaveBeenCalled();
  } finally {
    if (previous.live === undefined) delete process.env.RUN_LIVE_GEOCODING_TESTS;
    else process.env.RUN_LIVE_GEOCODING_TESTS = previous.live;
    if (previous.key === undefined) delete process.env.HERE_API_KEY;
    else process.env.HERE_API_KEY = previous.key;
  }
});
