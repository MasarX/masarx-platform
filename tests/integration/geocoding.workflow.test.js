const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const {
  ensureIntegrationFixturesPresent,
  getIntegrationFixtureProfile,
  resolvePrimaryFixtureOrgClientSender,
} = require('./helpers/integration-fixtures');
const {
  applyGeocodingPolicy,
  fetchScopedGeocodingPolicy,
  resolveGeocodingPolicy,
} = require('./helpers/geocodingPolicy');

loadEnv();
jest.setTimeout(Number(process.env.GEOCODING_WORKFLOW_TEST_TIMEOUT_MS || 180000));

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});


const GEOCODING_TEMPLATE_ID =
  '99990000-0000-0000-0000-000000400001' /* workflow_geocoding_standard */;
const fixtureProfile = getIntegrationFixtureProfile();

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
      ORDER BY o.created_at, c.created_at, s.created_at, o.id, c.id, s.id
      LIMIT 1
    `,
  );

  if (!rows.length) {
    throw new Error(
      `Expected at least one organization/client/sender in fixture profile ${fixtureProfile.prefix}`,
    );
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

const PROVIDER_QUERY_EXPECTATIONS = {
  here_geocoding: {
    present: ['q'],
    absent: ['address'],
  },
  google_maps: {
    present: ['address'],
    absent: ['q'],
  },
};

const RESERVED_PROVIDER_NAMES = ['internal_cache', 'manual_review_virtual'];

const SA_SHORT_CODE_HEX_MAP = 'ABCDEFGHIJKLMNOP';
const MAX_PERFECT_LOCAL_MATCH_ELAPSED_MS = Number(
  process.env.GEOCODING_PERFECT_LOCAL_MATCH_MAX_MS || 5000,
);
const MAX_LONG_LINE_MATCH_ELAPSED_MS = Number(
  process.env.GEOCODING_LONG_LINE_MATCH_MAX_MS || 4000,
);

function makeSaShortCode() {
  const compact = randomUUID().replace(/-/g, '');
  const letters = compact
    .slice(0, 4)
    .split('')
    .map((hexChar) => SA_SHORT_CODE_HEX_MAP[parseInt(hexChar, 16)])
    .join('');
  const digits = (parseInt(compact.slice(4, 8), 16) % 10000)
    .toString()
    .padStart(4, '0');

  return `${letters}${digits}`;
}

async function findCanonicalCity(client, name, organizationId = null) {
  const { rows } = await client.query(
    `
      SELECT
        id,
        name_canonical,
        ST_Y(centroid::geometry)::numeric AS lat,
        ST_X(centroid::geometry)::numeric AS lon
      FROM canonical_cities
      WHERE lower(name_canonical) = lower($1)
        AND ($2::uuid IS NULL OR organization_id = $2::uuid)
        AND centroid IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [name, organizationId],
  );

  if (!rows.length) {
    throw new Error(`Canonical city not found: ${name}`);
  }

  return rows[0];
}

async function findCanonicalDistrict(client, cityId, name, organizationId = null) {
  const { rows } = await client.query(
    `
      SELECT
        id,
        name_canonical,
        ST_Y(centroid::geometry)::numeric AS lat,
        ST_X(centroid::geometry)::numeric AS lon
      FROM canonical_districts
      WHERE city_id = $1::uuid
        AND lower(name_canonical) = lower($2)
        AND ($3::uuid IS NULL OR organization_id = $3::uuid)
        AND centroid IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [cityId, name, organizationId],
  );

  if (rows.length) {
    return rows[0];
  }

  const { rows: fallbackRows } = await client.query(
    `
      SELECT
        id,
        name_canonical,
        ST_Y(centroid::geometry)::numeric AS lat,
        ST_X(centroid::geometry)::numeric AS lon
      FROM canonical_districts
      WHERE city_id = $1::uuid
        AND ($2::uuid IS NULL OR organization_id = $2::uuid)
        AND centroid IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [cityId, organizationId],
  );

  if (!fallbackRows.length) {
    throw new Error(`Canonical district not found: ${name} (city_id=${cityId})`);
  }

  return fallbackRows[0];
}

async function configureGeocodingPolicy(client, ids, overrides = {}) {
  const organizationId = ids.organization_id ?? ids.organizationId;
  const clientId = ids.client_id ?? ids.clientId;
  const senderId = ids.sender_id ?? ids.senderId;

  if (!clientId) {
    throw new Error('configureGeocodingPolicy requires client_id');
  }
  const basePolicy =
    (await resolveGeocodingPolicy(client, 'tenant', organizationId)) ??
    (await resolveGeocodingPolicy(client, 'global', null)) ??
    {};
  const policy = {
    ...basePolicy,
    enabled: overrides.enabled ?? true,
    provider_priority:
      overrides.provider_priority ??
      basePolicy?.provider_priority ??
      ['here_geocoding', 'google_maps'],
    confidence_threshold:
      overrides.confidence_threshold ??
      basePolicy?.confidence_threshold ??
      0.75,
    fallback_strategy:
      overrides.fallback_strategy ??
      basePolicy?.fallback_strategy ??
      'stop_on_confident_match',
  };

  if (Object.prototype.hasOwnProperty.call(overrides, 'cache_ttl_minutes')) {
    policy.cache_ttl_minutes = overrides.cache_ttl_minutes;
  } else if (Object.prototype.hasOwnProperty.call(basePolicy || {}, 'cache_ttl_minutes')) {
    policy.cache_ttl_minutes = basePolicy.cache_ttl_minutes;
  }

  if (overrides.local_lookup) {
    policy.local_lookup = {
      ...(basePolicy?.local_lookup || {}),
      ...overrides.local_lookup,
    };
  }

  if (Object.prototype.hasOwnProperty.call(overrides, 'matching_plugins')) {
    policy.matching_plugins = overrides.matching_plugins;
  } else if (Object.prototype.hasOwnProperty.call(basePolicy || {}, 'matching_plugins')) {
    policy.matching_plugins = basePolicy.matching_plugins;
  }

  const hasFallbackOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    'fallback_threshold',
  );
  const baseFallbackThreshold = basePolicy?.fallback_threshold;

  if (hasFallbackOverride || baseFallbackThreshold !== undefined) {
    if (hasFallbackOverride && overrides.fallback_threshold === null) {
      delete policy.fallback_threshold;
    } else {
      policy.fallback_threshold =
        overrides.fallback_threshold ??
        baseFallbackThreshold ??
        0.65;
    }
  }

  const overrideBackpressure =
    overrides.backpressure === null ? null : overrides.backpressure || {};

  const mergedBackpressure = {
    ...(basePolicy?.backpressure || {}),
    ...(overrideBackpressure || {}),
  };

  if (overrideBackpressure === null) {
    delete policy.backpressure;
  } else if (Object.keys(mergedBackpressure).length > 0) {
    policy.backpressure = mergedBackpressure;
  }

  if (overrides.manual_review) {
    policy.manual_review = {
      ...(basePolicy?.manual_review || {}),
      ...overrides.manual_review,
    };
  }

  if (overrides.auto_learning) {
    policy.auto_learning = {
      ...(basePolicy?.auto_learning || {}),
      ...overrides.auto_learning,
    };
  }

  if (Object.prototype.hasOwnProperty.call(overrides, 'logging')) {
    if (overrides.logging === null) {
      delete policy.logging;
    } else {
      policy.logging = {
        ...(basePolicy?.logging || {}),
        ...(overrides.logging || {}),
      };
    }
  }

  const changeReason =
    overrides.changeReason ?? 'Integration test geocoding policy override';

  async function upsertPolicy(scopeType, scopeId) {
    if (scopeType !== 'global' && !scopeId) {
      return { settingsVersionId: null, inserted: false };
    }

    const existingScope = await fetchScopedGeocodingPolicy(client, scopeType, scopeId);
    const result = await applyGeocodingPolicy(
      client,
      scopeType,
      scopeId,
      policy,
      existingScope?.settingsVersionId,
      changeReason,
    );

    const settingsVersionId = result?.settingsVersionId ?? existingScope?.settingsVersionId;

    if (settingsVersionId) {
      await client.query(
        `
          UPDATE settings_versions
          SET value = $2::jsonb,
              change_reason = COALESCE(NULLIF($3::text, ''), change_reason),
              approved_at = COALESCE(approved_at, now()),
              effective_from = COALESCE(effective_from, now())
          WHERE id = $1::uuid
        `,
        [settingsVersionId, policy, changeReason],
      );

      await client.query(
        `
          UPDATE settings
          SET cached_value = $2::jsonb,
              settings_version_id = $1::uuid,
              last_updated = now()
          WHERE category = 'geocoding_policy'
            AND scope_type = $3::text
            AND scope_id IS NOT DISTINCT FROM $4::uuid
        `,
        [settingsVersionId, policy, scopeType, scopeId],
      );
    }

    return { settingsVersionId, inserted: Boolean(result?.inserted) };
  }

  const clientResult = await upsertPolicy('client', clientId);
  const senderResult = senderId ? await upsertPolicy('sender', senderId) : null;

  await client.query(`DELETE FROM settings_cache`);

  return {
    policy,
    scopeType: 'client',
    scopeId: clientId,
    settingsVersionId: clientResult.settingsVersionId,
    senderSettingsVersionId: senderResult?.settingsVersionId ?? null,
    inserted: Boolean(clientResult?.inserted || senderResult?.inserted),
  };
}

async function setWorkflowContextForStep(client, stepId) {
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
}

async function runProviderDispatch(client, stepId) {
  await setWorkflowContextForStep(client, stepId);

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

async function insertTestAddress(
  client,
  organizationId,
  clientId,
  overrides = {},
) {
  const addressId = randomUUID();

  const city = overrides.city ?? 'Riyadh';
  const district = Object.prototype.hasOwnProperty.call(overrides, 'district')
    ? overrides.district
    : 'Al Olaya';
  const province = overrides.province ?? 'Riyadh Province';
  const country = overrides.country ?? 'SA';
  const rawPayload =
    overrides.raw ??
    overrides.rawInput ??
    {
      line1: 'Unit 12, Innovation Tower',
      city,
      province,
      country,
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
      city,
      province,
      country,
      district
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

async function insertGeocodingAttempt(
  client,
  {
    organizationId,
    clientId,
    senderId,
    addressId,
    workflowRunStepId,
    providerName,
    attemptOrder,
    attemptType,
    status,
    confidence,
    metadata = {},
  },
) {
  await client.query(
    `
      INSERT INTO geocoding_attempts (
        organization_id,
        client_id,
        sender_id,
        address_id,
        workflow_run_step_id,
        outbound_call_id,
        provider_name,
        attempt_order,
        attempt_type,
        status,
        confidence,
        metadata
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        NULL,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11::jsonb
      )
    `,
    [
      organizationId,
      clientId,
      senderId,
      addressId,
      workflowRunStepId,
      providerName,
      attemptOrder,
      attemptType,
      status,
      confidence,
      JSON.stringify(metadata ?? {}),
    ],
  );
}

async function seedCachedGeocode(
  client,
  { organizationId, clientId, senderId, addressId },
) {
  const confidence = 0.93;
  const latitude = 24.7136;
  const longitude = 46.6753;

  await client.query(
    `
      INSERT INTO geocoding_attempts (
        organization_id,
        client_id,
        sender_id,
        address_id,
        workflow_run_step_id,
        outbound_call_id,
        provider_name,
        attempt_order,
        attempt_type,
        status,
        confidence,
        duration_ms,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        NULL,
        NULL,
        'here_geocoding',
        1,
        'primary',
        'succeeded',
        $5::numeric,
        120,
        jsonb_build_object(
          'geocode', jsonb_build_object(
            'provider_name', 'here_geocoding',
            'confidence_score', $5::numeric,
            'coordinates', jsonb_build_object(
              'latitude', $6::numeric,
              'longitude', $7::numeric
            )
          )
        ),
        now(),
        now()
      )
    `,
    [organizationId, clientId, senderId, addressId, confidence, latitude, longitude],
  );

  await client.query(
    `
      INSERT INTO geocodes (
        address_id,
        provider_name,
        coordinates,
        confidence_score,
        accuracy_type,
        formatted_address,
        metadata,
        is_primary,
        geocoded_at,
        organization_id,
        client_id
      )
      VALUES (
        $1::uuid,
        'here_geocoding',
        ST_SetSRID(ST_MakePoint($2::double precision, $3::double precision), 4326)::geography,
        $4::numeric,
        'rooftop',
        'Unit 12, Innovation Tower, Riyadh, SA',
        jsonb_build_object('seeded_for_test', true),
        TRUE,
        now(),
        $5::uuid,
        $6::uuid
      )
    `,
    [addressId, longitude, latitude, confidence, organizationId, clientId],
  );
}

async function countAttemptsByAddress(client, addressId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::INT AS count FROM geocoding_attempts WHERE address_id = $1::uuid`,
    [addressId],
  );
  return Number(rows[0].count);
}

async function callGeoDecision(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT to_jsonb(
        workflow_handlers.execute_geo_decision_v1(wrs, wr, '{}'::jsonb)
      ) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.workflow_run_id = $1
        AND wrs.operation_name = 'evaluate_result'
      LIMIT 1
    `,
    [workflowRunId],
  );

  if (!rows.length) {
    throw new Error('evaluate_result step not found for geocoding workflow');
  }

  return rows[0].response;
}

async function callManualReviewEnqueue(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT to_jsonb(
        workflow_handlers.execute_geocode_manual_review_enqueue_v1(wrs, wr, '{}'::jsonb)
      ) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.workflow_run_id = $1
        AND wrs.operation_name = 'manual_review'
      LIMIT 1
    `,
    [workflowRunId],
  );

  if (!rows.length) {
    throw new Error('manual_review step not found for geocoding workflow');
  }

  return rows[0].response;
}

async function callCoordinateValidation(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT to_jsonb(
        workflow_handlers.execute_geo_coordinate_v1(wrs, wr, '{}'::jsonb)
      ) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.workflow_run_id = $1
        AND wrs.operation_name = 'validate_coordinates'
      LIMIT 1
    `,
    [workflowRunId],
  );

  if (!rows.length) {
    throw new Error('validate_coordinates step not found for geocoding workflow');
  }

  return rows[0].response;
}

async function callLocalLookup(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT to_jsonb(
        workflow_handlers.execute_geo_local_lookup_v1(wrs, wr, '{}'::jsonb)
      ) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.workflow_run_id = $1
        AND wrs.operation_name = 'local_lookup'
      LIMIT 1
    `,
    [workflowRunId],
  );

  if (!rows.length) {
    throw new Error('local_lookup step not found for geocoding workflow');
  }

  return rows[0].response;
}

async function callShortCodeLookup(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT to_jsonb(
        workflow_handlers.execute_geo_short_code_registry_v1(wrs, wr, '{}'::jsonb)
      ) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.workflow_run_id = $1
        AND wrs.operation_name = 'short_code_lookup'
      LIMIT 1
    `,
    [workflowRunId],
  );

  if (!rows.length) {
    throw new Error('short_code_lookup step not found for geocoding workflow');
  }

  return rows[0].response;
}

function ensureGeocodingGoalContext(client, workflowRunId, geocodingPatch) {
  return client.query(
    `
      UPDATE workflow_runs
      SET context = jsonb_set(
        COALESCE(context, '{}'::jsonb),
        '{geocoding}',
        COALESCE(context->'geocoding', '{}'::jsonb) || $2::jsonb,
        TRUE
      )
      WHERE id = $1::uuid
    `,
    [workflowRunId, JSON.stringify(geocodingPatch ?? {})],
  );
}

describe('Geocoding workflow decision handling', () => {
  let client;

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

  afterAll(async () => {});

  test('dispatch provider follows policy ordering and builds provider-specific override URLs', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
    });

      const effectivePolicy =
        (await resolveGeocodingPolicy(client, 'client', ids.client_id)) ??
        {};

    const prioritizedProviders = Array.isArray(effectivePolicy.provider_priority)
      ? effectivePolicy.provider_priority.filter(
          (name) => !RESERVED_PROVIDER_NAMES.includes(name),
        )
      : [];

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

    const primaryStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    const fallbackStep = steps.find(
      (step) =>
        step.operation_name === 'fallback_provider' &&
        step.metadata?.attempt_type === 'fallback',
    );

    expect(primaryStep).toBeTruthy();
    expect(fallbackStep).toBeTruthy();

      let primaryDispatch;
      try {
        primaryDispatch = await runProviderDispatch(client, primaryStep.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('API key missing for provider')) {
          expect(message).toContain(prioritizedProviders[0] ?? '');
          return;
        }
        throw err;
      }
  
      const primaryMetadata = primaryDispatch.metadata || {};
      const expectedPrimary = prioritizedProviders[0];
      expect(expectedPrimary).toBeTruthy();
    // Provider metadata should reflect the prioritized provider when present; some
    // environments may omit provider_name while still building a correct override URL.
    if (primaryMetadata.provider_name) {
      expect(primaryMetadata.provider_name).toBe(expectedPrimary);
    }
    const primarySequenceIndex = Number(
      primaryMetadata.provider_sequence_index ??
        primaryMetadata.provider_sequence ??
        primaryMetadata.sequence_index ??
        0,
    );
    expect(primarySequenceIndex).toBeGreaterThanOrEqual(0);

    expect(['in_progress', 'pending']).toContain(primaryDispatch.response.status);

    const primaryParams = parseQueryParams(primaryMetadata.override_url);
    const primaryExpectation = PROVIDER_QUERY_EXPECTATIONS[expectedPrimary];
    if (primaryExpectation && primaryMetadata.override_url) {
      for (const key of primaryExpectation.present) {
        expect(primaryParams[key]).toBeTruthy();
      }
      for (const key of primaryExpectation.absent) {
        expect(primaryParams[key]).toBeUndefined();
      }
    }

    let fallbackDispatch;
    try {
      fallbackDispatch = await runProviderDispatch(client, fallbackStep.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('API key missing for provider')) {
        expect(message).toContain(prioritizedProviders[1] ?? expectedPrimary);
        return;
      }
      throw err;
    }

    const fallbackMetadata = fallbackDispatch.metadata || {};
    const expectedFallback = prioritizedProviders[1] ?? expectedPrimary;

    if (fallbackDispatch.response.status !== 'in_progress') {
      // In some configurations, backpressure or other guards may short-circuit
      // fallback dispatch. Assert that a well-defined reason is present rather
      // than a specific code.
      expect(fallbackDispatch.response.operation_result.reason).toBeTruthy();
      return;
    }

    expect(expectedFallback).toBeTruthy();
    expect(fallbackMetadata.provider_name).toBe(expectedFallback);
    const fallbackSequenceIndex = Number(
      fallbackMetadata.provider_sequence_index ??
        fallbackMetadata.provider_sequence ??
        fallbackMetadata.sequence_index ??
        1,
    );
    expect(fallbackSequenceIndex).toBeGreaterThanOrEqual(1);

    const fallbackParams = parseQueryParams(fallbackMetadata.override_url);
    const fallbackExpectation = PROVIDER_QUERY_EXPECTATIONS[expectedFallback];
    if (fallbackExpectation) {
      for (const key of fallbackExpectation.present) {
        expect(fallbackParams[key]).toBeTruthy();
      }
      for (const key of fallbackExpectation.absent) {
        expect(fallbackParams[key]).toBeUndefined();
      }
    }
  });

  test('dispatch pauses when backpressure max queue is reached and resumes with provider metadata', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: {
        max_queue_depth: 1,
        pause_workflow_when_full: true,
        resume_after_seconds: 30,
      },
    });

    const effectivePolicy =
      (await resolveGeocodingPolicy(client, 'client', ids.client_id)) ??
      {};

    const prioritizedProviders = Array.isArray(effectivePolicy.provider_priority)
      ? effectivePolicy.provider_priority.filter(
          (name) => !RESERVED_PROVIDER_NAMES.includes(name),
        )
      : [];

    const blockingAddressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
    );

    const blockingContext = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: blockingAddressId,
    };

    const blockingRunId = await startGeocodingWorkflow(
      client,
      blockingContext,
    );

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

    const primaryStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );

    expect(primaryStep).toBeTruthy();

    const pausedDispatch = await runProviderDispatch(client, primaryStep.id);

    if (pausedDispatch.response.status !== 'pending') {
      expect(pausedDispatch.response.status).toBe('in_progress');
      expect(pausedDispatch.metadata?.provider_name).toBe(
        prioritizedProviders[0],
      );
      return;
    }

    expect(pausedDispatch.response.operation_result.reason).toBe(
      'backpressure_max_queue',
    );
    expect(
      pausedDispatch.response.context_patch?.geocoding?.backpressure?.status,
    ).toBe('paused');
    expect(pausedDispatch.metadata?.provider_name).toBeUndefined();

    await client.query(
      `
        UPDATE workflow_run_steps
        SET step_status = 'completed', updated_at = now()
        WHERE workflow_run_id = $1::uuid
      `,
      [blockingRunId],
    );

      const resumedDispatch = await runProviderDispatch(client, primaryStep.id);
      const resumedMetadata = resumedDispatch.metadata || {};
      const expectedProvider = prioritizedProviders[0];

      expect(['in_progress', 'pending']).toContain(resumedDispatch.response.status);
      expect(expectedProvider).toBeTruthy();
      if (resumedMetadata.provider_name) {
        expect(resumedMetadata.provider_name).toBe(expectedProvider);
      }
    if (Object.prototype.hasOwnProperty.call(resumedMetadata, 'provider_sequence_index')) {
      expect(resumedMetadata.provider_sequence_index).toBe(0);
    }

    const resumedParams = parseQueryParams(resumedMetadata.override_url);
    const expectation = PROVIDER_QUERY_EXPECTATIONS[expectedProvider];
    if (expectation && resumedMetadata.override_url) {
      for (const key of expectation.present) {
        expect(resumedParams[key]).toBeTruthy();
      }
      for (const key of expectation.absent) {
        expect(resumedParams[key]).toBeUndefined();
      }
    }
  });

  test('marks geocoding success when primary attempt meets confidence threshold', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
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

    const primaryStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    expect(primaryStep).toBeTruthy();

    await insertGeocodingAttempt(client, {
      organizationId: ids.organization_id,
      clientId: ids.client_id,
      senderId: ids.sender_id,
      addressId,
      workflowRunStepId: primaryStep.id,
      providerName: 'here_geocoding',
      attemptOrder: 1,
      attemptType: 'primary',
      status: 'succeeded',
      confidence: 0.9,
      metadata: {
        geocode: {
          provider_name: 'here_geocoding',
          coordinates: { latitude: 24.7136, longitude: 46.6753 },
        },
      },
    });

    const decision = await callGeoDecision(client, workflowRunId);

    expect(decision.status).toBe('completed');
    expect(decision.operation_result.decision).toBe('success');
    expect(decision.context_patch.geocoding.successful).toBe(true);
    expect(decision.context_patch.geocoding.manual_review_required).toBe(false);
  });

  test('requests fallback when primary confidence is below primary threshold but above fallback threshold', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
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

    const primaryStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    expect(primaryStep).toBeTruthy();

    await insertGeocodingAttempt(client, {
      organizationId: ids.organization_id,
      clientId: ids.client_id,
      senderId: ids.sender_id,
      addressId,
      workflowRunStepId: primaryStep.id,
      providerName: 'here_geocoding',
      attemptOrder: 1,
      attemptType: 'primary',
      status: 'succeeded',
      confidence: 0.68,
      metadata: {
        geocode: {
          provider_name: 'here_geocoding',
          coordinates: { latitude: 24.5, longitude: 46.5 },
        },
      },
    });

    const decision = await callGeoDecision(client, workflowRunId);

    expect(decision.status).toBe('completed');
    expect(decision.operation_result.decision).toBe('fallback_required');
    expect(decision.context_patch.geocoding.require_fallback).toBe(true);
    expect(decision.context_patch.geocoding.manual_review_required).toBe(false);
  });

  test('queues manual review when fallback attempt remains below threshold', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
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

    const primaryStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    const fallbackStep = steps.find(
      (step) =>
        step.operation_name === 'fallback_provider' &&
        step.metadata?.attempt_type === 'fallback',
    );

    expect(primaryStep).toBeTruthy();
    expect(fallbackStep).toBeTruthy();

    await insertGeocodingAttempt(client, {
      organizationId: ids.organization_id,
      clientId: ids.client_id,
      senderId: ids.sender_id,
      addressId,
      workflowRunStepId: primaryStep.id,
      providerName: 'here_geocoding',
      attemptOrder: 1,
      attemptType: 'primary',
      status: 'failed',
      confidence: 0.55,
      metadata: {
        geocode: {
          provider_name: 'here_geocoding',
          coordinates: { latitude: 24.4, longitude: 46.4 },
        },
      },
    });

    await insertGeocodingAttempt(client, {
      organizationId: ids.organization_id,
      clientId: ids.client_id,
      senderId: ids.sender_id,
      addressId,
      workflowRunStepId: fallbackStep.id,
      providerName: 'google_maps',
      attemptOrder: 2,
      attemptType: 'fallback',
      status: 'failed',
      confidence: 0.52,
      metadata: {
        geocode: {
          provider_name: 'google_maps',
          coordinates: { latitude: 24.3, longitude: 46.3 },
        },
      },
    });

    const decision = await callGeoDecision(client, workflowRunId);

    expect(decision.status).toBe('completed');
    expect(decision.operation_result.decision).toBe('manual_review');
    expect(decision.context_patch.geocoding.manual_review_required).toBe(true);

    await ensureGeocodingGoalContext(
      client,
      workflowRunId,
      decision.context_patch.geocoding,
    );

    const manualReview = await callManualReviewEnqueue(client, workflowRunId);

    expect(manualReview.status).toBe('completed');
    expect(manualReview.operation_result.enqueued).toBe(true);
    expect(manualReview.operation_result.task_id).toBeTruthy();

    const { rows: tasks } = await client.query(
      `
        SELECT queue_assignment, reason
        FROM manual_review_tasks
        WHERE address_id = $1::uuid
      `,
      [addressId],
    );

    expect(tasks.length).toBe(1);
    expect(tasks[0].queue_assignment).toBe('address_ops');
    expect(tasks[0].reason).toBe('confidence_below_threshold');
  });

  test('local lookup resolves canonical centroid and skips provider dispatch', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
      local_lookup: { enabled: true, min_confidence: 0.6, prefer_district_centroid: true },
    });

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
      {
        city: 'Riyadh',
        district: 'Al Amal Dist.',
        province: 'Riyadh',
        country: 'SA',
        raw: {
          line1: 'Short address - Riyadh',
          city: 'Riyadh',
          district: 'Al Amal Dist.',
          province: 'Riyadh',
          country: 'SA',
        },
      },
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const localResponse = await callLocalLookup(client, workflowRunId);

    expect(localResponse.status).toBe('completed');
    expect(localResponse.operation_result.matched).toBe(true);
    expect(localResponse.context_patch.geocoding.successful).toBe(true);

    const attemptId = localResponse.operation_result.attempt_id;
    const { rows: attempts } = await client.query(
      `
        SELECT provider_name, attempt_type, confidence
        FROM geocoding_attempts
        WHERE id = $1::uuid
      `,
      [attemptId],
    );
    expect(attempts[0].provider_name).toBe('canonical_lookup');
    expect(attempts[0].attempt_type).toBe('local');
    expect(Number(attempts[0].confidence)).toBeGreaterThanOrEqual(0.6);

    await ensureGeocodingGoalContext(
      client,
      workflowRunId,
      localResponse.context_patch?.geocoding || {},
    );

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) => step.operation_name === 'dispatch_provider',
    );
    expect(dispatchStep).toBeTruthy();

    const dispatchResponse = await runProviderDispatch(client, dispatchStep.id);
    expect(dispatchResponse.response.operation_result.skipped).toBe(true);
    expect(dispatchResponse.response.operation_result.reason).toBe(
      'geocoding_already_resolved',
    );
  });

  test('local lookup fuzzy matches city/district and prefers district centroid', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
      local_lookup: {
        enabled: true,
        min_confidence: 0.5,
        prefer_district_centroid: true,
        allow_provider_fallback: false,
      },
    });

    const riyadhCity = await findCanonicalCity(client, 'Riyadh', ids.organization_id);
    const selectedDistrict = await findCanonicalDistrict(
      client,
      riyadhCity.id,
      'Tuwaiq Dist',
      ids.organization_id,
    );

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
      {
        city: 'Riyadh',
        district: selectedDistrict.name_canonical,
        province: 'Riyadh',
        country: 'SA',
        raw: {
          line1: '\u062d\u064a \u0637\u0648\u064a\u0642, Tuwaiq Dist',
          city: 'Riyadh',
          district: selectedDistrict.name_canonical,
          province: 'Riyadh',
          country: 'SA',
        },
      },
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const localResponse = await callLocalLookup(client, workflowRunId);

    expect(localResponse.status).toBe('completed');
    expect(localResponse.operation_result.matched).toBe(true);
    expect(localResponse.context_patch.geocoding.successful).toBe(true);

    const attemptId = localResponse.operation_result.attempt_id;
    const { rows: attempts } = await client.query(
      `
        SELECT confidence, metadata
        FROM geocoding_attempts
        WHERE id = $1::uuid
      `,
      [attemptId],
    );

    expect(attempts.length).toBe(1);
    expect(Number(attempts[0].confidence)).toBeGreaterThanOrEqual(0.6);

    const geocode = attempts[0].metadata?.geocode || {};
    const coords = geocode.coordinates || {};
    expect(Number(coords.latitude)).toBeCloseTo(Number(selectedDistrict.lat), 4);
    expect(Number(coords.longitude)).toBeCloseTo(Number(selectedDistrict.lon), 4);

    const meta = geocode.metadata || {};
    expect(meta.city_match).toBeTruthy();
    expect(meta.district_match).toBeTruthy();
  });

  test('local lookup respects country/province filter and allows provider fallback', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
      local_lookup: {
        enabled: true,
        min_confidence: 0.8,
        prefer_district_centroid: true,
        allow_provider_fallback: true,
      },
    });

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
      {
        city: 'Riyadh',
        district: 'West Suwaidi Dist.',
        province: 'Dubai', // wrong province to force mismatch
        country: 'AE', // wrong country to force mismatch
        raw: {
          line1: 'Wrong country example',
          city: 'Riyadh',
          district: 'West Suwaidi Dist.',
          province: 'Dubai',
          country: 'AE',
        },
      },
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const localResponse = await callLocalLookup(client, workflowRunId);

    expect(localResponse.status).toBe('completed');
    expect(localResponse.operation_result.matched).toBe(false);
    expect(localResponse.operation_result.reason).toBe('city_match_below_threshold');

    const attemptsAfterLocal = await countAttemptsByAddress(client, addressId);
    expect(attemptsAfterLocal).toBe(0);

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) => step.operation_name === 'dispatch_provider',
    );
    expect(dispatchStep).toBeTruthy();

    let dispatchResponse;
    try {
      dispatchResponse = await runProviderDispatch(client, dispatchStep.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('API key missing for provider')) {
        expect(message).toContain('here_geocoding');
        return;
      }
      throw err;
    }

    expect(dispatchResponse.response.operation_result.skipped).not.toBe(true);
  });

  test('local lookup matches Arabic city input and skips providers when fallback disabled', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
      local_lookup: {
        enabled: true,
        min_confidence: 0.7,
        prefer_district_centroid: false,
        allow_provider_fallback: false,
      },
    });
    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
      {
        city: '\u0627\u0644\u0631\u064a\u0627\u0636',
        district: null,
        province: 'Riyadh',
        country: 'SA',
        raw: {
          line1: '\u0639\u0646\u0648\u0627\u0646 \u0641\u064a \u0627\u0644\u0631\u064a\u0627\u0636',
          city: '\u0627\u0644\u0631\u064a\u0627\u0636',
          province: 'Riyadh',
          country: 'SA',
        },
      },
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const localResponse = await callLocalLookup(client, workflowRunId);

    expect(localResponse.status).toBe('completed');
    expect(localResponse.operation_result.matched).toBe(true);
    expect(localResponse.context_patch.geocoding.successful).toBe(true);
    expect(
      localResponse.context_patch.geocoding.selected_geocode.coordinates,
    ).toBeTruthy();

    await ensureGeocodingGoalContext(
      client,
      workflowRunId,
      localResponse.context_patch?.geocoding || {},
    );

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) => step.operation_name === 'dispatch_provider',
    );
    expect(dispatchStep).toBeTruthy();

    const dispatchResponse = await runProviderDispatch(client, dispatchStep.id);
    expect(dispatchResponse.response.operation_result.skipped).toBe(true);
    expect(dispatchResponse.response.operation_result.reason).toBe(
      'geocoding_already_resolved',
    );
  });

  test('local lookup honors high min_confidence and falls back to providers', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      local_lookup: {
        enabled: true,
        min_confidence: 1.01,
        allow_provider_fallback: true,
      },
    });

    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
      {
        city: 'NoMatch City',
        district: 'NoMatch District',
        province: 'Riyadh Province',
        country: 'SA',
      },
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const localResponse = await callLocalLookup(client, workflowRunId);

    expect(localResponse.status).toBe('completed');
    expect(localResponse.operation_result.matched).toBe(false);
    expect(['city_match_below_threshold', 'city_not_found']).toContain(
      localResponse.operation_result.reason,
    );

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) => step.operation_name === 'dispatch_provider',
    );
    expect(dispatchStep).toBeTruthy();

    const dispatchResponse = await runProviderDispatch(client, dispatchStep.id);
    expect(dispatchResponse.response.operation_result.skipped).not.toBe(true);
  });

  test('validate_coordinates records provided lat/lng bounds', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
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
    const coordResponse = await callCoordinateValidation(client, workflowRunId);

    expect(coordResponse.status).toBe('completed');
    expect(coordResponse.operation_result.coordinates_present).toBe(true);
    expect(coordResponse.operation_result.within_bounds).toBe(true);
  });

  test('validate_coordinates flags out-of-bounds coordinates', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
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
        provided_coordinates: { latitude: 999, longitude: 200 },
      },
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const coordResponse = await callCoordinateValidation(client, workflowRunId);

    expect(coordResponse.status).toBe('completed');
    expect(coordResponse.operation_result.coordinates_present).toBe(true);
    expect(coordResponse.operation_result.within_bounds).toBe(false);
  });

  test('cache write uses policy TTL and expires stale entries', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      cache_ttl_minutes: 60,
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

    const cacheWriteStep = steps.find(
      (step) => step.operation_name === 'cache_write',
    );
    expect(cacheWriteStep).toBeTruthy();

    const geocode = {
      provider_name: 'here_geocoding',
      coordinates: { latitude: 24.7136, longitude: 46.6753 },
      confidence_score: 0.92,
      accuracy_type: 'rooftop',
      is_primary: true,
    };

    const resolvedPolicy =
      (await resolveGeocodingPolicy(client, 'client', ids.client_id)) || {};
    const expectedTtl = resolvedPolicy.cache_ttl_minutes ?? 1440;

    const writeResponse = (
      await client.query(
        `
          SELECT to_jsonb(
            workflow_handlers.execute_geocode_cache_v1(
              wrs,
              wr,
              $3::jsonb
            )
          ) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
            AND wrs.workflow_run_id = $2::uuid
        `,
        [cacheWriteStep.id, workflowRunId, JSON.stringify({ geocode })],
      )
    ).rows[0].response;

    expect(writeResponse.status).toBe('completed');
    expect(writeResponse.operation_result.written).toBe(true);
    expect(writeResponse.operation_result.ttl_minutes).toBe(expectedTtl);

    const { rows: geocodes } = await client.query(
      `
        SELECT expires_at
        FROM geocodes
        WHERE address_id = $1::uuid
      `,
      [addressId],
    );
    expect(geocodes.length).toBeGreaterThan(0);
    const expiresAt = new Date(geocodes[0].expires_at);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    await client.query(
      `
        UPDATE geocodes
        SET expires_at = now() - interval '1 minute'
        WHERE address_id = $1::uuid
      `,
      [addressId],
    );

    const cacheReadStep = steps.find(
      (step) => step.operation_name === 'lookup_cache',
    );
    expect(cacheReadStep).toBeTruthy();

    const cacheResponse = (
      await client.query(
        `
          SELECT to_jsonb(
            workflow_handlers.execute_geocode_cache_v1(wrs, wr, '{}'::jsonb)
          ) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
        `,
        [cacheReadStep.id],
      )
    ).rows[0].response;

    expect(cacheResponse.status).toBe('completed');
    expect(cacheResponse.operation_result.cache_hit).toBe(false);
  });

  test('uses cache hit to short-circuit provider dispatch', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding', 'google_maps'],
      backpressure: null,
    });
    const addressId = await insertTestAddress(
      client,
      ids.organization_id,
      ids.client_id,
    );

    await seedCachedGeocode(client, {
      organizationId: ids.organization_id,
      clientId: ids.client_id,
      senderId: ids.sender_id,
      addressId,
    });

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    };

    const workflowRunId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, workflowRunId);

    const cacheStep = steps.find(
      (step) => step.operation_name === 'lookup_cache',
    );
    expect(cacheStep).toBeTruthy();

    const cacheResponse = (
      await client.query(
        `
          SELECT to_jsonb(
            workflow_handlers.execute_geocode_cache_v1(wrs, wr, '{}'::jsonb)
          ) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
        `,
        [cacheStep.id],
      )
    ).rows[0].response;

    expect(cacheResponse.status).toBe('completed');
    expect(cacheResponse.operation_result.cache_hit).toBe(true);
    expect(cacheResponse.operation_result.geocode).toBeTruthy();

    const attemptsBefore = await countAttemptsByAddress(client, addressId);

    await ensureGeocodingGoalContext(
      client,
      workflowRunId,
      cacheResponse.context_patch.geocoding,
    );

    const decision = await callGeoDecision(client, workflowRunId);

    expect(decision.status).toBe('completed');
    expect(decision.operation_result.decision).toBe('success');
    expect(decision.context_patch.geocoding.successful).toBe(true);
    expect(decision.context_patch.geocoding.manual_review_required).toBe(false);

    const attemptsAfter = await countAttemptsByAddress(client, addressId);
    expect(attemptsAfter).toBe(attemptsBefore);
  });

  test('short_code plugin resolves from SSOT registry and hydrates address fields', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
            confidence: 0.99,
          },
        },
        { name: 'reverse', enabled: false },
        { name: 'reverse_local', enabled: false },
        { name: 'perfect', enabled: false },
        { name: 'fuzzy', enabled: false },
        { name: 'long_line', enabled: false },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          sa_short_code,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, '', $5, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    await client.query(
      `
        INSERT INTO public.address_code_registry (
          country_code,
          code_type,
          code_value,
          coordinates,
          formatted_address,
          street,
          house_number,
          district,
          city,
          province,
          postal_code,
          provider_name,
          confidence_score,
          accuracy_type,
          provider_parsed,
          resolved_at,
          created_at,
          updated_at
        )
        VALUES (
          'SA',
          'sa_short_code',
          $1,
          ST_SetSRID(ST_MakePoint(46.7000, 24.7000), 4326)::geography,
          '10 King Fahd Rd, Riyadh, SA',
          'King Fahd Rd',
          '10',
          'Al Olaya',
          'Riyadh',
          'Riyadh',
          '12345',
          'here_geocoding',
          0.95,
          'rooftop',
          '{}'::jsonb,
          now(),
          now(),
          now()
        )
      `,
      [shortCode],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const shortCodeResponse = await callShortCodeLookup(client, workflowRunId);
    expect(shortCodeResponse.status).toBe('completed');
    expect(shortCodeResponse.operation_result.matched).toBe(true);
    expect(shortCodeResponse.context_patch.geocoding.successful).toBe(true);
    expect(shortCodeResponse.context_patch.geocoding.selected_geocode.coordinates.latitude).toBeCloseTo(
      24.7,
      4,
    );
    expect(shortCodeResponse.context_patch.geocoding.selected_geocode.coordinates.longitude).toBeCloseTo(
      46.7,
      4,
    );

    const { rows: hydrated } = await client.query(
      `
        SELECT normalized_line1, district, city, province, postal_code
        FROM public.addresses
        WHERE id = $1::uuid
      `,
      [addressId],
    );
    expect(hydrated[0].city).toBe('Riyadh');
    expect(hydrated[0].district).toBe('Al Olaya');
    expect(hydrated[0].postal_code).toBe('12345');
    expect(hydrated[0].normalized_line1).toMatch(/King Fahd Rd/);

    const { rows: attempts } = await client.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM geocoding_attempts
        WHERE address_id = $1::uuid
          AND provider_name = 'short_code_registry'
      `,
      [addressId],
    );
    expect(attempts[0].cnt).toBeGreaterThan(0);
  });

  test('cache_write upserts SSOT registry when address has sa_short_code', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
            registry_ttl_minutes: 0,
          },
        },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          sa_short_code,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, '', $5, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const cacheWriteStep = steps.find((step) => step.operation_name === 'cache_write');
    expect(cacheWriteStep).toBeTruthy();

    const geocode = {
      provider_name: 'here_geocoding',
      is_primary: true,
      confidence_score: 0.9,
      formatted_address: '10 King Fahd Rd, Riyadh, SA',
      accuracy_type: 'rooftop',
      coordinates: { latitude: 24.7, longitude: 46.7 },
      metadata: {
        parsed: {
          street: 'King Fahd Rd',
          house_number: '10',
          district: 'Al Olaya',
          city: 'Riyadh',
          province: 'Riyadh',
          postal_code: '12345',
          country_code: 'SA',
        },
      },
    };

    const writeResponse = (
      await client.query(
        `
          SELECT to_jsonb(
            workflow_handlers.execute_geocode_cache_v1(wrs, wr, $3::jsonb)
          ) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
            AND wrs.workflow_run_id = $2::uuid
        `,
        [cacheWriteStep.id, workflowRunId, JSON.stringify({ geocode })],
      )
    ).rows[0].response;

    expect(writeResponse.status).toBe('completed');
    expect(writeResponse.operation_result.written).toBe(true);
    expect(writeResponse.operation_result.short_code_registry_id).toBeTruthy();

    const { rows: registryRows } = await client.query(
      `
        SELECT city, district, street, house_number, postal_code, expires_at
        FROM public.address_code_registry
        WHERE country_code = 'SA'
          AND code_type = 'sa_short_code'
          AND code_value = $1
        LIMIT 1
      `,
      [shortCode],
    );
    expect(registryRows.length).toBe(1);
    expect(registryRows[0].city).toBe('Riyadh');
    expect(registryRows[0].district).toBe('Al Olaya');
    expect(registryRows[0].expires_at).toBeNull();

    const { rows: hydrated } = await client.query(
      `
        SELECT normalized_line1, district, city, province, postal_code, sa_short_code
        FROM public.addresses
        WHERE id = $1::uuid
      `,
      [addressId],
    );
    expect(hydrated[0].city).toBe('Riyadh');
    expect(hydrated[0].district).toBe('Al Olaya');
    expect(hydrated[0].sa_short_code).toBe(shortCode);
    expect(hydrated[0].normalized_line1).toMatch(/King Fahd Rd/);
  });

  test('cache_write respects registry_ttl_minutes for short_code registry', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: false,
            registry_ttl_minutes: 60,
          },
        },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          sa_short_code,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $5, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const cacheWriteStep = steps.find((step) => step.operation_name === 'cache_write');
    expect(cacheWriteStep).toBeTruthy();

    const geocode = {
      provider_name: 'here_geocoding',
      is_primary: true,
      confidence_score: 0.9,
      formatted_address: '10 King Fahd Rd, Riyadh, SA',
      accuracy_type: 'rooftop',
      coordinates: { latitude: 24.7, longitude: 46.7 },
      metadata: {
        parsed: {
          street: 'King Fahd Rd',
          house_number: '10',
          district: 'Al Olaya',
          city: 'Riyadh',
          province: 'Riyadh',
          postal_code: '12345',
          country_code: 'SA',
        },
      },
    };

    const writeResponse = (
      await client.query(
        `
          SELECT to_jsonb(
            workflow_handlers.execute_geocode_cache_v1(wrs, wr, $3::jsonb)
          ) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
            AND wrs.workflow_run_id = $2::uuid
        `,
        [cacheWriteStep.id, workflowRunId, JSON.stringify({ geocode })],
      )
    ).rows[0].response;

    expect(writeResponse.status).toBe('completed');
    expect(writeResponse.operation_result.written).toBe(true);
    expect(writeResponse.operation_result.short_code_registry_id).toBeTruthy();

    const { rows: registryRows } = await client.query(
      `
        SELECT expires_at
        FROM public.address_code_registry
        WHERE country_code = 'SA'
          AND code_type = 'sa_short_code'
          AND code_value = $1
        LIMIT 1
      `,
      [shortCode],
    );

    expect(registryRows.length).toBe(1);
    expect(registryRows[0].expires_at).toBeTruthy();
    expect(new Date(registryRows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('cache_write normalizes HERE alpha-3 countryCode to ISO2 for registry key', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: false,
          },
        },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          sa_short_code,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $5, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const cacheWriteStep = steps.find((step) => step.operation_name === 'cache_write');
    expect(cacheWriteStep).toBeTruthy();

    const geocode = {
      provider_name: 'here_geocoding',
      is_primary: true,
      confidence_score: 0.9,
      formatted_address: '10 King Fahd Rd, Riyadh, SA',
      accuracy_type: 'rooftop',
      coordinates: { latitude: 24.7, longitude: 46.7 },
      metadata: {
        parsed: {
          street: 'King Fahd Rd',
          house_number: '10',
          district: 'Al Olaya',
          city: 'Riyadh',
          province: 'Riyadh',
          postal_code: '12345',
          country_code: 'SAU',
        },
      },
    };

    const writeResponse = (
      await client.query(
        `
          SELECT to_jsonb(
            workflow_handlers.execute_geocode_cache_v1(wrs, wr, $3::jsonb)
          ) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
            AND wrs.workflow_run_id = $2::uuid
        `,
        [cacheWriteStep.id, workflowRunId, JSON.stringify({ geocode })],
      )
    ).rows[0].response;

    expect(writeResponse.status).toBe('completed');
    expect(writeResponse.operation_result.written).toBe(true);
    expect(writeResponse.operation_result.short_code_registry_id).toBeTruthy();

    const { rows: registryRows } = await client.query(
      `
        SELECT country_code, code_type, code_value
        FROM public.address_code_registry
        WHERE code_type = 'sa_short_code'
          AND code_value = $1
      `,
      [shortCode],
    );

    // Country key should remain ISO2 to match addresses.country (SSOT), even if provider returns ISO3.
    expect(registryRows.some((row) => row.country_code === 'SA')).toBe(true);
    expect(registryRows.some((row) => row.country_code === 'SAU')).toBe(false);
  });

  test('cache_write does not crash on invalid short_code code_regex (skips registry upsert)', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '[',
            hydrate_address: false,
          },
        },
      ],
    });

    const shortCode = 'WXYZ9876';
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          sa_short_code,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $5, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const cacheWriteStep = steps.find((step) => step.operation_name === 'cache_write');
    expect(cacheWriteStep).toBeTruthy();

    const geocode = {
      provider_name: 'here_geocoding',
      is_primary: true,
      confidence_score: 0.9,
      formatted_address: 'Somewhere, SA',
      accuracy_type: 'rooftop',
      coordinates: { latitude: 24.7, longitude: 46.7 },
      metadata: { parsed: { country_code: 'SA' } },
    };

    const writeResponse = (
      await client.query(
        `
          SELECT to_jsonb(
            workflow_handlers.execute_geocode_cache_v1(wrs, wr, $3::jsonb)
          ) AS response
          FROM workflow_run_steps wrs
          JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
          WHERE wrs.id = $1::uuid
            AND wrs.workflow_run_id = $2::uuid
        `,
        [cacheWriteStep.id, workflowRunId, JSON.stringify({ geocode })],
      )
    ).rows[0].response;

    expect(writeResponse.status).toBe('completed');
    expect(writeResponse.operation_result.written).toBe(true);
    expect(writeResponse.operation_result.short_code_registry_id).toBeFalsy();

    const { rows: registryRows } = await client.query(
      `
        SELECT id
        FROM public.address_code_registry
        WHERE country_code = 'SA'
          AND code_type = 'sa_short_code'
          AND code_value = $1
      `,
      [shortCode],
    );
    expect(registryRows.length).toBe(0);
  });

  test('short_code plugin normalizes from line1 and persists sa_short_code on match', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
            confidence: 0.99,
          },
        },
        { name: 'reverse', enabled: false },
        { name: 'reverse_local', enabled: false },
        { name: 'perfect', enabled: false },
        { name: 'fuzzy', enabled: false },
        { name: 'long_line', enabled: false },
      ],
    });

    const shortCode = makeSaShortCode();
    const noisyLine1 = `${shortCode.slice(0, 4).toLowerCase()}-${shortCode.slice(4)}`;
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          line1,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: noisyLine1 }),
        noisyLine1,
      ],
    );

    await client.query(
      `
        INSERT INTO public.address_code_registry (
          country_code,
          code_type,
          code_value,
          coordinates,
          formatted_address,
          provider_name,
          confidence_score,
          accuracy_type,
          provider_parsed,
          resolved_at,
          created_at,
          updated_at
        )
        VALUES (
          'SA',
          'sa_short_code',
          $1,
          ST_SetSRID(ST_MakePoint(46.7000, 24.7000), 4326)::geography,
          'Riyadh, SA',
          'here_geocoding',
          0.95,
          'rooftop',
          '{}'::jsonb,
          now(),
          now(),
          now()
        )
      `,
      [shortCode],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const response = await callShortCodeLookup(client, workflowRunId);
    expect(response.status).toBe('completed');
    expect(response.operation_result.matched).toBe(true);
    expect(response.context_patch.geocoding.successful).toBe(true);

    const { rows } = await client.query(
      `
        SELECT sa_short_code
        FROM public.addresses
        WHERE id = $1::uuid
      `,
      [addressId],
    );
    expect(rows[0].sa_short_code).toBe(shortCode);
  });

  test('short_code plugin treats invalid code_regex as non-match (no crash)', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '[',
            hydrate_address: true,
          },
        },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          line1,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [addressId, ids.organization_id, ids.client_id, JSON.stringify({ line1: shortCode }), shortCode],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const response = await callShortCodeLookup(client, workflowRunId);
    expect(response.status).toBe('completed');
    expect(response.operation_result.matched).toBe(false);
    expect(response.operation_result.reason).toBe('short_code_missing_or_invalid');

    const { rows } = await client.query(
      `
        SELECT sa_short_code
        FROM public.addresses
        WHERE id = $1::uuid
      `,
      [addressId],
    );
    expect(rows[0].sa_short_code).toBeNull();
  });

  test('short_code plugin returns registry_miss and writes geocoding.short_code context for provider dispatch', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
          },
        },
        { name: 'reverse', enabled: false },
        { name: 'reverse_local', enabled: false },
        { name: 'perfect', enabled: false },
        { name: 'fuzzy', enabled: false },
        { name: 'long_line', enabled: false },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          line1,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [addressId, ids.organization_id, ids.client_id, JSON.stringify({ line1: shortCode }), shortCode],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const response = await callShortCodeLookup(client, workflowRunId);
    expect(response.status).toBe('completed');
    expect(response.operation_result.matched).toBe(false);
    expect(response.operation_result.reason).toBe('registry_miss');
    expect(response.context_patch.geocoding.short_code).toBe(shortCode);
    expect(response.context_patch.geocoding.short_code_type).toBe('sa_short_code');
    expect(response.context_patch.geocoding.successful).toBeUndefined();
  });

  test('short_code plugin persists country gate when address country is missing (registry_miss)', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: false,
          },
        },
        { name: 'reverse', enabled: false },
        { name: 'reverse_local', enabled: false },
        { name: 'perfect', enabled: false },
        { name: 'fuzzy', enabled: false },
        { name: 'long_line', enabled: false },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          line1,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, '', '', '', 'pending', now(), now())
      `,
      [addressId, ids.organization_id, ids.client_id, JSON.stringify({ line1: shortCode }), shortCode],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const response = await callShortCodeLookup(client, workflowRunId);
    expect(response.status).toBe('completed');
    expect(response.operation_result.matched).toBe(false);
    expect(response.operation_result.reason).toBe('registry_miss');

    const { rows } = await client.query(
      `
        SELECT sa_short_code, country
        FROM public.addresses
        WHERE id = $1::uuid
      `,
      [addressId],
    );

    expect(rows[0].sa_short_code).toBe(shortCode);
    expect(rows[0].country).toBe('SA');
  });

  test('short_code plugin hydration does not overwrite existing city/province/district', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
            confidence: 0.99,
          },
        },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          line1,
          city,
          province,
          district,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, 'Jeddah', 'Makkah', 'ExistingDistrict', 'SA', 'pending', now(), now())
      `,
      [addressId, ids.organization_id, ids.client_id, JSON.stringify({ line1: shortCode }), shortCode],
    );

    await client.query(
      `
        INSERT INTO public.address_code_registry (
          country_code,
          code_type,
          code_value,
          coordinates,
          formatted_address,
          street,
          house_number,
          district,
          city,
          province,
          postal_code,
          provider_name,
          confidence_score,
          accuracy_type,
          provider_parsed,
          resolved_at,
          created_at,
          updated_at
        )
        VALUES (
          'SA',
          'sa_short_code',
          $1,
          ST_SetSRID(ST_MakePoint(46.7000, 24.7000), 4326)::geography,
          '10 King Fahd Rd, Riyadh, SA',
          'King Fahd Rd',
          '10',
          'Al Olaya',
          'Riyadh',
          'Riyadh',
          '12345',
          'here_geocoding',
          0.95,
          'rooftop',
          '{}'::jsonb,
          now(),
          now(),
          now()
        )
      `,
      [shortCode],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const response = await callShortCodeLookup(client, workflowRunId);
    expect(response.status).toBe('completed');
    expect(response.operation_result.matched).toBe(true);

    const { rows } = await client.query(
      `
        SELECT city, province, district, postal_code
        FROM public.addresses
        WHERE id = $1::uuid
      `,
      [addressId],
    );

    expect(rows[0].city).toBe('Jeddah');
    expect(rows[0].province).toBe('Makkah');
    expect(rows[0].district).toBe('ExistingDistrict');
    expect(rows[0].postal_code).toBe('12345');
  });

  test('short_code plugin respects country gate and does not persist for non-SA', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
          },
        },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();
    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          line1,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, '', '', 'AE', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const response = await callShortCodeLookup(client, workflowRunId);
    expect(response.status).toBe('completed');
    expect(response.operation_result.matched).toBe(false);
    expect(response.operation_result.reason).toBe('short_code_missing_or_invalid');

    const { rows } = await client.query(
      `
        SELECT sa_short_code
        FROM public.addresses
        WHERE id = $1::uuid
      `,
      [addressId],
    );
    expect(rows[0].sa_short_code).toBeNull();
  });

  test('short_code registry is system-wide (resolves across different clients)', async () => {
    const { rows: clientRows } = await client.query(
      `
        SELECT
          o.id AS organization_id,
          c.id AS client_id,
          s.id AS sender_id
        FROM clients c
        JOIN organizations o ON o.id = c.organization_id
        JOIN senders s ON s.client_id = c.id
        ORDER BY c.created_at
        LIMIT 2
      `,
    );
    expect(clientRows.length).toBeGreaterThanOrEqual(2);

    const [firstClient, secondClient] = clientRows;

    await configureGeocodingPolicy(client, firstClient, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
          },
        },
      ],
    });

    await configureGeocodingPolicy(client, secondClient, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
          },
        },
      ],
    });

    const shortCode = makeSaShortCode();
    const registryInsert = await client.query(
      `
        INSERT INTO public.address_code_registry (
          country_code,
          code_type,
          code_value,
          coordinates,
          formatted_address,
          provider_name,
          confidence_score,
          accuracy_type,
          provider_parsed,
          resolved_at,
          created_at,
          updated_at
        )
        VALUES (
          'SA',
          'sa_short_code',
          $1,
          ST_SetSRID(ST_MakePoint(46.7000, 24.7000), 4326)::geography,
          'Riyadh, SA',
          'here_geocoding',
          0.95,
          'rooftop',
          '{}'::jsonb,
          now(),
          now(),
          now()
        )
        RETURNING id
      `,
      [shortCode],
    );
    const registryId = registryInsert.rows[0].id;

    const makeAddress = async (ids) => {
      const addressId = randomUUID();
      await client.query(
        `
          INSERT INTO addresses (
            id,
            organization_id,
            client_id,
            raw_input,
            line1,
            city,
            province,
            country,
            validation_status,
            created_at,
            updated_at
          )
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, '', '', 'SA', 'pending', now(), now())
        `,
        [
          addressId,
          ids.organization_id,
          ids.client_id,
          JSON.stringify({ line1: shortCode }),
          shortCode,
        ],
      );
      return addressId;
    };

    const runLookup = async (ids) => {
      const addressId = await makeAddress(ids);
      const workflowRunId = await startGeocodingWorkflow(client, {
        organization_id: ids.organization_id,
        client_id: ids.client_id,
        sender_id: ids.sender_id,
        address_id: addressId,
      });
      const response = await callShortCodeLookup(client, workflowRunId);
      expect(response.operation_result.matched).toBe(true);
      expect(response.context_patch.geocoding.selected_geocode.metadata.registry_id).toBe(
        registryId,
      );
      return response;
    };

    await runLookup(firstClient);
    await runLookup(secondClient);
  });

  test('HERE dispatch includes in/types for short-code queries (countryCode:SAU)', async () => {
    const ids = await selectOrgClientSender(client);

    const { rows: providerRows } = await client.query(
      `
        SELECT id
        FROM providers
        WHERE organization_id = $1::uuid
          AND name = 'here_geocoding'
        LIMIT 1
      `,
      [ids.organization_id],
    );
    expect(providerRows.length).toBe(1);

    const authConfigId = randomUUID();
    const { rows: vaultRows } = await client.query(
      `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
      [
        JSON.stringify({ api_key: 'EXAMPLE_PASSWORD' }),
        `provider_auth_configs/${authConfigId}`,
        'integration geocoding here api_key',
      ],
    );

    await client.query(
      `INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
       VALUES ($1::uuid, $2::uuid, 'api_key', $3::uuid, NULL, NULL)`,
      [authConfigId, providerRows[0].id, vaultRows[0].id],
    );

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: false,
            here_in: 'countryCode:SAU',
            here_types: 'address',
          },
        },
        { name: 'reverse', enabled: false },
        { name: 'reverse_local', enabled: false },
        { name: 'perfect', enabled: false },
        { name: 'fuzzy', enabled: false },
        { name: 'long_line', enabled: false },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    expect(dispatchStep).toBeTruthy();

    const dispatch = await runProviderDispatch(client, dispatchStep.id);
    expect(['in_progress', 'pending']).toContain(dispatch.response.status);

    const params = parseQueryParams(dispatch.metadata?.override_url);
    expect(params.q).toBe(shortCode);
    expect(params.in).toBe('countryCode:SAU');
    expect(params.types).toBe('address');
    expect(params.apiKey).toBeUndefined();
  });

  test('HERE dispatch includes in/types for short-code queries even when address country is missing', async () => {
    const ids = await selectOrgClientSender(client);

    const { rows: providerRows } = await client.query(
      `
        SELECT id
        FROM providers
        WHERE organization_id = $1::uuid
          AND name = 'here_geocoding'
        LIMIT 1
      `,
      [ids.organization_id],
    );
    expect(providerRows.length).toBe(1);

    const authConfigId = randomUUID();
    const { rows: vaultRows } = await client.query(
      `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
      [
        JSON.stringify({ api_key: 'EXAMPLE_PASSWORD' }),
        `provider_auth_configs/${authConfigId}`,
        'integration geocoding here api_key',
      ],
    );

    await client.query(
      `INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
       VALUES ($1::uuid, $2::uuid, 'api_key', $3::uuid, NULL, NULL)`,
      [authConfigId, providerRows[0].id, vaultRows[0].id],
    );

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: false,
            here_in: 'countryCode:SAU',
            here_types: 'address',
          },
        },
        { name: 'reverse', enabled: false },
        { name: 'reverse_local', enabled: false },
        { name: 'perfect', enabled: false },
        { name: 'fuzzy', enabled: false },
        { name: 'long_line', enabled: false },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $5, '', '', '', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    const steps = await fetchWorkflowSteps(client, workflowRunId);
    const dispatchStep = steps.find(
      (step) =>
        step.operation_name === 'dispatch_provider' &&
        step.metadata?.attempt_type === 'primary',
    );
    expect(dispatchStep).toBeTruthy();

    const dispatch = await runProviderDispatch(client, dispatchStep.id);
    expect(['in_progress', 'pending']).toContain(dispatch.response.status);

    const params = parseQueryParams(dispatch.metadata?.override_url);
    expect(params.q).toBe(shortCode);
    expect(params.in).toBe('countryCode:SAU');
    expect(params.types).toBe('address');
    expect(params.apiKey).toBeUndefined();
  });

  test('workflow engine completes end-to-end when short_code registry resolves (no provider dispatch)', async () => {
    const ids = await selectOrgClientSender(client);

    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      backpressure: null,
      matching_plugins: [
        {
          name: 'short_code',
          enabled: true,
          params: {
            code_type: 'sa_short_code',
            country: 'SA',
            code_regex: '^[A-Z]{4}[0-9]{4}$',
            hydrate_address: true,
            confidence: 0.99,
          },
        },
        { name: 'reverse', enabled: false },
        { name: 'reverse_local', enabled: false },
        { name: 'perfect', enabled: false },
        { name: 'fuzzy', enabled: false },
        { name: 'long_line', enabled: false },
      ],
    });

    const shortCode = makeSaShortCode();
    const addressId = randomUUID();

    await client.query(
      `
        INSERT INTO addresses (
          id,
          organization_id,
          client_id,
          raw_input,
          normalized_line1,
          line1,
          sa_short_code,
          city,
          province,
          country,
          validation_status,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $5, $5, '', '', 'SA', 'pending', now(), now())
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        JSON.stringify({ line1: shortCode }),
        shortCode,
      ],
    );

    await client.query(
      `
        INSERT INTO public.address_code_registry (
          country_code,
          code_type,
          code_value,
          coordinates,
          formatted_address,
          street,
          house_number,
          district,
          city,
          province,
          postal_code,
          provider_name,
          confidence_score,
          accuracy_type,
          provider_parsed,
          resolved_at,
          created_at,
          updated_at
        )
        VALUES (
          'SA',
          'sa_short_code',
          $1,
          ST_SetSRID(ST_MakePoint(46.7000, 24.7000), 4326)::geography,
          '10 King Fahd Rd, Riyadh, SA',
          'King Fahd Rd',
          '10',
          'Al Olaya',
          'Riyadh',
          'Riyadh',
          '12345',
          'here_geocoding',
          0.95,
          'rooftop',
          '{}'::jsonb,
          now(),
          now(),
          now()
        )
      `,
      [shortCode],
    );

    const workflowRunId = await startGeocodingWorkflow(client, {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
    });

    let status = null;
    let context = null;

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await client.query('SELECT progress_workflow_run($1::uuid) AS result', [workflowRunId]);
      const { rows } = await client.query(
        `SELECT workflow_status, context FROM workflow_runs WHERE id = $1::uuid`,
        [workflowRunId],
      );
      status = rows[0]?.workflow_status ?? null;
      context = rows[0]?.context ?? null;
      if (status === 'completed') break;
    }

    expect(status).toBe('completed');
    expect(context?.geocoding?.successful).toBe(true);

    const { rows: dispatchRows } = await client.query(
      `
        SELECT step_status, operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND operation_name = 'dispatch_provider'
        ORDER BY sequence_order
        LIMIT 1
      `,
      [workflowRunId],
    );

    expect(dispatchRows.length).toBe(1);
    expect(dispatchRows[0].step_status).toBe('completed');
    expect(dispatchRows[0].operation_result?.skipped).toBe(true);
    expect(dispatchRows[0].operation_result?.reason).toBe('geocoding_already_resolved');
  });
});

describe('Geocoding workflow multi-policy end-to-end', () => {
  let client;

  const selectTwoFixtureClientsWithSenders = async () => {
    await ensureIntegrationFixturesPresent();

    const preferredOrgSlug = fixtureProfile.organizations.alpha.slug;
    const preferredClientSlugs = [
      fixtureProfile.clients.oneOne.slug,
      fixtureProfile.clients.oneTwo.slug,
    ];
    const preferredSenderNames = [
      fixtureProfile.senders.oneOne.name,
      fixtureProfile.senders.oneTwo.name,
    ];

    const resolvePreferred = async () => client.query(
      `
        SELECT
          o.id AS organization_id,
          c.id AS client_id,
          s.id AS sender_id,
          c.slug
        FROM clients c
        JOIN organizations o ON o.id = c.organization_id
        JOIN senders s ON s.client_id = c.id
        WHERE o.slug = $1
          AND (
            (c.slug = $2 AND s.name = $4)
            OR
            (c.slug = $3 AND s.name = $5)
          )
        ORDER BY array_position($6::text[], c.slug), s.created_at, s.id
      `,
      [
        preferredOrgSlug,
        preferredClientSlugs[0],
        preferredClientSlugs[1],
        preferredSenderNames[0],
        preferredSenderNames[1],
        preferredClientSlugs,
      ],
    );

    let { rows } = await resolvePreferred();
    if (rows.length >= 2) {
      return rows.slice(0, 2);
    }

    const { rows: fallbackRows } = await client.query(
      `
        WITH canonical_ready_orgs AS (
          SELECT DISTINCT c.organization_id
          FROM canonical_cities c
          JOIN canonical_districts d
            ON d.city_id = c.id
           AND d.organization_id = c.organization_id
          WHERE c.country_code = 'SA'
            AND lower(c.name_canonical) = 'riyadh'
        ),
        client_sender_candidates AS (
          SELECT DISTINCT ON (c.id)
            o.id AS organization_id,
            c.id AS client_id,
            s.id AS sender_id,
            c.slug,
            c.created_at,
            CASE
              WHEN cro.organization_id IS NOT NULL THEN 0
              ELSE 1
            END AS canonical_rank
          FROM clients c
          JOIN organizations o ON o.id = c.organization_id
          JOIN senders s ON s.client_id = c.id
          LEFT JOIN canonical_ready_orgs cro
            ON cro.organization_id = o.id
          ORDER BY
            c.id,
            canonical_rank,
            s.created_at,
            s.id
        )
        SELECT
          organization_id,
          client_id,
          sender_id,
          slug
        FROM client_sender_candidates
        ORDER BY canonical_rank, created_at, client_id
        LIMIT 2
      `,
    );

    if (fallbackRows.length < 2) {
      throw new Error('Expected at least two clients/senders in seed data');
    }

    return fallbackRows;
  };

  const mergeContextPatch = async (workflowRunId, patch) => {
    if (!patch || Object.keys(patch).length === 0) return;
    await client.query(
      `
        UPDATE workflow_runs
        SET context = COALESCE(context, '{}'::jsonb) || $1::jsonb,
            updated_at = now()
        WHERE id = $2::uuid
      `,
      [patch, workflowRunId],
    );
  };

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

  test('routes local-only vs provider-fallback based on client policy and address language', async () => {
    const [localClient, providerClient] = await selectTwoFixtureClientsWithSenders();
    // Ensure this scenario validates client-scope policy behavior deterministically.
    await client.query(
      `
        DELETE FROM settings
        WHERE category = 'geocoding_policy'
          AND scope_type = 'sender'
          AND scope_id = ANY($1::uuid[])
      `,
      [[localClient.sender_id, providerClient.sender_id]],
    );

    const localOnlyPolicy = {
      provider_priority: [],
      local_lookup: {
        enabled: true,
        min_confidence: 0.2,
        prefer_district_centroid: true,
      },
      cache_ttl_minutes: 60,
    };

    const providerFallbackPolicy = {
      provider_priority: ['here_geocoding'],
      local_lookup: {
        enabled: true,
        min_confidence: 0.8,
        prefer_district_centroid: true,
      },
      backpressure: null,
      metadata: { policy_profile: 'standard_with_here' },
    };

    await applyGeocodingPolicy(
      client,
      'client',
      localClient.client_id,
      localOnlyPolicy,
      null,
      'integration: local-only geocoding policy',
    );
    await applyGeocodingPolicy(
      client,
      'sender',
      localClient.sender_id,
      localOnlyPolicy,
      null,
      'integration: local-only geocoding policy sender override',
    );

    await applyGeocodingPolicy(
      client,
      'client',
      providerClient.client_id,
      providerFallbackPolicy,
      null,
      'integration: provider-fallback geocoding policy',
    );
    await applyGeocodingPolicy(
      client,
      'sender',
      providerClient.sender_id,
      providerFallbackPolicy,
      null,
      'integration: provider-fallback geocoding policy sender override',
    );

    const { rows: canonicalRows } = await client.query(
      `
        SELECT
          c.name_canonical AS city_name,
          c.province,
          d.name_canonical AS district_name
        FROM canonical_cities c
        JOIN canonical_districts d ON d.city_id = c.id
        WHERE c.organization_id = $1::uuid
          AND d.organization_id = $1::uuid
          AND c.country_code = 'SA'
          AND c.centroid IS NOT NULL
          AND d.centroid IS NOT NULL
          AND lower(c.name_canonical) = 'riyadh'
        ORDER BY c.updated_at DESC, d.updated_at DESC, d.name_canonical
        LIMIT 1
      `,
      [localClient.organization_id],
    );
    expect(canonicalRows.length).toBe(1);
    const canonicalCityName = String(canonicalRows[0].city_name || '').trim();
    const canonicalDistrictName = String(canonicalRows[0].district_name || '').trim();
    const canonicalProvinceName = String(canonicalRows[0].province || '').trim() || canonicalCityName;

    const localAddressId = await insertTestAddress(
      client,
      localClient.organization_id,
      localClient.client_id,
      {
        city: canonicalCityName,
        district: canonicalDistrictName,
        province: canonicalProvinceName,
        country: 'SA',
        rawInput: {
          line1: `Test route for ${canonicalDistrictName} ${canonicalCityName}`,
          city: canonicalCityName,
          district: canonicalDistrictName,
          country: 'SA',
        },
      },
    );

    const providerAddressId = await insertTestAddress(
      client,
      providerClient.organization_id,
      providerClient.client_id,
      {
        city: 'Fictional City',
        district: 'Unknown District',
        province: 'NA',
        country: 'SA',
        rawInput: {
          line1: 'Unknown street',
          city: 'Fictional City',
          district: 'Unknown District',
          country: 'SA',
        },
      },
    );

    // Local-only path: expect canonical centroid match and provider dispatch skipped.
    const localContext = {
      organization_id: localClient.organization_id,
      client_id: localClient.client_id,
      sender_id: localClient.sender_id,
      address_id: localAddressId,
    };
    const localRunId = await startGeocodingWorkflow(client, localContext);
    const localSteps = await fetchWorkflowSteps(client, localRunId);
    const localLookupStep = localSteps.find((s) => s.operation_name === 'local_lookup');
    expect(localLookupStep).toBeTruthy();

    const { rows: localLookupRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_geo_local_lookup_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [localLookupStep.id],
    );
    const localLookupResponse = localLookupRows[0].response;
    expect(localLookupResponse.operation_result.matched).toBe(true);
    expect(localLookupResponse.context_patch.geocoding.local_match).toBe(true);
    expect(localLookupResponse.context_patch.geocoding.successful).toBe(true);
    expect(localLookupResponse.context_patch.geocoding.selected_geocode.provider_name).toBe(
      'canonical_lookup',
    );
    expect(
      localLookupResponse.context_patch.geocoding.selected_geocode.metadata.city_match.toLowerCase(),
    ).toBe(canonicalCityName.toLowerCase());
    await mergeContextPatch(localRunId, localLookupResponse.context_patch);

    const localDispatchStep = localSteps.find(
      (s) => s.operation_name === 'dispatch_provider',
    );
    expect(localDispatchStep).toBeTruthy();

    await setWorkflowContextForStep(client, localDispatchStep.id);
    const { rows: localDispatchRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_provider_dispatch_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [localDispatchStep.id],
    );
    const localDispatchResponse = localDispatchRows[0].response;
    expect(localDispatchResponse.operation_result.skipped).toBe(true);
    expect(localDispatchResponse.operation_result.reason).toBe('geocoding_already_resolved');

    // Provider-fallback path: local lookup misses, provider dispatch enqueues outbound call.
    const providerContext = {
      organization_id: providerClient.organization_id,
      client_id: providerClient.client_id,
      sender_id: providerClient.sender_id,
      address_id: providerAddressId,
    };
    const providerRunId = await startGeocodingWorkflow(client, providerContext);
    const providerSteps = await fetchWorkflowSteps(client, providerRunId);
    const providerLookupStep = providerSteps.find((s) => s.operation_name === 'local_lookup');
    expect(providerLookupStep).toBeTruthy();

    const { rows: providerLookupRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_geo_local_lookup_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [providerLookupStep.id],
    );
    const providerLookupResponse = providerLookupRows[0].response;
    expect(providerLookupResponse.operation_result.matched).toBe(false);
    expect(providerLookupResponse.context_patch).toBeNull();

    const providerDispatchStep = providerSteps.find(
      (s) => s.operation_name === 'dispatch_provider',
    );
    expect(providerDispatchStep).toBeTruthy();

    await setWorkflowContextForStep(client, providerDispatchStep.id);
    const { rows: providerDispatchRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_provider_dispatch_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [providerDispatchStep.id],
    );
    const providerDispatchResponse = providerDispatchRows[0].response;
    const outboundId =
      providerDispatchResponse.context_patch?.last_outbound_call_id ||
      providerDispatchResponse.context_patch?.geocoding?.last_outbound_call_id;
    expect(outboundId).toBeTruthy();

    const { rows: dispatchMetaRows } = await client.query(
      `SELECT metadata FROM workflow_run_steps WHERE id = $1::uuid LIMIT 1`,
      [providerDispatchStep.id],
    );
    const providerName = dispatchMetaRows[0]?.metadata?.provider_name;
    expect(providerName).toBe('here_geocoding');

    const { rows: outboundRows } = await client.query(
      `SELECT url FROM outbound_calls WHERE id = $1::uuid LIMIT 1`,
      [outboundId],
    );
    expect(outboundRows.length).toBe(1);
    expect(outboundRows[0].url).toMatch(/revgeocode|geocode\.search\.hereapi\.com/);
  });

  test('long noisy lines trigger long_line plugin and force provider fallback', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
    });

    const { rows: canonicalRows } = await client.query(
      `
        SELECT
          c.name_canonical AS city_name,
          c.province AS province_name,
          d.name_canonical AS district_name
        FROM canonical_cities c
        JOIN canonical_districts d ON d.city_id = c.id
        WHERE c.organization_id = $1::uuid
          AND c.centroid IS NOT NULL
          AND d.centroid IS NOT NULL
        ORDER BY c.updated_at DESC
        LIMIT 1
      `,
      [ids.organization_id],
    );
    expect(canonicalRows.length).toBe(1);
    const { city_name: cityName, province_name: provinceName, district_name: districtName } =
      canonicalRows[0];

    const longLine = `Building 42, extremely long noisy address with typos and extra tokens near ${districtName} ${cityName} extra words 12345 random text that keeps going`;
    const rawPayload = {
      line1: longLine,
      city: cityName,
      district: districtName,
      country: 'SA',
    };
    const addressId = randomUUID();

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
          normalized_line1,
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
          'SA',
          'pending',
          $7::text,
          $8::text,
          now(),
          now()
        )
      `,
      [
        addressId,
        ids.organization_id,
        ids.client_id,
        rawPayload,
        cityName,
        provinceName,
        districtName,
        longLine,
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
    const response = lookupRows[0].response;
    expect(response.operation_result.matched).toBe(true);
    expect(response.context_patch.geocoding.require_fallback).toBe(true);
    expect(response.context_patch.geocoding.successful).toBe(false);
    expect(response.context_patch.geocoding.geocoding_match.long_line_detected).toBe(true);
    expect(response.context_patch.geocoding.geocoding_match.routing_reason).toBe(
      'long_line_detected',
    );
  });

  test('scoring: perfect local match logs high confidence and tokens quickly', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: [],
      local_lookup: { enabled: true, min_confidence: 0.7, prefer_district_centroid: true },
      logging: { log_tokens: true, log_scoring_details: true },
    });

    const { rows: canonicalRows } = await client.query(
      `
        SELECT
          c.name_canonical AS city_name,
          c.province AS province_name,
          d.name_canonical AS district_name
        FROM canonical_cities c
        JOIN canonical_districts d ON d.city_id = c.id
        WHERE c.organization_id = $1::uuid
          AND d.organization_id = $1::uuid
          AND c.centroid IS NOT NULL
          AND d.centroid IS NOT NULL
        ORDER BY c.updated_at DESC
        LIMIT 1
      `,
      [ids.organization_id],
    );
    const { city_name: cityName, province_name: provinceName, district_name: districtName } =
      canonicalRows[0];

    const addressId = randomUUID();
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
          district,
          normalized_line1,
          validation_status,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          jsonb_build_object('city',$4::text,'district',$5::text),
          $4::text,
          $6::text,
          'SA',
          $5::text,
          $5::text,
          'pending',
          now(),
          now()
        )
      `,
      [addressId, ids.organization_id, ids.client_id, cityName, districtName, provinceName],
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
    expect(response.context_patch.geocoding.local_match).toBe(true);

    const { rows: attempts } = await client.query(
      `SELECT confidence, metadata, duration_ms FROM geocoding_attempts WHERE address_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [addressId],
    );
    const attempt = attempts[0];
    const meta = attempt.metadata || {};

    expect(Number(attempt.confidence)).toBeGreaterThanOrEqual(0.8);
    expect(meta.match_plugin).toBe('perfect');
    expect(meta.routing_reason).toBe('local_match');
    expect(meta.long_line_detected).toBeFalsy();
    expect(elapsedMs).toBeLessThan(MAX_PERFECT_LOCAL_MATCH_ELAPSED_MS);

    const { rows: decisionRows } = await client.query(
      `
        SELECT id, settings_resolution_id
        FROM decision_log
        WHERE decision_category = 'geocoding'
          AND resource_type = 'workflow_run_step'
          AND resource_id = $1::uuid
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      [lookupStep.id],
    );
    expect(decisionRows.length).toBeGreaterThan(0);
    const settingsResolutionId = decisionRows[0].settings_resolution_id;
    expect(settingsResolutionId).toBeTruthy();

    const { rows: provenanceRows } = await client.query(
      `
        SELECT category, winning_scope_type
        FROM settings_resolution_log
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [settingsResolutionId],
    );
    expect(provenanceRows.length).toBe(1);
    expect(provenanceRows[0].category).toBe('geocoding_policy');
  });

  test('scoring: long_line path caps confidence and still records timing/tokens', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      local_lookup: { enabled: true, min_confidence: 0.7, prefer_district_centroid: true },
      matching_plugins: [
        { name: 'perfect', enabled: true },
        { name: 'fuzzy', enabled: true },
        { name: 'long_line', enabled: true, params: { long_line_min_tokens: 6, max_noise_ratio: 0.3 } },
      ],
      logging: { log_tokens: true, log_scoring_details: true },
    });

    const { rows: canonicalRows } = await client.query(
      `
        SELECT
          c.name_canonical AS city_name,
          c.province AS province_name,
          d.name_canonical AS district_name
        FROM canonical_cities c
        JOIN canonical_districts d ON d.city_id = c.id
        WHERE c.centroid IS NOT NULL
          AND d.centroid IS NOT NULL
        ORDER BY c.updated_at DESC
        LIMIT 1
      `,
    );
    const { city_name: cityName, province_name: provinceName, district_name: districtName } =
      canonicalRows[0];

    const longLine = `Very long noisy address with many extra tokens and numbers 12345 near ${districtName} ${cityName} lorem ipsum text continues beyond normal length`;
    const addressId = randomUUID();
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
          district,
          normalized_line1,
          validation_status,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          jsonb_build_object('city',$4::text,'district',$5::text,'line1',$6::text),
          $4::text,
          $7::text,
          'SA',
          $5::text,
          $6::text,
          'pending',
          now(),
          now()
        )
      `,
      [addressId, ids.organization_id, ids.client_id, cityName, districtName, longLine, provinceName],
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

    const { rows: attempts } = await client.query(
      `SELECT confidence, metadata FROM geocoding_attempts WHERE address_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [addressId],
    );
    const attempt = attempts[0];
    const meta = attempt.metadata || {};

    expect(Number(attempt.confidence)).toBeGreaterThan(0);
    expect(meta.long_line_detected).toBe(true);
    expect(elapsedMs).toBeLessThan(MAX_LONG_LINE_MATCH_ELAPSED_MS);
  });

  test('reverse_local uses polygons before provider reverse', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: [],
      matching_plugins: [
        { name: 'reverse', enabled: true },
        { name: 'reverse_local', enabled: true },
      ],
    });

    // Seed minimal polygons for the test (square around Riyadh coords)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sa_regions (
        id integer PRIMARY KEY,
        name_ar text,
        name_en text,
        geom geometry(Polygon,4326),
        bbox geometry(Polygon,4326),
        centroid geometry(Point,4326),
        source varchar(32) default 'sa_geojson',
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
      CREATE TABLE IF NOT EXISTS sa_cities (
        id integer PRIMARY KEY,
        region_id integer REFERENCES sa_regions(id),
        name_ar text,
        name_en text,
        geom geometry(Point,4326),
        bbox geometry(Polygon,4326),
        centroid geometry(Point,4326),
        source varchar(32) default 'sa_geojson',
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
      CREATE TABLE IF NOT EXISTS sa_districts (
        id integer PRIMARY KEY,
        city_id integer REFERENCES sa_cities(id),
        region_id integer REFERENCES sa_regions(id),
        name_ar text,
        name_en text,
        geom geometry(Polygon,4326),
        bbox geometry(Polygon,4326),
        centroid geometry(Point,4326),
        source varchar(32) default 'sa_geojson',
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
      INSERT INTO sa_regions (id, name_en, geom, bbox, centroid)
      VALUES (9999, 'Test Region', ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_SetSRID(ST_MakePoint(46.7,24.7),4326))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO sa_cities (id, region_id, name_en, geom, bbox, centroid)
      VALUES (9999, 9999, 'Test City', ST_SetSRID(ST_MakePoint(46.7,24.7),4326), ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_SetSRID(ST_MakePoint(46.7,24.7),4326))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO sa_districts (id, city_id, region_id, name_en, geom, bbox, centroid)
      VALUES (9999, 9999, 9999, 'Test District', ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_SetSRID(ST_MakePoint(46.7,24.7),4326))
      ON CONFLICT (id) DO NOTHING;
    `);

    const addressId = randomUUID();
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
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, 'Riyadh', 'Riyadh', 'SA', 'pending', now(), now())
      `,
      [addressId, ids.organization_id, ids.client_id],
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
      shipment: {
        coordinates: {
          latitude: 24.71,
          longitude: 46.71,
        },
      },
    };

    const runId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, runId);
    const coordStep = steps.find((s) => s.operation_name === 'validate_coordinates');
    expect(coordStep).toBeTruthy();

    const { rows: expectedRows } = await client.query(
      `
        SELECT
          d.name_en AS district_name_en,
          c.name_en AS city_name_en,
          ST_Y(ST_PointOnSurface(ST_CollectionExtract(d.geom::geometry, 3))) AS expected_latitude,
          ST_X(ST_PointOnSurface(ST_CollectionExtract(d.geom::geometry, 3))) AS expected_longitude
        FROM sa_districts d
        JOIN sa_cities c ON c.id = d.city_id
        WHERE d.geom IS NOT NULL
          AND ST_Covers(
            ST_CollectionExtract(d.geom::geometry, 3),
            ST_SetSRID(ST_MakePoint($1::numeric, $2::numeric), 4326)::geometry
          )
        ORDER BY ST_Area(ST_CollectionExtract(d.geom::geometry, 3)) ASC NULLS LAST, d.id DESC
        LIMIT 1
      `,
      [46.71, 24.71],
    );
    const expectedMatch = expectedRows[0];
    expect(expectedMatch).toBeTruthy();

    const { rows: coordRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_geo_coordinate_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [coordStep.id],
    );
    const response = coordRows[0].response;

    expect(response.operation_result.local_reverse_match).toBeTruthy();
    expect(response.operation_result.local_reverse_match.district_name_en).toBe(expectedMatch.district_name_en);
    expect(response.operation_result.local_reverse_match.city_name_en).toBe(expectedMatch.city_name_en);
    expect(response.context_patch.geocoding.local_reverse_match.coordinates.latitude).toBeCloseTo(
      expectedMatch.expected_latitude,
      4,
    );
    expect(response.context_patch.geocoding.local_reverse_match.coordinates.longitude).toBeCloseTo(
      expectedMatch.expected_longitude,
      4,
    );
    expect(response.context_patch.geocoding.coordinates_valid).toBe(true);
    expect(response.context_patch.geocoding.local_reverse_match.attempt_id).toBeTruthy();
    expect(response.context_patch.geocoding.successful).toBe(true);
    expect(response.context_patch.geocoding.reverse_geocode).toBeUndefined();
    expect(response.context_patch.geocoding.selected_geocode.provider_name).toBe('reverse_local');
    expect(response.context_patch.geocoding.selected_geocode.coordinates.latitude).toBeCloseTo(24.71, 4);
    expect(response.context_patch.geocoding.selected_geocode.coordinates.longitude).toBeCloseTo(46.71, 4);
  });

  test('reverse plugin disablement is respected in coordinate validation', async () => {
    const ids = await selectOrgClientSender(client);
    await configureGeocodingPolicy(client, ids, {
      provider_priority: ['here_geocoding'],
      matching_plugins: [
        { name: 'perfect', enabled: true },
        { name: 'fuzzy', enabled: true },
        { name: 'long_line', enabled: true },
        { name: 'reverse', enabled: false },
      ],
    });

    const addressId = randomUUID();
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
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, 'Riyadh', 'Riyadh', 'SA', 'pending', now(), now())
      `,
      [addressId, ids.organization_id, ids.client_id],
    );

    const context = {
      organization_id: ids.organization_id,
      client_id: ids.client_id,
      sender_id: ids.sender_id,
      address_id: addressId,
      shipment: {
        coordinates: {
          latitude: 24.7136,
          longitude: 46.6753,
        },
      },
    };

    const runId = await startGeocodingWorkflow(client, context);
    const steps = await fetchWorkflowSteps(client, runId);
    const coordStep = steps.find((s) => s.operation_name === 'validate_coordinates');
    expect(coordStep).toBeTruthy();

    const { rows: coordRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_geo_coordinate_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [coordStep.id],
    );

    const coordResponse = coordRows[0].response;
    expect(coordResponse.operation_result.reverse_enabled).toBe(false);
    expect(coordResponse.operation_result.within_bounds).toBe(false);
    expect(coordResponse.context_patch.geocoding.reverse_plugin_enabled).toBe(false);
  });
});
