// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2HoldItem } from "../mobile-v2-hold-queue-screen";

/** Timestamps computed at module load so the "Nm on hold" ribbon stays
 * fresh on every reload. In production these arrive as epoch ms from
 * `public.resolve_fieldops_hold_v1`. */
export function buildMobileV2PreviewHold(): ReadonlyArray<MobileV2HoldItem> {
  return Object.freeze([
    Object.freeze({
      id: "h-1",
      parcel: "DLX-784512",
      reason: "addr" as const,
      note: "GPS resolves to wrong building; courier needs revised pin from CS.",
      atMs: Date.now() - 22 * 60 * 1000,
    }),
    Object.freeze({
      id: "h-2",
      parcel: "DLX-784516",
      reason: "damage" as const,
      note: "Outer carton crushed; inner items appear intact.",
      atMs: Date.now() - 41 * 60 * 1000,
    }),
    Object.freeze({
      id: "h-3",
      parcel: "DLX-784520",
      reason: "wrong_route" as const,
      note: "Sorted to JED, belongs to RUH south route.",
      atMs: Date.now() - 8 * 60 * 1000,
    }),
  ]);
}
