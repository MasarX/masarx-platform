// Resolve audio cue selection and prayer-window suppression from audio_cue_policy.
//
// Contract: the resolver `public.resolve_audio_cue_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     cues: {
//       "pod.completed":          { asset: "chime",       critical: false, locale_aware: true },
//       "scan.success":           { asset: "tick",        critical: false },
//       "scan.failure":           { asset: "buzz",        critical: false },
//       "outbox.synced":          { asset: "soft_chime",  critical: false },
//       "driving_lock.engaged":   { asset: "warning",     critical: true, respect_adhan_window: false },
//       "geofence.arrival":       { asset: "ping",        critical: false },
//       "shift.start":            { asset: "shift_start", critical: false }
//     },
//     adhan_window_suppression: { enabled: true, non_critical_only: true }
//   }
//
// This module:
//  1. Defines the typed shape (AudioCuePolicyValue, AudioCueDescriptor, AudioCueEventName)
//  2. Normalizes the JSONB into a strict-typed object (defensive parse)
//  3. Provides the pure resolver `resolveAudioCueForEvent(policy, eventName, isAdhanWindow?)`
//     which returns either the cue's asset to play, or { suppressed: true } when
//     the cue must be skipped because of Adhan-window policy.
//  4. Ships a STATIC fallback that mirrors the global default seed, so consumers
//     stay legible while the network query is in flight or offline.
//
// Prayer-window suppression
//   - When `policy.adhan_window_suppression.enabled` is false, no suppression.
//   - When enabled and `non_critical_only=true` (the default), critical cues
//     ALWAYS play (e.g. driving_lock.engaged) — safety-critical audio cannot
//     be suppressed during prayer time.
//   - A cue can also explicitly opt out via `respect_adhan_window: false`.
//   - When enabled and `non_critical_only=false`, ALL cues are suppressed
//     during the Adhan window (defensive — used by tenants who choose total
//     silence during Salat).
//
// The caller supplies prayer-window state and plays the resolved asset.

export type AudioCueEventName =
  | "pod.completed"
  | "scan.success"
  | "scan.failure"
  | "outbox.synced"
  | "driving_lock.engaged"
  | "geofence.arrival"
  | "shift.start";

export type AudioCueDescriptor = {
  asset: string;
  critical: boolean;
  locale_aware?: boolean;
  respect_adhan_window?: boolean;
};

export type AdhanWindowSuppression = {
  enabled: boolean;
  non_critical_only: boolean;
};

export type AudioCuePolicyValue = {
  version: number;
  cues: Record<string, AudioCueDescriptor>;
  adhan_window_suppression: AdhanWindowSuppression;
};

export type AudioCueResolution =
  | { suppressed: false; asset: string; descriptor: AudioCueDescriptor }
  | { suppressed: true; reason: "adhan_window" | "unknown_event"; asset?: string };

// Mirror of the migration seed (see supabase/migrations/202604241820_audio_cue_policy_v1.sql).
// Kept in sync intentionally: when offline / pre-fetch, the audio cue resolver
// should match the global default the server would have returned.
export const STATIC_AUDIO_CUE: AudioCuePolicyValue = {
  version: 1,
  cues: {
    "pod.completed": { asset: "chime", critical: false, locale_aware: true },
    "scan.success": { asset: "tick", critical: false },
    "scan.failure": { asset: "buzz", critical: false },
    "outbox.synced": { asset: "soft_chime", critical: false },
    "driving_lock.engaged": {
      asset: "warning",
      critical: true,
      respect_adhan_window: false,
    },
    "geofence.arrival": { asset: "ping", critical: false },
    "shift.start": { asset: "shift_start", critical: false },
  },
  adhan_window_suppression: {
    enabled: true,
    non_critical_only: true,
  },
};

function coerceBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  return fallback;
}

function normalizeDescriptor(raw: unknown): AudioCueDescriptor | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const asset =
    typeof r.asset === "string" && r.asset.length > 0 ? r.asset : null;
  if (asset === null) return null;
  const critical = coerceBoolean(r.critical, false);
  const descriptor: AudioCueDescriptor = { asset, critical };
  if (typeof r.locale_aware === "boolean") descriptor.locale_aware = r.locale_aware;
  if (typeof r.respect_adhan_window === "boolean") {
    descriptor.respect_adhan_window = r.respect_adhan_window;
  }
  return descriptor;
}

function normalizeAdhanBlock(raw: unknown): AdhanWindowSuppression {
  if (!raw || typeof raw !== "object") {
    return { ...STATIC_AUDIO_CUE.adhan_window_suppression };
  }
  const r = raw as Record<string, unknown>;
  const enabled = coerceBoolean(
    r.enabled,
    STATIC_AUDIO_CUE.adhan_window_suppression.enabled,
  );
  const non_critical_only = coerceBoolean(
    r.non_critical_only,
    STATIC_AUDIO_CUE.adhan_window_suppression.non_critical_only,
  );
  return { enabled, non_critical_only };
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// AudioCuePolicyValue. Defensive: any malformed cue descriptor is dropped, and
// if no valid cues remain we fall back to the static seed so a bad row in
// production cannot brick the audio surface.
export function normalizeAudioCuePolicy(raw: unknown): AudioCuePolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_AUDIO_CUE.version,
      cues: { ...STATIC_AUDIO_CUE.cues },
      adhan_window_suppression: { ...STATIC_AUDIO_CUE.adhan_window_suppression },
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const cues: Record<string, AudioCueDescriptor> = {};
  const rawCues = obj.cues;
  if (rawCues && typeof rawCues === "object" && !Array.isArray(rawCues)) {
    for (const [key, value] of Object.entries(rawCues as Record<string, unknown>)) {
      if (typeof key !== "string" || key.length === 0) continue;
      const descriptor = normalizeDescriptor(value);
      if (descriptor) cues[key] = descriptor;
    }
  }

  const adhan_window_suppression = normalizeAdhanBlock(obj.adhan_window_suppression);

  if (Object.keys(cues).length === 0) {
    return {
      version,
      cues: { ...STATIC_AUDIO_CUE.cues },
      adhan_window_suppression,
    };
  }

  return { version, cues, adhan_window_suppression };
}

// Pure resolver: given a normalized policy, an event name, and whether we are
// currently inside an Adhan (Salat) window, return either the asset to play or
// a suppression reason.
//
// Suppression rules:
//   - If the event is unknown → { suppressed: true, reason: "unknown_event" }
//   - If isAdhanWindow=true AND adhan_window_suppression.enabled:
//       * If the cue has `respect_adhan_window: false` → play (descriptor opts out).
//       * Else if non_critical_only=true AND cue is critical → play.
//       * Else → { suppressed: true, reason: "adhan_window", asset: cue.asset }.
//   - Otherwise → play.
//
// The returned `asset` field is preserved on suppression so callers can still
// log/telemetry which cue was suppressed without a second lookup.
export function resolveAudioCueForEvent(
  policy: AudioCuePolicyValue,
  eventName: string,
  isAdhanWindow: boolean = false,
): AudioCueResolution {
  const descriptor = policy.cues[eventName];
  if (!descriptor) {
    return { suppressed: true, reason: "unknown_event" };
  }

  const adhan = policy.adhan_window_suppression;
  if (isAdhanWindow && adhan.enabled) {
    // Cue-level explicit opt-out (e.g. driving_lock.engaged).
    if (descriptor.respect_adhan_window === false) {
      return { suppressed: false, asset: descriptor.asset, descriptor };
    }
    // Policy-level: only non-critical cues are suppressed.
    if (adhan.non_critical_only && descriptor.critical) {
      return { suppressed: false, asset: descriptor.asset, descriptor };
    }
    // Suppress.
    return { suppressed: true, reason: "adhan_window", asset: descriptor.asset };
  }

  return { suppressed: false, asset: descriptor.asset, descriptor };
}
