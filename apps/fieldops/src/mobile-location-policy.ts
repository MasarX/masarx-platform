export type MobileLocationAccuracy = "lowest" | "low" | "balanced" | "high" | "highest";

export type MobileLocationTrackingPolicy = {
  enabled: boolean;
  minIntervalSeconds: number;
  maxAccuracyM: number | null;
  backgroundEnabled: boolean;
  requestBackgroundPermission: boolean;
  backgroundDistanceIntervalM: number;
  backgroundTimeIntervalMs: number;
  backgroundDeferredUpdatesIntervalMs: number;
  backgroundShowsIndicator: boolean;
  backgroundPausesUpdatesAutomatically: boolean;
  backgroundNotificationTitle: string;
  backgroundNotificationBody: string;
  foregroundAccuracy: MobileLocationAccuracy;
  backgroundAccuracy: MobileLocationAccuracy;
};

export const DEFAULT_MOBILE_LOCATION_TRACKING_POLICY: MobileLocationTrackingPolicy = {
  enabled: false,
  minIntervalSeconds: 15,
  maxAccuracyM: 200,
  backgroundEnabled: false,
  requestBackgroundPermission: true,
  backgroundDistanceIntervalM: 50,
  backgroundTimeIntervalMs: 60_000,
  backgroundDeferredUpdatesIntervalMs: 60_000,
  backgroundShowsIndicator: false,
  backgroundPausesUpdatesAutomatically: true,
  backgroundNotificationTitle: "Fieldops location tracking",
  backgroundNotificationBody: "Fieldops captures location updates for operational tasks.",
  foregroundAccuracy: "balanced",
  backgroundAccuracy: "balanced",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  if (next < 0) return fallback;
  return next;
}

function readNullablePositiveInt(value: unknown, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  if (next < 0) return fallback;
  return next;
}

function normalizeAccuracy(value: unknown, fallback: MobileLocationAccuracy): MobileLocationAccuracy {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "lowest" ||
    normalized === "low" ||
    normalized === "balanced" ||
    normalized === "high" ||
    normalized === "highest"
  ) {
    return normalized;
  }
  return fallback;
}

export function normalizeMobileLocationTrackingPolicy(value: unknown): MobileLocationTrackingPolicy {
  const input = asRecord(value);
  return {
    enabled: readBoolean(input.enabled, DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.enabled),
    minIntervalSeconds: readPositiveInt(
      input.min_interval_seconds,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.minIntervalSeconds
    ),
    maxAccuracyM: readNullablePositiveInt(
      input.max_accuracy_m,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.maxAccuracyM
    ),
    backgroundEnabled: readBoolean(
      input.background_enabled,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundEnabled
    ),
    requestBackgroundPermission: readBoolean(
      input.request_background_permission,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.requestBackgroundPermission
    ),
    backgroundDistanceIntervalM: readPositiveInt(
      input.background_distance_interval_m,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundDistanceIntervalM
    ),
    backgroundTimeIntervalMs: readPositiveInt(
      input.background_time_interval_ms,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundTimeIntervalMs
    ),
    backgroundDeferredUpdatesIntervalMs: readPositiveInt(
      input.background_deferred_updates_interval_ms,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundDeferredUpdatesIntervalMs
    ),
    backgroundShowsIndicator: readBoolean(
      input.background_shows_indicator,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundShowsIndicator
    ),
    backgroundPausesUpdatesAutomatically: readBoolean(
      input.background_pauses_updates_automatically,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundPausesUpdatesAutomatically
    ),
    backgroundNotificationTitle: readString(
      input.background_notification_title,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundNotificationTitle
    ),
    backgroundNotificationBody: readString(
      input.background_notification_body,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundNotificationBody
    ),
    foregroundAccuracy: normalizeAccuracy(
      input.foreground_accuracy,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.foregroundAccuracy
    ),
    backgroundAccuracy: normalizeAccuracy(
      input.background_accuracy,
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY.backgroundAccuracy
    ),
  };
}
