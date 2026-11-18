import {
  DEFAULT_PUSH_BATCHING_POLICY,
  createPushBatchState,
  enqueuePush,
  flushPushBatch,
  isInQuietHours,
  normalizePushBatchingPolicy,
  type PushBatchingPolicy,
  type PushPayload,
} from "../../../apps/fieldops/src/mobile-push-batching";

function makePayload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    id: overrides.id ?? "p-1",
    title: overrides.title ?? "Title",
    body: overrides.body ?? "Body",
    receivedAt: overrides.receivedAt ?? 1_000,
    priority: overrides.priority ?? null,
    category: overrides.category ?? null,
    data: overrides.data,
  };
}

describe("mobile push batching policy normalization", () => {
  test("DEFAULT_PUSH_BATCHING_POLICY has safe defaults", () => {
    expect(DEFAULT_PUSH_BATCHING_POLICY.enabled).toBe(false);
    expect(DEFAULT_PUSH_BATCHING_POLICY.window_ms).toBe(60_000);
    expect(DEFAULT_PUSH_BATCHING_POLICY.max_batch_size).toBe(8);
    expect(DEFAULT_PUSH_BATCHING_POLICY.instant_categories).toEqual(["emergency"]);
  });

  test("normalizePushBatchingPolicy returns defaults for null/empty input", () => {
    expect(normalizePushBatchingPolicy(null)).toEqual(DEFAULT_PUSH_BATCHING_POLICY);
    expect(normalizePushBatchingPolicy(undefined)).toEqual(DEFAULT_PUSH_BATCHING_POLICY);
    expect(normalizePushBatchingPolicy({})).toEqual(DEFAULT_PUSH_BATCHING_POLICY);
  });

  test("normalizePushBatchingPolicy maps typed values", () => {
    const policy = normalizePushBatchingPolicy({
      enabled: true,
      window_ms: 120_000,
      max_batch_size: 5,
      instant_categories: ["emergency", "critical"],
      quiet_hours_start_utc: 22,
      quiet_hours_end_utc: 6,
    });
    expect(policy.enabled).toBe(true);
    expect(policy.window_ms).toBe(120_000);
    expect(policy.max_batch_size).toBe(5);
    expect(policy.instant_categories).toEqual(["emergency", "critical"]);
    expect(policy.quiet_hours_start_utc).toBe(22);
    expect(policy.quiet_hours_end_utc).toBe(6);
  });

  test("normalizePushBatchingPolicy rejects invalid numeric values", () => {
    const policy = normalizePushBatchingPolicy({
      enabled: "yes",
      window_ms: -10,
      max_batch_size: 0,
      instant_categories: [1, "", "emergency", "emergency"],
      quiet_hours_start_utc: 99,
      quiet_hours_end_utc: "6",
    });
    expect(policy.enabled).toBe(false);
    expect(policy.window_ms).toBe(DEFAULT_PUSH_BATCHING_POLICY.window_ms);
    expect(policy.max_batch_size).toBe(DEFAULT_PUSH_BATCHING_POLICY.max_batch_size);
    expect(policy.instant_categories).toEqual(["emergency"]);
    expect(policy.quiet_hours_start_utc).toBeNull();
    expect(policy.quiet_hours_end_utc).toBeNull();
  });

  test("normalizePushBatchingPolicy falls back to default instant categories when none provided", () => {
    const policy = normalizePushBatchingPolicy({ enabled: true });
    expect(policy.instant_categories).toEqual(["emergency"]);
  });
});

describe("isInQuietHours", () => {
  const base: PushBatchingPolicy = {
    ...DEFAULT_PUSH_BATCHING_POLICY,
    enabled: true,
  };

  test("returns false when quiet hours unset", () => {
    expect(isInQuietHours(base, new Date("2024-01-01T03:00:00Z"))).toBe(false);
  });

  test("returns true inside same-day window", () => {
    const policy: PushBatchingPolicy = {
      ...base,
      quiet_hours_start_utc: 8,
      quiet_hours_end_utc: 17,
    };
    expect(isInQuietHours(policy, new Date("2024-01-01T10:00:00Z"))).toBe(true);
    expect(isInQuietHours(policy, new Date("2024-01-01T07:59:00Z"))).toBe(false);
    expect(isInQuietHours(policy, new Date("2024-01-01T17:00:00Z"))).toBe(false);
  });

  test("returns true inside overnight wrap window", () => {
    const policy: PushBatchingPolicy = {
      ...base,
      quiet_hours_start_utc: 22,
      quiet_hours_end_utc: 6,
    };
    expect(isInQuietHours(policy, new Date("2024-01-01T23:30:00Z"))).toBe(true);
    expect(isInQuietHours(policy, new Date("2024-01-02T05:59:00Z"))).toBe(true);
    expect(isInQuietHours(policy, new Date("2024-01-01T12:00:00Z"))).toBe(false);
  });

  test("returns false when start equals end (no window)", () => {
    const policy: PushBatchingPolicy = {
      ...base,
      quiet_hours_start_utc: 10,
      quiet_hours_end_utc: 10,
    };
    expect(isInQuietHours(policy, new Date("2024-01-01T10:30:00Z"))).toBe(false);
  });
});

describe("enqueuePush pass-through behavior", () => {
  test("pass-through when policy disabled", () => {
    const state = createPushBatchState();
    const payload = makePayload({ id: "p-a" });
    const result = enqueuePush(state, payload, DEFAULT_PUSH_BATCHING_POLICY, 10);
    expect(result.emit).toEqual([payload]);
    expect(result.nextState).toBe(state);
    expect(result.nextState.pending).toHaveLength(0);
  });

  test("instant categories bypass batching", () => {
    const policy: PushBatchingPolicy = {
      ...DEFAULT_PUSH_BATCHING_POLICY,
      enabled: true,
      instant_categories: ["emergency"],
    };
    const state = createPushBatchState();
    const emergency = makePayload({ id: "p-e", category: "emergency" });
    const result = enqueuePush(state, emergency, policy, 1_234);
    expect(result.emit).toEqual([emergency]);
    expect(result.nextState.pending).toHaveLength(0);
  });
});

describe("enqueuePush batching", () => {
  const policy: PushBatchingPolicy = {
    ...DEFAULT_PUSH_BATCHING_POLICY,
    enabled: true,
    max_batch_size: 3,
    instant_categories: ["emergency"],
  };

  test("queues payloads without emitting when below threshold", () => {
    const p1 = makePayload({ id: "p-1", title: "First" });
    const p2 = makePayload({ id: "p-2", title: "Second" });

    const after1 = enqueuePush(createPushBatchState(), p1, policy, 1_000);
    expect(after1.emit).toBeNull();
    expect(after1.nextState.pending).toHaveLength(1);

    const after2 = enqueuePush(after1.nextState, p2, policy, 2_000);
    expect(after2.emit).toBeNull();
    expect(after2.nextState.pending).toHaveLength(2);
    expect(after2.nextState.pending.map((p) => p.id)).toEqual(["p-1", "p-2"]);
  });

  test("auto-flushes as digest when reaching max_batch_size", () => {
    const p1 = makePayload({ id: "p-1", title: "First" });
    const p2 = makePayload({ id: "p-2", title: "Second" });
    const p3 = makePayload({ id: "p-3", title: "Third" });

    const s1 = enqueuePush(createPushBatchState(), p1, policy, 1_000).nextState;
    const s2 = enqueuePush(s1, p2, policy, 2_000).nextState;
    const result = enqueuePush(s2, p3, policy, 3_000);

    expect(result.emit).not.toBeNull();
    expect(result.emit).toHaveLength(1);
    const digest = result.emit![0]!;
    expect(digest.id).toBe("digest-3000");
    expect(digest.title).toBe("3 new alerts");
    expect(digest.body).toBe("First; Second; Third");
    const data = digest.data as { kind: string; items: PushPayload[] };
    expect(data.kind).toBe("digest");
    expect(data.items).toHaveLength(3);
    expect(result.nextState.pending).toHaveLength(0);
    expect(result.nextState.lastFlushAt).toBe(3_000);
  });

  test("digest body joins only the first three titles", () => {
    const tinyPolicy: PushBatchingPolicy = { ...policy, max_batch_size: 5 };
    let state = createPushBatchState();
    for (let i = 1; i <= 4; i += 1) {
      state = enqueuePush(
        state,
        makePayload({ id: `id-${i}`, title: `T${i}` }),
        tinyPolicy,
        1_000 + i
      ).nextState;
    }
    // now 4 are pending; the 5th triggers auto-flush (pending+1 >= max=5)
    const result = enqueuePush(
      state,
      makePayload({ id: "id-5", title: "T5" }),
      tinyPolicy,
      2_000
    );
    const digest = result.emit![0]!;
    expect(digest.body).toBe("T1; T2; T3");
    const data = digest.data as { kind: string; items: PushPayload[] };
    expect(data.items).toHaveLength(5);
  });
});

describe("flushPushBatch", () => {
  const policy: PushBatchingPolicy = {
    ...DEFAULT_PUSH_BATCHING_POLICY,
    enabled: true,
  };

  test("empty pending returns null digest and updates lastFlushAt", () => {
    const result = flushPushBatch(createPushBatchState(), policy, 5_000);
    expect(result.digest).toBeNull();
    expect(result.nextState.pending).toHaveLength(0);
    expect(result.nextState.lastFlushAt).toBe(5_000);
  });

  test("single pending flushes as original payload, not digest", () => {
    const only = makePayload({ id: "p-only", title: "Solo" });
    const state = enqueuePush(createPushBatchState(), only, policy, 100).nextState;
    const result = flushPushBatch(state, policy, 200);
    expect(result.digest).not.toBeNull();
    expect(result.digest!.id).toBe("p-only");
    expect(result.digest!.title).toBe("Solo");
  });

  test("multiple pending flushes as digest payload", () => {
    let state = createPushBatchState();
    state = enqueuePush(state, makePayload({ id: "a", title: "A" }), policy, 100).nextState;
    state = enqueuePush(state, makePayload({ id: "b", title: "B" }), policy, 101).nextState;
    const result = flushPushBatch(state, policy, 500);
    expect(result.digest).not.toBeNull();
    expect(result.digest!.id).toBe("digest-500");
    expect(result.digest!.title).toBe("2 new alerts");
    expect(result.digest!.body).toBe("A; B");
    expect(result.nextState.pending).toHaveLength(0);
    expect(result.nextState.lastFlushAt).toBe(500);
  });

  test("digest in quiet hours still flushes at window boundary", () => {
    const quietPolicy: PushBatchingPolicy = {
      ...policy,
      quiet_hours_start_utc: 22,
      quiet_hours_end_utc: 6,
    };
    const t0 = Date.UTC(2024, 0, 1, 23, 0, 0);
    let state = createPushBatchState();
    state = enqueuePush(state, makePayload({ id: "q1", title: "Q1" }), quietPolicy, t0).nextState;
    state = enqueuePush(state, makePayload({ id: "q2", title: "Q2" }), quietPolicy, t0 + 10).nextState;
    expect(state.pending).toHaveLength(2);
    const result = flushPushBatch(state, quietPolicy, t0 + 30);
    expect(result.digest).not.toBeNull();
    expect(result.digest!.title).toBe("2 new alerts");
  });
});

describe("digest payload shape", () => {
  const policy: PushBatchingPolicy = {
    ...DEFAULT_PUSH_BATCHING_POLICY,
    enabled: true,
    max_batch_size: 2,
  };

  test("digest preserves item metadata for downstream consumers", () => {
    const p1 = makePayload({
      id: "x1",
      title: "Alpha",
      body: "Body A",
      priority: "high",
      category: "ops",
    });
    const p2 = makePayload({
      id: "x2",
      title: "Beta",
      body: "Body B",
      priority: "normal",
      category: "ops",
    });
    const s1 = enqueuePush(createPushBatchState(), p1, policy, 10).nextState;
    const result = enqueuePush(s1, p2, policy, 42);
    const digest = result.emit![0]!;
    expect(digest.id).toBe("digest-42");
    expect(digest.receivedAt).toBe(42);
    expect(digest.category).toBe("digest");
    const data = digest.data as { kind: string; items: Array<{ id: string; title: string; priority: string | null; category: string | null }> };
    expect(data.items.map((i) => i.id)).toEqual(["x1", "x2"]);
    expect(data.items[0]!.priority).toBe("high");
    expect(data.items[1]!.category).toBe("ops");
  });
});
