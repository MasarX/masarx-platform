const { randomUUID } = require('crypto');
const { applyGeocodingPolicy } = require('./geocodingPolicy');

// IDs for benchmark template and base geocoding template
const BENCHMARK_TEMPLATE_ID = '99990000-0000-0000-0000-0000004b0001';
const GEOCODING_TEMPLATE_ID = '99990000-0000-0000-0000-000000400001'; // existing standard geocoding template

async function startBenchmarkRun(client, sample, policyConfig, policyScopeType, policyScopeId, policyLabel) {
  // Apply policy to the requested scope
  await applyGeocodingPolicy(client, policyScopeType, policyScopeId, policyConfig, null, policyLabel || 'benchmark policy');

  // Create address row (minimal fields; rest driven by sample)
  const addressId = randomUUID();
  await client.query(
    `
      INSERT INTO addresses (
        id, organization_id, client_id, raw_input, city, district, province, country,
        validation_status, created_at, updated_at
      )
      VALUES ($1::uuid, $2::uuid, $3::uuid,
        jsonb_strip_nulls(jsonb_build_object('line1',$4::text,'line2',$5::text,'city',$6::text,'district',$7::text,'province',$8::text,'country',$9::text)),
        COALESCE(NULLIF($6::text,''),'Riyadh'), COALESCE(NULLIF($7::text,''), 'Test District'), COALESCE(NULLIF($8::text,''), 'Riyadh'), COALESCE(NULLIF($9::text,''), 'SA'),
        'pending', now(), now()
      )
    `,
    [
      addressId,
      sample.organization_id || null,
      sample.client_id || null,
      sample.line1 || null,
      sample.line2 || null,
      sample.city || null,
      sample.district || null,
      sample.province || null,
      sample.country || 'SA',
    ],
  );

  // Build context for the run
  const context = {
    organization_id: sample.organization_id || null,
    client_id: sample.client_id || null,
    sender_id: sample.sender_id || null,
    address_id: addressId,
  };
  if ((policyScopeType || '').toLowerCase() === 'client') {
    context.sender_id = null;
  }
  if (sample.latitude && sample.longitude) {
    context.shipment = { coordinates: { latitude: sample.latitude, longitude: sample.longitude } };
  }

  // Start workflow using the benchmark template (same handlers as geocoding standard)
  const { rows } = await client.query(
    `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
    [BENCHMARK_TEMPLATE_ID, context],
  );
  return { runId: rows[0].run_id, addressId };
}

module.exports = {
  startBenchmarkRun,
  BENCHMARK_TEMPLATE_ID,
  GEOCODING_TEMPLATE_ID,
};
