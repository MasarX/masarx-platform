import type { MobileV2TripStage } from "./mobile-v2-trips-screen";

export const MOBILE_V2_TRIP_STAGE_READBACK_FAILED_MESSAGE =
  "Trip advanced, but the trip did not refresh";

export function mobileV2TripsHaveStage(
  data: unknown,
  tripId: string,
  expectedStage: MobileV2TripStage,
): boolean {
  if (!Array.isArray(data)) return false;
  return data.some((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const trip = entry as { readonly id?: unknown; readonly stage?: unknown };
    return trip.id === tripId && trip.stage === expectedStage;
  });
}
