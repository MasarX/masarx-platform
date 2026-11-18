/** Expose branded empty-state copy and bounded outbox diagnostics to the screen. */

import { formatRelativeAge } from "../mobile-outbox-aging";

export const IDEMPOTENCY_KEY_TAIL_LENGTH = 8;
export const LAST_ERROR_TRUNCATE_LENGTH = 80;

export const OUTBOX_EMPTY_STATE_TITLE = "All caught up";
export const OUTBOX_EMPTY_STATE_DESCRIPTION =
  "Actions you take offline appear here until synced.";

export function shortIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= IDEMPOTENCY_KEY_TAIL_LENGTH
    ? trimmed
    : trimmed.slice(-IDEMPOTENCY_KEY_TAIL_LENGTH);
}

export function truncateError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= LAST_ERROR_TRUNCATE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, LAST_ERROR_TRUNCATE_LENGTH - 1)}\u2026`;
}

export type OutboxEntryDiagnosticsInput = {
  id: string;
  idempotency_key?: string | null;
  attempt_count?: number | null;
  created_at?: string | number | Date | null;
  last_error?: string | null;
};

export type OutboxEntryDiagnostics = {
  idempotencyKeyShort: string | null;
  attemptCount: number;
  createdAtRelative: string | null;
  lastErrorTruncated: string | null;
  rowKey: string;
};

export function deriveEntryDiagnostics(
  entry: OutboxEntryDiagnosticsInput,
  now: number = Date.now()
): OutboxEntryDiagnostics {
  const idempotencyKeyShort = shortIdempotencyKey(entry.idempotency_key);
  const attemptCount =
    typeof entry.attempt_count === "number" && Number.isFinite(entry.attempt_count)
      ? Math.max(0, Math.floor(entry.attempt_count))
      : 0;
  const createdMs = toEpochMsLoose(entry.created_at);
  const createdAtRelative =
    createdMs === null ? null : formatRelativeAge(Math.max(0, now - createdMs));
  const lastErrorTruncated = truncateError(entry.last_error);
  const rowKey = idempotencyKeyShort ?? entry.id;
  return {
    idempotencyKeyShort,
    attemptCount,
    createdAtRelative,
    lastErrorTruncated,
    rowKey,
  };
}

export function hasDeadEntries(
  entries: ReadonlyArray<{ status?: string | null }> | null | undefined
): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => entry?.status === "dead");
}

function toEpochMsLoose(
  value: string | number | Date | null | undefined
): number | null {
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
