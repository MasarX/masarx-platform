/**
 * Inserts a synthetic geocoding_attempt for benchmarks when we have a polygon-mapped geocode.
 * This keeps decision logic unchanged while allowing it to evaluate the injected attempt.
 */
async function insertBenchmarkAttempt(client, addressId, geocode, confidence = 0.95) {
  if (!geocode || !addressId) return null;
  // Remove prior attempts for this address in the benchmark run to ensure the synthetic attempt is latest
  await client.query(`DELETE FROM geocoding_attempts WHERE address_id = $1::uuid`, [addressId]);
  const { rows } = await client.query(
    `
      INSERT INTO geocoding_attempts (
        organization_id,
        client_id,
        sender_id,
        address_id,
        attempt_order,
        attempt_type,
        provider_name,
        confidence,
        status,
        decision_outcome,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        (SELECT organization_id FROM addresses WHERE id = $1::uuid),
        (SELECT client_id FROM addresses WHERE id = $1::uuid),
        NULL,
        $1::uuid,
        1,
        'local',
        COALESCE($2, 'benchmark_polygon'),
        $3::numeric,
        'succeeded',
        'success',
        jsonb_strip_nulls(jsonb_build_object(
          'geocode', $4::jsonb,
          'match_plugin', COALESCE($5, 'provider'),
          'match_type', COALESCE($6, 'polygon')
        )),
        now(),
        now()
      )
      RETURNING id
    `,
    [
      addressId,
      geocode.provider_name || 'benchmark_polygon',
      confidence,
      geocode,
      geocode.match_plugin || 'provider',
      geocode.match_type || 'polygon',
    ],
  );
  return rows[0]?.id || null;
}

module.exports = { insertBenchmarkAttempt };
