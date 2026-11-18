import {
  DEFAULT_OUTBOX_AGING_POLICY,
  classifyOutboxAge,
  formatRelativeAge,
  normalizeOutboxAgingPolicy,
  pickDeadEntriesForPurge,
  summarizeOutboxAging,
  type OutboxAgingPolicy,
  type OutboxEntryLike,
} from "../../../apps/fieldops/src/mobile-outbox-aging";

const NOW = Date.parse("2026-04-21T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function makeEntry(overrides: Partial<OutboxEntryLike> = {}): OutboxEntryLike {
  return {
    id: overrides.id ?? "entry_1",
    rpc: overrides.rpc ?? "rpc.create_order",
    status: overrides.status ?? "queued",
    attempt_count: overrides.attempt_count ?? 0,
    created_at: overrides.created_at ?? new Date(NOW - 5 * MINUTE).toISOString(),
    last_attempted_at: overrides.last_attempted_at ?? null,
    last_error: overrides.last_error ?? null,
    idempotency_key: overrides.idempotency_key ?? null,
  };
}

describe("normalizeOutboxAgingPolicy", () => {
  test("null/undefined/empty fall back to defaults", () => {
    expect(normalizeOutboxAgingPolicy(null)).toEqual(DEFAULT_OUTBOX_AGING_POLICY);
    expect(normalizeOutboxAgingPolicy(undefined)).toEqual(DEFAULT_OUTBOX_AGING_POLICY);
    expect(normalizeOutboxAgingPolicy({})).toEqual(DEFAULT_OUTBOX_AGING_POLICY);
    expect(normalizeOutboxAgingPolicy([])).toEqual(DEFAULT_OUTBOX_AGING_POLICY);
    expect(normalizeOutboxAgingPolicy("not-an-object")).toEqual(DEFAULT_OUTBOX_AGING_POLICY);
  });

  test("partial input keeps specified fields and defaults the rest", () => {
    const normalized = normalizeOutboxAgingPolicy({
      dead_ttl_days: 14,
      max_entries_warn: 100,
    });
    expect(normalized.dead_ttl_days).toBe(14);
    expect(normalized.max_entries_warn).toBe(100);
    expect(normalized.warn_pending_hours).toBe(
      DEFAULT_OUTBOX_AGING_POLICY.warn_pending_hours
    );
    expect(normalized.purge_batch_size).toBe(
      DEFAULT_OUTBOX_AGING_POLICY.purge_batch_size
    );
  });

  test("invalid numerics fall back per-field", () => {
    const normalized = normalizeOutboxAgingPolicy({
      dead_ttl_days: -4,
      warn_pending_hours: Number.NaN,
      max_entries_warn: 0,
      purge_batch_size: "nope",
    });
    expect(normalized).toEqual(DEFAULT_OUTBOX_AGING_POLICY);
  });

  test("floors floats to integers", () => {
    const normalized = normalizeOutboxAgingPolicy({
      dead_ttl_days: 3.9,
      purge_batch_size: 10.4,
    });
    expect(normalized.dead_ttl_days).toBe(3);
    expect(normalized.purge_batch_size).toBe(10);
  });
});

describe("classifyOutboxAge", () => {
  const policy: OutboxAgingPolicy = { ...DEFAULT_OUTBOX_AGING_POLICY };

  test("fresh entry under half the warn window", () => {
    const entry = makeEntry({ created_at: new Date(NOW - 2 * HOUR).toISOString() });
    const classified = classifyOutboxAge(entry, policy, NOW);
    expect(classified.severity).toBe("fresh");
    expect(classified.ageMs).toBe(2 * HOUR);
  });

  test("stale entry past half the warn window but under it", () => {
    const entry = makeEntry({ created_at: new Date(NOW - 7 * HOUR).toISOString() });
    const classified = classifyOutboxAge(entry, policy, NOW);
    expect(classified.severity).toBe("stale");
  });

  test("overdue entry past warn_pending_hours", () => {
    const entry = makeEntry({ created_at: new Date(NOW - 13 * HOUR).toISOString() });
    const classified = classifyOutboxAge(entry, policy, NOW);
    expect(classified.severity).toBe("overdue");
    expect(classified.ageMs).toBe(13 * HOUR);
  });

  test("dead entry past dead_ttl_days is dead_expired", () => {
    const entry = makeEntry({
      status: "dead",
      created_at: new Date(NOW - 8 * DAY).toISOString(),
    });
    const classified = classifyOutboxAge(entry, policy, NOW);
    expect(classified.severity).toBe("dead_expired");
  });

  test("dead entry younger than TTL is not dead_expired", () => {
    const entry = makeEntry({
      status: "dead",
      created_at: new Date(NOW - 2 * DAY).toISOString(),
    });
    const classified = classifyOutboxAge(entry, policy, NOW);
    expect(classified.severity).not.toBe("dead_expired");
  });

  test("idleMs uses last_attempted_at when available", () => {
    const entry = makeEntry({
      created_at: new Date(NOW - 5 * HOUR).toISOString(),
      last_attempted_at: new Date(NOW - 30 * MINUTE).toISOString(),
    });
    const classified = classifyOutboxAge(entry, policy, NOW);
    expect(classified.idleMs).toBe(30 * MINUTE);
    expect(classified.ageMs).toBe(5 * HOUR);
  });

  test("synced entries stay fresh regardless of age", () => {
    const entry = makeEntry({
      status: "synced",
      created_at: new Date(NOW - 30 * DAY).toISOString(),
    });
    const classified = classifyOutboxAge(entry, policy, NOW);
    expect(classified.severity).toBe("fresh");
  });

  test("accepts numeric and Date created_at", () => {
    const numeric = classifyOutboxAge(
      makeEntry({ created_at: NOW - 30 * MINUTE }),
      policy,
      NOW
    );
    const dated = classifyOutboxAge(
      makeEntry({ created_at: new Date(NOW - 30 * MINUTE) }),
      policy,
      NOW
    );
    expect(numeric.ageMs).toBe(30 * MINUTE);
    expect(dated.ageMs).toBe(30 * MINUTE);
  });
});

describe("summarizeOutboxAging", () => {
  const policy: OutboxAgingPolicy = { ...DEFAULT_OUTBOX_AGING_POLICY };

  test("empty list yields zeros and null banner", () => {
    const summary = summarizeOutboxAging([], policy, NOW);
    expect(summary.total).toBe(0);
    expect(summary.overdue).toBe(0);
    expect(summary.dead_expired).toBe(0);
    expect(summary.oldest_ms).toBeNull();
    expect(summary.banner_message).toBeNull();
  });

  test("one overdue entry yields overdue banner", () => {
    const entries = [
      makeEntry({
        id: "a",
        created_at: new Date(NOW - 13 * HOUR).toISOString(),
      }),
    ];
    const summary = summarizeOutboxAging(entries, policy, NOW);
    expect(summary.total).toBe(1);
    expect(summary.overdue).toBe(1);
    expect(summary.dead_expired).toBe(0);
    expect(summary.banner_message).not.toBeNull();
    expect(summary.banner_message).toMatch(/overdue/i);
  });

  test("one dead_expired entry yields purge banner and dominates over overdue", () => {
    const entries = [
      makeEntry({
        id: "a",
        status: "dead",
        created_at: new Date(NOW - 9 * DAY).toISOString(),
      }),
      makeEntry({
        id: "b",
        created_at: new Date(NOW - 13 * HOUR).toISOString(),
      }),
    ];
    const summary = summarizeOutboxAging(entries, policy, NOW);
    expect(summary.dead_expired).toBe(1);
    expect(summary.overdue).toBe(1);
    expect(summary.banner_message).toMatch(/purge/i);
  });

  test("banner mentions count when total exceeds max_entries_warn", () => {
    const entries: OutboxEntryLike[] = [];
    for (let i = 0; i < policy.max_entries_warn + 5; i += 1) {
      entries.push(
        makeEntry({
          id: `e${i}`,
          created_at: new Date(NOW - 2 * MINUTE).toISOString(),
        })
      );
    }
    const summary = summarizeOutboxAging(entries, policy, NOW);
    expect(summary.total).toBe(policy.max_entries_warn + 5);
    expect(summary.overdue).toBe(0);
    expect(summary.dead_expired).toBe(0);
    expect(summary.banner_message).not.toBeNull();
    expect(summary.banner_message).toContain(String(policy.max_entries_warn + 5));
  });

  test("all-fresh entries under max_entries_warn yield null banner", () => {
    const entries = [
      makeEntry({ id: "a", created_at: new Date(NOW - 1 * MINUTE).toISOString() }),
      makeEntry({ id: "b", created_at: new Date(NOW - 2 * MINUTE).toISOString() }),
    ];
    const summary = summarizeOutboxAging(entries, policy, NOW);
    expect(summary.banner_message).toBeNull();
    expect(summary.oldest_ms).toBe(2 * MINUTE);
  });

  test("oldest_ms reflects the oldest entry in the list", () => {
    const entries = [
      makeEntry({ id: "a", created_at: new Date(NOW - 10 * MINUTE).toISOString() }),
      makeEntry({ id: "b", created_at: new Date(NOW - 120 * MINUTE).toISOString() }),
      makeEntry({ id: "c", created_at: new Date(NOW - 30 * MINUTE).toISOString() }),
    ];
    const summary = summarizeOutboxAging(entries, policy, NOW);
    expect(summary.oldest_ms).toBe(120 * MINUTE);
  });
});

describe("pickDeadEntriesForPurge", () => {
  const policy: OutboxAgingPolicy = {
    ...DEFAULT_OUTBOX_AGING_POLICY,
    purge_batch_size: 3,
  };

  test("returns only dead entries older than TTL", () => {
    const entries = [
      makeEntry({ id: "keep_queued", status: "queued", created_at: new Date(NOW - 30 * DAY).toISOString() }),
      makeEntry({ id: "keep_failed", status: "failed", created_at: new Date(NOW - 30 * DAY).toISOString() }),
      makeEntry({ id: "keep_dead_young", status: "dead", created_at: new Date(NOW - 1 * DAY).toISOString() }),
      makeEntry({ id: "drop_dead_old", status: "dead", created_at: new Date(NOW - 10 * DAY).toISOString() }),
    ];
    const picked = pickDeadEntriesForPurge(entries, policy, NOW);
    expect(picked.map((e) => e.id)).toEqual(["drop_dead_old"]);
  });

  test("caps at purge_batch_size and sorts oldest-first", () => {
    const entries = [
      makeEntry({ id: "d1", status: "dead", created_at: new Date(NOW - 8 * DAY).toISOString() }),
      makeEntry({ id: "d2", status: "dead", created_at: new Date(NOW - 20 * DAY).toISOString() }),
      makeEntry({ id: "d3", status: "dead", created_at: new Date(NOW - 10 * DAY).toISOString() }),
      makeEntry({ id: "d4", status: "dead", created_at: new Date(NOW - 15 * DAY).toISOString() }),
      makeEntry({ id: "d5", status: "dead", created_at: new Date(NOW - 9 * DAY).toISOString() }),
    ];
    const picked = pickDeadEntriesForPurge(entries, policy, NOW);
    expect(picked).toHaveLength(3);
    expect(picked.map((e) => e.id)).toEqual(["d2", "d4", "d3"]);
  });

  test("empty/invalid lists return empty array", () => {
    expect(pickDeadEntriesForPurge([], policy, NOW)).toEqual([]);
    expect(pickDeadEntriesForPurge(null as unknown as OutboxEntryLike[], policy, NOW)).toEqual([]);
  });
});

describe("formatRelativeAge", () => {
  test("zero and negative intervals are 'just now'", () => {
    expect(formatRelativeAge(0)).toBe("just now");
    expect(formatRelativeAge(-5_000)).toBe("just now");
    expect(formatRelativeAge(30 * 1_000)).toBe("just now");
  });

  test("minutes band", () => {
    expect(formatRelativeAge(1 * MINUTE)).toBe("1m ago");
    expect(formatRelativeAge(3 * MINUTE)).toBe("3m ago");
    expect(formatRelativeAge(59 * MINUTE)).toBe("59m ago");
  });

  test("hours band", () => {
    expect(formatRelativeAge(1 * HOUR)).toBe("1h ago");
    expect(formatRelativeAge(2 * HOUR)).toBe("2h ago");
    expect(formatRelativeAge(12 * HOUR)).toBe("12h ago");
    expect(formatRelativeAge(23 * HOUR + 59 * MINUTE)).toBe("23h ago");
  });

  test("days band rounds down", () => {
    expect(formatRelativeAge(1 * DAY)).toBe("1d ago");
    expect(formatRelativeAge(2 * DAY + 3 * HOUR)).toBe("2d ago");
    expect(formatRelativeAge(10 * DAY)).toBe("10d ago");
  });

  test("non-finite input is 'just now'", () => {
    expect(formatRelativeAge(Number.NaN)).toBe("just now");
    expect(formatRelativeAge(Number.POSITIVE_INFINITY)).toBe("just now");
  });
});
