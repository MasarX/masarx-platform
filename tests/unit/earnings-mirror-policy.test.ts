import { computeStopEarningsEstimate } from "../../apps/fieldops/src/earnings-mirror-policy";

const stop = { distance_km: 3, pickup_count: 2, base_fee: 10, per_km_rate: 2, per_pickup_fee: 1, tip_amount: 3 };

test("keeps the estimate hidden until enabled", () => {
  expect(computeStopEarningsEstimate(stop, false)).toBeNull();
});

test("uses the supplied rates and reports the estimated breakdown", () => {
  expect(computeStopEarningsEstimate(stop, true)).toEqual({
    amount: 21,
    breakdown: { base: 10, distance: 6, pickups: 2, tip: 3 },
  });
});

test("omits invalid and incomplete estimates", () => {
  expect(computeStopEarningsEstimate({ ...stop, per_km_rate: NaN }, true)).toBeNull();
  expect(computeStopEarningsEstimate({ ...stop, pickup_count: 1.5 }, true)).toBeNull();
});
