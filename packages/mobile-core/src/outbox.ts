export type OutboxDisplay = {
  actionLabel?: string | null;
  targetLabel?: string | null;
};

export function normalizeOutboxDisplay(value: unknown): OutboxDisplay | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const display: OutboxDisplay = {};
  for (const key of ["actionLabel", "targetLabel"] as const) {
    const label = source[key];
    if (typeof label === "string" && label.trim()) display[key] = label.trim();
  }
  return Object.keys(display).length ? display : undefined;
}

export type OutboxEntryStatus =
  | "queued"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "dead";

export type OutboxEntry = {
  id: string;
  rpc: string;
  transport?: "rpc" | "edge";
  display?: OutboxDisplay;
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
  transport?: "rpc" | "edge";
  display?: OutboxDisplay;
  args: Record<string, unknown>;
  id?: string;
};

export type RpcExecutor = (
  rpc: string,
  args: Record<string, unknown>,
  transport?: "rpc" | "edge"
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
export const MAX_OUTBOX_QUERY_LIMIT = 500;

export function normalizeOutboxLimit(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_OUTBOX_QUERY_LIMIT, Math.max(0, Math.floor(value))) : fallback;
}

export function normalizeOutboxDuration(value: unknown, fallback: number) {
  // Match the platform timer range; larger values can also break ISO-date ordering.
  return typeof value === "number" && Number.isFinite(value) && value <= 2_147_483_647
    ? Math.max(0, Math.floor(value)) : fallback;
}

export function createOutboxNow() {
  return new Date().toISOString();
}

export function createOutboxId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `outbox_${Date.now()}_${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
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
  let value: string;
  if (!error) value = "Unknown error";
  else if (typeof error === "string") value = error;
  else if (error instanceof Error) value = error.stack || error.message;
  else {
    try { value = JSON.stringify(error) ?? String(error); }
    catch { value = String(error); }
  }
  return redactOutboxErrorText(value);
}

export function redactOutboxErrorText(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(\b(?=[a-z0-9_]*(?:api_?key|token|authorization|password|secret|jwt))[a-z0-9_]+["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");
}

export type OutboxSyncOptions = {
  limit?: number;
  /** Replay queued/failed entries immediately, ignoring retry backoff. */
  force?: boolean;
  shouldRetry?: (error: unknown) => boolean;
  backoff?: { base: number; max: number };
  staleInFlightMs?: number;
  maxAttempts?: number;
  // Observation is downstream of accepted execution; its failure must not replay a mutation.
  onSucceeded?: (entry: OutboxEntry, result: unknown) => Promise<void>;
};

export type OutboxSyncResult = {
  attempted: number;
  succeeded: number;
  succeededIds: string[];
  failed: number;
  dead: number;
};

export function createOutbox(store: OutboxStore) {
  async function enqueue(input: OutboxEnqueueInput) {
    if (!input.rpc || !input.rpc.trim()) {
      throw new Error("Outbox enqueue requires rpc name.");
    }
    if (input.transport !== undefined && input.transport !== "rpc" && input.transport !== "edge") {
      throw new Error("Unsupported outbox transport.");
    }
    return store.enqueue({
      ...input,
      display: normalizeOutboxDisplay(input.display),
      id: input.id ?? createOutboxId(),
    });
  }

  async function sync(executor: RpcExecutor, options: OutboxSyncOptions = {}) {
    const limit = normalizeOutboxLimit(options.limit, 50);
    const force = options.force === true;
    const shouldRetry = options.shouldRetry ?? (() => true);
    const base = Math.max(1, normalizeOutboxDuration(options.backoff?.base, DEFAULT_OUTBOX_BACKOFF_MS.base));
    const backoffConfig = {
      base,
      max: Math.max(base, normalizeOutboxDuration(options.backoff?.max, DEFAULT_OUTBOX_BACKOFF_MS.max)),
    };
    const maxAttempts = typeof options.maxAttempts === "number" && Number.isFinite(options.maxAttempts)
      ? Math.max(1, Math.floor(options.maxAttempts)) : Infinity;
    const staleInFlightMs = normalizeOutboxDuration(options.staleInFlightMs, DEFAULT_OUTBOX_STALE_IN_FLIGHT_MS);

    if (store.recoverStaleInFlight && staleInFlightMs > 0) {
      await store.recoverStaleInFlight({ olderThanMs: staleInFlightMs });
    }

    const entries = store.claimPending
      ? await store.claimPending({ limit, force })
      : await store.listPending({ limit, force });
    const result: OutboxSyncResult = {
      attempted: 0,
      succeeded: 0,
      succeededIds: [],
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
        if (entry.transport !== undefined && entry.transport !== "rpc" && entry.transport !== "edge") {
          throw new Error("Unsupported outbox transport.");
        }
        const executionResult = await executor(entry.rpc, entry.args, entry.transport ?? "rpc");
        await store.remove(entry.id);
        result.succeeded += 1;
        result.succeededIds.push(entry.id);
        try {
          await options.onSucceeded?.(entry, executionResult);
        } catch {
          // Missing observation remains unverified; the accepted mutation stays succeeded.
        }
      } catch (error) {
        const attemptCount = (Number.isSafeInteger(entry.attempt_count) && entry.attempt_count >= 0
          ? Math.min(entry.attempt_count, Number.MAX_SAFE_INTEGER - 1) : 0) + 1;
        const retriable = shouldRetry(error);
        const status: OutboxEntryStatus = retriable && attemptCount < maxAttempts ? "failed" : "dead";
        if (status === "dead") result.dead += 1;
        else result.failed += 1;

        const nextAttemptAt = status === "failed"
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

export type OutboxAgingPolicy = {
  dead_ttl_days: number;
  warn_pending_hours: number;
  max_entries_warn: number;
  purge_batch_size: number;
};

export type OutboxAgingEntry = Pick<OutboxEntry, "id" | "status"> & {
  created_at: string | number | Date;
  updated_at?: string | number | Date | null;
};

// Compatibility defaults from the selected aging-helper contract, not an
// automatic retention policy. Callers supply resolved policy; these helpers never delete.
export const DEFAULT_OUTBOX_AGING_POLICY: OutboxAgingPolicy = {
  dead_ttl_days: 7, warn_pending_hours: 12, max_entries_warn: 50, purge_batch_size: 25,
};

const AGING_MINUTE_MS = 60_000;
const AGING_HOUR_MS = 60 * AGING_MINUTE_MS;
const AGING_DAY_MS = 24 * AGING_HOUR_MS;

export function normalizeOutboxAgingPolicy(raw: unknown): OutboxAgingPolicy {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const positive = (key: keyof OutboxAgingPolicy, multiplier = 1) => {
    const input = value[key];
    const n = typeof input === "number" ? Math.floor(input) : NaN;
    return Number.isSafeInteger(n) && n > 0 && n <= Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
      ? n : DEFAULT_OUTBOX_AGING_POLICY[key];
  };
  return {
    dead_ttl_days: positive("dead_ttl_days", AGING_DAY_MS),
    warn_pending_hours: positive("warn_pending_hours", AGING_HOUR_MS),
    max_entries_warn: positive("max_entries_warn"),
    purge_batch_size: positive("purge_batch_size"),
  };
}

function agingTimestamp(value: string | number | Date | null | undefined): number | null {
  const ms = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function classifyOutboxAge<T extends OutboxAgingEntry>(
  entry: T, rawPolicy: unknown, now = Date.now(),
) {
  if (!Number.isFinite(now)) throw new Error("Outbox aging requires a finite clock.");
  const policy = normalizeOutboxAgingPolicy(rawPolicy);
  const created = agingTimestamp(entry.created_at) ?? now;
  const ageMs = Math.max(0, now - created);
  // Current outbox records last activity in updated_at, not last_attempted_at.
  const idleMs = Math.max(0, now - (agingTimestamp(entry.updated_at) ?? created));
  const warningMs = policy.warn_pending_hours * AGING_HOUR_MS;
  const severity = entry.status === "dead"
    ? ageMs >= policy.dead_ttl_days * AGING_DAY_MS ? "dead_expired" : "stale"
    : entry.status === "succeeded" ? "fresh"
    : ageMs >= warningMs ? "overdue" : ageMs >= warningMs / 2 ? "stale" : "fresh";
  return { entry, ageMs, idleMs, severity };
}

export function summarizeOutboxAging(
  entries: readonly OutboxAgingEntry[], rawPolicy: unknown, now = Date.now(),
) {
  if (!Number.isFinite(now)) throw new Error("Outbox aging requires a finite clock.");
  const policy = normalizeOutboxAgingPolicy(rawPolicy);
  const list = Array.isArray(entries) ? entries : [];
  let overdue = 0, deadExpired = 0;
  let oldestMs: number | null = null;
  for (const entry of list) {
    const age = classifyOutboxAge(entry, policy, now);
    if (age.severity === "overdue") overdue += 1;
    if (age.severity === "dead_expired") deadExpired += 1;
    oldestMs = oldestMs === null ? age.ageMs : Math.max(oldestMs, age.ageMs);
  }
  const banner = deadExpired
    ? `${deadExpired} outbox item${deadExpired === 1 ? "" : "s"} failed permanently; purge to clear.`
    : overdue ? `${overdue} outbox item${overdue === 1 ? " is" : "s are"} overdue; sync when online.`
    : list.length > policy.max_entries_warn ? `${list.length} pending actions in outbox, sync when online.` : null;
  return { total: list.length, overdue, dead_expired: deadExpired, oldest_ms: oldestMs, banner_message: banner };
}

export function pickDeadEntriesForPurge<T extends OutboxAgingEntry>(
  entries: readonly T[], rawPolicy: unknown, now = Date.now(),
): T[] {
  if (!Number.isFinite(now)) throw new Error("Outbox aging requires a finite clock.");
  const policy = normalizeOutboxAgingPolicy(rawPolicy);
  const ttl = policy.dead_ttl_days * AGING_DAY_MS;
  return (Array.isArray(entries) ? entries : [])
    .map(entry => ({ entry, created: agingTimestamp(entry.created_at) }))
    .filter((item): item is { entry: T; created: number } =>
      item.entry.status === "dead" && item.created !== null && now - item.created >= ttl)
    .sort((a, b) => a.created - b.created)
    .slice(0, policy.purge_batch_size)
    .map(item => item.entry);
}

export function formatRelativeAge(agoMs: number): string {
  if (!Number.isFinite(agoMs) || agoMs < AGING_MINUTE_MS) return "just now";
  if (agoMs < AGING_HOUR_MS) return `${Math.floor(agoMs / AGING_MINUTE_MS)}m ago`;
  if (agoMs < AGING_DAY_MS) return `${Math.floor(agoMs / AGING_HOUR_MS)}h ago`;
  return `${Math.floor(agoMs / AGING_DAY_MS)}d ago`;
}
