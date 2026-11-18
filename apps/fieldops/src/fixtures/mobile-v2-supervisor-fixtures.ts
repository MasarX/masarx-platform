// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2SupervisorItem } from "../mobile-v2-supervisor-screen";

export const MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE: {
  readonly supervisorName: string;
  readonly queue: ReadonlyArray<MobileV2SupervisorItem>;
  readonly activeId: string;
} = Object.freeze({
  // Aligned to design canvas sh-supervisor (sv-q artboard): subtitle
  // reads "4 pending · Omar Al-Saadi" so the supervisorName + 4-item
  // queue must line up exactly. The four-item set matches the visible
  // approvals (COD variance / Route change / Fail re-attempt /
  // Incident review). Production cutover replaces this with
  // `supervisor_pending_queue_v1` resolver output.
  supervisorName: "Omar Al-Saadi",
  activeId: "sv-1",
  queue: Object.freeze([
    Object.freeze({
      id: "sv-1",
      kind: "cod_variance" as const,
      driver: "Omar Al-Saadi",
      ref: "RT-2026-0502-A",
      atMs: Date.now() - 9 * 60_000,
      detail: "Reported variance: SAR 120 short on shift cash drop",
    }),
    Object.freeze({
      id: "sv-2",
      kind: "route_change" as const,
      driver: "Tariq Al-Rashidi",
      ref: "DRV-2055 · RT-2026-0502-B",
      atMs: Date.now() - 15 * 60_000,
      detail:
        "Driver proposes swap of stops 12–14 to compress fuel + driving time.",
    }),
    Object.freeze({
      id: "sv-3",
      kind: "fail_reattempt" as const,
      driver: "Hadeel Mansour",
      ref: "DRV-2102 · MX-2026-04421-018",
      atMs: Date.now() - 32 * 60_000,
      detail:
        "Second failed attempt — customer requested rebook tomorrow AM window.",
    }),
    Object.freeze({
      id: "sv-4",
      kind: "incident" as const,
      driver: "Yusuf Bin Saad",
      ref: "DRV-2118 · INC-9412",
      atMs: Date.now() - 55 * 60_000,
      detail:
        "Minor scooter scrape against bollard at Olaya Mall G-12. No injury.",
    }),
  ]),
});
