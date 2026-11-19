// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-bay-detail artboard: early-shift induction
// snapshot for Bay A (Al Olaya · North, RT-2026-0502-A) with 42 of 80
// slots inducted (53%, 38 remaining) and a single recent induction
// (PCL-441020 · Al Olaya · 7821 · 22s ago). Cross-references the
// loader-today driver assignment "RT-2026-0502-A" so the planning
// snapshot stays internally consistent.

import type { MobileV2BayDetailInduction } from "../mobile-v2-bay-detail-screen";

export const MOBILE_V2_PREVIEW_BAY_DETAIL_INDUCTIONS: ReadonlyArray<MobileV2BayDetailInduction> =
  Object.freeze([
    Object.freeze({ id: "ind-1", parcel: "PCL-441020", dest: "Al Olaya · 7821", ageMs: 22000 }),
  ]);

export const MOBILE_V2_PREVIEW_BAY_DETAIL = Object.freeze({
  bayId: "A",
  bayLabel: "Olaya · North",
  routeId: "RT-2026-0502-A",
  transfer: false,
  exception: false,
  count: 42,
  capacity: 80,
  recent: MOBILE_V2_PREVIEW_BAY_DETAIL_INDUCTIONS,
});
