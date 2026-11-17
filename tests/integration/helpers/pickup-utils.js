const { randomUUID } = require('crypto');

async function createPickupRequest(client, seed, overrides = {}) {
  const now = Date.now();
  const payload = {
    organization_id: seed.organizationId,
    client_id: seed.clientId,
    sender_id: seed.senderId,
    branch_id: overrides.branch_id || null,
    requested_window_start_at:
      overrides.requested_window_start_at || new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    requested_window_end_at:
      overrides.requested_window_end_at || new Date(now + 25 * 60 * 60 * 1000).toISOString(),
    client_reference_number:
      overrides.client_reference_number || `pickup-ref-${randomUUID().slice(0, 8)}`,
    box_count: overrides.box_count || 1,
    idempotency_key: overrides.idempotency_key || `pickup-request-${randomUUID()}`,
    origin_address: overrides.origin_address || {
      raw_input: 'Riyadh pickup origin',
      line1: '12 Warehouse Road',
      district: 'Al Olaya',
      city: 'Riyadh',
      province: 'Riyadh Province',
      postal_code: '11564',
      country: 'SA',
      building_number: '12',
      additional_directions: 'Dock 3',
    },
  };

  const { rows } = await client.query(`SELECT public.create_pickup_request_v1($1::jsonb) AS result`, [
    JSON.stringify(payload),
  ]);
  return rows[0].result;
}

async function createPickupWave(client, seed, shipmentIds, overrides = {}) {
  const now = Date.now();
  const payload = {
    organization_id: seed.organizationId,
    branch_id: overrides.branch_id || null,
    planned_date:
      overrides.planned_date || new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    planned_start_at:
      overrides.planned_start_at || new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    planned_end_at:
      overrides.planned_end_at || new Date(now + 25 * 60 * 60 * 1000).toISOString(),
    idempotency_key: overrides.idempotency_key || `pickup-wave-${randomUUID()}`,
    shipment_ids: shipmentIds,
  };

  const { rows } = await client.query(`SELECT public.create_pickup_wave_v1($1::jsonb) AS result`, [
    JSON.stringify(payload),
  ]);
  return rows[0].result;
}

async function assignPickupWave(client, seed, routeRunId, overrides = {}) {
  const payload = {
    organization_id: seed.organizationId,
    route_run_id: routeRunId,
    driver_user_id: overrides.driver_user_id || null,
    vehicle_id: overrides.vehicle_id || null,
    partner: overrides.partner || null,
    metadata: overrides.metadata || { source: 'integration-test' },
    idempotency_key: overrides.idempotency_key || `pickup-assign-${randomUUID()}`,
  };

  const { rows } = await client.query(`SELECT public.assign_pickup_wave_v1($1::jsonb) AS result`, [
    JSON.stringify(payload),
  ]);
  return rows[0].result;
}

module.exports = {
  assignPickupWave,
  createPickupRequest,
  createPickupWave,
};
