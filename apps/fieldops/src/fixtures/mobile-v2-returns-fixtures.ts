// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2ReturnsRtoStop,
  MobileV2ReturnsStop,
} from "../mobile-v2-returns-screen";

export const MOBILE_V2_PREVIEW_RETURNS: {
  readonly failed: ReadonlyArray<MobileV2ReturnsStop>;
  readonly returned: ReadonlyArray<MobileV2ReturnsRtoStop>;
  readonly codCollected: number;
  readonly currency: string;
} = Object.freeze({
  failed: Object.freeze([
    Object.freeze({
      id: "stop-rf-1",
      seq: 12,
      customer: "Mona Saleh",
      addr: "Al Yasmin · Ring Rd 4421",
      parcels: 2,
      failReason: "Customer unreachable",
    }),
    Object.freeze({
      id: "stop-rf-2",
      seq: 18,
      customer: "Eastern Mart",
      addr: "Al Naseem · Block 9",
      parcels: 5,
      failReason: "Address not found",
    }),
  ]),
  returned: Object.freeze([
    Object.freeze({ id: "RTO-9919", customer: "Returns Desk", parcels: 1 }),
  ]),
  codCollected: 1240,
  currency: "SAR",
});
