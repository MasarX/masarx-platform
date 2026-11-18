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
    const getAllAsync = jest.fn(async () => rows);
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
    const getAllAsync = jest.fn(async () => []);
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

    const selectSql = String(getAllAsync.mock.calls[0]?.[0] ?? "");
    expect(selectSql).toContain("WHERE status IN ('queued','failed')");
    expect(selectSql).not.toContain("next_attempt_at");
    expect(getAllAsync.mock.calls[0]).toHaveLength(2);
    expect(getAllAsync.mock.calls[0]?.[1]).toBe(10);
  });

  test("claimPending rolls back on failure", async () => {
    jest.resetModules();

    const execCalls: string[] = [];
    const execAsync = jest.fn(async (sql: string) => {
      execCalls.push(String(sql));
    });
    const getAllAsync = jest.fn(async () => {
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

    await expect(store.claimPending({ limit: 10 })).rejects.toThrow("boom");
    expect(execCalls).toContain("BEGIN IMMEDIATE");
    expect(execCalls).toContain("ROLLBACK");
  });
});
