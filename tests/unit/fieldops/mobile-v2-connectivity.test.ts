// Mobile V2 connectivity model unit coverage.
//
// Engineering audit B3 (BLOCKER): `PreviewBody` previously held
// `online`/`queueCount` as never-wired constants. This suite covers the
// pure connectivity resolution + outbox-entry projection helpers that
// back the production shell's "online · N queued" indicator and the
// More-screen outbox panel.

import {
  MOBILE_V2_PREVIEW_CONNECTIVITY,
  buildMobileV2Connectivity,
  normalizeMobileV2QueueCount,
  projectMobileV2OutboxEntries,
  projectMobileV2SyncQueueEntries,
  resolveMobileV2OnlineFromNetworkState,
  type MobileV2RawOutboxEntry,
  type MobileV2RawOutboxSyncEntry,
} from "../../../apps/fieldops/src/mobile-v2-connectivity";

describe("MOBILE_V2_PREVIEW_CONNECTIVITY", () => {
  test("is the fixed design-rehearsal offline state (visual baseline anchor)", () => {
    expect(MOBILE_V2_PREVIEW_CONNECTIVITY).toEqual({
      online: false,
      queueCount: 3,
      syncing: false,
    });
  });

  test("is frozen so the showcase rehearsal value cannot drift", () => {
    expect(Object.isFrozen(MOBILE_V2_PREVIEW_CONNECTIVITY)).toBe(true);
  });
});

describe("resolveMobileV2OnlineFromNetworkState", () => {
  test("online when connected and reachable", () => {
    expect(
      resolveMobileV2OnlineFromNetworkState({
        isConnected: true,
        isInternetReachable: true,
      }),
    ).toBe(true);
  });

  test("online when connected and reachability not yet probed (null)", () => {
    // A freshly-mounted shell with a live radio must not be painted
    // offline while reachability is still resolving.
    expect(
      resolveMobileV2OnlineFromNetworkState({
        isConnected: true,
        isInternetReachable: null,
      }),
    ).toBe(true);
  });

  test("offline when connected but reachability explicitly false", () => {
    expect(
      resolveMobileV2OnlineFromNetworkState({
        isConnected: true,
        isInternetReachable: false,
      }),
    ).toBe(false);
  });

  test("offline when not connected", () => {
    expect(
      resolveMobileV2OnlineFromNetworkState({
        isConnected: false,
        isInternetReachable: true,
      }),
    ).toBe(false);
  });

  test("fail-closed (offline) on a null / undefined network state", () => {
    expect(resolveMobileV2OnlineFromNetworkState(null)).toBe(false);
    expect(resolveMobileV2OnlineFromNetworkState(undefined)).toBe(false);
  });
});

describe("normalizeMobileV2QueueCount", () => {
  test("passes through a valid non-negative integer", () => {
    expect(normalizeMobileV2QueueCount(0)).toBe(0);
    expect(normalizeMobileV2QueueCount(7)).toBe(7);
  });

  test("floors fractional values", () => {
    expect(normalizeMobileV2QueueCount(3.9)).toBe(3);
  });

  test("clamps negatives to zero", () => {
    expect(normalizeMobileV2QueueCount(-5)).toBe(0);
  });

  test("treats NaN / non-number as zero", () => {
    expect(normalizeMobileV2QueueCount(Number.NaN)).toBe(0);
    expect(normalizeMobileV2QueueCount(undefined)).toBe(0);
    expect(normalizeMobileV2QueueCount("3")).toBe(0);
    expect(normalizeMobileV2QueueCount(null)).toBe(0);
  });
});

describe("buildMobileV2Connectivity", () => {
  test("builds a real online + queue + syncing envelope", () => {
    expect(
      buildMobileV2Connectivity({
        networkState: { isConnected: true, isInternetReachable: true },
        queueCount: 4,
        syncing: true,
      }),
    ).toEqual({ online: true, queueCount: 4, syncing: true });
  });

  test("a null network state produces an offline envelope", () => {
    expect(
      buildMobileV2Connectivity({ networkState: null, queueCount: 0 }),
    ).toEqual({ online: false, queueCount: 0, syncing: false });
  });

  test("normalizes a garbage queue count and defaults syncing to false", () => {
    expect(
      buildMobileV2Connectivity({
        networkState: { isConnected: true },
        queueCount: -2,
      }),
    ).toEqual({ online: true, queueCount: 0, syncing: false });
  });

  test("result is frozen", () => {
    const c = buildMobileV2Connectivity({ networkState: null, queueCount: 1 });
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe("projectMobileV2OutboxEntries", () => {
  const NOW = 1_700_000_000_000;

  function entry(over: Partial<MobileV2RawOutboxEntry>): MobileV2RawOutboxEntry {
    return {
      id: "e1",
      rpc: "submit_fieldops_proof_v1",
      status: "queued",
      created_at: new Date(NOW - 4 * 60_000).toISOString(),
      ...over,
    };
  }

  test("maps a queued entry to a user-friendly display row with age", () => {
    const out = projectMobileV2OutboxEntries([entry({})], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "e1",
      label: "Proof upload",
      status: "queued",
      ageMin: 4,
    });
  });

  test("collapses in_flight to the in-flight display token", () => {
    const out = projectMobileV2OutboxEntries(
      [entry({ status: "in_flight" })],
      NOW,
    );
    expect(out[0]?.status).toBe("in-flight");
  });

  test("collapses dead entries to the failed display status", () => {
    const out = projectMobileV2OutboxEntries([entry({ status: "dead" })], NOW);
    expect(out[0]?.status).toBe("failed");
  });

  test("maps failed entries to failed", () => {
    const out = projectMobileV2OutboxEntries([entry({ status: "failed" })], NOW);
    expect(out[0]?.status).toBe("failed");
  });

  test("drops succeeded entries — they are no longer pending work", () => {
    const out = projectMobileV2OutboxEntries(
      [entry({ id: "ok", status: "succeeded" }), entry({ id: "q" })],
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual(["q"]);
  });

  test("ageMin floors at 0 for a future / unparseable timestamp", () => {
    const future = projectMobileV2OutboxEntries(
      [entry({ created_at: new Date(NOW + 60_000).toISOString() })],
      NOW,
    );
    expect(future[0]?.ageMin).toBe(0);
    const bad = projectMobileV2OutboxEntries(
      [entry({ created_at: "not-a-date" })],
      NOW,
    );
    expect(bad[0]?.ageMin).toBe(0);
  });

  test("returns a frozen empty array for no entries", () => {
    const out = projectMobileV2OutboxEntries([], NOW);
    expect(out).toEqual([]);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

describe("projectMobileV2SyncQueueEntries", () => {
  const CREATED = "2026-05-27T10:00:00.000Z";

  function entry(overrides: Partial<MobileV2RawOutboxSyncEntry>): MobileV2RawOutboxSyncEntry {
    return {
      id: "sync-1",
      rpc: "submit_fieldops_proof_v1",
      status: "queued",
      created_at: CREATED,
      args: { p_stop_id: "route-stop-1", p_outcome: "delivered" },
      attempt_count: 0,
      ...overrides,
    };
  }

  test("projects queued POD commits onto the full Sync Queue row model", () => {
    const out = projectMobileV2SyncQueueEntries([entry({})]);

    expect(out).toEqual([
      {
        id: "sync-1",
        kind: "pod.commit",
        stopId: "route-stop-1",
        atMs: Date.parse(CREATED),
        status: "queued",
        retryCount: 0,
      },
    ]);
  });

  test("projects failed proof writes as failed delivery rows", () => {
    const out = projectMobileV2SyncQueueEntries([
      entry({
        args: { p_stop_id: "route-stop-2", p_outcome: "failed" },
        attempt_count: 2,
        status: "failed",
      }),
    ]);

    expect(out[0]).toEqual({
      id: "sync-1",
      kind: "stop.failed",
      stopId: "route-stop-2",
      atMs: Date.parse(CREATED),
      status: "retrying",
      retryCount: 2,
    });
  });

  test("reads route lineage from p_input and marks dead letters as failed", () => {
    const out = projectMobileV2SyncQueueEntries([
      entry({
        rpc: "ui_confirm_route_run_departure_v1",
        status: "dead",
        args: { p_input: { route_run_id: "route-run-1" } },
      }),
    ]);

    expect(out[0]?.kind).toBe("stop.update");
    expect(out[0]?.stopId).toBe("route-run-1");
    expect(out[0]?.status).toBe("failed");
  });

  test("projects cash-drop writes with amount context instead of a generic pending write", () => {
    const out = projectMobileV2SyncQueueEntries([
      entry({
        rpc: "sign_fieldops_cash_drop_v1",
        status: "failed",
        args: {
          p_expected_sar: 137,
          p_actual_sar: 137,
          p_supervisor_name: null,
          p_photo_id: null,
        },
        attempt_count: 1,
      }),
    ]);

    expect(out[0]).toEqual({
      id: "sync-1",
      kind: "cash.drop",
      stopId: "cash-drop 137/137 SAR",
      atMs: Date.parse(CREATED),
      status: "retrying",
      retryCount: 1,
    });
  });
});
