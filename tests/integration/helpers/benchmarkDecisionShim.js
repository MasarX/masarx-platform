/**
 * benchmarkDecisionShim:
 * Injects a synthetic geocode into the decision context when a polygon-mapped candidate exists.
 * This is benchmark-only and does not alter production handlers; it helps the decision handler
 * receive a provider-style geocode with canonical UUIDs and confidence so we can measure accuracy.
 */
async function applyDecisionShim(client, decisionStepId, syntheticGeocode, confidence = 0.95) {
  if (!syntheticGeocode) return;
  await client.query(
    `
      UPDATE workflow_run_steps
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{benchmark_injected_geocode}',
        jsonb_strip_nulls(jsonb_build_object(
          'selected_geocode', $2::jsonb,
          'confidence', $3::numeric
        ))
      )
      WHERE id = $1::uuid
    `,
    [decisionStepId, syntheticGeocode, confidence],
  );
}

module.exports = { applyDecisionShim };
