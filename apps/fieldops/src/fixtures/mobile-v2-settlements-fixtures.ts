// PREVIEW/DEV FIXTURE - DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2SettlementLedgerEnvelope } from "../mobile-v2-settlements-screen";

export const MOBILE_V2_PREVIEW_SETTLEMENTS: MobileV2SettlementLedgerEnvelope = Object.freeze({
  settlements: Object.freeze([
    Object.freeze({
      id: "preview-settlement-001",
      title: "Driver shift settlement",
      kind: "cod",
      scopeType: "driver_shift",
      status: "locked",
      expectedAmount: 1240,
      collectedAmount: 1225,
      remittedAmount: 1225,
      varianceAmount: -15,
      currency: "SAR",
      windowLabel: "Today",
      updatedAt: "2026-05-29T09:10:00.000Z",
    }),
  ]),
  summary: Object.freeze({
    count: 1,
    expectedAmount: 1240,
    collectedAmount: 1225,
    remittedAmount: 1225,
    varianceAmount: -15,
    currency: "SAR",
  }),
  readback: Object.freeze({
    source: "preview",
    count: 1,
    resolvedAt: "2026-05-29T09:10:00.000Z",
  }),
});
