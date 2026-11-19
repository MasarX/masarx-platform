// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2MoreOutboxEntry } from "../mobile-v2-more-screen";

export const MOBILE_V2_PREVIEW_MORE_OUTBOX: ReadonlyArray<MobileV2MoreOutboxEntry> = Object.freeze([
  { id: "ob-1", label: "POST record_scan_event_v1", status: "queued", ageMin: 4 } as MobileV2MoreOutboxEntry,
  { id: "ob-2", label: "POST record_location_ping_v1", status: "queued", ageMin: 2 } as MobileV2MoreOutboxEntry,
  { id: "ob-3", label: "POST record_route_stop_pod_v1", status: "in-flight", ageMin: 0 } as MobileV2MoreOutboxEntry,
]);

export const MOBILE_V2_PREVIEW_USER = Object.freeze({
  name: "Khalid Al-Hashimi",
  badge: "DRV-2026-0042",
  currency: "SAR",
});
