import type { TimelineEntry } from "./activity-timeline";

/**
 * Well-known field names used to map raw resource rows into TimelineEntry shape.
 * The mapper tries each candidate list in order and picks the first non-empty string value.
 */
const ID_CANDIDATES = ["id", "event_id", "action_id"] as const;
const TIMESTAMP_CANDIDATES = ["timestamp", "event_time", "created_at", "occurred_at", "enqueued_at", "operation_started_at"] as const;
const TYPE_CANDIDATES = ["action_type", "event_type", "type", "action_category", "operation_name"] as const;
const LABEL_CANDIDATES = ["label", "canonical_status", "status", "step_status", "action_category", "event_source", "operation_name"] as const;
const DESCRIPTION_CANDIDATES = ["description", "summary", "notes", "resolution", "root_cause"] as const;
const ACTOR_CANDIDATES = ["actor", "performed_by_user_id", "performed_by_system", "user_id", "created_by"] as const;
const TRACE_CANDIDATES = ["trace_id", "traceId", "correlation_id"] as const;

function pickString(row: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

const TONE_MAP: Record<string, TimelineEntry["tone"]> = {
  delivered: "success",
  completed: "success",
  picked_up: "success",
  resolved: "success",
  success: "success",
  done: "success",
  failed: "danger",
  cancelled: "danger",
  rejected: "danger",
  error: "danger",
  exception: "warning",
  pending: "warning",
  investigating: "warning",
  rto: "warning",
  returned: "warning",
  in_transit: "info",
  dispatched: "info",
  assigned: "info",
  created: "info",
  processing: "info",
  running: "info",
  queued: "warning",
  skipped: "neutral",
  timed_out: "danger",
};

function resolveTone(status: string | null, type: string | null): TimelineEntry["tone"] {
  const normalized = (status ?? type ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  if (!normalized) return "neutral";
  if (TONE_MAP[normalized]) return TONE_MAP[normalized];
  for (const [marker, tone] of Object.entries(TONE_MAP)) {
    if (normalized.includes(marker)) return tone;
  }
  return "neutral";
}

/**
 * Convert a raw related-resource row (e.g. from shipment_actions) to a TimelineEntry.
 */
export function mapRowToTimelineEntry(
  row: Record<string, unknown>,
  index: number
): TimelineEntry {
  const id = pickString(row, ID_CANDIDATES) ?? String(index);
  const timestamp = pickString(row, TIMESTAMP_CANDIDATES) ?? new Date().toISOString();
  const type = pickString(row, TYPE_CANDIDATES) ?? "action";
  const label = pickString(row, LABEL_CANDIDATES);
  const description = pickString(row, DESCRIPTION_CANDIDATES);
  const actor = pickString(row, ACTOR_CANDIDATES);
  const traceId = pickString(row, TRACE_CANDIDATES);
  const tone = resolveTone(
    pickString(row, ["canonical_status", "step_status", "status"]),
    type
  );

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) {
      metadata[key] = value;
    }
  }

  return { id, timestamp, type, label, description, actor, tone, metadata, traceId };
}

/**
 * Convert an array of related resource items into sorted TimelineEntry[].
 * Sorts newest-first by timestamp.
 */
export function mapRelatedItemsToTimeline(
  items: Record<string, unknown>[]
): TimelineEntry[] {
  return items
    .map((row, index) => mapRowToTimelineEntry(row, index))
    .sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return tb - ta;
    });
}

/**
 * Check if a related resource key represents an activity/actions resource.
 * Convention: keys ending with _actions, _events, _history, _timeline, or _steps.
 */
export function isActivityRelatedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return (
    normalized.endsWith("_actions") ||
    normalized.endsWith("_events") ||
    normalized.endsWith("_history") ||
    normalized.endsWith("_timeline") ||
    normalized.endsWith("_steps")
  );
}
