// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2ChecklistItem } from "../mobile-v2-pre-shift-checklist-screen";

/**
 * 5 typical pre-shift checklist items — matches the design source
 * defaults from `flow-auth.jsx` ScrChecklist. In production these
 * arrive from the resolved policy (driver_safety_policy /
 * mobile_pre_shift_policy) with no hardcoding.
 */
export const MOBILE_V2_PREVIEW_CHECKLIST: ReadonlyArray<MobileV2ChecklistItem> =
  Object.freeze([
    Object.freeze({ id: "fuel", label: "Fuel ≥ ¼ tank", sub: "Or refuel before route start" }),
    Object.freeze({ id: "tires", label: "Tires + lights OK", sub: "Quick walk-around" }),
    Object.freeze({ id: "phone", label: "Phone charged > 70%", sub: "Use vehicle holder + cable" }),
    Object.freeze({
      id: "docs",
      label: "Iqama + license on hand",
      sub: "Required for high-value stops",
    }),
    Object.freeze({
      id: "cash",
      label: "COD float counted",
      sub: "Reconcile against expected ledger",
    }),
  ]);
