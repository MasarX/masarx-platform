import { createOutboxId, type OutboxEntry, type OutboxStore, type OutboxEnqueueInput } from "@masarx/mobile-core";

export function createMemoryOutboxStore(): OutboxStore {
  const entries = new Map<string, OutboxEntry>();

  async function init() {}

  async function enqueue(input: OutboxEnqueueInput) {
    const id = input.id ?? createOutboxId();
    const now = new Date().toISOString();
    if (!entries.has(id)) {
      entries.set(id, {
        id,
        rpc: input.rpc,
        transport: input.transport,
        display: input.display,
        args: input.args,
        status: "queued",
        created_at: now,
        updated_at: now,
        attempt_count: 0,
        next_attempt_at: null,
        last_error: null,
      });
    }
    return entries.get(id)!;
  }

  async function get(id: string) {
    return entries.get(id) ?? null;
  }

  async function list(params: { status?: any[]; limit?: number } = {}) {
    const limit = params.limit ?? 200;
    const allowed = Array.isArray(params.status) && params.status.length ? new Set(params.status) : null;
    const all = Array.from(entries.values())
      .filter((entry) => (allowed ? allowed.has(entry.status) : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return all.slice(0, limit);
  }

  async function listPending(params: { limit?: number } = {}) {
    const limit = params.limit ?? 50;
    const now = new Date().toISOString();
    const out = Array.from(entries.values()).filter((entry) => {
      if (entry.status !== "queued" && entry.status !== "failed") return false;
      if (!entry.next_attempt_at) return true;
      return entry.next_attempt_at <= now;
    });
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out.slice(0, limit);
  }

  async function countPending() {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.status === "queued" || entry.status === "failed") count += 1;
    }
    return count;
  }

  async function update(id: string, patch: Partial<OutboxEntry>) {
    const existing = entries.get(id);
    if (!existing) return;
    entries.set(id, { ...existing, ...patch });
  }

  async function remove(id: string) {
    entries.delete(id);
  }

  async function clear(params: { status?: any[] } = {}) {
    const allowed = Array.isArray(params.status) && params.status.length ? new Set(params.status) : null;
    const before = entries.size;
    for (const [id, entry] of entries.entries()) {
      if (!allowed || allowed.has(entry.status)) entries.delete(id);
    }
    return before - entries.size;
  }

  return {
    init,
    enqueue,
    get,
    list,
    listPending,
    countPending,
    update,
    remove,
    clear,
  };
}
