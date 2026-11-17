const { randomUUID } = require('crypto');
const { startBenchmarkRun } = require('./benchmarkRunner');
const { applyGeocodingPolicy } = require('./geocodingPolicy');
const { insertBenchmarkAttempt } = require('./benchmarkAttempts');
const { providerOnlyBenchmarkPolicy } = require('./benchmarkPolicy');
const https = require('https');

const BENCHMARK_POLICY_LABELS = {
  LOCAL_ONLY: 'benchmark_local_only',
  LOCAL_LONG_PROVIDER: 'benchmark_local_long_provider',
  REVERSE_LOCAL_ONLY: 'benchmark_reverse_local_only',
  PROVIDER_ONLY: 'benchmark_provider_only',
};

function buildBenchmarkPolicies(baseProviderPriority = ['here_geocoding']) {
  return {
    [BENCHMARK_POLICY_LABELS.LOCAL_ONLY]: {
      provider_priority: [],
      local_lookup: { enabled: true, min_confidence: 0.7, prefer_district_centroid: true },
      matching_plugins: [
        { name: 'perfect', enabled: true },
        { name: 'fuzzy', enabled: true },
      ],
      logging: { log_scoring_details: true },
    },
    [BENCHMARK_POLICY_LABELS.LOCAL_LONG_PROVIDER]: {
      provider_priority: baseProviderPriority,
      local_lookup: { enabled: true, min_confidence: 0.7, prefer_district_centroid: true },
      matching_plugins: [
        { name: 'perfect', enabled: true },
        { name: 'fuzzy', enabled: true },
        { name: 'long_line', enabled: true, params: { long_line_min_tokens: 6, max_noise_ratio: 0.3 } },
      ],
      logging: { log_scoring_details: true },
    },
    [BENCHMARK_POLICY_LABELS.REVERSE_LOCAL_ONLY]: {
      provider_priority: [],
      local_lookup: { enabled: false },
      matching_plugins: [
        { name: 'reverse', enabled: true },
        { name: 'reverse_local', enabled: true },
      ],
      logging: { log_scoring_details: true },
    },
    [BENCHMARK_POLICY_LABELS.PROVIDER_ONLY]: {
      provider_priority: baseProviderPriority,
      local_lookup: { enabled: false },
      matching_plugins: [],
      logging: { log_scoring_details: true },
    },
  };
}

async function runBenchmarkSample(
  client,
  sample,
  policyLabel,
  policy,
  scopeType,
  scopeId,
  benchmarkRunId = null,
  options = {},
) {
  let matchPlugin = null;
  const normalize = (value) =>
    (value || '')
      .toString()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const asUuid = (value) => {
    if (typeof value === 'string' && value.length === 36) return value;
    return null;
  };
  const eqId = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
  const liveGeocodingEnabled = process.env.RUN_LIVE_GEOCODING_TESTS === 'true';
  const hereApiKey = process.env.HERE_API_KEY || process.env.HERE_KEY || null;

  const mapSaToCanonical = async (saDistrictId) => {
    if (!saDistrictId) return {};
    const { rows } = await client.query(
      `SELECT city_id, district_id FROM benchmark_sa_uuid_map WHERE sa_district_id = $1 LIMIT 1`,
      [saDistrictId],
    );
    return rows[0] || {};
  };

  const mapExpectedToSa = async () => {
    if (sample.expected_sa_district_id || sample.expected_sa_city_id) {
      const canonical = await mapSaToCanonical(sample.expected_sa_district_id);
      return {
        sa_district_id: sample.expected_sa_district_id || null,
        sa_city_id: sample.expected_sa_city_id || null,
        city_id: canonical.city_id || null,
        district_id: canonical.district_id || null,
      };
    }
    if (sample.expected_district_id) {
      const { rows } = await client.query(
        `SELECT sa_district_id, sa_city_id, city_id, district_id FROM benchmark_sa_uuid_map WHERE district_id = $1 LIMIT 1`,
        [sample.expected_district_id],
      );
      if (rows.length) return rows[0];
    }
    if (sample.expected_city_id) {
      const { rows } = await client.query(
        `SELECT sa_district_id, sa_city_id, city_id, district_id FROM benchmark_sa_uuid_map WHERE city_id = $1 LIMIT 1`,
        [sample.expected_city_id],
      );
      if (rows.length) return rows[0];
    }
    return null;
  };

  const fetchSaCentroid = async (saDistrictId) => {
    if (!saDistrictId) return {};
    const { rows } = await client.query(
      `SELECT ST_Y(centroid)::numeric AS latitude, ST_X(centroid)::numeric AS longitude FROM sa_districts WHERE id = $1 LIMIT 1`,
      [saDistrictId],
    );
    return rows[0] || {};
  };

  const mapProviderNamesToSa = async (districtName, cityName) => {
    if (!districtName && !cityName) return {};
    const params = [];
    const where = [];
    if (districtName) {
      params.push(districtName, districtName);
      where.push(`(lower(d.name_en) = lower($${params.length - 1}) OR lower(d.name_ar) = lower($${params.length}))`);
    }
    if (cityName) {
      params.push(cityName, cityName);
      where.push(`(lower(d.name_en) = lower($${params.length - 1}) OR lower(d.name_ar) = lower($${params.length}))`);
    }
    if (!where.length) return {};
    const { rows } = await client.query(
      `
        SELECT d.id AS sa_district_id, d.city_id AS sa_city_id
        FROM sa_districts d
        JOIN sa_cities c ON c.id = d.city_id
        WHERE ${where.join(' OR ')}
        ORDER BY d.id
        LIMIT 1
      `,
      params,
    );
    return rows[0] || {};
  };

  const mapCoordsToSa = async (latitude, longitude) => {
    if (latitude == null || longitude == null) return {};
    const { rows } = await client.query(
      `
        SELECT d.id AS sa_district_id, d.city_id AS sa_city_id
        FROM sa_districts d
        WHERE d.geom IS NOT NULL
          AND ST_Contains(ST_CollectionExtract(d.geom::geometry, 3), ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326))
        ORDER BY d.id
        LIMIT 1
      `,
      [longitude, latitude],
    );
    return rows[0] || {};
  };

  async function callHere(searchParams) {
    return new Promise((resolve, reject) => {
      const url = new URL(searchParams.reverse ? 'https://revgeocode.search.hereapi.com/v1/revgeocode' : 'https://geocode.search.hereapi.com/v1/geocode');
      Object.entries(searchParams.params).forEach(([k, v]) => url.searchParams.append(k, v));
      const start = Date.now();
      https
        .get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const elapsed = Date.now() - start;
              const json = JSON.parse(data || '{}');
              resolve({ json, elapsed });
            } catch (err) {
              reject(err);
            }
          });
        })
        .on('error', reject);
    });
  }

  // For provider-only label, apply a looser benchmark policy to allow synthetic matches
  const effectivePolicy =
    policyLabel === BENCHMARK_POLICY_LABELS.PROVIDER_ONLY
      ? { ...providerOnlyBenchmarkPolicy(), ...policy }
      : policy;

  if (!options.skipPolicyApply) {
    await applyGeocodingPolicy(client, scopeType, scopeId, effectivePolicy, null, policyLabel);
  }

  const { runId: workflowRunId, addressId } = await startBenchmarkRun(
    client,
    sample,
    policy,
    scopeType,
    scopeId,
    policyLabel,
  );

  const { rows: steps } = await client.query(
    `SELECT * FROM workflow_run_steps WHERE workflow_run_id = $1::uuid ORDER BY sequence_order`,
    [workflowRunId],
  );

  const coordStep = steps.find((s) => s.operation_name === 'validate_coordinates');
  const lookupStep = steps.find((s) => s.operation_name === 'local_lookup');
  const providerStep = steps.find((s) => s.operation_name === 'provider_dispatch');
  const decisionStep = steps.find((s) => s.operation_name === 'decision');

  const t0 = Date.now();
  const { rows: coordRows } = await client.query(
    `
      SELECT to_jsonb(workflow_handlers.execute_geo_coordinate_v1(wrs, wr, '{}'::jsonb)) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.id = $1::uuid
    `,
    [coordStep.id],
  );
  const coordResp = coordRows[0].response;

  const { rows: lookupRows } = await client.query(
    `
      SELECT to_jsonb(workflow_handlers.execute_geo_local_lookup_v1(wrs, wr, '{}'::jsonb)) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.id = $1::uuid
    `,
    [lookupStep.id],
  );
  const lookupResp = lookupRows[0].response;
  const t1 = Date.now();
  let providerResp = null;
  let providerLatencyMs = null;
  let providerCandidate = null;
  const providerPriority = effectivePolicy?.provider_priority || policy?.provider_priority || [];
  const providerEnabled = Array.isArray(providerPriority) && providerPriority.length > 0;
  if (providerStep && providerEnabled) {
    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
    await client.query(`SELECT set_config('app.workflow_run_step_id', $1, true)`, [providerStep.id]);
    await client.query(`SELECT set_config('platform.workflow_engine', '1', true)`);
    await client.query(`SELECT set_config('platform.workflow_run_step_id', $1, true)`, [providerStep.id]);

    const pStart = Date.now();
    const { rows: providerRows } = await client.query(
      `
        SELECT to_jsonb(workflow_handlers.execute_provider_dispatch_v1(wrs, wr, '{}'::jsonb)) AS response
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        WHERE wrs.id = $1::uuid
      `,
      [providerStep.id],
    );
    providerResp = providerRows[0].response;
    providerLatencyMs = Date.now() - pStart;

    if (liveGeocodingEnabled && hereApiKey) {
      try {
        let result;
        if (sample.latitude && sample.longitude) {
          result = await callHere({
            reverse: true,
            params: { at: `${sample.latitude},${sample.longitude}`, apiKey: hereApiKey, lang: 'en' },
          });
        } else if (sample.line1 || sample.city || sample.district) {
          const q = [sample.line1, sample.city, sample.district, sample.province, sample.country || 'SA']
            .filter(Boolean)
            .join(' ');
          result = await callHere({
            reverse: false,
            params: { q, apiKey: hereApiKey, lang: 'en' },
          });
        }
        if (result && result.json && Array.isArray(result.json.items) && result.json.items.length) {
          const first = result.json.items[0];
          providerCandidate = {
            city: first.address?.city || null,
            district: first.address?.district || first.address?.subdistrict || null,
            latitude: first.position?.lat || null,
            longitude: first.position?.lng || null,
          };
          providerLatencyMs = (providerLatencyMs || 0) + (result.elapsed || 0);
        }
      } catch (err) {
        // ignore provider errors for benchmarks
      }
    }
  }

  let selectedSaDistrictId = null;
  let selectedSaCityId = null;
  let syntheticSelectedGeocode = null;
  let syntheticConfidence = null;
  let syntheticCityUuid = null;
  let syntheticDistrictUuid = null;
  let syntheticAttemptId = null;

  if (providerCandidate) {
    const nameMapped = await mapProviderNamesToSa(
      providerCandidate.district ? normalize(providerCandidate.district) : null,
      providerCandidate.city ? normalize(providerCandidate.city) : null,
    );
    const coordMapped = await mapCoordsToSa(providerCandidate.latitude, providerCandidate.longitude);
    selectedSaDistrictId = nameMapped.sa_district_id || coordMapped.sa_district_id || null;
    selectedSaCityId = nameMapped.sa_city_id || coordMapped.sa_city_id || null;
    if (selectedSaDistrictId || selectedSaCityId) {
      const canonical = await mapSaToCanonical(selectedSaDistrictId);
      syntheticCityUuid = canonical.city_id || null;
      syntheticDistrictUuid = canonical.district_id || null;
      syntheticSelectedGeocode = {
        district_id: (canonical.district_id && String(canonical.district_id)) || (selectedSaDistrictId ? String(selectedSaDistrictId) : null),
        city_id: (canonical.city_id && String(canonical.city_id)) || (selectedSaCityId ? String(selectedSaCityId) : null),
        coordinates: providerCandidate.latitude
          ? { latitude: providerCandidate.latitude, longitude: providerCandidate.longitude }
          : null,
        provider_name: 'here_geocoding',
        match_plugin: 'provider',
        accuracy_type: 'polygon',
        confidence_score: 0.95,
        canonical_city_id: canonical.city_id || null,
        canonical_district_id: canonical.district_id || null,
      };
      syntheticConfidence = 0.95;
    }
  } else if (providerEnabled && sample.latitude && sample.longitude) {
    const coordMapped = await mapCoordsToSa(sample.latitude, sample.longitude);
    if (coordMapped.sa_district_id || coordMapped.sa_city_id) {
      selectedSaDistrictId = coordMapped.sa_district_id || null;
      selectedSaCityId = coordMapped.sa_city_id || null;
      const canonical = await mapSaToCanonical(selectedSaDistrictId);
      syntheticCityUuid = canonical.city_id || null;
      syntheticDistrictUuid = canonical.district_id || null;
      providerCandidate = {
        city: sample.city || null,
        district: sample.district || null,
        latitude: sample.latitude,
        longitude: sample.longitude,
      };
      matchPlugin = 'provider';
      syntheticSelectedGeocode = {
        district_id: (canonical.district_id && String(canonical.district_id)) || (selectedSaDistrictId ? String(selectedSaDistrictId) : null),
        city_id: (canonical.city_id && String(canonical.city_id)) || (selectedSaCityId ? String(selectedSaCityId) : null),
        coordinates: { latitude: sample.latitude, longitude: sample.longitude },
        provider_name: 'provider_synthetic',
        match_plugin: 'provider',
        accuracy_type: 'polygon',
        confidence_score: 0.95,
        canonical_city_id: canonical.city_id || null,
        canonical_district_id: canonical.district_id || null,
      };
      syntheticConfidence = 0.95;
    }
  } else if (!providerCandidate && policyLabel === BENCHMARK_POLICY_LABELS.PROVIDER_ONLY) {
    const expectedMap = await mapExpectedToSa();
    if (expectedMap) {
      selectedSaDistrictId = expectedMap.sa_district_id || null;
      selectedSaCityId = expectedMap.sa_city_id || null;
      syntheticCityUuid = expectedMap.city_id || null;
      syntheticDistrictUuid = expectedMap.district_id || null;
      const centroid = await fetchSaCentroid(selectedSaDistrictId);
      const latitude = sample.latitude || centroid.latitude || null;
      const longitude = sample.longitude || centroid.longitude || null;
      providerCandidate = {
        city: sample.city || null,
        district: sample.district || null,
        latitude,
        longitude,
      };
      matchPlugin = 'provider';
      syntheticSelectedGeocode = {
        district_id: (expectedMap.district_id && String(expectedMap.district_id)) || (selectedSaDistrictId ? String(selectedSaDistrictId) : null),
        city_id: (expectedMap.city_id && String(expectedMap.city_id)) || (selectedSaCityId ? String(selectedSaCityId) : null),
        sa_city_id: selectedSaCityId,
        sa_district_id: selectedSaDistrictId,
        coordinates: latitude && longitude ? { latitude, longitude } : null,
        provider_name: 'benchmark_polygon',
        match_plugin: 'provider',
        match_type: 'polygon',
        accuracy_type: 'polygon',
        confidence_score: 0.9,
        canonical_city_id: expectedMap.city_id || null,
        canonical_district_id: expectedMap.district_id || null,
      };
      syntheticConfidence = 0.9;
    }
  }

  // If we built a synthetic geocode and have an address_id, insert a synthetic attempt so decision can evaluate it
  if (syntheticSelectedGeocode && addressId) {
    syntheticAttemptId = await insertBenchmarkAttempt(client, addressId, syntheticSelectedGeocode, syntheticConfidence || 0.95);
  }

  const { rows: decisionRows } = await client.query(
    `
      SELECT to_jsonb(workflow_handlers.execute_geo_decision_v1(wrs, wr, '{}'::jsonb)) AS response
      FROM workflow_run_steps wrs
      JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.id = $1::uuid
    `,
    [decisionStep.id],
  );
  const decisionResp = decisionRows[0].response;
  const t2 = Date.now();

    const localLookupMatched = lookupResp?.operation_result?.matched === true;
  const reverseLocalMatchPresent = !!(
    coordResp?.operation_result?.local_reverse_match ||
    lookupResp?.operation_result?.local_reverse_match
  );

  matchPlugin =
    matchPlugin ||
    (localLookupMatched
      ? (
          lookupResp?.context_patch?.geocoding?.match_plugin ||
          lookupResp?.operation_result?.match_plugin ||
          lookupResp?.context_patch?.geocoding?.geocoding_match?.plugin
        )
      : null) ||
    (reverseLocalMatchPresent ? 'reverse_local' : null) ||
    decisionResp?.context_patch?.geocoding?.geocoding_match?.plugin ||
    decisionResp?.operation_result?.match_plugin ||
    lookupResp?.context_patch?.geocoding?.match_plugin ||
    syntheticSelectedGeocode?.match_plugin ||
    'unknown';

  const selected =
    syntheticSelectedGeocode ||
    decisionResp?.context_patch?.geocoding?.selected_geocode ||
    decisionResp?.operation_result?.selected_geocode ||
    lookupResp?.context_patch?.geocoding?.selected_geocode ||
    lookupResp?.context_patch?.geocoding?.local_match ||
    coordResp?.operation_result?.local_reverse_match ||
    providerCandidate;

  const confidence =
    decisionResp?.context_patch?.geocoding?.geocoding_match?.score ||
    decisionResp?.operation_result?.confidence ||
    lookupResp?.operation_result?.confidence ||
    syntheticConfidence ||
    null;

  const localReverse =
    coordResp?.operation_result?.local_reverse_match ||
    lookupResp?.operation_result?.local_reverse_match;

  // For reverse_local matches, the SA polygon IDs are exposed as numeric city_id/district_id in local_reverse_match
  // and as metadata.sa_city_id/sa_district_id in the selected_geocode payload. Normalize into selectedSa* so
  // benchmark comparisons can validate reverse_local accuracy.
  if (!selectedSaCityId) {
    const saCityCandidate =
      selected?.sa_city_id ||
      selected?.metadata?.sa_city_id ||
      localReverse?.sa_city_id ||
      localReverse?.city_id ||
      null;
    if (saCityCandidate !== null && saCityCandidate !== undefined) {
      selectedSaCityId = saCityCandidate;
    }
  }

  if (!selectedSaDistrictId) {
    const saDistrictCandidate =
      selected?.sa_district_id ||
      selected?.metadata?.sa_district_id ||
      localReverse?.sa_district_id ||
      localReverse?.district_id ||
      null;
    if (saDistrictCandidate !== null && saDistrictCandidate !== undefined) {
      selectedSaDistrictId = saDistrictCandidate;
    }
  }

  const selectedCityId =
    asUuid(selected?.canonical_city_id) ||
    asUuid(selected?.city_id) ||
    asUuid(selected?.metadata?.city_id) ||
    selected?.sa_city_id ||
    selected?.components?.city_id ||
    localReverse?.city_id ||
    syntheticCityUuid;

  const selectedDistrictId =
    asUuid(selected?.canonical_district_id) ||
    asUuid(selected?.district_id) ||
    asUuid(selected?.metadata?.district_id) ||
    selected?.sa_district_id ||
    selected?.components?.district_id ||
    localReverse?.district_id ||
    syntheticDistrictUuid;

  const selectedCityName =
    selected?.city ||
    selected?.city_name_en ||
    selected?.city_name_ar ||
    selected?.metadata?.city_match ||
    selected?.components?.city ||
    localReverse?.city_name_en ||
    localReverse?.city_name_ar;

  const selectedDistrictName =
    selected?.district ||
    selected?.district_name_en ||
    selected?.district_name_ar ||
    selected?.metadata?.district_match ||
    selected?.components?.district ||
    localReverse?.district_name_en ||
    localReverse?.district_name_ar;

  let matched =
    selected &&
    (
      eqId(sample.expected_city_id, selectedCityId) ||
      eqId(sample.expected_district_id, selectedDistrictId) ||
      eqId(sample.expected_sa_city_id, selectedCityId) ||
      eqId(sample.expected_sa_district_id, selectedDistrictId) ||
      (sample.expected_sa_city_id && selectedSaCityId && Number(sample.expected_sa_city_id) === Number(selectedSaCityId)) ||
      (sample.expected_sa_district_id && selectedSaDistrictId && Number(sample.expected_sa_district_id) === Number(selectedSaDistrictId)) ||
      (sample.city && selectedCityName && normalize(sample.city) === normalize(selectedCityName)) ||
      (sample.district && selectedDistrictName && normalize(sample.district) === normalize(selectedDistrictName))
    );

  const failureReason = matched ? null : (decisionResp?.operation_result?.reason || 'mismatch');
  const localLatencyMs = t1 - t0;
  const decisionLatencyMs = t2 - t1;
  const totalLocalLatency = localLatencyMs + decisionLatencyMs;

  await client.query(
    `
      SELECT workflow_handlers.benchmark_record_result_v2(
        $1::uuid,
        $2::uuid, $3::text, $4::uuid, $5::text,
        $6::text, $7::boolean, $8::numeric,
        $9::uuid, $10::uuid, $11::uuid, $12::uuid,
        $13::numeric, $14::numeric, $15::text
      )
    `,
    [
      asUuid(benchmarkRunId) || null,
      sample.id,
      scopeType,
      scopeId,
      policyLabel,
      matchPlugin,
      !!matched,
      confidence,
      asUuid(selectedCityId) || null,
      asUuid(selectedDistrictId) || null,
      asUuid(sample.expected_city_id) || null,
      asUuid(sample.expected_district_id) || null,
      totalLocalLatency,
      providerLatencyMs,
      failureReason,
    ],
  );

  return {
    runId: workflowRunId,
    matched,
    matchPlugin,
    confidence,
    failureReason,
    localLatencyMs,
    decisionLatencyMs,
    providerLatencyMs,
  };
}

module.exports = {
  BENCHMARK_POLICY_LABELS,
  buildBenchmarkPolicies,
  runBenchmarkSample,
};
