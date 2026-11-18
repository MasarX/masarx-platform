export type PushPayload = {
  id: string;
  title: string;
  body: string;
  receivedAt: number;
  priority?: "high" | "normal" | null;
  category?: string | null;
  data?: Record<string, unknown>;
};

export type PushBatchingPolicy = {
  enabled: boolean;
  window_ms: number;
  max_batch_size: number;
  instant_categories: string[];
  quiet_hours_start_utc?: number | null;
  quiet_hours_end_utc?: number | null;
};

export const DEFAULT_PUSH_BATCHING_POLICY: PushBatchingPolicy = {
  enabled: false,
  window_ms: 60_000,
  max_batch_size: 8,
  instant_categories: ["emergency"],
  quiet_hours_start_utc: null,
  quiet_hours_end_utc: null,
};

export type PushBatchState = {
  pending: PushPayload[];
  lastFlushAt: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

function readHourOfDay(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored < 0 || floored > 23) return null;
  return floored;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function normalizePushBatchingPolicy(raw: unknown): PushBatchingPolicy {
  const input = asRecord(raw);
  const instantCategories = readStringArray(input.instant_categories);
  return {
    enabled: readBoolean(input.enabled, DEFAULT_PUSH_BATCHING_POLICY.enabled),
    window_ms: readPositiveInt(input.window_ms, DEFAULT_PUSH_BATCHING_POLICY.window_ms),
    max_batch_size: readPositiveInt(
      input.max_batch_size,
      DEFAULT_PUSH_BATCHING_POLICY.max_batch_size
    ),
    instant_categories:
      instantCategories.length > 0
        ? instantCategories
        : [...DEFAULT_PUSH_BATCHING_POLICY.instant_categories],
    quiet_hours_start_utc: readHourOfDay(input.quiet_hours_start_utc),
    quiet_hours_end_utc: readHourOfDay(input.quiet_hours_end_utc),
  };
}

export function createPushBatchState(): PushBatchState {
  return { pending: [], lastFlushAt: 0 };
}

export function isInQuietHours(policy: PushBatchingPolicy, now: Date): boolean {
  const start = policy.quiet_hours_start_utc;
  const end = policy.quiet_hours_end_utc;
  if (start === null || start === undefined) return false;
  if (end === null || end === undefined) return false;
  const hour = now.getUTCHours();
  if (start === end) return false;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Wraps around midnight (e.g. start=22, end=6)
  return hour >= start || hour < end;
}

function buildDigestPayload(
  pending: PushPayload[],
  now: number
): PushPayload {
  const count = pending.length;
  const previewTitles = pending.slice(0, 3).map((p) => p.title);
  return {
    id: `digest-${now}`,
    title: `${count} new alerts`,
    body: previewTitles.join("; "),
    receivedAt: now,
    priority: "normal",
    category: "digest",
    data: {
      kind: "digest",
      items: pending.map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        receivedAt: p.receivedAt,
        priority: p.priority ?? null,
        category: p.category ?? null,
      })),
    },
  };
}

function isInstantCategory(
  policy: PushBatchingPolicy,
  category: string | null | undefined
): boolean {
  if (!category) return false;
  return policy.instant_categories.includes(category);
}

export function enqueuePush(
  state: PushBatchState,
  payload: PushPayload,
  policy: PushBatchingPolicy,
  now: number
): { nextState: PushBatchState; emit: PushPayload[] | null } {
  if (!policy.enabled) {
    return { nextState: state, emit: [payload] };
  }

  if (isInstantCategory(policy, payload.category)) {
    return { nextState: state, emit: [payload] };
  }

  // If adding this payload would reach/exceed max_batch_size, auto-flush
  // including the new payload as part of the digest.
  if (state.pending.length + 1 >= policy.max_batch_size) {
    const combined = [...state.pending, payload];
    const digest = buildDigestPayload(combined, now);
    return {
      nextState: { pending: [], lastFlushAt: now },
      emit: [digest],
    };
  }

  const nextPending = [...state.pending, payload];
  return {
    nextState: { pending: nextPending, lastFlushAt: state.lastFlushAt },
    emit: null,
  };
}

export function flushPushBatch(
  state: PushBatchState,
  policy: PushBatchingPolicy,
  now: number
): { nextState: PushBatchState; digest: PushPayload | null } {
  void policy;
  if (state.pending.length === 0) {
    return {
      nextState: { pending: [], lastFlushAt: now },
      digest: null,
    };
  }
  if (state.pending.length === 1) {
    const only = state.pending[0]!;
    return {
      nextState: { pending: [], lastFlushAt: now },
      digest: only,
    };
  }
  const digest = buildDigestPayload(state.pending, now);
  return {
    nextState: { pending: [], lastFlushAt: now },
    digest,
  };
}
