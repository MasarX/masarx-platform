const {
  DEFAULT_SEED_SERVICE_TYPE_PREFERENCE,
  DEFAULT_SEED_SHIPMENT_STATUS_PREFERENCE,
  resolveSeedServiceTypes,
  resolveSeedShipmentStatuses,
} = require('../../../scripts/data/seed-lookup-values');

describe('seed lookup policy', () => {
  test('prefers canonical operational statuses from the lookup set', () => {
    const resolved = resolveSeedShipmentStatuses([
      'cancelled',
      'pending',
      'in_transit',
      'delivered',
      'delivery_failed',
      'return_to_origin',
    ]);

    expect(resolved).toEqual(DEFAULT_SEED_SHIPMENT_STATUS_PREFERENCE);
  });

  test('falls back to the available statuses when the preferred subset is unavailable', () => {
    expect(resolveSeedShipmentStatuses(['cancelled', 'return_to_origin'])).toEqual([
      'cancelled',
      'return_to_origin',
    ]);
  });

  test('deduplicates and trims lookup values before resolving', () => {
    expect(resolveSeedShipmentStatuses([' pending ', 'pending', 'delivery_failed'])).toEqual([
      'pending',
      'delivery_failed',
    ]);
  });

  test('prefers canonical service types from the lookup set', () => {
    expect(
      resolveSeedServiceTypes(['delivery', 'pickup', 'swap', 'return_to_origin', 'special'])
    ).toEqual(DEFAULT_SEED_SERVICE_TYPE_PREFERENCE);
  });
});
