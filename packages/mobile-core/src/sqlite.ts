import { defaultDatabaseDirectory, openDatabaseAsync } from "expo-sqlite";

import type { OutboxEntry, OutboxEntryStatus, OutboxStore } from "./outbox";
import { createOutboxId, createOutboxNow } from "./outbox";
import type { KeyValueStore } from "./kv";

type SqliteRow = {
  id: string;
  rpc: string;
  args_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
};

function parseRow(row: SqliteRow): OutboxEntry {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(row.args_json || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  return {
    id: row.id,
    rpc: row.rpc,
    args,
    status: (row.status as OutboxEntryStatus) || "queued",
    created_at: row.created_at,
    updated_at: row.updated_at,
    attempt_count: row.attempt_count ?? 0,
    next_attempt_at: row.next_attempt_at ?? null,
    last_error: row.last_error ?? null,
  };
}

function normalizeDatabaseName(name?: string) {
  const trimmed = String(name || "").trim();
  return trimmed ? trimmed : "app.db";
}

function normalizeFallbackDirectory(directory?: string | null) {
  const trimmed = String(directory || "").trim().replace(/[\\/]+$/, "");
  return trimmed ? `${trimmed}_masarx` : null;
}

function isBlockedDefaultDirectoryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("Could not open database") &&
    message.includes("SQLite") &&
    (message.includes("Path already points to a non-normal file") ||
      message.includes("points to a file, but must point to a directory"))
  );
}

async function openDatabaseWithFallback(databaseName: string) {
  try {
    return await openDatabaseAsync(databaseName);
  } catch (error) {
    const fallbackDirectory = normalizeFallbackDirectory(defaultDatabaseDirectory);
    if (!fallbackDirectory || !isBlockedDefaultDirectoryError(error)) {
      throw error;
    }
    return openDatabaseAsync(databaseName, undefined, fallbackDirectory);
  }
}

function normalizeTableName(name?: string) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "outbox";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid outbox table name: ${trimmed}`);
  }
  return trimmed;
}

export function createSqliteOutboxStore(params: {
  databaseName?: string;
  tableName?: string;
} = {}): OutboxStore {
  const databaseName = normalizeDatabaseName(params.databaseName);
  const tableName = normalizeTableName(params.tableName);
  let dbPromise: ReturnType<typeof openDatabaseAsync> | null = null;

  function getDb() {
    if (!dbPromise) {
      dbPromise = openDatabaseWithFallback(databaseName);
    }
    return dbPromise;
  }

  async function init() {
    const db = await getDb();
    await db.execAsync(
      [
        `CREATE TABLE IF NOT EXISTS ${tableName} (`,
        `  id TEXT PRIMARY KEY NOT NULL,`,
        `  rpc TEXT NOT NULL,`,
        `  args_json TEXT NOT NULL,`,
        `  status TEXT NOT NULL,`,
        `  created_at TEXT NOT NULL,`,
        `  updated_at TEXT NOT NULL,`,
        `  attempt_count INTEGER NOT NULL DEFAULT 0,`,
        `  next_attempt_at TEXT NULL,`,
        `  last_error TEXT NULL`,
        `);`,
        `CREATE INDEX IF NOT EXISTS ${tableName}_status_next_idx ON ${tableName} (status, next_attempt_at);`,
      ].join("\n")
    );
  }

  async function enqueue(input: { rpc: string; args: Record<string, unknown>; id?: string }) {
    const db = await getDb();
    const now = createOutboxNow();
    const id = input.id ?? createOutboxId();
    await db.runAsync(
      `INSERT INTO ${tableName} (id, rpc, args_json, status, created_at, updated_at, attempt_count, next_attempt_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      id,
      input.rpc,
      JSON.stringify(input.args ?? {}),
      "queued",
      now,
      now,
      0,
      null,
      null
    );

    const existing = await get(id);
    if (!existing) {
      throw new Error(`Outbox insert did not persist entry id=${id}`);
    }
    return existing;
  }

  async function get(id: string) {
    const db = await getDb();
    const rows = await db.getAllAsync<SqliteRow>(
      `SELECT * FROM ${tableName} WHERE id = ? LIMIT 1`,
      id
    );
    const row = rows[0];
    return row ? parseRow(row) : null;
  }

  async function list(params: { status?: OutboxEntryStatus[]; limit?: number } = {}) {
    const db = await getDb();
    const limit = params.limit ?? 200;
    const statuses = Array.isArray(params.status) ? params.status.filter(Boolean) : [];
    const values: unknown[] = [];
    let where = "";

    if (statuses.length) {
      where = `WHERE status IN (${statuses.map(() => "?").join(",")})`;
      values.push(...statuses);
    }

    const rows = await db.getAllAsync<SqliteRow>(
      `SELECT * FROM ${tableName}
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      ...(values as any[]),
      limit
    );
    return rows.map(parseRow);
  }

  async function listPending(params: { limit?: number; force?: boolean } = {}) {
    const db = await getDb();
    const limit = params.limit ?? 50;
    const now = createOutboxNow();
    const retryGate = params.force === true ? "" : "AND (next_attempt_at IS NULL OR next_attempt_at <= ?)";
    const values = params.force === true ? [limit] : [now, limit];
    const rows = await db.getAllAsync<SqliteRow>(
      `SELECT * FROM ${tableName}
       WHERE status IN ('queued','failed')
         ${retryGate}
       ORDER BY created_at ASC
       LIMIT ?`,
      ...(values as any[])
    );
    return rows.map(parseRow);
  }

  async function claimPending(params: { limit?: number; force?: boolean } = {}) {
    const db = await getDb();
    const limit = params.limit ?? 50;
    const now = createOutboxNow();
    const retryGate = params.force === true ? "" : "AND (next_attempt_at IS NULL OR next_attempt_at <= ?)";
    const values = params.force === true ? [limit] : [now, limit];

    await db.execAsync("BEGIN IMMEDIATE");
    try {
      const rows = await db.getAllAsync<SqliteRow>(
        `SELECT * FROM ${tableName}
         WHERE status IN ('queued','failed')
           ${retryGate}
         ORDER BY created_at ASC
         LIMIT ?`,
        ...(values as any[])
      );

      const ids = rows.map((row) => row.id).filter(Boolean);
        if (ids.length) {
          const placeholders = ids.map(() => "?").join(",");
          await db.runAsync(
            `UPDATE ${tableName}
             SET status = 'in_flight',
                 updated_at = ?
           WHERE id IN (${placeholders})
             AND status IN ('queued','failed')`,
            now,
            ...(ids as any[])
          );
        }

      await db.execAsync("COMMIT");

      return rows.map((row) => ({
        ...parseRow(row),
        status: "in_flight" as const,
        updated_at: now,
      }));
    } catch (error) {
      try {
        await db.execAsync("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }
      throw error;
    }
  }

  async function countPending() {
    const db = await getDb();
    const rows = await db.getAllAsync<{ count: number }>(
      `SELECT COUNT(1) AS count FROM ${tableName} WHERE status IN ('queued','failed')`
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function update(id: string, patch: Partial<OutboxEntry>) {
    const db = await getDb();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (patch.rpc) {
      fields.push("rpc = ?");
      values.push(patch.rpc);
    }
    if (patch.args) {
      fields.push("args_json = ?");
      values.push(JSON.stringify(patch.args));
    }
    if (patch.status) {
      fields.push("status = ?");
      values.push(patch.status);
    }
    if (typeof patch.attempt_count === "number") {
      fields.push("attempt_count = ?");
      values.push(patch.attempt_count);
    }
    if ("next_attempt_at" in patch) {
      fields.push("next_attempt_at = ?");
      values.push(patch.next_attempt_at ?? null);
    }
    if ("last_error" in patch) {
      fields.push("last_error = ?");
      values.push(patch.last_error ?? null);
    }
    if (patch.updated_at) {
      fields.push("updated_at = ?");
      values.push(patch.updated_at);
    }

    if (!fields.length) return;
    values.push(id);

    await db.runAsync(
      `UPDATE ${tableName} SET ${fields.join(", ")} WHERE id = ?`,
      ...(values as any[])
    );
  }

  async function remove(id: string) {
    const db = await getDb();
    await db.runAsync(`DELETE FROM ${tableName} WHERE id = ?`, id);
  }

  async function clear(params: { status?: OutboxEntryStatus[] } = {}) {
    const db = await getDb();
    const statuses = Array.isArray(params.status) ? params.status.filter(Boolean) : [];
    const values: unknown[] = [];
    let where = "";

    if (statuses.length) {
      where = ` WHERE status IN (${statuses.map(() => "?").join(",")})`;
      values.push(...statuses);
    }

    const res = await db.runAsync(`DELETE FROM ${tableName}${where}`, ...(values as any[]));
    return Number((res as any)?.changes ?? 0);
  }

  return {
    init,
    enqueue,
    get,
    list,
    listPending,
    claimPending,
    countPending,
    update,
    remove,
    clear,
    recoverStaleInFlight: async ({ olderThanMs }) => {
      const db = await getDb();
      const now = createOutboxNow();
      const threshold = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
      const res = await db.runAsync(
        `UPDATE ${tableName}
         SET status = 'failed',
             next_attempt_at = ?,
             last_error = ?,
             updated_at = ?
         WHERE status = 'in_flight'
           AND updated_at <= ?`,
        now,
        "Recovered stale in_flight entry",
        now,
        threshold
      );
      return Number((res as any)?.changes ?? 0);
    },
  };
}

export function createSqliteKeyValueStore(params: {
  databaseName?: string;
  tableName?: string;
} = {}): KeyValueStore {
  const databaseName = normalizeDatabaseName(params.databaseName);
  const tableName = normalizeTableName(params.tableName || "kv_store");
  let dbPromise: ReturnType<typeof openDatabaseAsync> | null = null;

  function getDb() {
    if (!dbPromise) {
      dbPromise = openDatabaseWithFallback(databaseName);
    }
    return dbPromise;
  }

  async function init() {
    const db = await getDb();
    await db.execAsync(
      [
        `CREATE TABLE IF NOT EXISTS ${tableName} (`,
        `  key TEXT PRIMARY KEY NOT NULL,`,
        `  value_json TEXT NOT NULL,`,
        `  updated_at TEXT NOT NULL`,
        `);`,
      ].join("\n")
    );
  }

  async function get(key: string) {
    const db = await getDb();
    const rows = await db.getAllAsync<{ value_json: string }>(
      `SELECT value_json FROM ${tableName} WHERE key = ? LIMIT 1`,
      key
    );
    const raw = rows[0]?.value_json;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  async function set(key: string, value: unknown) {
    const db = await getDb();
    const now = createOutboxNow();
    await db.runAsync(
      `INSERT INTO ${tableName} (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value ?? null),
      now
    );
  }

  async function remove(key: string) {
    const db = await getDb();
    await db.runAsync(`DELETE FROM ${tableName} WHERE key = ?`, key);
  }

  async function clear() {
    const db = await getDb();
    const res = await db.runAsync(`DELETE FROM ${tableName}`);
    return Number((res as any)?.changes ?? 0);
  }

  return { init, get, set, remove, clear };
}
