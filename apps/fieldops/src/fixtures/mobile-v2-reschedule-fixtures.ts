// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-sheet-reschedule artboard: 4 suggested
// windows with "Today/Tomorrow/Day after" vocabulary + hh:mm format.
// First window is `good` fit with the historical-reachability reason
// rendered as green sub-line (matching design). Production cutover
// replaces this with `mobile_reschedule_suggest_v1` policy resolver.

import type { MobileV2RescheduleWindow } from "../mobile-v2-sheet-reschedule";

export const MOBILE_V2_PREVIEW_RESCHEDULE_CUSTOMER_NAME = "Salem Al-Qahtani";

export const MOBILE_V2_PREVIEW_RESCHEDULE_WINDOWS: ReadonlyArray<MobileV2RescheduleWindow> =
  Object.freeze([
    Object.freeze({
      id: "w-today-15-17",
      label: "Today · 15:00–17:00",
      startIso: "2026-05-13T15:00:00Z",
      endIso: "2026-05-13T17:00:00Z",
      fit: "good" as const,
      recommendedReason: "Recommended · customer was home last week at this hour",
    }),
    Object.freeze({
      id: "w-tomorrow-09-12",
      label: "Tomorrow · 09:00–12:00",
      startIso: "2026-05-14T09:00:00Z",
      endIso: "2026-05-14T12:00:00Z",
      fit: "ok" as const,
    }),
    Object.freeze({
      id: "w-tomorrow-14-17",
      label: "Tomorrow · 14:00–17:00",
      startIso: "2026-05-14T14:00:00Z",
      endIso: "2026-05-14T17:00:00Z",
      fit: "ok" as const,
    }),
    Object.freeze({
      id: "w-day-after-09-12",
      label: "Day after · 09:00–12:00",
      startIso: "2026-05-15T09:00:00Z",
      endIso: "2026-05-15T12:00:00Z",
      fit: "ok" as const,
    }),
  ]);
