import type { KeyValueStore, OutboxEntry, OutboxStore } from "@masarx/mobile-core";
import { createMemoryKeyValueStore, createMemoryOutboxStore } from "./mobile-memory-store";

const OUTBOX_KEY = "fieldops:outbox:v1";
const CACHE_KEY = "fieldops:cache:v1";

export type WebStoreScope = { userId: string; organizationId: string; assertCurrent?: () => Promise<void> };

function scopedKey(key: string, scope: WebStoreScope | null): string {
  if (!scope?.userId || !scope.organizationId) throw new Error("Offline storage requires an authenticated user and organization.");
  return `${key}:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.organizationId)}`;
}

async function locked<T>(key: string, operation: (storage: Storage) => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks || typeof window === "undefined") {
    throw new Error("Durable offline storage is unavailable in this browser.");
  }
  return navigator.locks.request(key, async () => {
    // Never acknowledge a queued action when its durable write failed.
    const storage = window.localStorage;
    return operation(storage);
  });
}

function readArray(storage: Storage, key: string): unknown[] {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Offline storage is invalid; retained data was not changed.");
  return value;
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && Boolean(entry.id) &&
    typeof entry.rpc === "string" && Boolean(entry.rpc) &&
    entry.args !== null && typeof entry.args === "object" && !Array.isArray(entry.args) &&
    typeof entry.status === "string" && ["queued", "in_flight", "succeeded", "failed", "dead"].includes(entry.status) &&
    typeof entry.created_at === "string" && Number.isFinite(Date.parse(entry.created_at)) &&
    typeof entry.updated_at === "string" && Number.isFinite(Date.parse(entry.updated_at)) &&
    typeof entry.attempt_count === "number" && Number.isInteger(entry.attempt_count) && entry.attempt_count >= 0 &&
    (entry.next_attempt_at === null || (typeof entry.next_attempt_at === "string" && Number.isFinite(Date.parse(entry.next_attempt_at)))) &&
    (entry.last_error === null || typeof entry.last_error === "string");
}

export function createWebOutboxStore(scope: WebStoreScope | null): OutboxStore {
  async function run<T>(write: boolean, operation: (store: OutboxStore) => Promise<T>): Promise<T> {
    const key = scopedKey(OUTBOX_KEY, scope);
    return locked(key, async (storage) => {
      await scope?.assertCurrent?.();
      const rows = readArray(storage, key);
      const ids = new Set<string>();
      const entries: OutboxEntry[] = [];
      for (const row of rows) {
        if (!isEntry(row) || ids.has(row.id)) throw new Error("Offline queue is invalid; retained data was not changed.");
        ids.add(row.id);
        entries.push(row);
      }
      const store = createMemoryOutboxStore(entries);
      const result = await operation(store);
      await scope?.assertCurrent?.();
      // Persistence must retain all requests, independently of bounded UI queries.
      if (write) storage.setItem(key, JSON.stringify(store.snapshot()));
      return result;
    });
  }
  return {
    init: () => run(true, async () => {}),
    enqueue: (input) => run(true, (store) => store.enqueue(input)),
    get: (id) => run(false, (store) => store.get(id)),
    list: (params) => run(false, (store) => store.list(params)),
    listPending: (params) => run(false, (store) => store.listPending(params)),
    claimPending: (params) => run(true, (store) => store.claimPending!(params)),
    countPending: () => run(false, (store) => store.countPending()),
    update: (id, patch) => run(true, (store) => store.update(id, patch)),
    remove: (id) => run(true, (store) => store.remove(id)),
    clear: (params) => run(true, (store) => store.clear(params)),
    recoverStaleInFlight: (params) => run(true, (store) => store.recoverStaleInFlight!(params)),
  };
}

export function createWebKeyValueStore(scope: WebStoreScope | null): KeyValueStore {
  async function run<T>(write: boolean, operation: (store: KeyValueStore, keys: Set<string>) => Promise<T>): Promise<T> {
    const key = scopedKey(CACHE_KEY, scope);
    return locked(key, async (storage) => {
      await scope?.assertCurrent?.();
      const rows = readArray(storage, key);
      const keys = new Set<string>();
      const store = createMemoryKeyValueStore();
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || keys.has(row[0])) {
          throw new Error("Offline cache is invalid; retained data was not changed.");
        }
        keys.add(row[0]);
        await store.set(row[0], row[1]);
      }
      const result = await operation(store, keys);
      await scope?.assertCurrent?.();
      if (write) {
        const values = await Promise.all([...keys].map(async (key) => [key, await store.get(key)]));
        storage.setItem(key, JSON.stringify(values));
      }
      return result;
    });
  }
  return {
    init: () => run(true, async () => {}),
    get: (key) => run(false, (store) => store.get(key)),
    set: (key, value) => run(true, async (store, keys) => { await store.set(key, value); keys.add(key); }),
    remove: (key) => run(true, async (store, keys) => { await store.remove(key); keys.delete(key); }),
    clear: () => run(true, async (store, keys) => { const count = await store.clear(); keys.clear(); return count; }),
  };
}
