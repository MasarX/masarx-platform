// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2Trip } from "../mobile-v2-trips-screen";

export const MOBILE_V2_PREVIEW_TRIPS: ReadonlyArray<MobileV2Trip> = Object.freeze([
  // Demo-parity: TRIP-9913 mirrors the design source's primary trip
  // (flow-network app-store.jsx) — Riyadh North → Dammam East,
  // vehicle TR-8842, assigned stage, 188 parcels, 395km, planned
  // 13:30→18:00. Used to verify Trip Detail against reference
  // 01-start.png.
  Object.freeze({
    id: "TRIP-9913",
    leg: "Riyadh North → Dammam East",
    driver: "You",
    vehicle: "TR-8842",
    stage: "assigned" as const,
    origin: Object.freeze({ id: "HUB-RYD-01", name: "Riyadh North" }),
    dest: Object.freeze({ id: "HUB-DMM-01", name: "Dammam East" }),
    plannedDepart: "13:30",
    plannedArrive: "18:00",
    etaMin: null,
    distance: 395,
    totalParcels: 188,
    scanned: 0,
    sealNo: null,
    manifest: Object.freeze([Object.freeze({ wb: "MAN-RYD-D-1", count: 188 })]),
  }),
  // Demo-parity: NETWORK · ALL HUBS section, second-visible card.
  // Mirrors design canvas s-trips artboard TRIP-9912 — In transit,
  // Riyadh North → Jeddah Central, vehicle TR-8821, parcels 412/412,
  // SEAL-44102, 18:00 → 04:30 plan, ETA 5h 12m (312 min). Driver !=
  // "You" so the screen routes this into NETWORK · ALL HUBS rather
  // than MY TRIP.
  Object.freeze({
    id: "TRIP-9912",
    leg: "Riyadh North → Jeddah Central",
    driver: "Faisal Al-Otaibi",
    vehicle: "TR-8821",
    stage: "in-transit" as const,
    origin: Object.freeze({ id: "HUB-RYD-01", name: "Riyadh North" }),
    dest: Object.freeze({ id: "HUB-JED-01", name: "Jeddah Central" }),
    plannedDepart: "18:00",
    plannedArrive: "04:30",
    etaMin: 312,
    distance: 949,
    totalParcels: 412,
    scanned: 412,
    sealNo: "SEAL-44102",
    manifest: Object.freeze([
      Object.freeze({ wb: "WB-JED-7821", count: 220 }),
      Object.freeze({ wb: "WB-JED-7822", count: 192 }),
    ]),
  }),
  // Demo-parity: NETWORK · ALL HUBS section, third-visible card.
  // Mirrors design canvas s-trips artboard TRIP-9914 — Arrived stage,
  // Dammam → Riyadh return leg. Only the top of this card peeks above
  // the bottom-tab strip in the 380×780 artboard, so the leg label /
  // stage chip are the dominant per-pixel signal.
  Object.freeze({
    id: "TRIP-9914",
    leg: "Dammam East → Riyadh North",
    driver: "Hadi Al-Mansour",
    vehicle: "TR-7610",
    stage: "arrived" as const,
    origin: Object.freeze({ id: "HUB-DMM-01", name: "Dammam East" }),
    dest: Object.freeze({ id: "HUB-RYD-01", name: "Riyadh North" }),
    plannedDepart: "06:00",
    plannedArrive: "10:42",
    etaMin: 0,
    distance: 395,
    totalParcels: 280,
    scanned: 280,
    sealNo: "SEAL-44210",
    manifest: Object.freeze([Object.freeze({ wb: "WB-RYD-9101", count: 280 })]),
  }),
  Object.freeze({
    id: "TRIP-9905",
    leg: "Jeddah · Hub West → Riyadh · Hub A",
    driver: "Salim Q.",
    vehicle: "JED-1184",
    stage: "reconciled" as const,
    origin: Object.freeze({ id: "HUB-JED-W", name: "Jeddah · Hub West" }),
    dest: Object.freeze({ id: "HUB-RYD-A", name: "Riyadh · Hub A" }),
    plannedDepart: "yesterday 22:00",
    plannedArrive: "today 08:14",
    etaMin: 0,
    distance: 869,
    totalParcels: 980,
    scanned: 980,
    sealNo: "SEAL-43997",
    manifest: Object.freeze([Object.freeze({ wb: "WB-RYD-9001", count: 980 })]),
  }),
]);
