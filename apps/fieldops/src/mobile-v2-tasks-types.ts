// Mobile V2 Tasks — typed envelope mirroring the public.resolve_fieldops_tasks_v1
// RETURNS TABLE shape. Pure types + filters / sorters / groupers; the React
// screen consumes these. Pure module so unit tests can cover ordering and
// grouping without rendering JSX.

import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";

export type MobileV2TaskUrgency = "now" | "today" | "later";

export type MobileV2TaskTone =
  | "danger"
  | "warning"
  | "accent"
  | "info"
  | "neutral"
  | "success";

export interface MobileV2Task {
  readonly task_id: string;
  readonly type: string;
  readonly title: string;
  readonly sub: string | null;
  readonly urgency: MobileV2TaskUrgency;
  readonly cta: string;
  readonly route: string;
  readonly eta_iso: string | null;
  readonly priority: number;
  readonly area: string | null;
  readonly code: string | null;
  readonly action: string;
  readonly tone: MobileV2TaskTone;
  readonly meta: Readonly<Record<string, unknown>>;
}

export type MobileV2TaskCompletionState = "done" | "failed" | "partial";

const URGENCY_ORDER: Readonly<Record<MobileV2TaskUrgency, number>> = Object.freeze({
  now: 0,
  today: 1,
  later: 2,
});

const TONE_ALLOWED = new Set<string>([
  "danger",
  "warning",
  "accent",
  "info",
  "neutral",
  "success",
]);

const URGENCY_ALLOWED = new Set<string>(["now", "today", "later"]);

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asTone(value: unknown): MobileV2TaskTone {
  if (typeof value === "string" && TONE_ALLOWED.has(value)) {
    return value as MobileV2TaskTone;
  }
  return "neutral";
}

function asUrgency(value: unknown): MobileV2TaskUrgency {
  if (typeof value === "string" && URGENCY_ALLOWED.has(value)) {
    return value as MobileV2TaskUrgency;
  }
  return "later";
}

function asMeta(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

/** Parse one row of the resolve_fieldops_tasks_v1 RETURNS TABLE shape, defensively. */
export function parseMobileV2Task(value: unknown): MobileV2Task | null {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const task_id = asString(r.task_id);
  const title = asString(r.title);
  const route = asString(r.route);
  if (task_id === null || title === null || route === null) return null;
  const meta = asMeta(r.meta);
  const completionState = normalizeMobileV2TaskCompletionState(meta);
  const cta =
    completionState === "done"
      ? "Done"
      : completionState === "failed"
        ? "Failed"
        : completionState === "partial"
          ? "Partial"
          : (asString(r.cta) ?? "Open");
  const tone: MobileV2TaskTone =
    completionState === "done"
      ? "success"
      : completionState === "failed"
        ? "danger"
        : completionState === "partial"
          ? "warning"
          : asTone(r.tone);
  return Object.freeze({
    task_id,
    type: asString(r.type) ?? "task",
    title,
    sub: asString(r.sub),
    urgency: asUrgency(r.urgency),
    cta,
    route,
    eta_iso: asString(r.eta_iso),
    priority: Math.max(0, Math.min(100, Math.round(asNumber(r.priority) ?? 50))),
    area: asString(r.area),
    code: asString(r.code),
    action: asString(r.action) ?? "open",
    tone,
    meta,
  });
}

export function parseMobileV2TaskList(value: unknown): ReadonlyArray<MobileV2Task> {
  if (!Array.isArray(value)) return [];
  const out: MobileV2Task[] = [];
  for (const entry of value) {
    const task = parseMobileV2Task(entry);
    if (task !== null) out.push(task);
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Display derivation
//
// The design ScrTasks `TaskRow` (flow-tasks.jsx:723-764) renders, below the
// `sub` line, a chip row of a "Priority" chip + a meta chip. In the design's
// static task object `priority` is a string ('high'|'normal'|'low') and
// `meta` is a pre-baked right-side string. The production envelope instead
// carries `priority` as a 0..100 INT (resolve_fieldops_tasks_v1) and `meta`
// as a structured JSONB object — so the screen derives the chip inputs from
// those typed fields here (pure + unit-tested) rather than in JSX.
// ---------------------------------------------------------------------------

/**
 * Priority threshold for the "Priority" chip. Mirrors the resolver tone
 * ladder (`fieldops_v2_resolve_tone`: `priority >= 75` is the high band
 * that flips the row tone to `warning`). A task at/above this score gets
 * the design's danger "Priority" chip.
 */
export const MOBILE_V2_TASK_HIGH_PRIORITY_THRESHOLD = 75;

/** True when a task is in the high-priority band (design "Priority" chip). */
export function isMobileV2TaskHighPriority(task: MobileV2Task): boolean {
  return task.priority >= MOBILE_V2_TASK_HIGH_PRIORITY_THRESHOLD;
}

function metaNumber(meta: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = meta[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function metaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = meta[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeMobileV2TaskCompletionState(
  meta: Readonly<Record<string, unknown>>,
): MobileV2TaskCompletionState | null {
  const raw = metaString(meta, "route_stop_status")?.toLowerCase() ?? null;
  if (raw === "done" || raw === "delivered" || raw === "completed") return "done";
  if (raw === "failed" || raw === "returned" || raw === "cancelled") return "failed";
  if (raw === "partial") return "partial";
  return null;
}

export function deriveMobileV2TaskCompletionState(
  task: MobileV2Task,
): MobileV2TaskCompletionState | null {
  return normalizeMobileV2TaskCompletionState(task.meta);
}

/**
 * Derive the design `TaskRow` meta-chip label from the typed task
 * envelope. Mirrors the design `buildTasks` right-side `meta` strings
 * (`${s.cod} ﷼ COD`, `${p.expectedQty} parcels`, queue counts, …)
 * resolved from the structured `meta` JSONB the RPC actually returns.
 *
 * Precedence: COD amount (delivery/pickup cash) → parcel/box count →
 * queued-writes count. Returns `null` when no meta signal is present, so
 * the screen suppresses the chip (design renders it only when `meta` is
 * truthy).
 */
export function deriveMobileV2TaskMetaLabel(task: MobileV2Task): string | null {
  const meta = task.meta;
  const completionState = deriveMobileV2TaskCompletionState(task);
  if (completionState === "done") return "Done";
  if (completionState === "failed") return "Failed";
  if (completionState === "partial") return "Partial";
  const cod = metaNumber(meta, "cod_amount");
  if (cod !== null && cod > 0) {
    const currency = metaString(meta, "cod_currency") ?? "SAR";
    return `${formatMobileV2CurrencyCompact(cod, currency, { grouped: false })} COD`;
  }
  const boxes = metaNumber(meta, "box_count");
  if (boxes !== null && boxes > 0) {
    return `${boxes} ${boxes === 1 ? "box" : "boxes"}`;
  }
  const queued = metaNumber(meta, "queued");
  if (queued !== null && queued > 0) {
    return `${queued} queued`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sorting + grouping
// ---------------------------------------------------------------------------

/** Smart default order — urgency × priority desc × eta asc × code asc. */
export function sortMobileV2TasksSmart(
  tasks: ReadonlyArray<MobileV2Task>,
): ReadonlyArray<MobileV2Task> {
  const copy = [...tasks];
  copy.sort((a, b) => {
    const u = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (u !== 0) return u;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const aEta = a.eta_iso !== null ? Date.parse(a.eta_iso) : Number.POSITIVE_INFINITY;
    const bEta = b.eta_iso !== null ? Date.parse(b.eta_iso) : Number.POSITIVE_INFINITY;
    if (aEta !== bEta) return aEta - bEta;
    return (a.code ?? a.task_id).localeCompare(b.code ?? b.task_id);
  });
  return Object.freeze(copy);
}

export type MobileV2TaskSortMode = "smart" | "eta" | "priority" | "area";

/** Cycle through available sort modes (smart → eta → priority → area → smart). */
export const MOBILE_V2_TASK_SORT_MODES: ReadonlyArray<MobileV2TaskSortMode> = Object.freeze([
  "smart",
  "eta",
  "priority",
  "area",
]);

export function nextMobileV2TaskSortMode(current: MobileV2TaskSortMode): MobileV2TaskSortMode {
  const idx = MOBILE_V2_TASK_SORT_MODES.indexOf(current);
  const next = MOBILE_V2_TASK_SORT_MODES[(idx + 1) % MOBILE_V2_TASK_SORT_MODES.length];
  return next ?? "smart";
}

const SORT_MODE_LABELS: Readonly<Record<MobileV2TaskSortMode, string>> = Object.freeze({
  smart: "Smart",
  eta: "ETA",
  priority: "Priority",
  area: "Area",
});

export function getMobileV2TaskSortModeLabel(mode: MobileV2TaskSortMode): string {
  return SORT_MODE_LABELS[mode] ?? "Smart";
}

export function sortMobileV2TasksBy(
  tasks: ReadonlyArray<MobileV2Task>,
  mode: MobileV2TaskSortMode,
): ReadonlyArray<MobileV2Task> {
  if (mode === "smart") return sortMobileV2TasksSmart(tasks);
  const copy = [...tasks];
  if (mode === "eta") {
    copy.sort((a, b) => {
      const aEta = a.eta_iso !== null ? Date.parse(a.eta_iso) : Number.POSITIVE_INFINITY;
      const bEta = b.eta_iso !== null ? Date.parse(b.eta_iso) : Number.POSITIVE_INFINITY;
      if (aEta !== bEta) return aEta - bEta;
      return (a.code ?? a.task_id).localeCompare(b.code ?? b.task_id);
    });
  } else if (mode === "priority") {
    copy.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (a.code ?? a.task_id).localeCompare(b.code ?? b.task_id);
    });
  } else if (mode === "area") {
    copy.sort((a, b) => {
      const aArea = a.area ?? "";
      const bArea = b.area ?? "";
      const c = aArea.localeCompare(bArea);
      if (c !== 0) return c;
      return (a.code ?? a.task_id).localeCompare(b.code ?? b.task_id);
    });
  }
  return Object.freeze(copy);
}

export interface MobileV2TaskGroup {
  readonly key: MobileV2TaskUrgency;
  readonly label: string;
  readonly count: number;
  readonly tasks: ReadonlyArray<MobileV2Task>;
}

const GROUP_LABELS: Readonly<Record<MobileV2TaskUrgency, string>> = Object.freeze({
  now: "Now",
  today: "Today",
  later: "Later",
});

/** Aggregated KPI counts driving the Tasks hero strip
 *  (Now / Today / Later / Total). Mirrors the design's ScrTasks counts. */
export interface MobileV2TaskKpiCounts {
  readonly now: number;
  readonly today: number;
  readonly later: number;
  readonly all: number;
}

/** Count tasks by urgency bucket. Pure helper — no react state, easy to test. */
export function computeMobileV2TaskKpiCounts(
  tasks: ReadonlyArray<MobileV2Task>,
): MobileV2TaskKpiCounts {
  let now = 0;
  let today = 0;
  let later = 0;
  for (const t of tasks) {
    if (t.urgency === "now") now += 1;
    else if (t.urgency === "today") today += 1;
    else later += 1;
  }
  return Object.freeze({ now, today, later, all: tasks.length });
}

/** Group tasks by urgency. Empty groups are dropped. */
export function groupMobileV2TasksByUrgency(
  tasks: ReadonlyArray<MobileV2Task>,
): ReadonlyArray<MobileV2TaskGroup> {
  const buckets: Record<MobileV2TaskUrgency, MobileV2Task[]> = {
    now: [],
    today: [],
    later: [],
  };
  for (const task of tasks) {
    buckets[task.urgency].push(task);
  }
  const out: MobileV2TaskGroup[] = [];
  for (const key of ["now", "today", "later"] as const) {
    const list = buckets[key];
    if (list.length === 0) continue;
    out.push(
      Object.freeze({
        key,
        label: GROUP_LABELS[key],
        count: list.length,
        tasks: Object.freeze(list),
      }),
    );
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Filter tasks by a search query. Matches against title, sub, code, area, and
 * task_id (case-insensitive substring). Empty / whitespace query is a passthrough.
 */
export function filterMobileV2TasksByQuery(
  tasks: ReadonlyArray<MobileV2Task>,
  query: string,
): ReadonlyArray<MobileV2Task> {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return tasks;
  const out: MobileV2Task[] = [];
  for (const task of tasks) {
    const haystack = [
      task.title,
      task.sub ?? "",
      task.code ?? "",
      task.area ?? "",
      task.task_id,
      task.type,
    ]
      .join(" ")
      .toLowerCase();
    if (haystack.includes(trimmed)) out.push(task);
  }
  return Object.freeze(out);
}
