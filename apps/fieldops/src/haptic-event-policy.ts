// Resolve haptic feedback from haptic_event_policy.
//
// Contract: the resolver `public.resolve_haptic_event_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     events: {
//       "scan.success":         { pattern: "light",     respect_driving_lock: true },
//       "scan.failure":         { pattern: "warning",   respect_driving_lock: true },
//       "pod.completed":        { pattern: "medium",    audio: "chime",   respect_driving_lock: true },
//       "outbox.synced":        { pattern: "success",   respect_driving_lock: true },
//       "driving_lock.engaged": { pattern: "heavy",     audio: "warning", respect_driving_lock: false },
//       "geofence.arrival":     { pattern: "medium",    respect_driving_lock: true },
//       "swipe.threshold":      { pattern: "light",     respect_driving_lock: true },
//       "swipe.commit":         { pattern: "medium",    respect_driving_lock: true },
//       "selection":            { pattern: "selection", respect_driving_lock: true },
//       "error":                { pattern: "error",     respect_driving_lock: false }
//     }
//   }
//
// This module:
//  1. Defines the typed shape (HapticEventPolicyValue + HapticPattern + HapticEventName)
//  2. Normalizes the JSONB into a strict-typed object (defensive parse)
//  3. Provides the pure resolver `resolveHapticForEvent(policy, eventName, drivingLockActive?)`
//     which returns the haptic pattern + optional audio cue. When the driving
//     lock is active and the event has respect_driving_lock=true, the helper
//     returns pattern="off" so non-critical haptics don't fight driver focus.
//  4. Ships a STATIC fallback (STATIC_HAPTIC_EVENT) that mirrors the global
//     default seed, so consumers stay legible while the network query is in
//     flight or offline.
//
// Callers dispatch the resolved pattern through the platform haptic API.

export type HapticPattern =
  | "light"
  | "medium"
  | "heavy"
  | "success"
  | "warning"
  | "error"
  | "selection"
  | "off";

// Canonical event vocabulary. Mirror of the migration seed (see
// supabase/migrations/202604241810_haptic_event_policy_v1.sql). Tenants may
// extend the events map at override layers, but the helper accepts arbitrary
// strings for forward compatibility.
export type HapticEventName =
  | "scan.success"
  | "scan.failure"
  | "pod.completed"
  | "outbox.synced"
  | "driving_lock.engaged"
  | "geofence.arrival"
  | "swipe.threshold"
  | "swipe.commit"
  | "selection"
  | "error";

export type HapticEventConfig = {
  pattern: HapticPattern;
  audio?: string;
  respect_driving_lock: boolean;
};

export type HapticEventPolicyValue = {
  version: number;
  events: Record<string, HapticEventConfig>;
};

export type ResolvedHaptic = {
  pattern: HapticPattern;
  audio?: string;
};

const VALID_PATTERNS: ReadonlySet<HapticPattern> = new Set([
  "light",
  "medium",
  "heavy",
  "success",
  "warning",
  "error",
  "selection",
  "off",
]);

function coercePattern(input: unknown, fallback: HapticPattern): HapticPattern {
  if (typeof input !== "string") return fallback;
  return VALID_PATTERNS.has(input as HapticPattern)
    ? (input as HapticPattern)
    : fallback;
}

// Mirror of the migration seed (see supabase/migrations/202604241810_haptic_event_policy_v1.sql).
// Kept in sync intentionally: when offline / pre-fetch, the haptic resolver
// should match the global default the server would have returned.
export const STATIC_HAPTIC_EVENT: HapticEventPolicyValue = {
  version: 1,
  events: {
    "scan.success": { pattern: "light", respect_driving_lock: true },
    "scan.failure": { pattern: "warning", respect_driving_lock: true },
    "pod.completed": { pattern: "medium", audio: "chime", respect_driving_lock: true },
    "outbox.synced": { pattern: "success", respect_driving_lock: true },
    "driving_lock.engaged": {
      pattern: "heavy",
      audio: "warning",
      respect_driving_lock: false,
    },
    "geofence.arrival": { pattern: "medium", respect_driving_lock: true },
    "swipe.threshold": { pattern: "light", respect_driving_lock: true },
    "swipe.commit": { pattern: "medium", respect_driving_lock: true },
    selection: { pattern: "selection", respect_driving_lock: true },
    error: { pattern: "error", respect_driving_lock: false },
  },
};

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// HapticEventPolicyValue. Defensive: any malformed entry is dropped, and if
// no valid events remain we fall back to the static seed so a bad row in
// production cannot brick haptic feedback for the whole app.
export function normalizeHapticEventPolicy(raw: unknown): HapticEventPolicyValue {
  if (!raw || typeof raw !== "object") return STATIC_HAPTIC_EVENT;
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const rawEvents = obj.events;
  const events: Record<string, HapticEventConfig> = {};
  if (rawEvents && typeof rawEvents === "object" && !Array.isArray(rawEvents)) {
    for (const [eventName, entry] of Object.entries(rawEvents as Record<string, unknown>)) {
      if (typeof eventName !== "string" || eventName.length === 0) continue;
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      // pattern is required and must be one of the valid enum values
      if (typeof e.pattern !== "string" || !VALID_PATTERNS.has(e.pattern as HapticPattern)) {
        continue;
      }
      const pattern = e.pattern as HapticPattern;
      const respect_driving_lock =
        typeof e.respect_driving_lock === "boolean" ? e.respect_driving_lock : true;
      const config: HapticEventConfig = { pattern, respect_driving_lock };
      if (typeof e.audio === "string" && e.audio.length > 0) {
        config.audio = e.audio;
      }
      events[eventName] = config;
    }
  }

  if (Object.keys(events).length === 0) {
    return {
      version,
      events: { ...STATIC_HAPTIC_EVENT.events },
    };
  }

  return { version, events };
}

// Pure resolver: given a normalized policy, an event name, and the current
// driving-lock state, return the haptic pattern + optional audio cue to fire.
//
// Behavior:
//  - Unknown event name: returns { pattern: "off" } (silent — caller should
//    have already verified the event name is in the policy vocabulary).
//  - Driving lock active AND event has respect_driving_lock=true:
//    returns { pattern: "off" } (suppress so the driver isn't disturbed).
//  - Driving lock active AND event has respect_driving_lock=false:
//    returns the configured pattern + audio (safety-critical haptics like
//    driving_lock.engaged and error always fire).
//  - Driving lock inactive: returns the configured pattern + audio.
//
// The "off" pattern is also a valid configured value — tenants may map any
// event to "off" to disable a specific haptic without having to remove it
// from the policy.
export function resolveHapticForEvent(
  policy: HapticEventPolicyValue,
  eventName: string,
  drivingLockActive?: boolean,
): ResolvedHaptic {
  const config = policy.events[eventName];
  if (!config) return { pattern: "off" };
  if (drivingLockActive === true && config.respect_driving_lock === true) {
    return { pattern: "off" };
  }
  const result: ResolvedHaptic = { pattern: config.pattern };
  if (config.audio !== undefined) result.audio = config.audio;
  return result;
}
