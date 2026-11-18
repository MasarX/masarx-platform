// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-sheet-reassign artboard: 3 nearby driver
// candidates with DRV-21XX ids, distance + remaining stops + ETA delta.
// Production cutover replaces this with `mobile_reassign_candidates_v1`
// resolved against the stop's geo + active route fleet.

import type { MobileV2ReassignCandidate } from "../mobile-v2-sheet-reassign";

export const MOBILE_V2_PREVIEW_REASSIGN_CUSTOMER_NAME = "Salem Al-Qahtani";

export const MOBILE_V2_PREVIEW_REASSIGN_CANDIDATES: ReadonlyArray<MobileV2ReassignCandidate> =
  Object.freeze([
    Object.freeze({ id: "DRV-2102", name: "Hadeel Mansour", etaMin: 4, capacityLeft: 8, distanceKm: 1.4 }),
    Object.freeze({ id: "DRV-2118", name: "Yusuf Bin Saad", etaMin: 7, capacityLeft: 6, distanceKm: 2.1 }),
    Object.freeze({ id: "DRV-2055", name: "Tariq Al-Rashidi", etaMin: 9, capacityLeft: 11, distanceKm: 2.8 }),
  ]);
