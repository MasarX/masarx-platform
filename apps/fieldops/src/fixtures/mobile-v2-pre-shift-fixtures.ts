// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-pre-shift-gate artboard: pre-shift blocker
// snapshot for shift RT-2026-0502-A · 12 stops (cross-references the
// loader-today / bay-detail driver assignment so the planning snapshot
// stays internally consistent).
//
// Blocker order matches the design: photos card first, then cleaning
// card. A synthetic "health" blocker is included so the remaining-step
// counter ("3 steps remaining") reflects unconfirmed fit-to-drive
// attestation; the screen filters it out and renders health inline.

import type {
  MobileV2PreShiftBlocker,
  MobileV2PreShiftCadenceSummary,
} from "../mobile-v2-pre-shift-gate-screen";

export const MOBILE_V2_PREVIEW_PRE_SHIFT_BLOCKERS: ReadonlyArray<MobileV2PreShiftBlocker> =
  Object.freeze([
    Object.freeze({
      id: "photos",
      icon: "camera" as const,
      title: "Refresh vehicle photos",
      sub: "Last set is 8d old · refresh weekly",
      cta: "Take 4 fresh photos",
      severity: "med" as const,
      route: "kyc-vehicle-photos",
    }),
    Object.freeze({
      id: "cleaning",
      icon: "sparkle" as const,
      title: "Daily cleaning check",
      sub: "Required before first stop",
      cta: "Log cleaning + photo",
      severity: "med" as const,
      route: "cleaning",
    }),
    // Synthetic health blocker — filtered out of the rendered list by
    // the screen (id === "health") but counted into "<n> steps remaining".
    Object.freeze({
      id: "health",
      icon: "shield" as const,
      title: "Fit-to-drive attestation",
      sub: "Confirm rested, hydrated, no alcohol or medication.",
      cta: "Confirm",
      severity: "med" as const,
      route: "pre-shift-gate",
    }),
  ]);

export const MOBILE_V2_PREVIEW_PRE_SHIFT_CADENCE: MobileV2PreShiftCadenceSummary =
  Object.freeze({
    photoCadenceDays: 7,
    cleaningCadenceLabel: "every shift",
    healthAttestation: true,
  });

export const MOBILE_V2_PREVIEW_PRE_SHIFT: {
  readonly shiftId: string;
  readonly stopCount: number;
  readonly blockers: ReadonlyArray<MobileV2PreShiftBlocker>;
  readonly cadence: MobileV2PreShiftCadenceSummary;
  readonly healthOk: boolean;
} = Object.freeze({
  shiftId: "RT-2026-0502-A",
  stopCount: 12,
  blockers: MOBILE_V2_PREVIEW_PRE_SHIFT_BLOCKERS,
  cadence: MOBILE_V2_PREVIEW_PRE_SHIFT_CADENCE,
  healthOk: false,
});
