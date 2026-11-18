// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2RiderTicket } from "../mobile-v2-rider-today-screen";

const ACTIVE: MobileV2RiderTicket = Object.freeze({
  id: "TK-7741",
  kind: "food" as const,
  vendor: "Najd Coffee",
  pickup: "Olaya Mall G-12",
  drop: "Wurud · 226",
  payout: 18,
  etaMin: 8,
  status: "active" as const,
  cod: 0,
});

const UPCOMING: ReadonlyArray<MobileV2RiderTicket> = Object.freeze([
  Object.freeze({
    id: "TK-7742",
    kind: "pharmacy" as const,
    vendor: "Tahani RX",
    pickup: "Al Olaya 7821",
    drop: "Murooj 4419",
    payout: 24,
    etaMin: 14,
    status: "queued" as const,
    cod: 120,
  }),
  Object.freeze({
    id: "TK-7743",
    kind: "parcel" as const,
    vendor: "MasarX SDD",
    pickup: "HUB-RYD-01",
    drop: "Sulaymaniah",
    payout: 32,
    etaMin: 22,
    status: "queued" as const,
    cod: 0,
  }),
]);

export const MOBILE_V2_PREVIEW_RIDER_TODAY: {
  readonly greetingName: string;
  readonly employeeId: string;
  readonly online: boolean;
  readonly earningsToday: number;
  readonly tripsCompleted: number;
  readonly rating: number;
  readonly shiftDuration: string;
  readonly currency: string;
  readonly active: MobileV2RiderTicket;
  readonly upcoming: ReadonlyArray<MobileV2RiderTicket>;
} = Object.freeze({
  // Match the design canvas s-rider-today artboard so pixel-diff
  // compares like-for-like ("Hello, Omar" + bike DRV-2041 sub-line).
  greetingName: "Omar",
  employeeId: "DRV-2041",
  online: true,
  earningsToday: 184,
  tripsCompleted: 12,
  rating: 4.9,
  shiftDuration: "5h 12m",
  // Earnings render `<value> ﷼` via `formatMobileV2CurrencyCompact`
  // (SAR → U+FDFC) — the canonical FieldOps Mobile V2 design symbol.
  // No per-fixture currency-word override; production cutover keeps
  // the symbol row-driven via `mobile_wallet_locale_policy`.
  currency: "SAR",
  active: ACTIVE,
  upcoming: UPCOMING,
});
