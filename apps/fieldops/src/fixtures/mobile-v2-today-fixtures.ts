// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2TodayActiveStop,
  MobileV2TodayPreShiftBlocker,
} from "../mobile-v2-today-screen";

export const MOBILE_V2_PREVIEW_TODAY = Object.freeze({
  done: 28,
  total: 42,
  pending: 11,
  failed: 3,
  slaRisk: 3,
  etaFinish: "15:42",
  distanceKm: 42,
  codExpected: 4280,
  codCurrency: "SAR",
  blockers: [] as ReadonlyArray<MobileV2TodayPreShiftBlocker>,
  activeStop: Object.freeze({
    id: "stop-1",
    seq: 17,
    customer: "Khalid Al-Hashimi",
    address: "Khalid bin Walid Tower · Al Olaya · Riyadh",
    sla: "14:00",
    cod: 250,
    fragile: false,
    parcels: 2,
  }) as MobileV2TodayActiveStop,
});
