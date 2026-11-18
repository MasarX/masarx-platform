// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2EorChecklistItem,
  MobileV2EorSummary,
} from "../mobile-v2-eor-screen";

export const MOBILE_V2_PREVIEW_EOR: {
  readonly summary: MobileV2EorSummary;
  readonly checklist: ReadonlyArray<MobileV2EorChecklistItem>;
  readonly performanceNote: string | null;
  readonly routeLabel: string;
  readonly recon: {
    readonly parcelsCount: number;
    readonly mismatchCount: number;
    readonly cashDeclared: number;
    readonly cashCounted: number;
    readonly walletStatus: string;
  };
  readonly lastRecon: null;
} = {
  summary: Object.freeze({ delivered: 28, total: 42, failed: 3 }),
  // SHOWCASE-ONLY route id for the EOR app-bar subtitle. The production
  // hook reads `routeLabel` from resolve_fieldops_eor_v1; this literal is
  // reached only via the `?v2=preview` showcase / offline fallback.
  routeLabel: "RT-2026-0502-A",
  // SHOWCASE-ONLY end-of-day reconciliation seed: 42 parcels handled, 0
  // mismatches, 1,240 SAR COD declared+counted, wallet synced. The production
  // hook reads `recon` from resolve_fieldops_eor_v1; this object is reached
  // only via preview mode and is never submitted as a live reconciliation.
  recon: Object.freeze({
    parcelsCount: 42,
    mismatchCount: 0,
    cashDeclared: 1240,
    cashCounted: 1240,
    walletStatus: "synced",
  }),
  lastRecon: null,
  checklist: Object.freeze([
    Object.freeze({
      id: "parcels",
      icon: "package" as const,
      label: "Returned undelivered parcels",
      sub: "14 parcels in vehicle",
    }),
    Object.freeze({
      id: "cash",
      icon: "cash" as const,
      label: "Hand over COD cash",
      sub: "1,240 ﷼ collected",
    }),
    Object.freeze({
      id: "devices",
      icon: "shield" as const,
      label: "Plug in handheld + scanner",
      sub: "Battery report uploaded",
    }),
    Object.freeze({
      id: "sync",
      icon: "cloud-up" as const,
      label: "Final sync",
      sub: "3 writes pending",
    }),
  ]),
  performanceNote:
    "You're 12% above team average for on-time delivery this week.",
};
