import {
  DEFAULT_MOBILE_SYNC_POLICY,
  normalizeMobileSyncPolicy,
} from "../../../apps/fieldops/src/mobile-sync-policy";

describe("mobile sync policy normalization", () => {
  test("returns defaults when policy is missing", () => {
    expect(normalizeMobileSyncPolicy(null)).toEqual(DEFAULT_MOBILE_SYNC_POLICY);
  });

  test("normalizes numeric thresholds and enforces retry max >= retry base", () => {
    const normalized = normalizeMobileSyncPolicy({
      enabled: true,
      degraded_pending_threshold: 3,
      stale_sync_after_seconds: 45,
      max_retry_attempts: 2,
      retry_base_delay_seconds: 20,
      retry_max_delay_seconds: 5,
      sync_batch_size: 11,
      auto_sync_on_reconnect: false,
      show_degraded_banner: false,
    });

    expect(normalized.enabled).toBe(true);
    expect(normalized.degradedPendingThreshold).toBe(3);
    expect(normalized.staleSyncAfterSeconds).toBe(45);
    expect(normalized.maxRetryAttempts).toBe(2);
    expect(normalized.retryBaseDelaySeconds).toBe(20);
    expect(normalized.retryMaxDelaySeconds).toBe(20);
    expect(normalized.syncBatchSize).toBe(11);
    expect(normalized.autoSyncOnReconnect).toBe(false);
    expect(normalized.showDegradedBanner).toBe(false);
  });
});
