// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Mirrors design source flow-loader.jsx ScrBayBoard: 5 bays (A free,
// B loading 88% Omar Al-Saadi, C loading 42% Rashid Hamad, D waiting
// Yousef Khalid, E maintenance cleaning crew).

import type { MobileV2BayEntry } from "../mobile-v2-bay-board-screen";

export const MOBILE_V2_PREVIEW_BAY_BOARD: ReadonlyArray<MobileV2BayEntry> = Object.freeze([
  Object.freeze({ id: "A", driver: "—", route: null, status: "free" as const, pct: 0 }),
  Object.freeze({ id: "B", driver: "Omar Al-Saadi", route: "RT-…0502-A", status: "loading" as const, pct: 88 }),
  Object.freeze({ id: "C", driver: "Rashid Hamad", route: "RT-…0502-B", status: "loading" as const, pct: 42 }),
  Object.freeze({ id: "D", driver: "Yousef Khalid", route: "RT-…0502-C", status: "waiting" as const, pct: 0 }),
  Object.freeze({ id: "E", driver: "Cleaning crew", route: null, status: "maint" as const, pct: 0 }),
]);
