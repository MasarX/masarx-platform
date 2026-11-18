export type OutboxEntryStatus =
  | "queued"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "dead";

export type OutboxEntry = {
  id: string;
  rpc: string;
  args: Record<string, unknown>;
  status: OutboxEntryStatus;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
};

export type OutboxEnqueueInput = {
  rpc: string;
  args: Record<string, unknown>;
  id?: string;
};

export type RpcExecutor = (
  rpc: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export type OutboxStore = {
  init: () => Promise<void>;
  enqueue: (input: OutboxEnqueueInput) => Promise<OutboxEntry>;
  get: (id: string) => Promise<OutboxEntry | null>;
  list: (params?: {
    status?: OutboxEntryStatus[];
    limit?: number;
  }) => Promise<OutboxEntry[]>;
  listPending: (params?: { limit?: number; force?: boolean }) => Promise<OutboxEntry[]>;
  claimPending?: (params: { limit?: number; force?: boolean }) => Promise<OutboxEntry[]>;
  countPending: () => Promise<number>;
  update: (id: string, patch: Partial<OutboxEntry>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: (params?: { status?: OutboxEntryStatus[] }) => Promise<number>;
  recoverStaleInFlight?: (params: { olderThanMs: number }) => Promise<number>;
};

export const DEFAULT_OUTBOX_BACKOFF_MS = {
  base: 1_000,
  max: 60_000,
};

export const DEFAULT_OUTBOX_STALE_IN_FLIGHT_MS = 5 * 60_000;

export function createOutboxNow() {
  return new Date().toISOString();
}

export function createOutboxId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `outbox_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function computeBackoffMs(attempt: number, config = DEFAULT_OUTBOX_BACKOFF_MS) {
  const safeAttempt = clampNumber(attempt, 0, 30);
  const exp = Math.pow(2, safeAttempt);
  const jitter = 0.85 + Math.random() * 0.3; // 0.85..1.15
  return clampNumber(Math.round(config.base * exp * jitter), config.base, config.max);
}

function serializeError(error: unknown) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export type OutboxSyncOptions = {
  limit?: number;
  /** Replay queued/failed entries immediately, ignoring retry backoff. */
  force?: boolean;
  shouldRetry?: (error: unknown) => boolean;
  backoff?: { base: number; max: number };
  staleInFlightMs?: number;
};

export type OutboxSyncResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  dead: number;
};

export function createOutbox(store: OutboxStore) {
  async function enqueue(input: OutboxEnqueueInput) {
    if (!input.rpc || !input.rpc.trim()) {
      throw new Error("Outbox enqueue requires rpc name.");
    }
    return store.enqueue({
      ...input,
      id: input.id ?? createOutboxId(),
    });
  }

  async function sync(executor: RpcExecutor, options: OutboxSyncOptions = {}) {
    const limit = options.limit ?? 50;
    const force = options.force === true;
    const shouldRetry = options.shouldRetry ?? (() => true);
    const backoffConfig = options.backoff ?? DEFAULT_OUTBOX_BACKOFF_MS;
    const staleInFlightMs = options.staleInFlightMs ?? DEFAULT_OUTBOX_STALE_IN_FLIGHT_MS;

    if (store.recoverStaleInFlight && staleInFlightMs > 0) {
      await store.recoverStaleInFlight({ olderThanMs: staleInFlightMs });
    }

    const entries = store.claimPending
      ? await store.claimPending({ limit, force })
      : await store.listPending({ limit, force });
    const result: OutboxSyncResult = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    };

    for (const entry of entries) {
      result.attempted += 1;
      if (!store.claimPending) {
        await store.update(entry.id, {
          status: "in_flight",
          updated_at: createOutboxNow(),
        });
      }

      try {
        await executor(entry.rpc, entry.args);
        result.succeeded += 1;
        await store.remove(entry.id);
      } catch (error) {
        const attemptCount = (entry.attempt_count ?? 0) + 1;
        const retriable = shouldRetry(error);
        const status: OutboxEntryStatus = retriable ? "failed" : "dead";
        if (status === "dead") result.dead += 1;
        else result.failed += 1;

        const nextAttemptAt = retriable
          ? new Date(Date.now() + computeBackoffMs(attemptCount, backoffConfig)).toISOString()
          : null;

        await store.update(entry.id, {
          status,
          attempt_count: attemptCount,
          last_error: serializeError(error),
          next_attempt_at: nextAttemptAt,
          updated_at: createOutboxNow(),
        });
      }
    }

    return result;
  }

  async function countPending() {
    return store.countPending();
  }

  return {
    init: () => store.init(),
    enqueue,
    sync,
    countPending,
    get: (id: string) => store.get(id),
    // Entry listing — surfaced so observability UIs (e.g. the Mobile V2
    // More screen's outbox panel) can render recent queued / failed
    // entries from the canonical outbox store rather than fabricating
    // them. Thin pass-throughs to the underlying store.
    list: (params?: { status?: OutboxEntryStatus[]; limit?: number }) =>
      store.list(params),
    listPending: (params?: { limit?: number; force?: boolean }) => store.listPending(params),
  };
}
