// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-sheet-damage-hold artboard. Design surfaces
// damage CATEGORIES (Crushed / Wet / Open tamper / Wrong label / Missing
// barcode), not the original severity ladder. Each category carries an
// underlying color tone so the CTA gate / readiness helper continues to
// work unchanged — danger-colored categories still trigger the red CTA.
// Production cutover replaces this with the
// `mobile_damage_severity_policy` resolver output.

import {
  MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES,
} from "../mobile-v2-damage-hold-policy";
import type { MobileV2DamageSeverity } from "../mobile-v2-sheet-damage-hold";

export const MOBILE_V2_PREVIEW_DAMAGE_PARCEL_ID = "PCL-440117";

export const MOBILE_V2_PREVIEW_DAMAGE_CATEGORIES: ReadonlyArray<MobileV2DamageSeverity> =
  MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES;
