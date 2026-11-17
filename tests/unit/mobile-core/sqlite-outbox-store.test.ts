describe("sqlite outbox store", () => {
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
