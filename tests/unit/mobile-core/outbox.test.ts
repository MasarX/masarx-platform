import { createOutbox, createOutboxId, DEFAULT_OUTBOX_AGING_POLICY, normalizeOutboxAgingPolicy,
  classifyOutboxAge, summarizeOutboxAging, pickDeadEntriesForPurge, formatRelativeAge,
  type OutboxAgingEntry, type OutboxEntry, type OutboxStore, type OutboxEnqueueInput } from "@masarx/mobile-core";

import { createMemoryOutboxStore } from "./memory-outbox-fixture";

test("outbox sync removes successful entries", async () => {
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  await outbox.init();

  await outbox.enqueue({ rpc: "rpc_ok", args: { ok: true }, id: "id-1" });
  expect(await outbox.countPending()).toBe(1);

  const result = await outbox.sync(async () => ({ ok: true }), { shouldRetry: () => true });
  expect(result.succeeded).toBe(1);
  expect(await outbox.countPending()).toBe(0);
});

test("outbox sync marks retriable failures as failed", async () => {
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  await outbox.init();

  await outbox.enqueue({ rpc: "rpc_fail", args: {}, id: "id-2" });
  const result = await outbox.sync(
    async () => {
      throw new Error("network");
    },
    { shouldRetry: () => true }
  );

  expect(result.failed).toBe(1);
  const entry = await store.get("id-2");
  expect(entry?.status).toBe("failed");
  expect(entry?.attempt_count).toBe(1);
  expect(entry?.next_attempt_at).toBeTruthy();
});

test("outbox sync marks non-retriable failures as dead", async () => {
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  await outbox.init();

  await outbox.enqueue({ rpc: "rpc_dead", args: {}, id: "id-3" });
  const result = await outbox.sync(
    async () => {
      throw new Error("forbidden");
    },
    { shouldRetry: () => false }
  );

  expect(result.dead).toBe(1);
  const entry = await store.get("id-3");
  expect(entry?.status).toBe("dead");
  expect(entry?.attempt_count).toBe(1);
  expect(entry?.next_attempt_at).toBeNull();
});


test("Edge replay uses the persisted target, actor and key in the same queue", async () => {
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  const args = { p_expected_actor_user_id: "actor-a", p_idempotency_key: "entry-edge" };
  await outbox.enqueue({ id: "entry-edge", rpc: "fieldops-reassignment-request", transport: "edge", args });
  const executor = jest.fn().mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 })).mockResolvedValueOnce({});
  const first = await outbox.sync(executor);
  expect(first.succeededIds).toEqual([]);
  expect((await store.get("entry-edge"))?.status).toBe("failed");
  await store.update("entry-edge", { next_attempt_at: null });
  const second = await createOutbox(store).sync(executor);
  expect(executor.mock.calls).toEqual([
    ["fieldops-reassignment-request", args, "edge"], ["fieldops-reassignment-request", args, "edge"],
  ]);
  expect(second.succeededIds).toEqual(["entry-edge"]);
  expect(second.succeeded).toBe(1);
});

test("legacy RPC entries remain RPC and unknown persisted transport never executes", async () => {
  const store = createMemoryOutboxStore();
  await store.enqueue({ id: "legacy", rpc: "legacy_rpc", args: {} });
  await store.enqueue({ id: "invalid", rpc: "remote", args: {}, transport: "unknown" as any });
  const executor = jest.fn().mockResolvedValue({});
  const result = await createOutbox(store).sync(executor, { shouldRetry: () => false });
  expect(executor.mock.calls).toEqual([["legacy_rpc", {}, "rpc"]]);
  expect(result.succeededIds).toEqual(["legacy"]);
  expect(result.dead).toBe(1);
  expect((await store.get("invalid"))?.status).toBe("dead");
});

test("removal failure and unrelated cleared entries cannot emit completion identities", async () => {
  const store = createMemoryOutboxStore();
  await store.enqueue({ id: "own", rpc: "rpc", args: {} });
  await store.enqueue({ id: "cleared", rpc: "rpc", args: {} });
  await store.remove("cleared");
  store.remove = jest.fn().mockRejectedValue(new Error("durable remove failed"));
  const result = await createOutbox(store).sync(jest.fn().mockResolvedValue({}));
  expect(result.succeeded).toBe(0);
  expect(result.succeededIds).toEqual([]);
  expect(result.failed).toBe(1);
});

test("unknown transport is rejected before persistence", async () => {
  const store = createMemoryOutboxStore();
  store.enqueue = jest.fn();
  await expect(createOutbox(store).enqueue({ rpc: "x", args: {}, transport: "http" as any }))
    .rejects.toThrow("Unsupported outbox transport");
  expect(store.enqueue).not.toHaveBeenCalled();
});

describe("outbox aging helpers", () => {
  const now = Date.parse("2026-04-21T12:00:00Z"), hour = 3_600_000, day = 24 * hour;
  const policy = DEFAULT_OUTBOX_AGING_POLICY;
  const entry = (id: string, status: OutboxAgingEntry["status"], ago: number): OutboxAgingEntry =>
    ({ id, status, created_at: new Date(now - ago).toISOString() });

  test.each([null, undefined, [], "bad", {}, { dead_ttl_days: -1, warn_pending_hours: NaN,
    max_entries_warn: 0, purge_batch_size: Infinity }])("normalizes invalid policy %j", raw => {
    expect(normalizeOutboxAgingPolicy(raw)).toEqual(policy);
  });
  test("normalizes partial policy, floors fractions and rejects overflow", () => {
    expect(normalizeOutboxAgingPolicy({ dead_ttl_days: 14.9, purge_batch_size: 3.5 }))
      .toEqual({ ...policy, dead_ttl_days: 14, purge_batch_size: 3 });
    expect(normalizeOutboxAgingPolicy({ dead_ttl_days: Number.MAX_SAFE_INTEGER,
      warn_pending_hours: Number.MAX_SAFE_INTEGER, max_entries_warn: "2" })).toEqual(policy);
  });
  test.each([
    ["queued", 6 * hour - 1, "fresh"], ["queued", 6 * hour, "stale"],
    ["failed", 12 * hour - 1, "stale"], ["in_flight", 12 * hour, "overdue"],
    ["dead", 7 * day - 1, "stale"], ["dead", 7 * day, "dead_expired"],
    ["succeeded", 30 * day, "fresh"],
  ] as const)("classifies %s at %d", (status, age, severity) => {
    expect(classifyOutboxAge(entry("one", status, age), policy, now)).toMatchObject({ ageMs: age, severity });
  });
  test("accepts timestamp forms, clamps future/invalid timestamps and uses updated_at activity", () => {
    for (const created_at of [now - hour, new Date(now - hour), new Date(now - hour).toISOString()]) {
      expect(classifyOutboxAge({ id: "one", status: "queued", created_at, updated_at: now - 60_000 }, policy, now))
        .toMatchObject({ ageMs: hour, idleMs: 60_000 });
    }
    expect(classifyOutboxAge({ ...entry("one", "queued", hour), updated_at: "invalid" }, policy, now).idleMs).toBe(hour);
    for (const created_at of ["invalid", new Date(NaN), now + hour]) {
      expect(classifyOutboxAge({ id: "one", status: "queued", created_at }, policy, now))
        .toMatchObject({ ageMs: 0, idleMs: 0 });
    }
  });
  test("summary prioritizes expired, then overdue, then strictly-over-limit count", () => {
    expect(summarizeOutboxAging([], policy, now)).toEqual({
      total: 0, overdue: 0, dead_expired: 0, oldest_ms: null, banner_message: null,
    });
    const overdue = entry("old", "queued", 12 * hour), dead = entry("dead", "dead", 7 * day);
    expect(summarizeOutboxAging([overdue, dead], policy, now)).toEqual({
      total: 2, overdue: 1, dead_expired: 1, oldest_ms: 7 * day,
      banner_message: "1 outbox item failed permanently; purge to clear.",
    });
    expect(summarizeOutboxAging([dead, dead], policy, now).banner_message).toBe("2 outbox items failed permanently; purge to clear.");
    expect(summarizeOutboxAging([overdue], policy, now).banner_message).toBe("1 outbox item is overdue; sync when online.");
    expect(summarizeOutboxAging([overdue, overdue], policy, now).banner_message).toBe("2 outbox items are overdue; sync when online.");
    const fresh = entry("fresh", "queued", 0), small = { ...policy, max_entries_warn: 1 };
    expect(summarizeOutboxAging([fresh], small, now).banner_message).toBeNull();
    expect(summarizeOutboxAging([fresh, fresh], small, now).banner_message).toBe("2 pending actions in outbox, sync when online.");
  });
  test("purge selection is dead-only, inclusive-TTL, oldest-first, bounded and non-mutating", () => {
    const entries = Object.freeze([
      entry("queued", "queued", 30 * day), entry("failed", "failed", 30 * day),
      entry("flight", "in_flight", 30 * day), entry("success", "succeeded", 30 * day),
      entry("young", "dead", 7 * day - 1), entry("threshold", "dead", 7 * day),
      entry("oldest", "dead", 20 * day), entry("middle", "dead", 10 * day),
      { ...entry("invalid", "dead", 0), created_at: "invalid" }, entry("future", "dead", -day),
    ].map(value => Object.freeze(value)));
    const before = JSON.stringify(entries);
    const picked = pickDeadEntriesForPurge(entries, { ...policy, purge_batch_size: 2 }, now);
    expect(picked.map(value => value.id)).toEqual(["oldest", "middle"]);
    expect(pickDeadEntriesForPurge(entries, policy, now).map(value => value.id)).toEqual(["oldest", "middle", "threshold"]);
    expect(picked[0]).toBe(entries[6]);
    expect(JSON.stringify(entries)).toBe(before);
    expect(pickDeadEntriesForPurge([], policy, now)).toEqual([]);
    expect(pickDeadEntriesForPurge(null as unknown as OutboxAgingEntry[], policy, now)).toEqual([]);
  });
  test("invalid clock fails before selecting any entry", () => {
    expect(() => classifyOutboxAge(entry("one", "queued", 0), policy, NaN)).toThrow("finite clock");
    expect(() => summarizeOutboxAging([], policy, Infinity)).toThrow("finite clock");
    expect(() => pickDeadEntriesForPurge([], policy, NaN)).toThrow("finite clock");
  });
  test.each([[0, "just now"], [-1, "just now"], [NaN, "just now"], [Infinity, "just now"],
    [59_999, "just now"], [60_000, "1m ago"], [hour - 1, "59m ago"],
    [hour, "1h ago"], [day - 1, "23h ago"], [day, "1d ago"], [2 * day + hour, "2d ago"]])
    ("relative age boundary %s", (value, expected) => { expect(formatRelativeAge(value as number)).toBe(expected); });
});

test.each([NaN, Infinity, -Infinity, -1, 0, 1.9, 9999])("sync normalizes query limit %s", async limit => {
  const store = createMemoryOutboxStore();
  store.listPending = jest.fn().mockResolvedValue([]);
  await createOutbox(store).sync(jest.fn(), { limit });
  expect(store.listPending).toHaveBeenCalledWith({ force: false, limit: Number.isFinite(limit) ? Math.min(500, Math.max(0, Math.floor(limit))) : 50 });
});

test("sync bounds backoff, sanitizes persisted errors and exhausts configured retries", async () => {
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  await outbox.enqueue({ id: "retry", rpc: "rpc", args: {} });
  const executor = jest.fn().mockRejectedValue({ message: "Bearer private-bearer api_key=private-key", password: "private-password" });
  const first = await outbox.sync(executor, { maxAttempts: 2, backoff: { base: NaN, max: Infinity } });
  expect(first).toMatchObject({ failed: 1, dead: 0, succeededIds: [] });
  const pending = await store.get("retry");
  expect(Number.isFinite(Date.parse(pending!.next_attempt_at!))).toBe(true);
  expect(pending?.last_error).toContain("[REDACTED]");
  expect(pending?.last_error).not.toMatch(/private-bearer|private-key|private-password/);
  await store.update("retry", { next_attempt_at: null });
  const second = await outbox.sync(executor, { maxAttempts: 2 });
  expect(second).toMatchObject({ dead: 1, failed: 0, succeededIds: [] });
  expect(await store.get("retry")).toMatchObject({ status: "dead", attempt_count: 2, next_attempt_at: null });
});

test.each([
  "Bearer private-token access_token=private-access",
  new Error("refresh_token=private-refresh eyJheader.payload.signature"),
  { secret: "private-secret", authorization: "private-auth" },
])("redacts string, stack and structured error values (case %#)", async error => {
  const store = createMemoryOutboxStore();
  await store.enqueue({ id: "redact", rpc: "rpc", args: {} });
  await createOutbox(store).sync(async () => { throw error; });
  expect((await store.get("redact"))?.last_error).not.toMatch(/private-|eyJheader/);
});

test("sync finite overflow and malformed attempts cannot strand an in-flight row", async () => {
  const store = createMemoryOutboxStore();
  store.recoverStaleInFlight = jest.fn().mockResolvedValue(0);
  await store.enqueue({ id: "bounded", rpc: "rpc", args: {} });
  await store.update("bounded", { attempt_count: NaN });
  await createOutbox(store).sync(async () => { throw new Error("retry"); }, {
    staleInFlightMs: Infinity, backoff: { base: Number.MAX_VALUE, max: Number.MAX_VALUE },
  });
  expect(store.recoverStaleInFlight).toHaveBeenCalledWith({ olderThanMs: 300000 });
  const entry = await store.get("bounded");
  expect(entry).toMatchObject({ status: "failed", attempt_count: 1 });
  expect(Number.isFinite(Date.parse(entry!.next_attempt_at!))).toBe(true);
});

test("id uses available crypto bytes before non-crypto fallback", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const random = jest.spyOn(Math, "random").mockReturnValue(0.5);
  const getRandomValues = jest.fn((bytes: Uint8Array) => { bytes.fill(171); return bytes; });
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });
    expect(createOutboxId()).toMatch(/^outbox_\d+_abababababababababababababababab$/);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(random).not.toHaveBeenCalled();
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    expect(createOutboxId()).toMatch(/^outbox_/);
    expect(random).toHaveBeenCalledTimes(1);
  } finally {
    random.mockRestore();
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test.each([
  { secret: 'prefix"private-tail' },
  { password: "prefix\\private-tail" },
  { token: 'prefix\\"private-tail', safe: "visible" },
])("redacts complete escaped JSON secrets through persistence (case %#)", async error => {
  const store = createMemoryOutboxStore();
  await store.enqueue({ id: "escaped", rpc: "rpc", args: {} });
  await createOutbox(store).sync(async () => { throw error; });
  const saved = (await store.get("escaped"))?.last_error;
  expect(saved).toContain("[REDACTED]");
  expect(saved).not.toMatch(/prefix|private-tail/);
  if ("safe" in error) expect(saved).toContain("visible");
});

test("historical diagnostic sanitizer consumes escaped and unterminated quoted values", () => {
  const { redactOutboxErrorText } = require("@masarx/mobile-core");
  for (const source of [
    JSON.stringify({ secret: 'prefix"private-tail', safe: "visible" }),
    JSON.stringify({ password: "prefix\\private-tail", safe: "visible" }),
    "secret='prefix\\'private-tail' safe=visible",
    'secret="prefix\\"private-tail',
  ]) {
    const redacted = redactOutboxErrorText(source);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toMatch(/prefix|private-tail/);
    if (source.includes("visible")) expect(redacted).toContain("visible");
  }
});

test("client display labels never enter RPC or Edge executor arguments", async () => {
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  const args = { p_expected_actor_user_id: "actor", p_idempotency_key: "key" };
  for (const transport of ["rpc", "edge"] as const) {
    await outbox.enqueue({ id: transport, rpc: transport, transport, args,
      display: { actionLabel: " Complete ", targetLabel: " Shipment A " } });
    expect((await outbox.get(transport))?.display).toEqual({ actionLabel: "Complete", targetLabel: "Shipment A" });
  }
  const executor = jest.fn().mockResolvedValue({});
  await outbox.sync(executor);
  expect(executor.mock.calls).toEqual([["rpc", args, "rpc"], ["edge", args, "edge"]]);
  expect(args).toEqual({ p_expected_actor_user_id: "actor", p_idempotency_key: "key" });
});

test("display normalization retains only nonblank labels and ignores other snapshots", () => {
  const { normalizeOutboxDisplay } = require("@masarx/mobile-core");
  expect(normalizeOutboxDisplay({ actionLabel: " Approve ", targetLabel: null, secret: "drop" }))
    .toEqual({ actionLabel: "Approve" });
  for (const value of [null, [], "label", {}, { actionLabel: " ", targetLabel: 42 }]) {
    expect(normalizeOutboxDisplay(value)).toBeUndefined();
  }
});
