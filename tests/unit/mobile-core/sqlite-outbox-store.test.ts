describe("sqlite outbox store", () => {
  test("falls back to a dedicated database directory when Expo default SQLite directory is blocked", async () => {
    jest.resetModules();

    const execAsync = jest.fn(async () => undefined);
    const getAllAsync = jest.fn(async () => []);
    const runAsync = jest.fn(async () => ({ changes: 1 }));
    const openDatabaseAsync = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Could not open database /data/data/co.masarx.fieldops.dev/files/SQLite/fieldops.db. Couldn't create directory '/data/data/co.masarx.fieldops.dev/files/SQLite'. Path already points to a non-normal file."
        )
      )
      .mockResolvedValueOnce({ execAsync, getAllAsync, runAsync });

    jest.doMock(
      "expo-sqlite",
      () => ({
        defaultDatabaseDirectory: "/data/data/co.masarx.fieldops.dev/files/SQLite",
        openDatabaseAsync,
      }),
      { virtual: true }
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSqliteOutboxStore } = require("@masarx/mobile-core/sqlite");

    const store = createSqliteOutboxStore({ databaseName: "fieldops.db", tableName: "outbox" });
    await store.init();

    expect(openDatabaseAsync).toHaveBeenCalledTimes(2);
    expect(openDatabaseAsync).toHaveBeenNthCalledWith(1, "fieldops.db");
    expect(openDatabaseAsync).toHaveBeenNthCalledWith(
      2,
      "fieldops.db",
      undefined,
      "/data/data/co.masarx.fieldops.dev/files/SQLite_masarx"
    );
    expect(execAsync).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS outbox"));
  });

  test("key-value store uses the same fallback directory for the blocked Expo SQLite parent", async () => {
    jest.resetModules();

    const execAsync = jest.fn(async () => undefined);
    const getAllAsync = jest.fn(async () => []);
    const runAsync = jest.fn(async () => ({ changes: 1 }));
    const openDatabaseAsync = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Could not open database /data/data/co.masarx.fieldops.dev/files/SQLite/fieldops.db. Path '/data/data/co.masarx.fieldops.dev/files/SQLite' points to a file, but must point to a directory."
        )
      )
      .mockResolvedValueOnce({ execAsync, getAllAsync, runAsync });

    jest.doMock(
      "expo-sqlite",
      () => ({
        defaultDatabaseDirectory: "/data/data/co.masarx.fieldops.dev/files/SQLite/",
        openDatabaseAsync,
      }),
      { virtual: true }
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSqliteKeyValueStore } = require("@masarx/mobile-core/sqlite");

    const store = createSqliteKeyValueStore({ databaseName: "fieldops.db", tableName: "kv_store" });
    await store.init();

    expect(openDatabaseAsync).toHaveBeenNthCalledWith(
      2,
      "fieldops.db",
      undefined,
      "/data/data/co.masarx.fieldops.dev/files/SQLite_masarx"
    );
    expect(execAsync).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS kv_store"));
  });

  test("does not mask unrelated SQLite open failures", async () => {
    jest.resetModules();

    const openDatabaseAsync = jest.fn().mockRejectedValueOnce(new Error("Could not open database fieldops.db"));

    jest.doMock(
      "expo-sqlite",
      () => ({
        defaultDatabaseDirectory: "/data/data/co.masarx.fieldops.dev/files/SQLite",
        openDatabaseAsync,
      }),
      { virtual: true }
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSqliteOutboxStore } = require("@masarx/mobile-core/sqlite");

    const store = createSqliteOutboxStore({ databaseName: "fieldops.db", tableName: "outbox" });
    await expect(store.init()).rejects.toThrow("Could not open database fieldops.db");
    expect(openDatabaseAsync).toHaveBeenCalledTimes(1);
  });

  test("claimPending uses a transaction (BEGIN IMMEDIATE + COMMIT)", async () => {
    jest.resetModules();

    const execCalls: string[] = [];
    const execAsync = jest.fn(async (sql: string) => {
      execCalls.push(String(sql));
    });
    const now = new Date().toISOString();
    const rows = [
      {
        id: "id-1",
        rpc: "rpc_ok",
        args_json: "{}",
        status: "queued",
        created_at: now,
        updated_at: now,
        attempt_count: 0,
        next_attempt_at: null,
        last_error: null,
      },
    ];
    const getAllAsync = jest.fn(async (sql: string) => sql.startsWith("PRAGMA") ? [{ name: "transport" }] : rows);
    const runAsync = jest.fn(async () => ({ changes: 1 }));

    jest.doMock(
      "expo-sqlite",
      () => ({
        openDatabaseAsync: jest.fn(async () => ({ execAsync, getAllAsync, runAsync })),
      }),
      { virtual: true }
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSqliteOutboxStore } = require("@masarx/mobile-core/sqlite");

    const store = createSqliteOutboxStore({ databaseName: "test.db", tableName: "outbox" });
    await store.init();

    execCalls.length = 0; // init has its own additive-schema transaction.
    const claimed = await store.claimPending({ limit: 10 });
    expect(Array.isArray(claimed)).toBe(true);
    expect(claimed[0]?.id).toBe("id-1");
    expect(claimed[0]?.status).toBe("in_flight");

    const transactional = execCalls.filter((sql) => sql === "BEGIN IMMEDIATE" || sql === "COMMIT");
    expect(transactional).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  test("force claimPending ignores retry backoff for manual sync", async () => {
    jest.resetModules();

    const execAsync = jest.fn(async () => undefined);
    const getAllAsync = jest.fn(async (_sql: string, ..._params: unknown[]) => []);
    const runAsync = jest.fn(async () => ({ changes: 1 }));

    jest.doMock(
      "expo-sqlite",
      () => ({
        openDatabaseAsync: jest.fn(async () => ({ execAsync, getAllAsync, runAsync })),
      }),
      { virtual: true }
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSqliteOutboxStore } = require("@masarx/mobile-core/sqlite");

    const store = createSqliteOutboxStore({ databaseName: "test.db", tableName: "outbox" });
    await store.init();
    await store.claimPending({ limit: 10, force: true });

    const claim = getAllAsync.mock.calls.find(([sql]) => /SELECT.*FROM outbox/i.test(sql));
    expect(claim?.[0]).toContain("WHERE status IN ('queued','failed')");
    expect(claim?.[0]).not.toContain("next_attempt_at");
    expect(claim?.slice(1)).toEqual([10]);
  });

  test("claimPending rolls back on failure", async () => {
    jest.resetModules();

    const execCalls: string[] = [];
    const execAsync = jest.fn(async (sql: string) => {
      execCalls.push(String(sql));
    });
    const getAllAsync = jest.fn(async (sql: string) => {
      if (sql.startsWith("PRAGMA")) return [{ name: "transport" }];
      throw new Error("boom");
    });
    const runAsync = jest.fn(async () => ({ changes: 1 }));

    jest.doMock(
      "expo-sqlite",
      () => ({
        openDatabaseAsync: jest.fn(async () => ({ execAsync, getAllAsync, runAsync })),
      }),
      { virtual: true }
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSqliteOutboxStore } = require("@masarx/mobile-core/sqlite");

    const store = createSqliteOutboxStore({ databaseName: "test.db", tableName: "outbox" });
    await store.init();

    execCalls.length = 0;
    await expect(store.claimPending({ limit: 10 })).rejects.toThrow("boom");
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });
});

test("actual SQLite upgrades populated legacy rows once and preserves Edge replay across store recreation", async () => {
  jest.resetModules();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const now = "2026-09-06T00:00:00.000Z";
  db.exec("CREATE TABLE outbox (id TEXT PRIMARY KEY, rpc TEXT NOT NULL, args_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT)");
  db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy", "rpc_old", '{"preserved":true}', "failed", now, now, 2, null, "retry");
  const before = db.prepare("SELECT * FROM outbox").get();
  const adapter = {
    execAsync: async (sql: string) => db.exec(sql),
    runAsync: async (sql: string, ...params: any[]) => db.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: any[]) => db.prepare(sql).all(...params),
  };
  jest.doMock("expo-sqlite", () => ({ openDatabaseAsync: async () => adapter }), { virtual: true });
  try {
    const { createSqliteOutboxStore } = require("@masarx/mobile-core/sqlite");
    let store = createSqliteOutboxStore({ databaseName: "owned-memory" });
    await store.init();
    await store.init();
    expect(db.prepare("PRAGMA table_info(outbox)").all().filter((c: any) => c.name === "transport")).toHaveLength(1);
    expect(db.prepare("SELECT * FROM outbox WHERE id='legacy'").get()).toEqual({ ...before, transport: "rpc", display_json: null });
    expect((await store.get("legacy")).display).toBeUndefined();
    expect(db.prepare("PRAGMA table_info(outbox)").all().filter((c: any) => c.name === "display_json")).toHaveLength(1);
    const display = { actionLabel: " Request ", targetLabel: " Shipment A " };
    const args = { p_idempotency_key: "edge-key", p_expected_actor_user_id: "actor-a" };
    await store.enqueue({ id: "edge", rpc: "fieldops-reassignment-request", transport: "edge", args, display });
    display.actionLabel = "mutated caller";
    await store.enqueue({ id: "edge", rpc: "replacement", args: {}, display: { actionLabel: "replacement" } });
    store = createSqliteOutboxStore({ databaseName: "owned-memory" });
    await store.init();
    expect(await store.get("edge")).toMatchObject({ rpc: "fieldops-reassignment-request", transport: "edge", args });
    expect((await store.get("edge")).display).toEqual({ actionLabel: "Request", targetLabel: "Shipment A" });
    for (const invalid of ["{invalid", "null", "[]", '{"actionLabel":42,"unexpected":"drop"}']) {
      db.prepare("UPDATE outbox SET display_json=? WHERE id='edge'").run(invalid);
      expect((await store.get("edge")).display).toBeUndefined();
    }
    db.prepare("UPDATE outbox SET display_json=? WHERE id='edge'").run(JSON.stringify({ actionLabel: "Request", targetLabel: "Shipment A" }));
    const claimed = await store.claimPending({ limit: 10 });
    expect(claimed.find((r: any) => r.id === "legacy")).toMatchObject({ transport: "rpc", args: { preserved: true }, attempt_count: 2 });
    expect(claimed.find((r: any) => r.id === "edge")).toMatchObject({ transport: "edge", args, display: { actionLabel: "Request", targetLabel: "Shipment A" } });
    db.prepare("UPDATE outbox SET transport='unknown', status='queued' WHERE id='edge'").run();
    const { createOutbox } = require("@masarx/mobile-core");
    const executor = jest.fn();
    const result = await createOutbox(store).sync(executor, { staleInFlightMs: 0, shouldRetry: () => false });
    expect(executor).not.toHaveBeenCalled();
    expect(result.dead).toBe(1);
    expect((await store.get("edge")).transport).toBe("unknown");
  } finally {
    db.close();
    jest.dontMock("expo-sqlite");
    jest.resetModules();
  }
});

test("SQLite query bounds, eligible-now count and invalid-row rollback preserve future and malformed work", async () => {
  jest.resetModules();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const adapter = {
    execAsync: async (sql: string) => db.exec(sql),
    runAsync: async (sql: string, ...params: any[]) => db.prepare(sql).run(...params),
    getAllAsync: async (sql: string, ...params: any[]) => db.prepare(sql).all(...params),
  };
  jest.doMock("expo-sqlite", () => ({ openDatabaseAsync: async () => adapter }), { virtual: true });
  try {
    const { createSqliteOutboxStore } = require("@masarx/mobile-core/sqlite");
    const store = createSqliteOutboxStore({ databaseName: "owned-memory" });
    await store.init();
    await store.enqueue({ id: "ready", rpc: "rpc", args: {} });
    await store.enqueue({ id: "future", rpc: "rpc", args: { retained: true } });
    await store.update("future", { status: "failed", next_attempt_at: new Date(Date.now() + 60000).toISOString() });
    expect(await store.countPending()).toBe(1);
    expect(await store.list({ limit: -1 })).toEqual([]);
    expect(await store.list({ limit: 1.9 })).toHaveLength(1);
    expect(await store.listPending({ limit: Infinity })).toHaveLength(1);
    expect(await store.claimPending({ limit: 0 })).toEqual([]);
    for (const args of ["null", "[]", "42", "{invalid"]) {
      db.prepare("UPDATE outbox SET args_json=? WHERE id='ready'").run(args);
      await expect(store.claimPending({ limit: 10 })).rejects.toThrow("Invalid persisted outbox arguments");
      expect(db.prepare("SELECT status FROM outbox WHERE id='ready'").get().status).toBe("queued");
      expect((await store.get("future")).args).toEqual({ retained: true });
    }
    db.prepare("UPDATE outbox SET args_json='{}', status='unknown' WHERE id='ready'").run();
    await expect(store.get("ready")).rejects.toThrow("Invalid persisted outbox status");
    expect(await store.claimPending({ limit: 10 })).toEqual([]);
    db.prepare("UPDATE outbox SET status='queued', attempt_count=-3 WHERE id='ready'").run();
    expect((await store.get("ready")).attempt_count).toBe(0);
    expect((await store.claimPending({ limit: 10 }))[0].id).toBe("ready");
    await store.update("ready", { updated_at: "2000-01-01T00:00:00.000Z" });
    expect(await store.recoverStaleInFlight({ olderThanMs: NaN })).toBe(1);
    expect((await store.get("future")).status).toBe("failed");
    expect((await store.get("future")).next_attempt_at).not.toBeNull();
  } finally {
    db.close();
    jest.dontMock("expo-sqlite");
    jest.resetModules();
  }
});
