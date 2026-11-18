// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned with the design canvas s-cod artboard: 7 cash stops on the
// route, all in `pending` state, totals 0 collected / 4,300 expected /
// 0 variance. Stop IDs use the design's `STP-NNN` short form and the
// route sequence numbers (`stop 2`, `stop 3`, ...) match the design
// canvas demo. Prior fixture seeded a mid-flow scenario (4 paid + 1
// pending) which diverged structurally from the design baseline used
// by the pixel-diff harness.

import type { MobileV2CodLedgerStop } from "../mobile-v2-cod-ledger-screen";

export const MOBILE_V2_PREVIEW_COD_LEDGER: {
  readonly collected: number;
  readonly expected: number;
  readonly currency: string;
  readonly stops: ReadonlyArray<MobileV2CodLedgerStop>;
} = Object.freeze({
  collected: 0,
  expected: 4300,
  // Amounts render `<value> ﷼` via `formatMobileV2CurrencyCompact`
  // (SAR → U+FDFC) — the canonical FieldOps Mobile V2 design symbol
  // (`flow-pod.jsx` ScrCOD renders `{s.cod.toLocaleString()} ﷼`). No
  // per-fixture currency-word override; production cutover keeps the
  // symbol row-driven via `mobile_wallet_locale_policy`.
  currency: "SAR",
  stops: Object.freeze([
    Object.freeze({
      id: "STP-002",
      seq: 2,
      customer: "Layla Boutique",
      amount: 1840,
      state: "pending" as const,
    }),
    Object.freeze({
      id: "STP-003",
      seq: 3,
      customer: "Hessa Al-Saud",
      amount: 320,
      state: "pending" as const,
    }),
    Object.freeze({
      id: "STP-005",
      seq: 5,
      customer: "Khalid Al-Otaibi",
      amount: 210,
      state: "pending" as const,
    }),
    Object.freeze({
      id: "STP-006",
      seq: 6,
      customer: "Reem Al-Mutairi",
      amount: 95,
      state: "pending" as const,
    }),
    Object.freeze({
      id: "STP-009",
      seq: 9,
      customer: "Ibrahim Al-Dosari",
      amount: 540,
      state: "pending" as const,
    }),
    Object.freeze({
      id: "STP-010",
      seq: 10,
      customer: "Najd Coffee Co.",
      amount: 1220,
      state: "pending" as const,
    }),
    Object.freeze({
      id: "STP-012",
      seq: 12,
      customer: "Mona Bint Saad",
      amount: 75,
      state: "pending" as const,
    }),
  ]),
});
