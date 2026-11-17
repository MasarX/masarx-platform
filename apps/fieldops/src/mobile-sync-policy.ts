export type MobileSyncPolicy = {
  enabled: boolean;
  degradedPendingThreshold: number;
  staleSyncAfterSeconds: number;
  maxRetryAttempts: number;
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
  syncBatchSize: number;
  autoSyncOnReconnect: boolean;
  showDegradedBanner: boolean;
};

export const DEFAULT_MOBILE_SYNC_POLICY: MobileSyncPolicy = {
  enabled: true,
  degradedPendingThreshold: 10,
  staleSyncAfterSeconds: 180,
  maxRetryAttempts: 5,
  retryBaseDelaySeconds: 5,
  retryMaxDelaySeconds: 120,
  syncBatchSize: 50,
  autoSyncOnReconnect: true,
  showDegradedBanner: true,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  if (next < 1) return fallback;
  return next;
}

export function normalizeMobileSyncPolicy(value: unknown): MobileSyncPolicy {
  const input = asRecord(value);
  const retryBaseDelaySeconds = readPositiveInt(
    input.retry_base_delay_seconds,
    DEFAULT_MOBILE_SYNC_POLICY.retryBaseDelaySeconds
  );
  const retryMaxDelaySeconds = Math.max(
    retryBaseDelaySeconds,
    readPositiveInt(input.retry_max_delay_seconds, DEFAULT_MOBILE_SYNC_POLICY.retryMaxDelaySeconds)
  );

  return {
    enabled: readBoolean(input.enabled, DEFAULT_MOBILE_SYNC_POLICY.enabled),
    degradedPendingThreshold: readPositiveInt(
      input.degraded_pending_threshold,
      DEFAULT_MOBILE_SYNC_POLICY.degradedPendingThreshold
    ),
    staleSyncAfterSeconds: readPositiveInt(
      input.stale_sync_after_seconds,
      DEFAULT_MOBILE_SYNC_POLICY.staleSyncAfterSeconds
    ),
    maxRetryAttempts: readPositiveInt(
      input.max_retry_attempts,
      DEFAULT_MOBILE_SYNC_POLICY.maxRetryAttempts
    ),
    retryBaseDelaySeconds,
    retryMaxDelaySeconds,
    syncBatchSize: readPositiveInt(input.sync_batch_size, DEFAULT_MOBILE_SYNC_POLICY.syncBatchSize),
    autoSyncOnReconnect: readBoolean(
      input.auto_sync_on_reconnect,
      DEFAULT_MOBILE_SYNC_POLICY.autoSyncOnReconnect
    ),
    showDegradedBanner: readBoolean(
      input.show_degraded_banner,
      DEFAULT_MOBILE_SYNC_POLICY.showDegradedBanner
    ),
  };
}
