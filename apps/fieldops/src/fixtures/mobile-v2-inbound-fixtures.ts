// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Mirrors design source flow-network-extras.jsx ScrInbound expectations:
// trucks in stages in-transit/arrived/gate-out, with ETA in minutes
// (positive = future, 0 = now, negative = late). Dock label matches
// the design source ("Dock · Riyadh North · Bay D-1").

import type {
  MobileV2InboundTruck,
} from "../mobile-v2-inbound-dock-screen";

// Aligned to design canvas s-inbound artboard so pixel-diff compares
// like-for-like: 2 trucks (in-transit + arrived), short two-leg labels
// "Riyadh North → Jeddah Central" / "Riyadh South → Riyadh North", and
// human planner names (not "You"). The third gate-out truck and longer
// "Hub A → Hub West" two-word leg labels dominated diff with content
// that has no design analogue.
export const MOBILE_V2_PREVIEW_INBOUND_TRUCKS: ReadonlyArray<MobileV2InboundTruck> = Object.freeze([
  Object.freeze({
    id: "TRIP-9912",
    leg: "Riyadh North → Jeddah Central",
    vehicle: "TR-8821",
    driver: "Tariq Al-Rashidi",
    totalParcels: 412,
    sealNo: "SEAL-44102",
    stage: "in-transit" as const,
    stageLabel: "In transit",
    etaMin: 312,
    plannedArrive: "04:30",
  }),
  Object.freeze({
    id: "TRIP-9914",
    leg: "Riyadh South → Riyadh North",
    vehicle: "TR-2240",
    driver: "Saif Al-Mazrouei",
    totalParcels: 96,
    sealNo: "SEAL-44099",
    stage: "arrived" as const,
    stageLabel: "Arrived",
    etaMin: 0,
    plannedArrive: "13:15",
  }),
]);

export const MOBILE_V2_PREVIEW_INBOUND_DOCK = Object.freeze({
  dockLabel: "Dock · Riyadh North · Bay D-1",
  trucks: MOBILE_V2_PREVIEW_INBOUND_TRUCKS,
});
