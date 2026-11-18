// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import { formatMobileV2CurrencyCompact } from "../mobile-v2-ops-helpers";
import type { MobileV2StopDetail } from "../mobile-v2-stop-screen";

// COD amount/currency for this fixture stop. The proof-checklist `cod`
// label and the `cod` summary are both derived from these so the rial
// symbol (﷼) stays the single source — never a hardcoded `SAR` word.
const STOP_COD_AMOUNT = 320;
const STOP_COD_CURRENCY = "SAR";

// Aligned to design canvas s-stop artboard (Hessa Al-Saud / STP-003 /
// Stop 3 of 12, cod=320, otp required) so pixel-diff compares the same
// content state across both surfaces. Earlier values (Khalid Al-Hashimi
// / DLX-784521 / Stop 12 of 14) were a different demo state and
// dominated stop-detail's pixel-diff score with content drift rather
// than parity gaps.
export const MOBILE_V2_PREVIEW_STOP: MobileV2StopDetail = Object.freeze({
  id: "STP-003",
  seq: 3,
  customerInitials: "HA",
  customerName: "Hessa Al-Saud",
  customerPhone: "+966 55 ••• 0012",
  trackingCode: "STP-003",
  stopType: "delivery" as const,
  hazards: Object.freeze([
    // COD hazard chip renders `Collect <amount> ﷼` — the canonical
    // FieldOps Mobile V2 design symbol (`flow-route.jsx` ScrStopDetail
    // hazard ribbon renders `Collect {s.cod} ﷼`). Production cutover
    // resolves this label via `mobile_wallet_locale_policy`.
    Object.freeze({ label: "Collect 320 ﷼", tone: "accent" as const, icon: "shield" as const }),
    Object.freeze({ label: "OTP required", tone: "info" as const, icon: "shield" as const }),
  ]),
  etaMinutes: 0,
  distanceKm: 0,
  window: "11:30",
  addressLines: Object.freeze([
    "Al Murooj · 4419 · Apt 12",
  ]),
  addressNote: "Apt 12, 3rd floor — no elevator",
  // Aligned to design canvas ScrStopDetail parcel rows: each row shows
  // a service-class + weight sub-line beneath the code, and the section
  // header right side renders an aggregate "2× · 2.1 kg" label.
  parcels: Object.freeze([
    Object.freeze({
      id: "p-1",
      code: "MX-003-01",
      status: "pending" as const,
      description: "Standard · ~1.2 kg",
    }),
    Object.freeze({
      id: "p-2",
      code: "MX-003-02",
      status: "pending" as const,
      description: "Standard · ~0.9 kg",
    }),
  ]),
  parcelsTotalLabel: "2× · 2.1 kg",
  proofChecklist: Object.freeze([
    Object.freeze({ key: "scan", label: "Scan all parcels", status: "pending" as const }),
    Object.freeze({ key: "photo", label: "Capture photo at door", status: "pending" as const }),
    Object.freeze({ key: "sig", label: "Recipient signature", status: "pending" as const }),
    Object.freeze({ key: "otp", label: "OTP verification", status: "pending" as const }),
    // Design ScrStopDetail proof config (flow-route.jsx:402):
    // `Collect ${s.cod} ﷼ cash/card`. The amount + rial symbol (﷼) are
    // derived via formatMobileV2CurrencyCompact — no hardcoded `SAR`.
    Object.freeze({
      key: "cod",
      label: `Collect ${formatMobileV2CurrencyCompact(STOP_COD_AMOUNT, STOP_COD_CURRENCY)} cash/card`,
      status: "pending" as const,
    }),
  ]),
  timeline: Object.freeze([
    Object.freeze({ id: "t-1", label: "Order created", time: "09:12", icon: "check" as const, tone: "neutral" as const }),
    Object.freeze({ id: "t-2", label: "Picked from hub · Riyadh North", time: "09:28", icon: "check" as const, tone: "neutral" as const }),
    Object.freeze({ id: "t-3", label: "Out for delivery", time: "10:04", icon: "navigate" as const, tone: "neutral" as const }),
    Object.freeze({ id: "t-4", label: "Arriving now", time: "ETA", icon: "alert" as const, tone: "accent" as const }),
  ]),
  cod: Object.freeze({ amount: STOP_COD_AMOUNT, currency: STOP_COD_CURRENCY }),
} as MobileV2StopDetail);

export type StopParcelStatus = "pending" | "scanned" | "missing" | "damaged";
export type StopProofStatus = "pending" | "done";

export const MOBILE_V2_PREVIEW_STOP_PARCELS: ReadonlyArray<{
  id: string;
  code: string;
  status: StopParcelStatus;
}> = Object.freeze([
  { id: "p-1", code: "MX-003-01", status: "pending" },
  { id: "p-2", code: "MX-003-02", status: "pending" },
]);

export const MOBILE_V2_PREVIEW_STOP_PROOF: ReadonlyArray<{
  key: string;
  label: string;
  status: StopProofStatus;
}> = Object.freeze([
  { key: "scan", label: "Scan all parcels", status: "pending" },
  { key: "photo", label: "Capture photo at door", status: "pending" },
  { key: "sig", label: "Recipient signature", status: "pending" },
  { key: "otp", label: "OTP verification", status: "pending" },
  // Rial symbol (﷼) derived via the shared formatter — no hardcoded
  // `SAR` word. Matches MOBILE_V2_PREVIEW_STOP.proofChecklist's `cod`.
  {
    key: "cod",
    label: `Collect ${formatMobileV2CurrencyCompact(STOP_COD_AMOUNT, STOP_COD_CURRENCY)} cash/card`,
    status: "pending",
  },
]);
