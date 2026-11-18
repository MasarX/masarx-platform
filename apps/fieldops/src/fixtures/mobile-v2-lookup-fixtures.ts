// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2LookupRecent,
  MobileV2LookupRecord,
} from "../mobile-v2-lookup-screen";

export const MOBILE_V2_PREVIEW_LOOKUP_RECORDS: ReadonlyArray<MobileV2LookupRecord> = Object.freeze([
  Object.freeze({ id: "stop:1", kind: "stop" as const, parcel: "DLX-784521", customer: "Khalid Al-Hashimi", area: "Olaya", status: "pending" }),
  Object.freeze({ id: "stop:2", kind: "stop" as const, parcel: "DLX-784583", customer: "Sara Faisal", area: "Riyadh", status: "pending" }),
  Object.freeze({ id: "PCK-7741", kind: "pickup" as const, parcel: "WB-RYD-7741", customer: "Layla Boutique", area: "Olaya", status: "pending" }),
  Object.freeze({ id: "PCK-7742", kind: "pickup" as const, parcel: "WB-RYD-7742", customer: "Najd Coffee Co.", area: "Wurud", status: "pending" }),
  Object.freeze({ id: "stop:5", kind: "stop" as const, parcel: "RTO-9919", customer: "Returns Desk", area: "Hub-RUH-01", status: "returning" }),
]);

/** Recent-lookups timestamps are computed at module-load so the preview
 * stays current. In production these come from a `lookup_history` table. */
export function buildMobileV2PreviewLookupRecent(): ReadonlyArray<MobileV2LookupRecent> {
  return Object.freeze([
    Object.freeze({ wb: "DLX-784521", customer: "Khalid Al-Hashimi", stage: "out for delivery", atIso: new Date(Date.now() - 4 * 60 * 1000).toISOString() }),
    Object.freeze({ wb: "WB-RYD-7741", customer: "Layla Boutique", stage: "merchant pickup", atIso: new Date(Date.now() - 13 * 60 * 1000).toISOString() }),
    Object.freeze({ wb: "TRIP-9911", customer: "Riyadh → Jeddah trip", stage: "in transit", atIso: new Date(Date.now() - 28 * 60 * 1000).toISOString() }),
  ]);
}
