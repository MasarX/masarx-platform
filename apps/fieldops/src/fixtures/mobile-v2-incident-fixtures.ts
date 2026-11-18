// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-sheet-incident artboard: six-row incident
// type registry with severity-aware iconography and required-artefact
// chips (photo · geo · statement · call_112 · call_999). The production
// cutover replaces this with `resolve_incident_type_registry_v1` from
// the policy ladder; the sheet itself is pure presentation and stays
// driven by the resolved list.

import type {
  MobileV2IncidentNeed,
  MobileV2IncidentType,
} from "../mobile-v2-sheet-incident";

export const MOBILE_V2_PREVIEW_INCIDENT_TYPES: ReadonlyArray<MobileV2IncidentType> =
  Object.freeze([
    Object.freeze({
      id: "collision",
      label: "Vehicle collision",
      icon: "alert" as const,
      severity: "high" as const,
      needs: Object.freeze<MobileV2IncidentNeed[]>(["photo", "geo", "statement"]),
    }),
    Object.freeze({
      id: "medical",
      label: "Medical emergency",
      // Aligned to design canvas ScrIncident (app-store.jsx incidents.types[1]):
      // medical type uses the dedicated `cross` (medical cross) icon.
      // Earlier `info` was a substitute when `cross` wasn't in the
      // catalog; added 2026-05-13 in `mobile-v2-icon-specs.ts`.
      icon: "cross" as const,
      severity: "high" as const,
      needs: Object.freeze<MobileV2IncidentNeed[]>(["call_112"]),
    }),
    Object.freeze({
      id: "theft",
      label: "Theft / robbery",
      icon: "shield" as const,
      severity: "high" as const,
      needs: Object.freeze<MobileV2IncidentNeed[]>(["call_999", "statement"]),
    }),
    Object.freeze({
      id: "damage",
      label: "Vehicle damage (no incident)",
      icon: "truck" as const,
      severity: "med" as const,
      needs: Object.freeze<MobileV2IncidentNeed[]>(["photo"]),
    }),
    Object.freeze({
      id: "complaint",
      label: "Customer complaint",
      icon: "flag" as const,
      severity: "low" as const,
      needs: Object.freeze<MobileV2IncidentNeed[]>(["statement"]),
    }),
    Object.freeze({
      id: "breakdown",
      label: "Vehicle breakdown",
      // Aligned to design canvas ScrIncident (app-store.jsx incidents.types[5]):
      // breakdown type uses the dedicated `wrench` icon, not `truck`
      // (which clashes visually with the `damage` row above). Added
      // 2026-05-13 in `mobile-v2-icon-specs.ts`.
      icon: "wrench" as const,
      severity: "med" as const,
      needs: Object.freeze<MobileV2IncidentNeed[]>(["geo"]),
    }),
  ]);
