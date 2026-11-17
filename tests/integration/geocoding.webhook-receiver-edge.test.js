const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { skipIfMissing } = require('../utils/test-env');
const { upsertSettings } = require('../utils/policies');
const {
  makeTestIdentifiers,
  fetchSource,
  fetchWebhookPolicy,
  overrideWebhookMapping,
  seedMappingConfig,
  configureGeocodingPolicy,
  executeWebhookEdge,
  progressRun,
  fetchOutboundByRun,
  resetWebhookRunsForSource,
  cleanupGeocodingTestFixture,
} = require('./helpers/geocodingWebhookIntake');

loadEnv();

const missing = skipIfMissing(
  ['SUPABASE_URL', 'DATABASE_URL', 'SUPABASE_ANON_KEY', 'WEBHOOK_DB_JWT'],
  'geocoding webhook-receiver edge e2e',
);
const httpEnabled = process.env.RUN_WEBHOOK_HTTP_TESTS === 'true' && !missing;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

jest.setTimeout(150000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearSettingsCacheByCategory(client, category) {
  await client.query(
    `DELETE FROM settings_cache
      WHERE cache_key LIKE $1`,
    [`${category}:%`],
  );
}

async function executeWebhookEdgeWithRetry(payload, retries = 8, token) {
  let last;
  for (let i = 0; i < retries; i += 1) {
    last = await executeWebhookEdge(payload, token ? { token } : undefined);
    if (last.response.status !== 503) {
      return last;
    }
    await sleep(750 * (i + 1));
  }
  return last;
}

const describeIfHttp = httpEnabled ? describe : describe.skip;

async function fetchSettingsRow(client, category, scopeType, scopeId) {
  const { rows } = await client.query(
    `
      SELECT
        s.id AS settings_id,
        s.settings_version_id,
        s.scope_hash,
        s.cached_value
      FROM settings s
      WHERE s.category = $1
        AND s.scope_type = $2
        AND s.scope_id IS NOT DISTINCT FROM $3
      ORDER BY s.last_updated DESC
      LIMIT 1
    `,
    [category, scopeType, scopeId ?? null],
  );
  return rows[0] || null;
}

async function restoreSettingsExact(client, category, scopeType, scopeId, baselineRow) {
  if (!baselineRow) {
    await client.query(
      `
        DELETE FROM settings
        WHERE category = $1
          AND scope_type = $2
          AND scope_id IS NOT DISTINCT FROM $3
      `,
      [category, scopeType, scopeId ?? null],
    );
    await client.query(
      `
        DELETE FROM settings_versions sv
        WHERE sv.category = $1
          AND sv.scope_type = $2
          AND sv.scope_id IS NOT DISTINCT FROM $3
          AND NOT EXISTS (
            SELECT 1
            FROM settings s
            WHERE s.settings_version_id = sv.id
              AND s.scope_hash = sv.scope_hash
          )
      `,
      [category, scopeType, scopeId ?? null],
    );
    return;
  }

  await client.query(
    `
      UPDATE settings_versions
      SET value = $1::jsonb,
          change_reason = 'integration restore baseline',
          approved_at = COALESCE(approved_at, now()),
          effective_from = COALESCE(effective_from, now())
      WHERE id = $2::uuid
        AND scope_hash = $3::uuid
    `,
    [baselineRow.cached_value, baselineRow.settings_version_id, baselineRow.scope_hash],
  );

  await client.query(
    `
      UPDATE settings
      SET cached_value = $1::jsonb,
          last_updated = now()
      WHERE id = $2::uuid
    `,
    [baselineRow.cached_value, baselineRow.settings_id],
  );
}

describeIfHttp('Geocoding webhook receiver (edge) end-to-end', () => {
  let client;
  let source;
  let testIds;
  let baselineWebhookPolicy;
  let baselineGeocodingClient;
  let baselineGeocodingSender;
  const mappingConfigIds = new Set();

  beforeAll(async () => {
    client = await pool.connect();
    testIds = makeTestIdentifiers('edge');
    source = await fetchSource(client, testIds.sourceIdentifier, { token: testIds.token });
    baselineWebhookPolicy = await fetchWebhookPolicy(client, source.id);
    baselineGeocodingClient = await fetchSettingsRow(client, 'geocoding_policy', 'client', source.client_id);
    baselineGeocodingSender = source.sender_id
      ? await fetchSettingsRow(client, 'geocoding_policy', 'sender', source.sender_id)
      : null;
  });

  afterAll(async () => {
    if (baselineWebhookPolicy) {
      await upsertSettings(
        'webhook_ingest_policy',
        'source',
        source.id,
        baselineWebhookPolicy,
        'integration geocoding webhook policy restore',
        client,
      );
    }

    if (source?.client_id) {
      await restoreSettingsExact(client, 'geocoding_policy', 'client', source.client_id, baselineGeocodingClient);
    }
    if (source?.sender_id) {
      await restoreSettingsExact(client, 'geocoding_policy', 'sender', source.sender_id, baselineGeocodingSender);
    }

    if (mappingConfigIds.size) {
      await client.query(
        `DELETE FROM mapping_configs WHERE id = ANY($1::uuid[])`,
        [Array.from(mappingConfigIds)],
      );
    }

    if (testIds?.sourceIdentifier) {
      await cleanupGeocodingTestFixture(client, testIds.sourceIdentifier, { token: testIds.token });
    }

    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await resetWebhookRunsForSource(client, testIds.sourceIdentifier, { token: testIds.token });
    await upsertSettings(
      'webhook_ingest_policy',
      'source',
      source.id,
      baselineWebhookPolicy,
      'integration geocoding webhook policy reset',
      client,
    );

    await restoreSettingsExact(client, 'geocoding_policy', 'client', source.client_id, baselineGeocodingClient);
    if (source.sender_id) {
      await restoreSettingsExact(client, 'geocoding_policy', 'sender', source.sender_id, baselineGeocodingSender);
    }
    await clearSettingsCacheByCategory(client, 'webhook_ingest_policy');
    await clearSettingsCacheByCategory(client, 'geocoding_policy');
  });

  const runAndAssert = async (
    payload,
    policy,
    expectations,
    {
      scopeType = source.sender_id ? 'sender' : 'client',
      scopeId = source.sender_id || source.client_id,
      applyPolicy = true,
    } = {},
  ) => {
    if (applyPolicy && policy) {
      await configureGeocodingPolicy(client, scopeType, scopeId, policy);
    }
    await clearSettingsCacheByCategory(client, 'webhook_ingest_policy');
    await clearSettingsCacheByCategory(client, 'geocoding_policy');

    const { response, body } = await executeWebhookEdgeWithRetry(payload, 8, testIds.token);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);

    const runId = body?.followup_workflow_run_id || body?.workflow_run_id;
    expect(typeof runId).toBe('string');

    const runProgressed = await progressRun(client, runId, 12);
    const ctx =
      typeof runProgressed.context === 'string'
        ? JSON.parse(runProgressed.context)
        : runProgressed.context || {};

    expect(ctx.address_id).toBeTruthy();
    expect(ctx.organization_id || ctx.workflow?.context_patch?.organization_id).toBeTruthy();
    expect(ctx.client_id || ctx.workflow?.context_patch?.client_id).toBeTruthy();

    if (expectations.expectLocal) {
      expect(ctx.geocoding?.local_match).toBe(true);
      expect(ctx.geocoding?.successful).toBe(true);
      const outbound = await fetchOutboundByRun(client, runId);
      expect(outbound).toBeNull();
    }

    if (expectations.expectReverseLocal) {
      expect(ctx.geocoding?.local_reverse_match).toBeTruthy();
      expect(ctx.geocoding?.successful).toBe(true);
      expect(ctx.geocoding?.selected_geocode?.provider_name).toBe('reverse_local');
      const outbound = await fetchOutboundByRun(client, runId);
      expect(outbound).toBeNull();
    }

    if (expectations.expectProvider) {
      const outbound = await fetchOutboundByRun(client, runId, {
        attempts: 16,
        delayMs: 500,
        progress: true,
      });
      expect(outbound).toBeTruthy();
      expect(outbound.call_type).toBe('provider_api');
      expect(outbound.method).toBe('GET');
      expect(outbound.headers?.accept || outbound.headers?.Accept).toMatch(/application\/json/i);
      const bodyEmpty =
        outbound.body === null ||
        outbound.body === '' ||
        (typeof outbound.body === 'object' && Object.keys(outbound.body || {}).length === 0);
      expect(bodyEmpty).toBe(true);

      // Secret hygiene: outbound_calls.url should NOT store secrets; auth is injected at dispatch-time.
      const storedParams = new URL(outbound.url).searchParams;
      expect(storedParams.has('apiKey') || storedParams.has('apikey') || storedParams.has('key')).toBe(false);
      if (expectations.expectReverse) {
        expect(storedParams.get('at')).toBeTruthy();
      } else {
        expect(storedParams.get('q')).toBeTruthy();
      }
      expect(storedParams.get('lang')).toBeTruthy();
      expect(storedParams.get('limit')).toBeTruthy();

      const { rows: specRows } = await client.query(
        `SELECT public.get_job_call_spec($1::uuid) AS spec`,
        [outbound.id],
      );
      expect(specRows.length).toBe(1);
      const spec = specRows[0].spec;
      const specParams = new URL(spec.url).searchParams;
      expect(specParams.get('apiKey') || specParams.get('apikey') || specParams.get('key')).toBeTruthy();
      if (expectations.expectReverse) {
        expect(specParams.get('at')).toBeTruthy();
      } else {
        expect(specParams.get('q')).toBeTruthy();
      }
      expect(specParams.get('lang')).toBeTruthy();
      expect(specParams.get('limit')).toBeTruthy();
    }

    return { runId, addressId: ctx.address_id };
  };

  test('local-only mixed-language address resolves without provider dispatch', async () => {
    const payload = {
      event: { id: `evt-${randomUUID()}` },
      address: {
        line1: 'شارع العليا 12, Olaya St 12',
        city: 'Riyadh',
        district: 'Al Olaya',
        province: 'Riyadh',
        country: 'SA',
      },
    };

    await runAndAssert(
      payload,
      {
        provider_priority: [],
        local_lookup: { enabled: true, min_confidence: 0.2, prefer_district_centroid: true },
      },
      { expectLocal: true, expectProvider: false, expectReverseLocal: false },
    );
  });

  test('sender override forces local-only even when client prefers provider fallback', async () => {
    if (!source.sender_id) {
      throw new Error('Expected geocoding-intake-test source to have sender_id for sender override test');
    }

    // Client-level prefers provider dispatch
    await configureGeocodingPolicy(client, 'client', source.client_id, {
      provider_priority: ['here_geocoding'],
      local_lookup: { enabled: false },
    });

    const payload = {
      event: { id: `evt-${randomUUID()}` },
      address: {
        line1: 'حي الملك فهد, King Fahd District',
        city: 'Riyadh',
        district: 'King Fahd',
        province: 'Riyadh',
        country: 'SA',
      },
    };

    // Sender-level override enforces local-only
    await runAndAssert(
      payload,
      {
        provider_priority: [],
        local_lookup: { enabled: true, min_confidence: 0.25, prefer_district_centroid: true },
      },
      { expectLocal: true, expectProvider: false, expectReverseLocal: false },
      { scopeType: 'sender', scopeId: source.sender_id },
    );
  });

  test('unrecognized forward address falls back to provider dispatch (no live call)', async () => {
    const payload = {
      event: { id: `evt-${randomUUID()}` },
      address: {
        line1: `Unknown-${randomUUID()}-address`,
        city: '',
        country: 'SA',
      },
    };

    await runAndAssert(
      payload,
      {
        provider_priority: ['here_geocoding'],
        local_lookup: { enabled: true, min_confidence: 1.01 },
      },
      { expectLocal: false, expectProvider: true, expectReverse: false, expectReverseLocal: false },
    );
  });

  test('reverse_local short-circuits via polygons when coordinates are provided (coords-only payload)', async () => {
    const payload = {
      event: { id: `evt-${randomUUID()}` },
      destinationAddress: {
        addressLine1: 'Coordinates only',
        latitude: 24.7136,
        longitude: 46.6753,
      },
    };

    await runAndAssert(
      payload,
      {
        provider_priority: ['here_geocoding'],
        local_lookup: { enabled: false },
        matching_plugins: [
          { name: 'reverse', enabled: true },
          { name: 'reverse_local', enabled: true },
        ],
      },
      { expectLocal: false, expectProvider: false, expectReverseLocal: true },
    );
  });

  test('reverse provider dispatch is used when reverse_local is disabled (nested payload keys)', async () => {
    const payload = {
      event: { id: `evt-${randomUUID()}` },
      destinationAddress: {
        addressLine1: 'Coordinates only',
        latitude: 24.7136,
        longitude: 46.6753,
      },
    };

    await runAndAssert(
      payload,
      {
        provider_priority: ['here_geocoding'],
        local_lookup: { enabled: false },
        matching_plugins: [
          { name: 'reverse', enabled: true },
          { name: 'reverse_local', enabled: false },
        ],
      },
      { expectLocal: false, expectProvider: true, expectReverse: true, expectReverseLocal: false },
    );
  });

  test('mapping override supports alternate payload shapes (originAddress)', async () => {
    const mappingId = await seedMappingConfig(
      client,
      source.organization_id,
      `geocoding-intake-test::edge.origin_${randomUUID()}`,
      {
        line1: 'originAddress.addressLine1',
        line2: 'originAddress.addressLine2',
        city: 'originAddress.city|originAddress.arabicCityName',
        district: 'originAddress.village|originAddress.arabicVillageName',
        province: 'originAddress.region|originAddress.regionPrefix',
        country: 'originAddress.country',
        postal_code: 'originAddress.zipCode',
        lat: 'originAddress.latitude',
        lng: 'originAddress.longitude',
      },
    );
    mappingConfigIds.add(mappingId);

    await overrideWebhookMapping(client, source.id, mappingId);

    const payload = {
      event: { id: `evt-${randomUUID()}` },
      originAddress: {
        addressLine1: 'King Abdulaziz Rd',
        city: 'Jeddah',
        region: 'Makkah',
        arabicCityName: 'جدة',
        arabicRegionName: 'مكة المكرمة',
        latitude: 21.4858,
        longitude: 39.1925,
      },
    };

    await runAndAssert(
      payload,
      {
        provider_priority: ['here_geocoding'],
        local_lookup: { enabled: false },
        matching_plugins: [
          { name: 'reverse', enabled: true },
          { name: 'reverse_local', enabled: false },
        ],
      },
      { expectLocal: false, expectProvider: true, expectReverse: true, expectReverseLocal: false },
    );
  });
});
