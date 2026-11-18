import { createWebKeyValueStore as outboxCache, createWebOutboxStore as outboxStore } from "../../../apps/fieldops/src/mobile-web-store";
import * as fs from "node:fs";
import * as path from "node:path";
import { createOutbox } from "@masarx/mobile-core";
const scope = { userId: "user-a", organizationId: "org-a" };
const createWebOutboxStore = () => outboxStore(scope);
const createWebKeyValueStore = () => outboxCache(scope);
const queueKey = "fieldops:outbox:v1:user-a:org-a";
const cacheKey = "fieldops:cache:v1:user-a:org-a";

describe("durable FieldOps web stores", () => {
  let values: Map<string, string>;
  let storage: Storage;
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  beforeEach(() => {
    values = new Map();
    storage = {
      getItem: jest.fn((key) => values.get(key) ?? null),
      setItem: jest.fn((key, value) => { values.set(key, value); }),
      removeItem: jest.fn((key) => { values.delete(key); }),
      clear: jest.fn(() => values.clear()),
      key: jest.fn(),
      get length() { return values.size; },
    };
    const locks = new Map<string, Promise<unknown>>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: jest.fn((name: string, callback: () => Promise<unknown>) => {
        const next = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(callback);
        locks.set(name, next);
        return next;
      }) } },
    });
  });

  afterAll(() => {
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });

  test("keeps offline requests and cache across reconstructed stores, with duplicate IDs unchanged", async () => {
    const outbox = createWebOutboxStore();
    await outbox.init();
    await outbox.enqueue({ id: "departure", rpc: "depart", args: { shipment: "one" } });
    const reloaded = createWebOutboxStore();
    expect(await reloaded.countPending()).toBe(1);
    expect((await reloaded.enqueue({ id: "departure", rpc: "other", args: {} })).rpc).toBe("depart");
    const cache = createWebKeyValueStore();
    await cache.init();
    await cache.set("route", { id: "one" });
    expect(await createWebKeyValueStore().get("route")).toEqual({ id: "one" });
  });

  test("serializes independent tabs' writes and claims each request once", async () => {
    const a = createWebOutboxStore();
    const b = createWebOutboxStore();
    await Promise.all([
      a.enqueue({ id: "a", rpc: "depart", args: {} }),
      b.enqueue({ id: "b", rpc: "depart", args: {} }),
    ]);
    const results = await Promise.all([a.claimPending!({}), b.claimPending!({})]);
    expect(results.flat().map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(results.flat().every((entry) => entry.status === "in_flight")).toBe(true);
    expect(await a.countPending()).toBe(0);
  });

  test("retains more than 500 requests and original chronology across every durable write", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `request-${index}`, rpc: "depart", transport: "rpc", args: { route: index },
      status: "queued", created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updated_at: "2026-01-01T00:00:00.000Z", attempt_count: 0,
      next_attempt_at: null, last_error: null,
    }));
    storage.setItem(queueKey, JSON.stringify(rows));
    const store = createWebOutboxStore();
    await store.init();
    expect(JSON.parse(storage.getItem(queueKey)!)).toHaveLength(501);
    expect(await store.countPending()).toBe(501);
    expect(await store.list({ limit: Number.MAX_SAFE_INTEGER })).toHaveLength(500);
    expect((await store.get("request-0"))?.created_at).toBe(rows[0].created_at);

    await store.enqueue({ id: "new", rpc: "depart", args: {} });
    expect((await store.enqueue({ id: "request-0", rpc: "other", args: {} })).rpc).toBe("depart");
    const reloaded = createWebOutboxStore();
    expect(await reloaded.countPending()).toBe(502);
    expect((await reloaded.claimPending!({ limit: 1 }))[0].id).toBe("request-0");
    expect((await createWebOutboxStore().get("request-0"))?.status).toBe("in_flight");
    await reloaded.update("request-0", { status: "failed", attempt_count: 3 });
    expect((await createWebOutboxStore().get("request-0"))?.created_at).toBe(rows[0].created_at);
    await reloaded.remove("new");
    expect(await createWebOutboxStore().countPending()).toBe(501);
    expect(await reloaded.clear({ status: ["failed"] })).toBe(1);
    expect(await createWebOutboxStore().countPending()).toBe(500);
    expect((await createWebOutboxStore().get("request-500"))?.rpc).toBe("depart");
  });

  test("preserves retry metadata, recovers stale claims and filters/clears terminal requests", async () => {
    const store = createWebOutboxStore();
    await store.enqueue({ id: "a", rpc: "depart", args: {} });
    await store.claimPending!({ limit: 1 });
    await store.update("a", { updated_at: "2020-01-01T00:00:00.000Z", attempt_count: 3 });
    expect(await createWebOutboxStore().recoverStaleInFlight!({ olderThanMs: 1000 })).toBe(1);
    expect((await store.get("a"))?.attempt_count).toBe(3);
    await store.update("a", { status: "succeeded" });
    expect(await store.list({ status: ["succeeded"] })).toHaveLength(1);
    expect(await store.clear({ status: ["failed"] })).toBe(0);
    expect(await store.clear()).toBe(1);
    expect(await createWebOutboxStore().list()).toEqual([]);
  });

  test("logout clear removes cache and outbox without touching auth or unrelated keys", async () => {
    storage.setItem("auth", "token");
    const cache = createWebKeyValueStore();
    await cache.set("route", 1);
    await cache.set("theme", "dark");
    await cache.remove("theme");
    expect(await cache.get("theme")).toBeNull();
    const store = createWebOutboxStore();
    await store.enqueue({ id: "a", rpc: "depart", args: {} });
    await store.remove("a");
    expect(await store.get("a")).toBeNull();
    expect(await cache.clear()).toBe(1);
    expect(await createWebKeyValueStore().get("route")).toBeNull();
    expect(storage.getItem("auth")).toBe("token");
  });

  test.each(["not json", "{}", '[{"id":"invalid"}]'])("rejects corrupt queue without overwriting it: %s", async (raw) => {
    storage.setItem(queueKey, raw);
    await expect(createWebOutboxStore().init()).rejects.toThrow();
    expect(storage.getItem(queueKey)).toBe(raw);
  });

  test("rejects corrupt cache and unavailable browser facilities", async () => {
    storage.setItem(cacheKey, '[1]');
    await expect(createWebKeyValueStore().init()).rejects.toThrow("Offline cache is invalid");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await expect(createWebOutboxStore().enqueue({ rpc: "depart", args: {} })).rejects.toThrow("unavailable");
  });

  test("quota failure never acknowledges an enqueue or changes the retained queue", async () => {
    const store = createWebOutboxStore();
    await store.enqueue({ id: "saved", rpc: "depart", args: {} });
    const original = storage.getItem(queueKey);
    (storage.setItem as jest.Mock).mockImplementationOnce(() => { throw new Error("Quota exceeded"); });
    await expect(store.enqueue({ id: "lost", rpc: "depart", args: {} })).rejects.toThrow("Quota exceeded");
    expect(storage.getItem(queueKey)).toBe(original);
    expect(await store.get("lost")).toBeNull();
    (storage.getItem as jest.Mock).mockImplementationOnce(() => { throw new Error("Storage denied"); });
    await expect(store.countPending()).rejects.toThrow("Storage denied");
  });

  test("app uses durable web stores, retains native sqlite and clears both on logout", () => {
    const app = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
    expect(app).toContain("? createWebOutboxStore(webStoreScope)");
    expect(app).toContain("? createWebKeyValueStore(webStoreScope)");
    expect(app).toContain(': createSqliteOutboxStore({ databaseName: "fieldops.db", tableName: "outbox" })');
    expect(app).toContain(': createSqliteKeyValueStore({ databaseName: "fieldops.db", tableName: "kv_store" })');
    expect(app).toContain("await outboxStore.clear();");
    expect(app).toContain("clearEvidenceLocalState(pendingEvidence, () => outboxStore.clear(), () => cacheStore.clear())");
    expect(app).toContain("outboxInitQuery.isError || cacheInitQuery.isError");
    expect(app).toContain('if (Platform.OS === "web") return "Unavailable in the web app";');
    expect(app).toContain('queryKey: ["outbox", "init", webScopeKey]');
    expect(app).toContain("boundWebScope !== webScopeKey");
    expect(app).toContain("queryClient.removeQueries({ predicate })");
    expect(app).toContain("data.session?.user.id !== webUserId");
    expect(app).toContain("await webStoreScope.assertCurrent()");
    expect(app).toContain('Platform.OS === "web" ? auth.revision : null');
    const diagnosticClear = app.slice(app.indexOf("onClearLocal={async () =>"), app.indexOf("onRetryDeviceRegistration="));
    expect(diagnosticClear.indexOf("await outboxStore.clear()")).toBeLessThan(diagnosticClear.indexOf("client.auth.signOut"));
  });

  test("isolates two users and organizations while preserving the prior user's queue", async () => {
    const original = outboxStore(scope);
    await original.enqueue({ id: "old-user", rpc: "depart", args: { shipment: "private" } });
    await outboxCache(scope).set("activeOpsSession", "private-session");
    const otherUser = { userId: "user-b", organizationId: "org-a" };
    const otherOrg = { userId: "user-a", organizationId: "org-b" };
    for (const other of [otherUser, otherOrg]) {
      expect(await outboxStore(other).claimPending!({})).toEqual([]);
      expect(await outboxCache(other).get("activeOpsSession")).toBeNull();
      const executor = jest.fn();
      await createOutbox(outboxStore(other)).sync(executor);
      expect(executor).not.toHaveBeenCalled();
      await outboxStore(other).enqueue({ id: "own", rpc: "depart", args: {} });
      expect((await outboxStore(other).claimPending!({}))[0].id).toBe("own");
    }
    expect((await outboxStore(scope).get("old-user"))?.args).toEqual({ shipment: "private" });
    expect(await outboxCache(scope).get("activeOpsSession")).toBe("private-session");
  });

  test("auth switch cancels stale queued operations and leaves previous data intact", async () => {
    let user = "user-a";
    const bound = { ...scope, assertCurrent: async () => { if (user !== scope.userId) throw new Error("Identity changed"); } };
    const old = outboxStore(bound);
    await old.enqueue({ id: "retained", rpc: "depart", args: {} });
    user = "user-b";
    await expect(old.claimPending!({})).rejects.toThrow("Identity changed");
    await expect(outboxCache(bound).set("route", "stale")).rejects.toThrow("Identity changed");
    expect((await outboxStore(scope).get("retained"))?.status).toBe("queued");
    await expect(outboxStore(null).init()).rejects.toThrow("authenticated");
  });

  test("identity change during an operation prevents its durable write", async () => {
    let assertions = 0;
    const switching = { ...scope, assertCurrent: async () => {
      if (++assertions === 2) throw new Error("Identity changed");
    } };
    await expect(outboxStore(switching).enqueue({ id: "stale", rpc: "depart", args: {} })).rejects.toThrow("Identity changed");
    expect(await outboxStore(scope).get("stale")).toBeNull();
  });
});
