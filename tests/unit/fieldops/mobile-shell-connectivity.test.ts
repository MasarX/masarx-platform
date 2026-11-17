import {
  resolveConnectivitySnapshot,
  resolveEffectiveOnline,
} from "../../../apps/fieldops/src/mobile-shell-connectivity";

describe("mobile shell connectivity helpers", () => {
  test("keeps runtime connectivity when diagnostics override is off", () => {
    expect(
      resolveEffectiveOnline({
        networkOnline: true,
        diagnosticsEnabled: false,
        simulatedOffline: true,
      })
    ).toBe(true);
    expect(
      resolveEffectiveOnline({
        networkOnline: false,
        diagnosticsEnabled: false,
        simulatedOffline: false,
      })
    ).toBe(false);
  });

  test("forces offline when diagnostics override is enabled", () => {
    expect(
      resolveEffectiveOnline({
        networkOnline: true,
        diagnosticsEnabled: true,
        simulatedOffline: true,
      })
    ).toBe(false);
  });

  test("classifies degraded when queue is large and sync is stale", () => {
    const staleTs = new Date(Date.now() - 15 * 60_000).toISOString();
    const snapshot = resolveConnectivitySnapshot({
      networkOnline: true,
      diagnosticsEnabled: false,
      simulatedOffline: null,
      outboxPendingCount: 25,
      lastSyncSuccessAt: staleTs,
      syncErrorCount: 1,
      degradedPendingThreshold: 10,
      staleSyncAfterSeconds: 60,
    });
    expect(snapshot.effectiveOnline).toBe(true);
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.reasons).toEqual(
      expect.arrayContaining(["queue_pressure", "stale_sync", "sync_errors"])
    );
  });

  test("stays online when no degradation signals exist", () => {
    const snapshot = resolveConnectivitySnapshot({
      networkOnline: true,
      diagnosticsEnabled: false,
      simulatedOffline: null,
      outboxPendingCount: 0,
      lastSyncSuccessAt: new Date().toISOString(),
      syncErrorCount: 0,
      degradedPendingThreshold: 10,
      staleSyncAfterSeconds: 120,
    });
    expect(snapshot.effectiveOnline).toBe(true);
    expect(snapshot.status).toBe("online");
    expect(snapshot.reasons).toEqual([]);
  });
});
