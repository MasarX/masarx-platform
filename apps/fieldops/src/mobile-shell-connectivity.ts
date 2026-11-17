export type MobileConnectivityStatus = "online" | "degraded" | "offline";

export type MobileConnectivitySnapshot = {
  effectiveOnline: boolean;
  status: MobileConnectivityStatus;
  reasons: string[];
};

export function resolveEffectiveOnline(input: {
  networkOnline: boolean;
  diagnosticsEnabled: boolean;
  simulatedOffline: boolean | null | undefined;
}): boolean {
  if (input.diagnosticsEnabled && input.simulatedOffline === true) return false;
  return input.networkOnline;
}

export function resolveConnectivitySnapshot(input: {
  networkOnline: boolean;
  diagnosticsEnabled: boolean;
  simulatedOffline: boolean | null | undefined;
  outboxPendingCount: number;
  lastSyncSuccessAt: string | null | undefined;
  syncErrorCount: number;
  degradedPendingThreshold: number;
  staleSyncAfterSeconds: number;
}): MobileConnectivitySnapshot {
  const effectiveOnline = resolveEffectiveOnline({
    networkOnline: input.networkOnline,
    diagnosticsEnabled: input.diagnosticsEnabled,
    simulatedOffline: input.simulatedOffline,
  });

  if (!effectiveOnline) {
    return {
      effectiveOnline: false,
      status: "offline",
      reasons: ["network_unavailable"],
    };
  }

  const reasons: string[] = [];

  if (input.syncErrorCount > 0) {
    reasons.push("sync_errors");
  }

  if (Number.isFinite(input.outboxPendingCount) && input.outboxPendingCount >= input.degradedPendingThreshold) {
    reasons.push("queue_pressure");
  }

  if (input.staleSyncAfterSeconds > 0) {
    const lastSyncMs = input.lastSyncSuccessAt ? Date.parse(input.lastSyncSuccessAt) : Number.NaN;
    if (!Number.isNaN(lastSyncMs)) {
      const ageSeconds = Math.floor((Date.now() - lastSyncMs) / 1000);
      if (ageSeconds >= input.staleSyncAfterSeconds) {
        reasons.push("stale_sync");
      }
    } else if ((input.outboxPendingCount || 0) > 0) {
      reasons.push("missing_sync_baseline");
    }
  }

  return {
    effectiveOnline: true,
    status: reasons.length > 0 ? "degraded" : "online",
    reasons,
  };
}
