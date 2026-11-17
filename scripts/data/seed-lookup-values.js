const DEFAULT_SEED_SHIPMENT_STATUS_PREFERENCE = [
  'pending',
  'in_transit',
  'delivered',
  'delivery_failed',
];

const DEFAULT_SEED_SERVICE_TYPE_PREFERENCE = [
  'delivery',
  'pickup',
  'swap',
  'return_to_origin',
];

function normalizeLookupValues(values) {
  const normalized = [];
  const seen = new Set();

  for (const rawValue of Array.isArray(values) ? values : []) {
    if (typeof rawValue !== 'string') continue;
    const value = rawValue.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function resolveSeedLookupValues(availableValues, preferredValues, { category }) {
  const normalized = normalizeLookupValues(availableValues);
  if (!normalized.length) {
    throw new Error(
      `[seed-test-data] No ${category} lookup values are available for seeding.`
    );
  }

  const preferred = normalizeLookupValues(preferredValues).filter((value) =>
    normalized.includes(value)
  );

  return preferred.length ? preferred : normalized;
}

async function loadSeedLookupValues(client, category, preferredValues) {
  const { rows } = await client.query(
    `
      SELECT lv.value
      FROM lookup_values lv
      JOIN lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
      WHERE ld.category = $1
      ORDER BY lv.sort_order NULLS LAST, lv.value
    `,
    [category]
  );

  return resolveSeedLookupValues(rows.map((row) => row.value), preferredValues, { category });
}

function resolveSeedShipmentStatuses(availableStatuses) {
  return resolveSeedLookupValues(
    availableStatuses,
    DEFAULT_SEED_SHIPMENT_STATUS_PREFERENCE,
    { category: 'shipment_status' }
  );
}

function resolveSeedServiceTypes(availableServiceTypes) {
  return resolveSeedLookupValues(
    availableServiceTypes,
    DEFAULT_SEED_SERVICE_TYPE_PREFERENCE,
    { category: 'service_type' }
  );
}

async function loadSeedShipmentStatuses(client) {
  return loadSeedLookupValues(
    client,
    'shipment_status',
    DEFAULT_SEED_SHIPMENT_STATUS_PREFERENCE
  );
}

async function loadSeedServiceTypes(client) {
  return loadSeedLookupValues(
    client,
    'service_type',
    DEFAULT_SEED_SERVICE_TYPE_PREFERENCE
  );
}

module.exports = {
  DEFAULT_SEED_SERVICE_TYPE_PREFERENCE,
  DEFAULT_SEED_SHIPMENT_STATUS_PREFERENCE,
  loadSeedLookupValues,
  loadSeedServiceTypes,
  loadSeedShipmentStatuses,
  resolveSeedLookupValues,
  resolveSeedServiceTypes,
  resolveSeedShipmentStatuses,
};
