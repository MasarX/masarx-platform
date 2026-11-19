// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2Pickup } from "../mobile-v2-pickups-screen";

export const MOBILE_V2_PREVIEW_PICKUPS: ReadonlyArray<MobileV2Pickup> = Object.freeze([
  Object.freeze({
    id: "PCK-7741",
    wb: "WB-RYD-7741",
    merchant: "Layla Boutique",
    address: "King Fahd Rd · 102",
    area: "Olaya",
    window: "10:00–12:00",
    instructions: "Reception · ask for Hala",
    expectedQty: 8,
    picked: 0,
    status: "pending" as const,
    priority: "high" as const,
    sealRequired: true,
  }),
  Object.freeze({
    id: "PCK-7742",
    wb: "WB-RYD-7742",
    merchant: "Najd Coffee Co.",
    address: "Al Wurud · Plaza 2",
    area: "Wurud",
    window: "12:00–14:00",
    instructions: "Side dock after 12:00",
    expectedQty: 24,
    picked: 0,
    status: "pending" as const,
    priority: "normal" as const,
    sealRequired: true,
  }),
  Object.freeze({
    // Aligned to design canvas s-pickups artboard: Industrial-3 dock
    // entry copy, 14:00-16:00 window, instructions "Loading dock entry".
    id: "PCK-7743",
    wb: "WB-RYD-7743",
    merchant: "Faisal Trading",
    address: "Industrial 3 · Bay 9",
    area: "Industrial",
    window: "14:00–16:00",
    instructions: "Loading dock entry",
    expectedQty: 12,
    picked: 0,
    status: "pending" as const,
    priority: "normal" as const,
    sealRequired: false,
  }),
  Object.freeze({
    // Promoted to high priority so the Pickups filter ribbon reads
    // "Priority · 2" matching design (PCK-7741 + PCK-7740). The visible
    // card stays under the Done filter and is not affected by the chip
    // render on the Pending list.
    id: "PCK-7740",
    wb: "WB-RYD-7740",
    merchant: "Dar Alarab",
    address: "Diplomatic Quarter · gate 4",
    area: "DQ",
    window: "09:00–10:30",
    instructions: "Sealed",
    expectedQty: 6,
    picked: 6,
    status: "completed" as const,
    priority: "high" as const,
    sealRequired: true,
  }),
]);
