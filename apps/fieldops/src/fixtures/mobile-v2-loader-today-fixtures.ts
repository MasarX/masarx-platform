// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Mirrors the design source flow-loader.jsx ScrLoaderToday wave: 9
// parcels split across 4 destinations (5 scanned, 4 pending), 3 cold,
// 3 drivers (Omar Al-Saadi loading 88%, Rashid Hamad loading 42%,
// Yousef Khalid waiting 0%).

import type {
  MobileV2LoaderDriverQueueEntry,
  MobileV2LoaderQuickAction,
} from "../mobile-v2-loader-today-screen";

export const MOBILE_V2_PREVIEW_LOADER_TODAY_QUICK_ACTIONS: ReadonlyArray<MobileV2LoaderQuickAction> =
  Object.freeze([
    Object.freeze({ id: "loader-scan", icon: "scan", label: "Scan-out", sub: "4 pending" }),
    // Quick-action sub-line copy aligned to design canvas s-loader-today
    // artboard ("9 parcels · 3 routes" / "3 parcels" hold queue).
    Object.freeze({ id: "loader-manifest", icon: "list", label: "Manifest", sub: "9 parcels · 3 routes" }),
    Object.freeze({ id: "bay-board", icon: "package", label: "Bay board", sub: "Driver queue · cages" }),
    Object.freeze({ id: "inbound", icon: "truck", label: "Inbound dock", sub: "3 arriving" }),
    Object.freeze({ id: "hold", icon: "flag", label: "Hold queue", sub: "3 parcels" }),
    Object.freeze({ id: "sync", icon: "cloud-up", label: "Sync", sub: "0 pending" }),
  ]);

export const MOBILE_V2_PREVIEW_LOADER_TODAY_DRIVERS: ReadonlyArray<MobileV2LoaderDriverQueueEntry> =
  Object.freeze([
    Object.freeze({ name: "Omar Al-Saadi", route: "RT-2026-0502-A", pct: 88, status: "loading" as const }),
    Object.freeze({ name: "Rashid Hamad", route: "RT-2026-0502-B", pct: 42, status: "loading" as const }),
    Object.freeze({ name: "Yousef Khalid", route: "RT-2026-0502-C", pct: 0, status: "waiting" as const }),
  ]);

export const MOBILE_V2_PREVIEW_LOADER_TODAY = Object.freeze({
  // Loader display name — design canvas s-loader-today renders the
  // app-bar title "Hello, Omar". The production resolver resolves this
  // from the loader's profile (users.full_name first token).
  greetingName: "Omar",
  activeOpsSessionId: "",
  // E6: wave/bay/route/cut-off describe the loader's active wave
  // assignment. There is NO canonical loader-wave source table yet, so
  // `resolve_fieldops_loader_today_v1` honestly returns these as NULL —
  // the loader hook degrades them to neutral empty strings in the
  // production native shell. These literals are SHOWCASE/OFFLINE-ONLY
  // sample copy (preview mode `?v2=preview`) and are NEVER presented as
  // live loader-session data. When a loader-wave table ships, the
  // resolver populates these and the hook passes them through.
  waveLabel: "Bay B · Wave 3 · 06:40",
  bay: "B-04",
  routeLabel: "RT-2026-0502-A",
  cutOff: "07:30",
  coldChainCount: 3,
  liveRoutes: 3,
  totalParcels: 9,
  scannedParcels: 5,
  driversWaiting: 3,
  quickActions: MOBILE_V2_PREVIEW_LOADER_TODAY_QUICK_ACTIONS,
  drivers: MOBILE_V2_PREVIEW_LOADER_TODAY_DRIVERS,
});
