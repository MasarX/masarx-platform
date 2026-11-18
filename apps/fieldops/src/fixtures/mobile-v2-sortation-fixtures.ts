// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2SortationBay,
  MobileV2SortationInduction,
} from "../mobile-v2-sortation-screen";

export const MOBILE_V2_PREVIEW_SORTATION_BAYS: ReadonlyArray<MobileV2SortationBay> = Object.freeze([
  Object.freeze({ id: "A", label: "Al Olaya", routeId: "RT-OL-08", transfer: false, exception: false, count: 184, capacity: 220 }),
  Object.freeze({ id: "B", label: "Al Murooj", routeId: "RT-MR-14", transfer: false, exception: false, count: 102, capacity: 220 }),
  Object.freeze({ id: "C", label: "Al Wurud", routeId: "RT-WU-22", transfer: false, exception: false, count: 196, capacity: 220 }),
  Object.freeze({ id: "D", label: "Industrial 3", routeId: "RT-IN-03", transfer: false, exception: false, count: 64, capacity: 220 }),
  Object.freeze({ id: "TX", label: "Inter-hub", routeId: null, transfer: true, exception: false, count: 124, capacity: 220 }),
  Object.freeze({ id: "?", label: "Exception · review", routeId: null, transfer: false, exception: true, count: 7, capacity: 50 }),
]);

export const MOBILE_V2_PREVIEW_SORTATION_RECENT: ReadonlyArray<MobileV2SortationInduction> = Object.freeze([
  Object.freeze({ id: "ind-1", parcel: "PCL-440112", bay: "A", dest: "Al Olaya · 7821", at: "11:42" }),
  Object.freeze({ id: "ind-2", parcel: "PCL-440113", bay: "C", dest: "Al Wurud · 226", at: "11:41" }),
  Object.freeze({ id: "ind-3", parcel: "PCL-440114", bay: "TX", dest: "Jeddah · trip TRIP-9912", at: "11:41" }),
  Object.freeze({ id: "ind-4", parcel: "PCL-440115", bay: "?", dest: "Address not resolved", at: "11:40" }),
]);

export const MOBILE_V2_PREVIEW_SORTATION_STATS = Object.freeze({
  inductedThisSession: 677,
  throughputPerHour: 146,
  minutesElapsed: 278,
  /** Wave # in production resolves via mobile_sortation_policy. */
  waveNumber: 3,
});
