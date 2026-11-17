import {
  DEFAULT_MOBILE_LOCATION_TRACKING_POLICY,
  normalizeMobileLocationTrackingPolicy,
} from "../../../apps/fieldops/src/mobile-location-policy";

describe("mobile location policy helpers", () => {
  test("normalizeMobileLocationTrackingPolicy returns safe defaults", () => {
    expect(normalizeMobileLocationTrackingPolicy(null)).toEqual(
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY
    );
    expect(normalizeMobileLocationTrackingPolicy({})).toEqual(
      DEFAULT_MOBILE_LOCATION_TRACKING_POLICY
    );
  });

  test("normalizeMobileLocationTrackingPolicy maps configured values", () => {
    const next = normalizeMobileLocationTrackingPolicy({
      enabled: false,
      min_interval_seconds: 30,
      max_accuracy_m: 120,
      background_enabled: true,
      request_background_permission: false,
      background_distance_interval_m: 80,
      background_time_interval_ms: 90000,
      background_deferred_updates_interval_ms: 120000,
      background_shows_indicator: true,
      background_pauses_updates_automatically: false,
      background_notification_title: "Ops tracking",
      background_notification_body: "Running in background",
      foreground_accuracy: "high",
      background_accuracy: "lowest",
    });

    expect(next).toEqual({
      enabled: false,
      minIntervalSeconds: 30,
      maxAccuracyM: 120,
      backgroundEnabled: true,
      requestBackgroundPermission: false,
      backgroundDistanceIntervalM: 80,
      backgroundTimeIntervalMs: 90000,
      backgroundDeferredUpdatesIntervalMs: 120000,
      backgroundShowsIndicator: true,
      backgroundPausesUpdatesAutomatically: false,
      backgroundNotificationTitle: "Ops tracking",
      backgroundNotificationBody: "Running in background",
      foregroundAccuracy: "high",
      backgroundAccuracy: "lowest",
    });
  });

  test("normalizeMobileLocationTrackingPolicy ignores invalid value types", () => {
    const next = normalizeMobileLocationTrackingPolicy({
      enabled: "true",
      min_interval_seconds: "30",
      max_accuracy_m: "120",
      background_enabled: 1,
      request_background_permission: 0,
      background_distance_interval_m: -1,
      background_time_interval_ms: -1,
      background_deferred_updates_interval_ms: "120000",
      background_shows_indicator: "true",
      background_pauses_updates_automatically: null,
      background_notification_title: "",
      background_notification_body: "  ",
      foreground_accuracy: "invalid",
      background_accuracy: "invalid",
    });

    expect(next).toEqual(DEFAULT_MOBILE_LOCATION_TRACKING_POLICY);
  });
});
