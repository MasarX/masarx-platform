import type { KeyValueStore, OutboxEntry, OutboxEntryStatus, OutboxStore } from "@masarx/mobile-core";
import { createOutboxId, createOutboxNow } from "@masarx/mobile-core";

function cloneOutboxEntry(entry: OutboxEntry): OutboxEntry {
  return {
    ...entry,
    args: { ...(entry.args || {}) },
  };
}

function isPendingEntry(entry: OutboxEntry, nowIso: string, force = false) {
  if (!(entry.status === "queued" || entry.status === "failed")) return false;
  if (force) return true;
  if (!entry.next_attempt_at) return true;
  return entry.next_attempt_at <= nowIso;
}

export function createMemoryOutboxStore(): OutboxStore {
  const entries = new Map<string, OutboxEntry>();

  return {
    init: async () => {},
    enqueue: async (input) => {
      const id = input.id ?? createOutboxId();
      if (entries.has(id)) {
        return cloneOutboxEntry(entries.get(id)!);
      }
      const now = createOutboxNow();
      const entry: OutboxEntry = {
        id,
        rpc: input.rpc,
        args: { ...(input.args || {}) },
        status: "queued",
        created_at: now,
        updated_at: now,
        attempt_count: 0,
        next_attempt_at: null,
        last_error: null,
      };
      entries.set(id, entry);
      return cloneOutboxEntry(entry);
    },
    get: async (id) => {
      const existing = entries.get(id);
      return existing ? cloneOutboxEntry(existing) : null;
    },
    list: async (params = {}) => {
      const statuses = Array.isArray(params.status) ? new Set(params.status) : null;
      const limit = typeof params.limit === "number" ? Math.max(0, params.limit) : 200;
      const out = [...entries.values()]
        .filter((entry) => (statuses ? statuses.has(entry.status) : true))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map(cloneOutboxEntry);
      return out;
    },
    listPending: async (params = {}) => {
      const limit = typeof params.limit === "number" ? Math.max(0, params.limit) : 50;
      const now = createOutboxNow();
      const force = params.force === true;
      return [...entries.values()]
        .filter((entry) => isPendingEntry(entry, now, force))
        .sort((a, b) => (a.created_at > b.created_at ? 1 : -1))
        .slice(0, limit)
        .map(cloneOutboxEntry);
    },
    claimPending: async (params = {}) => {
      const limit = typeof params.limit === "number" ? Math.max(0, params.limit) : 50;
      const now = createOutboxNow();
      const force = params.force === true;
      const claimed = [...entries.values()]
        .filter((entry) => isPendingEntry(entry, now, force))
        .sort((a, b) => (a.created_at > b.created_at ? 1 : -1))
        .slice(0, limit);

      for (const entry of claimed) {
        entries.set(entry.id, {
          ...entry,
          status: "in_flight",
          updated_at: now,
        });
      }

      return claimed.map((entry) =>
        cloneOutboxEntry({
          ...entry,
          status: "in_flight",
          updated_at: now,
        })
      );
    },
    countPending: async () => {
      const now = createOutboxNow();
      let count = 0;
      for (const entry of entries.values()) {
        if (isPendingEntry(entry, now)) count += 1;
      }
      return count;
    },
    update: async (id, patch) => {
      const existing = entries.get(id);
      if (!existing) return;

      const next: OutboxEntry = {
        ...existing,
        ...(patch.rpc ? { rpc: patch.rpc } : {}),
        ...(patch.args ? { args: { ...patch.args } } : {}),
        ...(patch.status ? { status: patch.status as OutboxEntryStatus } : {}),
        ...(typeof patch.attempt_count === "number"
          ? { attempt_count: patch.attempt_count }
          : {}),
        ...("next_attempt_at" in patch
          ? { next_attempt_at: patch.next_attempt_at ?? null }
          : {}),
        ...("last_error" in patch ? { last_error: patch.last_error ?? null } : {}),
        ...(patch.updated_at ? { updated_at: patch.updated_at } : {}),
      };

      entries.set(id, next);
    },
    remove: async (id) => {
      entries.delete(id);
    },
    clear: async (params = {}) => {
      const statuses = Array.isArray(params.status) ? new Set(params.status) : null;
      if (!statuses) {
        const count = entries.size;
        entries.clear();
        return count;
      }

      let deleted = 0;
      for (const [id, entry] of entries.entries()) {
        if (!statuses.has(entry.status)) continue;
        entries.delete(id);
        deleted += 1;
      }
      return deleted;
    },
    recoverStaleInFlight: async ({ olderThanMs }) => {
      const thresholdMs = Date.now() - Math.max(0, olderThanMs);
      const now = createOutboxNow();
      let recovered = 0;
      for (const [id, entry] of entries.entries()) {
        if (entry.status !== "in_flight") continue;
        const updatedMs = Date.parse(entry.updated_at || "");
        if (!Number.isFinite(updatedMs) || updatedMs > thresholdMs) continue;
        entries.set(id, {
          ...entry,
          status: "failed",
          next_attempt_at: now,
          last_error: "Recovered stale in_flight entry",
          updated_at: now,
        });
        recovered += 1;
      }
      return recovered;
    },
  };
}

export function createMemoryKeyValueStore(): KeyValueStore {
  const values = new Map<string, unknown>();

  return {
    init: async () => {},
    get: async (key) => (values.has(key) ? (values.get(key) as unknown) : null),
    set: async (key, value) => {
      values.set(key, value ?? null);
    },
    remove: async (key) => {
      values.delete(key);
    },
    clear: async () => {
      const count = values.size;
      values.clear();
      return count;
    },
  };
}
