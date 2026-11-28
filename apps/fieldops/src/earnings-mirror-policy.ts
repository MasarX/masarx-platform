export type StopEarningsInput = {
  distance_km: number;
  pickup_count: number;
  base_fee: number;
  per_km_rate: number;
  per_pickup_fee: number;
  tip_amount?: number | null;
};

export function computeStopEarningsEstimate(input: StopEarningsInput, tenantEnabled: boolean) {
  if (tenantEnabled !== true) return null;
  const { distance_km, pickup_count, base_fee, per_km_rate, per_pickup_fee } = input;
  const tip = input.tip_amount ?? 0;
  const amounts = [distance_km, pickup_count, base_fee, per_km_rate, per_pickup_fee, tip];
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0) || !Number.isSafeInteger(pickup_count)) return null;

  const breakdown = { base: base_fee, distance: distance_km * per_km_rate, pickups: pickup_count * per_pickup_fee, tip };
  const amount = breakdown.base + breakdown.distance + breakdown.pickups + breakdown.tip;
  return Number.isFinite(amount) ? { amount, breakdown } : null;
}
