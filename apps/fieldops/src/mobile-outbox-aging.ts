export type OutboxEntryLike = {
  id: string;
  rpc: string;
  status: "queued" | "in_flight" | "failed" | "dead" | "synced" | string;
  attempt_count: number;
  created_at: string | number | Date;
  last_attempted_at?: string | number | Date | null;
  last_error?: string | null;
  idempotency_key?: string | null;
};

export type OutboxAgingPolicy = {
  dead_ttl_days: number;
  warn_pending_hours: number;
  max_entries_warn: number;
  purge_batch_size: number;
};

export const DEFAULT_OUTBOX_AGING_POLICY: OutboxAgingPolicy = {
  dead_ttl_days: 7,
  warn_pending_hours: 12,
  max_entries_warn: 50,
  purge_batch_size: 25,
};

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  if (next < 1) return fallback;
  return next;
}

export function normalizeOutboxAgingPolicy(raw: unknown): OutboxAgingPolicy {
  const input = asRecord(raw);
  return {
    dead_ttl_days: readPositiveInt(
      input.dead_ttl_days,
      DEFAULT_OUTBOX_AGING_POLICY.dead_ttl_days
    ),
    warn_pending_hours: readPositiveInt(
      input.warn_pending_hours,
      DEFAULT_OUTBOX_AGING_POLICY.warn_pending_hours
    ),
    max_entries_warn: readPositiveInt(
      input.max_entries_warn,
      DEFAULT_OUTBOX_AGING_POLICY.max_entries_warn
    ),
    purge_batch_size: readPositiveInt(
      input.purge_batch_size,
      DEFAULT_OUTBOX_AGING_POLICY.purge_batch_size
    ),
  };
}

function toEpochMs(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type OutboxEntryAge = {
  entry: OutboxEntryLike;
  ageMs: number;
  idleMs: number;
  severity: "fresh" | "stale" | "overdue" | "dead_expired";
};

export function classifyOutboxAge(
  entry: OutboxEntryLike,
  policy: OutboxAgingPolicy,
  now: number = Date.now()
): OutboxEntryAge {
  const createdMs = toEpochMs(entry.created_at);
  const lastAttemptMs = toEpochMs(entry.last_attempted_at ?? null);
  const effectiveCreated = createdMs ?? now;
  const effectiveLast = lastAttemptMs ?? effectiveCreated;

  const ageMs = Math.max(0, now - effectiveCreated);
  const idleMs = Math.max(0, now - effectiveLast);

  const warnPendingMs = policy.warn_pending_hours * MS_PER_HOUR;
  const deadTtlMs = policy.dead_ttl_days * MS_PER_DAY;

  let severity: OutboxEntryAge["severity"] = "fresh";

  if (entry.status === "dead") {
    if (ageMs >= deadTtlMs) {
      severity = "dead_expired";
    } else {
      // Dead but not yet past TTL is treated as stale — it's not fresh, but
      // also not actionable via overdue sync.
      severity = "stale";
    }
  } else if (entry.status === "synced") {
    severity = "fresh";
  } else if (ageMs >= warnPendingMs) {
    severity = "overdue";
  } else if (ageMs >= warnPendingMs / 2) {
    severity = "stale";
  } else {
    severity = "fresh";
  }

  return { entry, ageMs, idleMs, severity };
}

export type OutboxAgingSummary = {
  total: number;
  overdue: number;
  dead_expired: number;
  oldest_ms: number | null;
  banner_message: string | null;
};

export function summarizeOutboxAging(
  entries: OutboxEntryLike[],
  policy: OutboxAgingPolicy,
  now: number = Date.now()
): OutboxAgingSummary {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;

  if (total === 0) {
    return {
      total: 0,
      overdue: 0,
      dead_expired: 0,
      oldest_ms: null,
      banner_message: null,
    };
  }

  let overdue = 0;
  let deadExpired = 0;
  let oldestMs: number | null = null;

  for (const entry of list) {
    const classified = classifyOutboxAge(entry, policy, now);
    if (classified.severity === "overdue") overdue += 1;
    if (classified.severity === "dead_expired") deadExpired += 1;
    if (oldestMs === null || classified.ageMs > oldestMs) {
      oldestMs = classified.ageMs;
    }
  }

  let bannerMessage: string | null = null;

  if (deadExpired > 0) {
    bannerMessage =
      deadExpired === 1
        ? "1 outbox item failed permanently; purge to clear."
        : `${deadExpired} outbox items failed permanently; purge to clear.`;
  } else if (overdue > 0) {
    bannerMessage =
      overdue === 1
        ? "1 outbox item is overdue; sync when online."
        : `${overdue} outbox items are overdue; sync when online.`;
  } else if (total > policy.max_entries_warn) {
    bannerMessage = `${total} pending actions in outbox, sync when online.`;
  }

  return {
    total,
    overdue,
    dead_expired: deadExpired,
    oldest_ms: oldestMs,
    banner_message: bannerMessage,
  };
}

export function pickDeadEntriesForPurge(
  entries: OutboxEntryLike[],
  policy: OutboxAgingPolicy,
  now: number = Date.now()
): OutboxEntryLike[] {
  const list = Array.isArray(entries) ? entries : [];
  const deadTtlMs = policy.dead_ttl_days * MS_PER_DAY;

  const candidates: Array<{ entry: OutboxEntryLike; createdMs: number }> = [];

  for (const entry of list) {
    if (entry.status !== "dead") continue;
    const createdMs = toEpochMs(entry.created_at);
    if (createdMs === null) continue;
    const ageMs = now - createdMs;
    if (ageMs < deadTtlMs) continue;
    candidates.push({ entry, createdMs });
  }

  candidates.sort((a, b) => a.createdMs - b.createdMs);

  const batchSize = Math.max(1, policy.purge_batch_size);
  return candidates.slice(0, batchSize).map((c) => c.entry);
}

export function formatRelativeAge(agoMs: number): string {
  if (!Number.isFinite(agoMs) || agoMs < MS_PER_MINUTE) {
    return "just now";
  }
  if (agoMs < MS_PER_HOUR) {
    const minutes = Math.floor(agoMs / MS_PER_MINUTE);
    return `${minutes}m ago`;
  }
  if (agoMs < MS_PER_DAY) {
    const hours = Math.floor(agoMs / MS_PER_HOUR);
    return `${hours}h ago`;
  }
  const days = Math.floor(agoMs / MS_PER_DAY);
  return `${days}d ago`;
}
