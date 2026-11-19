// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2HubPickupQueueItem } from "../mobile-v2-hub-pickup-screen";

export const MOBILE_V2_PREVIEW_HUB_PICKUP: ReadonlyArray<MobileV2HubPickupQueueItem> = Object.freeze([
  Object.freeze({
    id: "HUB-CUST-1041",
    customer: "Faisal Aljohani",
    phone: "+966 50 ••• ••18",
    parcels: 2,
    codSar: 320,
    heldDays: 3,
    priority: "high" as const,
  }),
  Object.freeze({
    id: "HUB-CUST-1042",
    customer: "Ahmed Yassin",
    phone: "+966 55 ••• ••07",
    parcels: 1,
    codSar: 0,
    heldDays: 1,
    priority: "normal" as const,
  }),
  Object.freeze({
    id: "HUB-CUST-1043",
    customer: "Lina Saqr",
    phone: "+966 53 ••• ••91",
    parcels: 4,
    codSar: 540,
    heldDays: 2,
    priority: "normal" as const,
  }),
]);
