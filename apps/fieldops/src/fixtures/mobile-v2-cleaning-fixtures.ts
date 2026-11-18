// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2CleaningItem } from "../mobile-v2-cleaning-screen";

export const MOBILE_V2_PREVIEW_CLEANING_ITEMS: ReadonlyArray<MobileV2CleaningItem> =
  Object.freeze([
    Object.freeze({
      id: "cabin",
      label: "Cabin wiped & vacuumed",
      sub: "Dashboard, seats, floor mats",
    }),
    Object.freeze({
      id: "cargo",
      label: "Cargo bay swept & sanitised",
      sub: "Especially after cold-chain or food",
    }),
    Object.freeze({
      id: "glass",
      label: "Windscreen + mirrors clear",
      sub: "Inside and out",
    }),
    Object.freeze({
      id: "odour",
      label: "No odour or food waste",
      sub: "Critical for pharmacy & retail stops",
    }),
    Object.freeze({
      id: "plate",
      label: "Plate visible · no mud",
      sub: "ANPR at fulfilment gates fails on dirty plates",
    }),
  ]);

export const MOBILE_V2_PREVIEW_CLEANING: {
  readonly items: ReadonlyArray<MobileV2CleaningItem>;
  readonly checkedIds: ReadonlyArray<string>;
  readonly photoCaptured: boolean;
  readonly photoStamp: string;
} = Object.freeze({
  items: MOBILE_V2_PREVIEW_CLEANING_ITEMS,
  checkedIds: Object.freeze([]),
  photoCaptured: false,
  photoStamp: "2026-05-02 · 06:42 · 24.71°N 46.67°E",
});
