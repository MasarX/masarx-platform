import { createMemoryKeyValueStore, createMemoryOutboxStore } from "../../../apps/fieldops/src/mobile-memory-store";

describe("mobile memory stores", () => {
  test("restores and snapshots complete entries without aliasing mutable fields", async () => {
    const original = createMemoryOutboxStore();
    await original.enqueue({ id: "saved", rpc: "depart", args: { route: "one" } });
    const snapshot = original.snapshot();
    const restored = createMemoryOutboxStore(snapshot);
    snapshot[0].args.route = "changed";
    restored.snapshot()[0].args.route = "also changed";
    expect((await restored.get("saved"))?.args).toEqual({ route: "one" });
    expect((await restored.get("saved"))?.created_at).toBe((await original.get("saved"))?.created_at);
  });

  test("memory outbox supports enqueue, claim, update, and clear", async () => {
    const store = createMemoryOutboxStore();
    await store.init();

    const first = await store.enqueue({
      id: "entry-1",
      rpc: "ui_execute_command_v1",
      args: { p_action_key: "tasks.complete" },
    });

    expect(first.id).toBe("entry-1");
    expect(await store.countPending()).toBe(1);

    const claimed = await store.claimPending?.({ limit: 10 });
    expect(claimed?.length).toBe(1);
    expect(claimed?.[0].status).toBe("in_flight");

    await store.update("entry-1", {
      status: "failed",
      attempt_count: 1,
      next_attempt_at: null,
      last_error: "temporary",
    });

    expect(await store.countPending()).toBe(1);

    const deleted = await store.clear({ status: ["failed", "queued"] });
    expect(deleted).toBe(1);
    expect(await store.countPending()).toBe(0);
  });

  test("memory key/value store persists values for the process lifetime", async () => {
    const store = createMemoryKeyValueStore();
    await store.init();

    expect(await store.get("theme")).toBeNull();
    await store.set("theme", "dark");
    expect(await store.get("theme")).toBe("dark");

    await store.remove("theme");
    expect(await store.get("theme")).toBeNull();

    await store.set("locale", "en");
    await store.set("direction", "ltr");
    const cleared = await store.clear();
    expect(cleared).toBe(2);
    expect(await store.get("locale")).toBeNull();
    expect(await store.get("direction")).toBeNull();
  });

  test("memory outbox handles duplicate ids, list filters, and clear-all", async () => {
    const store = createMemoryOutboxStore();
    await store.init();

    await store.enqueue({ id: "a1", rpc: "rpc.a", args: { x: 1 } });
    const duplicate = await store.enqueue({ id: "a1", rpc: "rpc.b", args: { y: 2 } });
    expect(duplicate.rpc).toBe("rpc.a");

    await store.enqueue({ id: "a2", rpc: "rpc.b", args: {} });
    await store.update("a2", { status: "failed", next_attempt_at: null });
    const filtered = await store.list({ status: ["failed"], limit: 1 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("a2");

    const totalCleared = await store.clear();
    expect(totalCleared).toBe(2);
    expect(await store.list()).toEqual([]);
    expect(await store.get("missing-id")).toBeNull();
  });

  test("memory outbox pending and stale recovery behaviors are deterministic", async () => {
    const store = createMemoryOutboxStore();
    await store.init();

    await store.enqueue({ id: "p1", rpc: "rpc.pending", args: {} });
    await store.enqueue({ id: "p2", rpc: "rpc.future", args: {} });
    await store.update("p2", {
      status: "failed",
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.enqueue({ id: "p3", rpc: "rpc.flight", args: {} });
    await store.update("p3", {
      status: "in_flight",
      updated_at: new Date(Date.now() - 120_000).toISOString(),
    });

    const pending = await store.listPending({ limit: 10 });
    expect(pending.map((entry) => entry.id)).toEqual(["p1"]);

    const claimed = await store.claimPending({ limit: 5 });
    expect(claimed.map((entry) => entry.id)).toEqual(["p1"]);
    expect(claimed[0]?.status).toBe("in_flight");

    await store.update("p1", {
      rpc: "rpc.updated",
      args: { rewritten: true },
      status: "failed",
      attempt_count: 3,
      next_attempt_at: null,
      last_error: "retry",
      updated_at: "2026-03-04T00:00:00.000Z",
    });
    const updated = await store.get("p1");
    expect(updated?.rpc).toBe("rpc.updated");
    expect(updated?.args).toEqual({ rewritten: true });
    expect(updated?.attempt_count).toBe(3);
    expect(updated?.last_error).toBe("retry");

    await store.update("missing", { status: "failed" });

    const recovered = await store.recoverStaleInFlight({ olderThanMs: 30_000 });
    expect(recovered).toBe(1);
    const recoveredEntry = await store.get("p3");
    expect(recoveredEntry?.status).toBe("failed");
    expect(recoveredEntry?.last_error).toContain("Recovered stale");

    await store.remove("p3");
    expect(await store.get("p3")).toBeNull();
  });

  test("memory outbox default branches cover id generation, sorting, and selective clear", async () => {
    const store = createMemoryOutboxStore();
    await store.init();

    const generated = await store.enqueue({ rpc: "rpc.auto-id", args: undefined as any });
    expect(typeof generated.id).toBe("string");
    expect(generated.id.length).toBeGreaterThan(10);
    expect(generated.args).toEqual({});

    await store.enqueue({ id: "s1", rpc: "rpc.sort", args: {} });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.enqueue({ id: "s2", rpc: "rpc.sort", args: {} });

    const listed = await store.list();
    expect(listed.length).toBeGreaterThanOrEqual(3);
    const listedPending = await store.listPending();
    expect(listedPending.length).toBeGreaterThan(0);
    const claimed = await store.claimPending();
    expect(claimed.length).toBeGreaterThan(0);

    await store.update("s2", { status: "failed", last_error: null });
    const deleted = await store.clear({ status: ["failed"] });
    expect(deleted).toBe(1);
    const remaining = await store.list();
    expect(remaining.some((entry) => entry.id === "s1")).toBe(true);
  });

  test("memory outbox recovery skips non-stale records and invalid timestamps", async () => {
    const store = createMemoryOutboxStore();
    await store.init();

    await store.enqueue({ id: "r1", rpc: "rpc.recover", args: {} });
    await store.enqueue({ id: "r2", rpc: "rpc.recover", args: {} });
    await store.update("r1", {
      status: "in_flight",
      updated_at: "",
    });
    await store.update("r2", {
      status: "in_flight",
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const recovered = await store.recoverStaleInFlight({ olderThanMs: 10_000 });
    expect(recovered).toBe(0);
    expect((await store.get("r1"))?.status).toBe("in_flight");
    expect((await store.get("r2"))?.status).toBe("in_flight");
  });

  test("memory key/value store normalizes nullish set values", async () => {
    const store = createMemoryKeyValueStore();
    await store.init();

    await store.set("nullable", undefined as any);
    expect(await store.get("nullable")).toBeNull();
    await store.set("nullable", null);
    expect(await store.get("nullable")).toBeNull();
  });
});

test("memory store retains Edge transport and actor across claim and recovery", async () => {
  const store = createMemoryOutboxStore();
  const args = { p_expected_actor_user_id: "actor-a", p_idempotency_key: "edge-key" };
  await store.enqueue({ id: "edge", rpc: "fieldops-reassignment-request", transport: "edge", args });
  expect((await store.claimPending({ limit: 1 }))[0]).toMatchObject({ transport: "edge", args });
  await store.update("edge", { updated_at: "2000-01-01T00:00:00.000Z" });
  await store.recoverStaleInFlight({ olderThanMs: 1000 });
  expect((await store.claimPending({ limit: 1 }))[0]).toMatchObject({ transport: "edge", args });
});

test("memory query bounds and explicit force retain scheduled work without claiming dead or in-flight", async () => {
  const store = createMemoryOutboxStore();
  for (const id of ["ready", "future", "dead", "flight"]) await store.enqueue({ id, rpc: "rpc", args: {} });
  await store.update("future", { status: "failed", next_attempt_at: new Date(Date.now() + 60000).toISOString() });
  await store.update("dead", { status: "dead" });
  await store.update("flight", { status: "in_flight" });
  expect(await store.countPending()).toBe(1);
  expect(await store.listPending({ limit: -1 })).toEqual([]);
  expect(await store.listPending({ limit: Infinity })).toHaveLength(1);
  expect(await store.list({ limit: 1.9 })).toHaveLength(1);
  expect((await store.listPending({ force: true })).map(entry => entry.id).sort()).toEqual(["future", "ready"]);
  expect((await store.claimPending({ force: true })).map(entry => entry.id).sort()).toEqual(["future", "ready"]);
  expect((await store.get("dead"))?.status).toBe("dead");
  expect((await store.get("flight"))?.status).toBe("in_flight");
});

test("memory recovery normalizes nonfinite duration to selected fallback", async () => {
  const store = createMemoryOutboxStore();
  await store.enqueue({ id: "old", rpc: "rpc", args: {} });
  await store.update("old", { status: "in_flight", updated_at: new Date(Date.now() - 60000).toISOString() });
  expect(await store.recoverStaleInFlight?.({ olderThanMs: NaN })).toBe(1);
});

test("memory display labels are normalized, cloned and first-write-wins", async () => {
  const store = createMemoryOutboxStore();
  const display = { actionLabel: " Complete ", targetLabel: " Shipment A ", ignored: "drop" };
  const first = await store.enqueue({ id: "display", rpc: "rpc", args: {}, display });
  display.actionLabel = "caller mutation";
  first.display!.targetLabel = "returned mutation";
  const duplicate = await store.enqueue({ id: "display", rpc: "different", args: {}, display: { actionLabel: "replacement" } });
  expect(duplicate.display).toEqual({ actionLabel: "Complete", targetLabel: "Shipment A" });
  duplicate.display!.actionLabel = "duplicate mutation";
  const claimed = await store.claimPending({ limit: 1 });
  expect(claimed[0].display).toEqual({ actionLabel: "Complete", targetLabel: "Shipment A" });
  claimed[0].display!.actionLabel = "claim mutation";
  expect((await store.get("display"))?.display).toEqual({ actionLabel: "Complete", targetLabel: "Shipment A" });
});
