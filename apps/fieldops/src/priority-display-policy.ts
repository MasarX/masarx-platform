// Resolve localized labels and tones from priority_display_policy.
//
// Contract: the resolver `public.resolve_priority_display_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     buckets: [
//       { min_inclusive: 80, label_en: "Urgent", label_ar: "...", tone: "danger" },
//       { min_inclusive: 60, label_en: "High",   label_ar: "...", tone: "warning" },
//       { min_inclusive: 40, label_en: "Normal", label_ar: "...", tone: "info" },
//       { min_inclusive: 0,  label_en: "Low",    label_ar: "...", tone: "neutral" }
//     ]
//   }
//
// This module:
//  1. Defines the typed shape (PriorityDisplayPolicyValue)
//  2. Normalizes the JSONB into a strict-typed object (defensive parse)
//  3. Provides the pure resolver `resolvePriorityLabel(policy, value, locale)`
//  4. Ships a STATIC fallback that mirrors the global default seed, so
//     consumers stay legible while the network query is in flight or offline.

import type { StatusTone } from "./status-theme-policy";

export type PriorityBucket = {
  min_inclusive: number;
  label_en: string;
  label_ar: string;
  tone: StatusTone;
};

export type PriorityDisplayPolicyValue = {
  version: number;
  buckets: PriorityBucket[];
};

const VALID_TONES: ReadonlySet<StatusTone> = new Set([
  "info",
  "success",
  "warning",
  "danger",
  "neutral",
]);

function coerceTone(input: unknown, fallback: StatusTone): StatusTone {
  if (typeof input !== "string") return fallback;
  return VALID_TONES.has(input as StatusTone) ? (input as StatusTone) : fallback;
}

// Mirror of the migration seed (see supabase/migrations/202604241600_priority_display_policy_v1.sql).
// Kept in sync intentionally: when offline / pre-fetch, the priority pill
// rendering should match the global default the server would have returned.
export const STATIC_PRIORITY_DISPLAY: PriorityDisplayPolicyValue = {
  version: 1,
  buckets: [
    { min_inclusive: 80, label_en: "Urgent", label_ar: "عاجل", tone: "danger" },
    { min_inclusive: 60, label_en: "High", label_ar: "مرتفع", tone: "warning" },
    { min_inclusive: 40, label_en: "Normal", label_ar: "عادي", tone: "info" },
    { min_inclusive: 0, label_en: "Low", label_ar: "منخفض", tone: "neutral" },
  ],
};

// Sort buckets descending by min_inclusive so a linear scan returns the
// highest-priority match first. Stable for equal min_inclusive (defensive).
function sortBucketsDesc(buckets: PriorityBucket[]): PriorityBucket[] {
  return [...buckets].sort((a, b) => b.min_inclusive - a.min_inclusive);
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// PriorityDisplayPolicyValue. Defensive: any malformed entry is dropped, and
// if no valid buckets remain we fall back to the static seed so a bad row in
// production cannot brick priority rendering.
export function normalizePriorityDisplayPolicy(
  raw: unknown,
): PriorityDisplayPolicyValue {
  if (!raw || typeof raw !== "object") return STATIC_PRIORITY_DISPLAY;
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version = typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const rawBuckets = obj.buckets;
  const buckets: PriorityBucket[] = [];
  if (Array.isArray(rawBuckets)) {
    for (const entry of rawBuckets) {
      if (!entry || typeof entry !== "object") continue;
      const b = entry as Record<string, unknown>;
      const minRaw = b.min_inclusive;
      if (typeof minRaw !== "number" || !Number.isFinite(minRaw)) continue;
      const labelEn = typeof b.label_en === "string" && b.label_en.length > 0 ? b.label_en : null;
      const labelAr = typeof b.label_ar === "string" && b.label_ar.length > 0 ? b.label_ar : null;
      if (labelEn === null || labelAr === null) continue;
      const tone = coerceTone(b.tone, "neutral");
      buckets.push({
        min_inclusive: Math.max(0, Math.min(100, Math.floor(minRaw))),
        label_en: labelEn,
        label_ar: labelAr,
        tone,
      });
    }
  }

  if (buckets.length === 0) {
    return { version, buckets: [...STATIC_PRIORITY_DISPLAY.buckets] };
  }

  return { version, buckets: sortBucketsDesc(buckets) };
}

// Pure resolver: priority value (0-100) → { label, tone } according to the
// policy's bucket map. Buckets are scanned descending by min_inclusive — the
// first bucket whose threshold is <= the value wins. If no bucket matches
// (only possible when buckets[].min_inclusive are all > value), falls back to
// the lowest bucket. If the policy has no buckets (defensive), uses the
// static seed's lowest bucket.
//
// Locale-aware: returns label_ar when locale === 'ar', else label_en.
export function resolvePriorityLabel(
  policy: PriorityDisplayPolicyValue,
  priorityValue: number,
  locale: "en" | "ar",
): { label: string; tone: StatusTone } {
  // Defensive: zero buckets falls back to seed
  const sourceBuckets =
    policy.buckets.length > 0 ? policy.buckets : STATIC_PRIORITY_DISPLAY.buckets;
  // Ensure descending order regardless of how the policy was constructed
  const buckets = sortBucketsDesc(sourceBuckets);

  const value =
    typeof priorityValue === "number" && Number.isFinite(priorityValue)
      ? priorityValue
      : 0;

  // Find first bucket whose threshold is <= value (highest matching threshold)
  let match: PriorityBucket | undefined;
  for (const bucket of buckets) {
    if (value >= bucket.min_inclusive) {
      match = bucket;
      break;
    }
  }
  // Fallback to the lowest bucket if the value is below every threshold.
  // (With a sane policy that includes a 0-threshold bucket, this is never hit.)
  const chosen = match ?? buckets[buckets.length - 1] ?? STATIC_PRIORITY_DISPLAY.buckets[3]!;

  const label = locale === "ar" ? chosen.label_ar : chosen.label_en;
  return { label, tone: chosen.tone };
}
