const { startBenchmarkRun } = require('./benchmarkRunner');
const { applyGeocodingPolicy } = require('./geocodingPolicy');

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
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const asUuid = (value) =>
    typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';
  const eqId = (a, b) => present(a) && present(b) && normalize(a) === normalize(b);

  if (!options.skipPolicyApply) {
    await applyGeocodingPolicy(client, scopeType, scopeId, policy, null, policyLabel);
  }

  const { runId: workflowRunId } = await startBenchmarkRun(
    client, sample, policy, scopeType, scopeId, policyLabel,
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
  let providerLatencyMs = null;
  const providerPriority = policy?.provider_priority || [];
  if (providerStep && Array.isArray(providerPriority) && providerPriority.length > 0) {
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
    providerLatencyMs = Date.now() - pStart;
    const providerResp = providerRows[0]?.response;
    const providerResult = providerResp?.operation_result || {};
    const outboundCallId = providerResult.outbound_call_id
      ?? providerResp?.context_patch?.last_outbound_call_id;
    const statuses = [providerResp?.status, providerResult.status].map(normalize);
    const pending = statuses.some((status) => ['pending', 'queued', 'in_progress'].includes(status));
    const terminal = statuses.some((status) => ['completed', 'succeeded', 'failed'].includes(status));
    if (pending || (present(outboundCallId) && !terminal)) {
      // Dispatch can enqueue outbound work. Its response is not a completed
      // geocoding attempt, and this transactional harness cannot wait for a worker.
      const error = new Error(
        `Benchmark incomplete: provider response is pending for workflow ${workflowRunId}`
        + `${outboundCallId ? ` (outbound call ${outboundCallId})` : ''}.`
        + ' Complete the outbound workflow before measuring provider accuracy.',
      );
      error.code = 'BENCHMARK_PROVIDER_PENDING';
      error.workflowRunId = workflowRunId;
      if (outboundCallId) error.outboundCallId = outboundCallId;
      throw error;
    }
  }

  const decisionStarted = Date.now();
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
  const decisionResult = decisionResp?.operation_result || {};
  const decisionGeo = decisionResp?.context_patch?.geocoding || {};
  const decisionAccepted = decisionResp?.status !== 'failed'
    && decisionResp?.workflow_status !== 'failed'
    && decisionGeo.successful !== false
    && !['failed', 'manual_review', 'fallback_required'].includes(decisionResult.decision)
    && (decisionResult.decision === 'success' || decisionGeo.successful === true);

  // The decision handler can explicitly accept an existing context result without
  // repeating its geocode. Only that success path may reuse an earlier handler.
  // An explicit null selection or a rejected decision must remain a failed prediction.
  let selected = null;
  if (Object.hasOwn(decisionGeo, 'selected_geocode')) {
    selected = decisionGeo.selected_geocode;
  } else if (Object.hasOwn(decisionResult, 'selected_geocode')) {
    selected = decisionResult.selected_geocode;
  } else if (Object.hasOwn(decisionResult.attempt || {}, 'geocode')) {
    selected = decisionResult.attempt.geocode;
  } else if (decisionAccepted && decisionResult.source === 'context') {
    selected = lookupResp?.context_patch?.geocoding?.selected_geocode
      ?? coordResp?.context_patch?.geocoding?.selected_geocode
      ?? coordResp?.operation_result?.local_reverse_match
      ?? lookupResp?.operation_result?.local_reverse_match
      ?? null;
  }

  const selectedCityId = asUuid(selected?.canonical_city_id)
    || asUuid(selected?.city_id)
    || asUuid(selected?.metadata?.city_id)
    || asUuid(selected?.components?.city_id);
  const selectedDistrictId = asUuid(selected?.canonical_district_id)
    || asUuid(selected?.district_id)
    || asUuid(selected?.metadata?.district_id)
    || asUuid(selected?.components?.district_id);
  const selectedSaCityId = selected?.sa_city_id ?? selected?.metadata?.sa_city_id
    ?? (!asUuid(selected?.city_id) ? selected?.city_id : null);
  const selectedSaDistrictId = selected?.sa_district_id ?? selected?.metadata?.sa_district_id
    ?? (!asUuid(selected?.district_id) ? selected?.district_id : null);
  const selectedCityName = selected?.city ?? selected?.city_name_en ?? selected?.city_name_ar
    ?? selected?.metadata?.city_match ?? selected?.metadata?.city_name_en
    ?? selected?.metadata?.city_name_ar ?? selected?.components?.city;
  const selectedDistrictName = selected?.district ?? selected?.district_name_en ?? selected?.district_name_ar
    ?? selected?.metadata?.district_match ?? selected?.metadata?.district_name_en
    ?? selected?.metadata?.district_name_ar ?? selected?.components?.district;

  // Canonical and SA IDs are alternative representations of the same label.
  // Every available comparison must agree; a correct city cannot mask a wrong district.
  const matchesIds = (expectedId, actualId, expectedSaId, actualSaId) => {
    const comparisons = [[expectedId, actualId], [expectedSaId, actualSaId]]
      .filter(([expected, actual]) => present(expected) && present(actual));
    return comparisons.length > 0 && comparisons.every(([expected, actual]) => eqId(expected, actual));
  };
  const expectedComparisons = [];
  if (present(sample.expected_district_id) || present(sample.expected_sa_district_id)) {
    expectedComparisons.push(matchesIds(
      sample.expected_district_id, selectedDistrictId, sample.expected_sa_district_id, selectedSaDistrictId,
    ));
  }
  if (present(sample.expected_city_id) || present(sample.expected_sa_city_id)) {
    expectedComparisons.push(matchesIds(
      sample.expected_city_id, selectedCityId, sample.expected_sa_city_id, selectedSaCityId,
    ));
  }
  if (!expectedComparisons.length) {
    if (present(sample.district)) expectedComparisons.push(eqId(sample.district, selectedDistrictName));
    if (present(sample.city)) expectedComparisons.push(eqId(sample.city, selectedCityName));
  }
  const matched = Boolean(decisionAccepted && selected
    && expectedComparisons.length > 0 && expectedComparisons.every(Boolean));
  const matchPlugin = decisionGeo.geocoding_match?.plugin
    || decisionResult.match_plugin
    || selected?.match_plugin
    || selected?.metadata?.match_plugin
    || (selected?.provider_name === 'reverse_local' ? 'reverse_local' : null)
    || (selected?.provider_name && selected.provider_name !== 'canonical_lookup' ? 'provider' : null)
    || 'unknown';
  const confidence = decisionGeo.geocoding_match?.score
    ?? decisionResult.attempt?.confidence
    ?? decisionResult.confidence
    ?? selected?.confidence_score
    ?? null;
  const failureReason = matched ? null : (decisionResult.reason
    || decisionGeo.fail_reason || decisionGeo.manual_review_reason
    || decisionResp?.last_error || (decisionAccepted && selected ? 'mismatch' : 'no_selected_geocode'));
  const localLatencyMs = t1 - t0;
  const decisionLatencyMs = Date.now() - decisionStarted;
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
      asUuid(benchmarkRunId), sample.id, scopeType, scopeId, policyLabel,
      matchPlugin, matched, confidence, selectedCityId, selectedDistrictId,
      asUuid(sample.expected_city_id), asUuid(sample.expected_district_id),
      totalLocalLatency, providerLatencyMs, failureReason,
    ],
  );
  return {
    runId: workflowRunId, matched, matchPlugin, confidence, failureReason,
    localLatencyMs, decisionLatencyMs, providerLatencyMs,
  };
}

module.exports = {
  BENCHMARK_POLICY_LABELS,
  buildBenchmarkPolicies,
  runBenchmarkSample,
};
