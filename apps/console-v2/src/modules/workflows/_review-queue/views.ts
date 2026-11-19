// _review-queue/views.ts — Saved-view persistence and search helpers for the
// review queue. Module-local. LocalStorage backed; per-user, no shared visibility.
// When a backend `user_view_preferences` table is added, swap the storage layer
// here in one place — call sites stay stable.

import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';

export type FilterId = 'mine' | 'queue' | 'all' | 'breach' | 'snoozed' | string;

export interface SavedView {
  id: string;
  label: string;
  filter: FilterId;
  search: string;
  createdAt: number;
}

const STORAGE_KEY = 'console-v2.review-queue.views';

function readSafe(): SavedView[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is SavedView =>
      v && typeof v.id === 'string' && typeof v.label === 'string' && typeof v.filter === 'string'
    );
  } catch {
    return [];
  }
}

function writeSafe(views: SavedView[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // QuotaExceeded — ignore; views are non-critical.
  }
}

export function listSavedViews(): SavedView[] {
  return readSafe();
}

export function saveView(label: string, filter: FilterId, search: string): SavedView {
  const id = `view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const view: SavedView = { id, label, filter, search, createdAt: Date.now() };
  const views = [view, ...readSafe()];
  writeSafe(views.slice(0, 12)); // cap at 12 saved views
  return view;
}

export function deleteView(id: string): void {
  writeSafe(readSafe().filter((v) => v.id !== id));
}

// ---------- Search ----------

/** Normalise for case-insensitive substring match. */
function norm(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).toLowerCase();
}

export function matchesSearch(
  task: { task_id?: string; subject?: string; description?: string; queue?: string; assigned_to?: string | null },
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    norm(task.task_id).includes(needle) ||
    norm(task.subject).includes(needle) ||
    norm(task.description).includes(needle) ||
    norm(task.queue).includes(needle) ||
    norm(task.assigned_to).includes(needle)
  );
}

// ---------- SLA helpers ----------

/** Canonical duration bucket — mirror of one row from
 *  `ui_presentation_policy.duration_buckets[]` (see
 *  `apps/console-v2/src/lib/seed-raw/policies.js` `sv_360`). The formatter
 *  walks buckets largest→smallest threshold; the smallest bucket also
 *  drives the overdue-side rendering. */
export interface DurationBucket {
  unit: string;
  threshold_ms: number;
  label: string;
}

/** Canonical duration policy slice consumed by `formatTimeUntilCanonical`.
 *  Mirror of `ui_presentation_policy.{duration_buckets,overdue_label}`. */
export interface DurationFormatPolicy {
  duration_buckets: DurationBucket[];
  overdue_label: string;
}

/** W63 (Workflows Cycle F-R-3 P1-1/P1-2) — canonical SLA-countdown
 *  formatter. Replaces the duplicated `formatTimeUntil` ladders in
 *  `review-queue.tsx` and `views.ts` that hardcoded 60000/3600000/86400000
 *  ms thresholds + the `'m overdue'` literal. The bucket ladder + overdue
 *  label resolve canonically from `ui_presentation_policy.duration_buckets`
 *  / `ui_presentation_policy.overdue_label` via `useResolveSettings(
 *  'ui_presentation_policy')`. Strict no-fallback: missing canonical row
 *  → returns the placeholder `'—'` so the consumer renders the gap
 *  visibly instead of masking it with a hardcoded ladder
 *  (AGENTS.md §2 ZERO HARDCODING + §2 ZERO REDUNDANCY + §4 SSOT). */
export function formatTimeUntilCanonical(
  ms: number,
  policy: DurationFormatPolicy | null | undefined,
): string {
  if (!policy?.duration_buckets || policy.duration_buckets.length === 0) return '—';
  const sortedBuckets = [...policy.duration_buckets].sort(
    (a, b) => b.threshold_ms - a.threshold_ms,
  );
  const smallestBucket = sortedBuckets[sortedBuckets.length - 1]!;
  if (ms < 0) {
    const value = Math.floor(-ms / smallestBucket.threshold_ms);
    return `${value}${smallestBucket.label} ${policy.overdue_label}`;
  }
  for (const bucket of sortedBuckets) {
    if (ms >= bucket.threshold_ms) return `${Math.floor(ms / bucket.threshold_ms)}${bucket.label}`;
  }
  return `0${smallestBucket.label}`;
}

/** W70 (Workflows Cycle F-R-10 P2-1) — canonical "time ago" formatter.
 *  Reuses the same `ui_presentation_policy.duration_buckets` ladder as
 *  `formatTimeUntilCanonical` but renders with a trailing `' ago'` suffix
 *  for past-time displays (run history rows, recent-event timelines).
 *  Replaces the inline `fmtTimeAgo` ladder in
 *  `modules/workflows/templates.tsx` that hardcoded the same
 *  60000/3600000/86400000 ms thresholds + `'s ago'/'m ago'/'h ago'/'d ago'`
 *  literals. Strict no-fallback: missing canonical row → returns the `'—'`
 *  placeholder so the gap surfaces visibly instead of masking it with a
 *  hardcoded ladder (AGENTS.md §2 ZERO HARDCODING + §2 ZERO REDUNDANCY +
 *  §4 SSOT). When `ms` is below the smallest bucket threshold, derives a
 *  sub-bucket value (typically seconds, when the smallest bucket is `m`)
 *  using `smallestBucket.threshold_ms / 60` so the legacy `Xs ago` shape
 *  is preserved without an inline 1000ms literal. */
export function formatTimeAgoCanonical(
  ms: number,
  policy: DurationFormatPolicy | null | undefined,
): string {
  if (!policy?.duration_buckets || policy.duration_buckets.length === 0) return '—';
  const sortedBuckets = [...policy.duration_buckets].sort(
    (a, b) => b.threshold_ms - a.threshold_ms,
  );
  const smallestBucket = sortedBuckets[sortedBuckets.length - 1]!;
  const elapsed = Math.max(0, ms);
  for (const bucket of sortedBuckets) {
    if (elapsed >= bucket.threshold_ms) {
      return `${Math.floor(elapsed / bucket.threshold_ms)}${bucket.label} ago`;
    }
  }
  // Below the smallest bucket: project onto the next finer unit by
  // dividing the smallest bucket's ms threshold by 60 (m→s, h→m, etc.).
  // The label is derived from `smallestBucket.unit` truncated by 1 char
  // when it is a single-letter unit ('m'→'s' is the canonical seed case);
  // otherwise we fall back to the bucket's own label so the formatter
  // never fabricates a unit it does not have evidence for.
  const subBucketMs = smallestBucket.threshold_ms / 60;
  if (subBucketMs <= 0 || !Number.isFinite(subBucketMs)) {
    return `0${smallestBucket.label} ago`;
  }
  const subValue = Math.floor(elapsed / subBucketMs);
  const subLabel =
    smallestBucket.label === 'm' ? 's' :
    smallestBucket.label === 'h' ? 'm' :
    smallestBucket.label === 'd' ? 'h' :
    smallestBucket.label;
  return `${subValue}${subLabel} ago`;
}

/** Canonical snooze option shape (mirror of
 *  `ui_presentation_policy.task_snooze.options[]` row — see
 *  `apps/console-v2/src/lib/seed-raw/policies.js` `sv_360`).
 *  `duration_seconds` is the authoritative offset; the label/value pair is
 *  presentation only. */
export interface SnoozeOption {
  value: string;
  label: string;
  duration_seconds: number;
}

/** Cycle E (Workflows P1 #3) — `snoozeUntil` accepts only resolved
 *  canonical `SnoozeOption` objects. The previous string overload back-
 *  compat path (with the inline `SECONDS_BY_VALUE` Record) was a
 *  hardcoded duration matrix that violated AGENTS.md §2 (ZERO
 *  HARDCODING) + §4 (SSOT). Callers must obtain options from
 *  `useResolveSettings('ui_presentation_policy').task_snooze.options`
 *  and pass the full `{value, label, duration_seconds}` row. When the
 *  option is malformed (missing/non-positive `duration_seconds`),
 *  returns `null` so the caller surfaces a danger toast rather than
 *  silently snoozing for an unintended duration.
 */
export function snoozeUntil(
  option: SnoozeOption,
  base: number = Date.now(),
): string | null {
  if (!option || typeof option !== 'object') return null;
  const seconds = Number(option.duration_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(base + seconds * 1000).toISOString();
}

// ---------- Allowed actions (row-driven via task.allowed_actions, with
// task_type_catalog defaults as a deterministic fallback) ----------

/** Renderable descriptor for a task action button. */
export interface ActionDescriptor {
  /** UI label (Title-cased). */
  label: string;
  /** Icon glyph key from `<Icon />`. */
  icon: string;
  /** Stable backend-facing action key (e.g. `reschedule`, `claim`). */
  kind: string;
  /** Optional 1-based shortcut digit. */
  shortcut?: string;
}

// W34c — `TASK_TYPE_DEFAULT_ACTIONS` Record literal removed. Defaults now
// resolve canonically via `resolve_task_type_default_actions_v1(task_type)`,
// which mirrors `public.task_type_catalog.default_actions` (jsonb projection
// of `assignment_defaults.allowed_actions`). The previous inline map was a
// hardcoded behavior table, violating AGENTS.md §2 (ZERO HARDCODING) and §4
// (SSOT) — every task type's default action list must be row-driven.

// W34c — ACTION_REGISTRY Record literal removed. Visual descriptor data
// (label/icon/tone) and the action_kind → next_status transition map both
// resolve canonically from the `task_action_kind` lookup_values rows. Adding
// a new kind is now a single seed insert, not a code change.

type TaskActionRow = {
  value: string;
  label: string;
  icon?: string;
  tone?: string;
  next_status?: string;
  metadata?: {
    icon?: string;
    next_status?: string;
  };
};

function readActionRow(kind: string): TaskActionRow | null {
  const row = lookupRow('task_action_kind', kind) as TaskActionRow | null;
  return row ?? null;
}

function readDefaultActionRow(): TaskActionRow | null {
  return (lookupRow('task_action_kind', '_default') as TaskActionRow | null) ?? null;
}

function describeAction(kind: string, idx: number): ActionDescriptor {
  const row = readActionRow(kind);
  const fallback = readDefaultActionRow();
  return {
    kind,
    label: row?.label ?? fallback?.label ?? kind.replace(/_/g, ' '),
    icon: row?.icon ?? row?.metadata?.icon ?? fallback?.icon ?? fallback?.metadata?.icon ?? '',
    shortcut: idx < 9 ? String(idx + 1) : undefined,
  };
}

/** Resolve the action list for a task. Reads `task.allowed_actions` first
 *  (row-driven from `tasks.allowed_actions`), then falls back to canonical
 *  `task_type_catalog.default_actions` via `resolve_task_type_default_actions_v1`.
 *  Both signals are SSOT-faithful — no inline matrices. */
export function resolveAllowedActions(
  task: { task_type?: string; allowed_actions?: readonly string[] | null },
): ActionDescriptor[] {
  const fromRow = Array.isArray(task.allowed_actions) ? task.allowed_actions : null;
  const fromCatalog = task.task_type
    ? api.resolve_task_type_default_actions_v1(task.task_type)
    : [];
  const kinds = fromRow && fromRow.length ? fromRow : fromCatalog;
  return kinds.map((k, i) => describeAction(k, i));
}

/** Map an action kind to the next workflow status emitted by the seam.
 *  Resolves canonically from `task_action_kind.metadata.next_status`. The
 *  `_default` row carries the fallback when an unrecognised kind is passed. */
export function nextStatusForAction(kind: string): string {
  const row = readActionRow(kind);
  const fallback = readDefaultActionRow();
  return row?.next_status ?? row?.metadata?.next_status ?? fallback?.next_status ?? fallback?.metadata?.next_status ?? '';
}
