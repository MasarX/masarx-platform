// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2RouteDensity,
  MobileV2RouteSavedView,
  MobileV2RouteStop,
} from "../mobile-v2-route-screen";
import type {
  MobileV2MapAlert,
  MobileV2MapStop,
} from "../mobile-v2-map-screen";

// Aligned to the design canvas s-route artboard so pixel-diff compares
// like-for-like: sequence numbers 01..06 (route start, not mid-shift),
// stop names/addresses/SLAs match design ScrRoute snapshot, statuses
// produce the same chip set (Delivered ×2, In progress ×1 highlighted,
// SLA risk + Try 2, Pending ×2). The longer "Tower 12 · Riyadh" /
// "Wurud District 4 · Riyadh" copy used previously dominated the
// pixel-diff with wrapping content that has no design analogue.
const STOPS: ReadonlyArray<MobileV2RouteStop> = Object.freeze([
  Object.freeze({
    id: "MX-2026-04421-001",
    seq: 1,
    customer: "Salem Al-Qahtani",
    address: "Al Olaya · 7821",
    sla: "09:30",
    status: "done" as const,
    cod: 0,
    fragile: false,
    attempts: 1,
  }),
  Object.freeze({
    id: "MX-2026-04421-002",
    seq: 2,
    customer: "Layla Boutique",
    address: "King Fahd Rd · 102",
    sla: "10:00",
    status: "done" as const,
    cod: 1840,
    fragile: false,
    attempts: 1,
  }),
  Object.freeze({
    id: "MX-2026-04421-003",
    seq: 3,
    customer: "Hessa Al-Saud",
    address: "Al Murooj · 4419 · Apt 12",
    sla: "11:30",
    status: "current" as const,
    cod: 320,
    fragile: false,
    attempts: 1,
  }),
  Object.freeze({
    id: "MX-2026-04421-004",
    seq: 4,
    customer: "Tahani Pharmacy",
    address: "Olaya Tower · G-04",
    sla: "10:15",
    status: "sla" as const,
    cod: 0,
    fragile: false,
    attempts: 2,
  }),
  Object.freeze({
    id: "MX-2026-04421-005",
    seq: 5,
    customer: "Khalid Al-Otaibi",
    address: "Olaya Tower · 18-B",
    sla: "11:45",
    status: "pending" as const,
    cod: 210,
    fragile: false,
    attempts: 1,
  }),
  Object.freeze({
    id: "MX-2026-04421-006",
    seq: 6,
    customer: "Reem Al-Mutairi",
    address: "Al Wurud · 226",
    sla: "12:30",
    status: "pending" as const,
    cod: 0,
    fragile: false,
    attempts: 1,
  }),
]);

const VIEWS: ReadonlyArray<MobileV2RouteSavedView> = Object.freeze([
  Object.freeze({ id: "v-all", name: "All stops", emoji: "📍", builtin: true }),
  Object.freeze({ id: "v-sla", name: "SLA risk", emoji: "⏱️", builtin: true }),
  Object.freeze({ id: "v-cod", name: "COD only", emoji: "💵", builtin: true }),
  Object.freeze({ id: "v-failed", name: "Failed today", emoji: "🚫", builtin: true }),
  Object.freeze({
    id: "v-custom-north",
    name: "North loop (custom)",
    emoji: "⭐",
    builtin: false,
  }),
]);

export const MOBILE_V2_PREVIEW_ROUTE: {
  readonly activeView: MobileV2RouteSavedView;
  readonly views: ReadonlyArray<MobileV2RouteSavedView>;
  readonly rows: ReadonlyArray<MobileV2RouteStop>;
  readonly totalStops: number;
  readonly searchValue: string;
  readonly density: MobileV2RouteDensity;
  readonly sortLabel: string;
  readonly groupLabel: string;
  readonly filterCount: number;
  readonly dirty: boolean;
  readonly currency: string;
  readonly mapAlerts: ReadonlyArray<MobileV2MapAlert>;
  readonly mapUpcoming: ReadonlyArray<MobileV2MapStop>;
  readonly mapActive: MobileV2MapStop;
  readonly mapRouteId: string;
  readonly mapPendingCount: number;
  readonly mapDistanceLeftKm: number;
} = {
  activeView: VIEWS[0]!,
  views: VIEWS,
  rows: STOPS,
  // Aligned to design canvas s-route artboard: 12-stop micro-route with
  // chip labels "Sort: Route" / "Group: No grouping".
  totalStops: 12,
  searchValue: "",
  density: "comfy",
  sortLabel: "Route",
  groupLabel: "No grouping",
  filterCount: 0,
  dirty: false,
  // COD chips render `<amount> ﷼` via `formatMobileV2CurrencyCompact`
  // (SAR → U+FDFC) — the canonical FieldOps Mobile V2 design symbol
  // (`flow-route.jsx` StopRow renders `{s.cod} ﷼`). No per-fixture
  // currency-word override; production cutover keeps the symbol
  // row-driven via `mobile_wallet_locale_policy`.
  currency: "SAR",
  // Aligned to design canvas s-map artboard: traffic warning + geofence
  // info chip pair (instead of weather chip) so pixel-diff compares the
  // same alert-chip set.
  mapAlerts: Object.freeze([
    Object.freeze({
      id: "a-traffic",
      text: "Heavy traffic · King Fahd Rd",
      icon: "alert" as const,
      tone: "warning" as const,
    }),
    Object.freeze({
      id: "a-geofence",
      text: "Geofence: Diplomatic Quarter",
      icon: "shield" as const,
      tone: "info" as const,
    }),
  ]),
  // Aligned to design canvas s-map artboard: trail of past+current stops
  // (1 Salem, 2 Layla, 3 Hessa) with active stop = stop 3 (Hessa Al-Saud,
  // "now"). Earlier mid-shift seq (17/21/26) had no design analogue and
  // dominated upcoming-carousel diff.
  mapUpcoming: Object.freeze([
    Object.freeze({
      id: "MX-2026-04421-001",
      seq: 1,
      customer: "Salem Al-Qahtani",
      address: "Al Olaya · 7821",
      sla: "09:30",
      etaMin: 0,
      distanceKm: -1.5,
      cod: 0,
    }),
    Object.freeze({
      id: "MX-2026-04421-002",
      seq: 2,
      customer: "Layla Boutique",
      address: "King Fahd Rd · 102",
      sla: "10:00",
      etaMin: 0,
      distanceKm: -2.4,
      cod: 1840,
    }),
    Object.freeze({
      id: "MX-2026-04421-003",
      seq: 3,
      customer: "Hessa Al-Saud",
      address: "Al Murooj · 4419 · Apt 12",
      sla: "11:30",
      etaMin: 0,
      distanceKm: 0,
      cod: 320,
    }),
  ]),
  mapActive: Object.freeze({
    id: "MX-2026-04421-003",
    seq: 3,
    customer: "Hessa Al-Saud",
    address: "Al Murooj · 4419 · Apt 12",
    sla: "11:30",
    etaMin: 0,
    distanceKm: 0.6,
    cod: 320,
  }),
  mapRouteId: "RT-2026-0502-A",
  mapPendingCount: 7,
  mapDistanceLeftKm: 38.4,
};
