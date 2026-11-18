// Pure ready/state-derivation helpers for the 6 inline action sheets
// whose primary CTA gates on multiple discriminated inputs. Extracting
// the logic here lets Jest cover every state transition without
// rendering React Native trees, and mirrors the inline derivation each
// sheet still computes today.
//
// Per the engineering audit: these helpers are the single source of
// truth for "is this sheet submittable" so a sheet refactor that
// changes the gating contract MUST update this file + its tests.

import type {
  MobileV2IncidentType,
} from "./mobile-v2-sheet-incident";
import type {
  MobileV2DamageSeverity,
} from "./mobile-v2-sheet-damage-hold";

/**
 * Minimum statement length for a high-or-medium-severity incident to be
 * submittable. Mirrors the inline `statement.trim().length > 5`.
 */
export const MOBILE_V2_INCIDENT_MIN_STATEMENT_LEN = 5;

/**
 * Minimum note length for a damage hold to be submittable. Mirrors the
 * inline `note.trim().length > 2`.
 */
export const MOBILE_V2_DAMAGE_HOLD_MIN_NOTE_LEN = 2;

// ---------------------------------------------------------------------------
// Incident sheet
// ---------------------------------------------------------------------------

export interface MobileV2IncidentReadinessInput {
  readonly types: ReadonlyArray<MobileV2IncidentType>;
  readonly selectedTypeId: string | null;
  readonly photoCaptured: boolean;
  readonly statement: string;
}

/**
 * `true` when the user has picked an incident type AND satisfied each
 * required artefact on that type (`needs` may include "photo" /
 * "statement"; call-* and other markers are dispatcher-driven and not
 * gates).
 */
export function isMobileV2IncidentReady(
  input: MobileV2IncidentReadinessInput,
): boolean {
  const picked = input.types.find((t) => t.id === input.selectedTypeId);
  if (picked === undefined) return false;
  const reqPhoto = picked.needs.includes("photo");
  const reqStatement = picked.needs.includes("statement");
  if (reqPhoto && !input.photoCaptured) return false;
  if (
    reqStatement
    && input.statement.trim().length <= MOBILE_V2_INCIDENT_MIN_STATEMENT_LEN
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Damage hold sheet
// ---------------------------------------------------------------------------

export interface MobileV2DamageHoldReadinessInput {
  readonly severities: ReadonlyArray<MobileV2DamageSeverity>;
  readonly selectedSeverityId: string | null;
  readonly note: string;
  readonly photoCaptured: boolean;
  /**
   * When false, the free-text note is treated as optional and does not
   * gate the primary CTA. Defaults true (legacy contract — note required).
   * Mirrors the sheet's `showNote` prop so design-parity flows that hide
   * the note field don't get stuck in soft state.
   */
  readonly noteRequired?: boolean;
}

/**
 * `true` when the user has picked a severity AND captured the
 * mandatory photo AND (when required) written a sufficient note. Note
 * threshold mirrors the inline `note.trim().length > 2`.
 */
export function isMobileV2DamageHoldReady(
  input: MobileV2DamageHoldReadinessInput,
): boolean {
  const picked = input.severities.find((s) => s.id === input.selectedSeverityId);
  if (picked === undefined) return false;
  if (!input.photoCaptured) return false;
  const noteRequired = input.noteRequired !== false;
  if (noteRequired && input.note.trim().length <= MOBILE_V2_DAMAGE_HOLD_MIN_NOTE_LEN) {
    return false;
  }
  return true;
}

/**
 * CTA variant tone selector for the damage-hold sheet — the CTA goes
 * destructive only on a danger-severity pick once ready.
 */
export function resolveMobileV2DamageHoldCtaTone(
  input: MobileV2DamageHoldReadinessInput,
): "danger" | "primary" | "soft" {
  const ready = isMobileV2DamageHoldReady(input);
  const picked = input.severities.find((s) => s.id === input.selectedSeverityId);
  if (!ready || picked === undefined) return "soft";
  return picked.color === "danger" ? "danger" : "primary";
}

// ---------------------------------------------------------------------------
// Cash drop sheet
// ---------------------------------------------------------------------------

export interface MobileV2CashDropReadinessInput {
  /** Counted amount (whole SAR) entered on the numberpad. */
  readonly countedSar: number;
  /** mobile_cash_policy: a sealed-envelope photo is required. */
  readonly requirePhoto: boolean;
  readonly photoCaptured: boolean;
  /** mobile_cash_policy: a hub-cashier acknowledgement is required. */
  readonly requireCounterSig: boolean;
  readonly cashierId: string;
}

/**
 * `counted − expected`. Positive = overage, negative = shortage,
 * zero = exact.
 */
export function computeMobileV2CashDropVariance(
  countedSar: number,
  expectedSar: number,
): number {
  return countedSar - expectedSar;
}

/**
 * `true` when a positive amount has been counted AND every policy-required
 * proof is present (sealed-envelope photo + hub-cashier acknowledgement).
 * Variance does NOT gate the primary CTA — the sheet surfaces variance as
 * a banner rather than a block so end-of-shift cash drops can still
 * complete with explicit mismatch acknowledgement.
 */
export function isMobileV2CashDropReady(
  input: MobileV2CashDropReadinessInput,
): boolean {
  if (input.countedSar <= 0) return false;
  if (input.requirePhoto && !input.photoCaptured) return false;
  if (input.requireCounterSig && input.cashierId.trim().length <= 2) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Receive sheet
// ---------------------------------------------------------------------------

/**
 * Resolves the Receive sheet subtitle. Callers may pass their own
 * subtitle string when they have richer state context (e.g. "scan all
 * parcels" before a manifest is scanned, or a custom localised label).
 * When omitted, falls back to a manifest-style label derived from the
 * supplier / line-haul id. Extracted so unit tests assert the precedence
 * rule without rendering the React Native tree.
 */
export function resolveMobileV2ReceiveSubtitle(input: {
  readonly subtitle?: string;
  readonly manifestId: string;
}): string {
  if (typeof input.subtitle === "string" && input.subtitle.length > 0) {
    return input.subtitle;
  }
  return `Line-haul · manifest ${input.manifestId}`;
}

// ---------------------------------------------------------------------------
// Return sheet
// ---------------------------------------------------------------------------

export interface MobileV2ReturnReadinessInput {
  readonly selectedTypeId: string | null;
  readonly photoCaptured: boolean;
}

/**
 * `true` when the user has picked a return reason AND captured the
 * mandatory photo of the parcel state on hand-back.
 */
export function isMobileV2ReturnReady(
  input: MobileV2ReturnReadinessInput,
): boolean {
  if (input.selectedTypeId === null) return false;
  if (!input.photoCaptured) return false;
  return true;
}
