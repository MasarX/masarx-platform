// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-sheet-transfer artboard. Design shows the
// inter-HUB destination picker (outbound to another hub) with three
// hubs and ETA sub-lines, not the legacy inter-BAY parcel selector.
// Both shapes are exported so the production cutover can switch which
// `mode` the orchestrator binds to (`mobile_loader_transfer_v1` hub list
// for inter-hub; bay/parcel resolvers for inter-bay).

import type {
  MobileV2TransferBay,
  MobileV2TransferHub,
  MobileV2TransferParcel,
} from "../mobile-v2-sheet-transfer";

// Inter-hub (design canvas)
export const MOBILE_V2_PREVIEW_TRANSFER_HUBS: ReadonlyArray<MobileV2TransferHub> =
  Object.freeze([
    Object.freeze({ id: "ryd", name: "Riyadh South", code: "HUB-RYD-02", etaLabel: "ETA 2h 15m" }),
    Object.freeze({ id: "jed", name: "Jeddah Central", code: "HUB-JED-01", etaLabel: "ETA 9h 30m" }),
    Object.freeze({ id: "dmm", name: "Dammam Main", code: "HUB-DMM-01", etaLabel: "ETA 4h 40m" }),
  ]);

// Inter-bay (legacy, preserved for production fallback)
export const MOBILE_V2_PREVIEW_TRANSFER_PARCELS: ReadonlyArray<MobileV2TransferParcel> =
  Object.freeze([
    Object.freeze({ id: "p-1", sku: "SKU-9921", dest: "RT-OL-08" }),
    Object.freeze({ id: "p-2", sku: "SKU-7711", dest: "RT-OL-09" }),
    Object.freeze({ id: "p-3", sku: "SKU-3308", dest: "RT-OL-10" }),
  ]);

export const MOBILE_V2_PREVIEW_TRANSFER_BAYS: ReadonlyArray<MobileV2TransferBay> =
  Object.freeze([
    Object.freeze({ id: "B", label: "Bay B" }),
    Object.freeze({ id: "C", label: "Bay C" }),
    Object.freeze({ id: "D", label: "Bay D" }),
  ]);
