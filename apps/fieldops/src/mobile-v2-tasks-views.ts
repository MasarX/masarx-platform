// Mobile V2 Tasks + Route saved-views, filters, sorts, groups — pure
// module (no JSX) so unit tests cover the filter/sort/group logic
// directly. Mirrors the design SSOT:
//   - Tasks: flow-tasks.jsx TASK_DEFAULT_VIEWS / TASK_FIELDS / TASK_SORTS
//     / TASK_GROUPS + deriveTasks.
//   - Route: app-store.jsx DEFAULT_VIEWS / STOP_SORTS / STOP_GROUPS +
//     deriveStops.
//
// Audit F7/F8/F9: the Tasks segmented control (List/Board/Map), the
// Saved Views sheet, and the Filters/Group/Sort sheets were dead or
// toast-only. These pure helpers + the typed view definitions back the
// real, design-faithful sheets and the Board/Map view bodies.

import type {
  MobileV2Task,
  MobileV2TaskUrgency,
} from "./mobile-v2-tasks-types";
import type { MobileV2RouteStop } from "./mobile-v2-route-screen";
import type { MobileV2MapAlert, MobileV2MapStop } from "./mobile-v2-map-screen";
import { EN_STRINGS, type FieldOpsStrings } from "./i18n";

// ===========================================================================
// Label keys — every visible label resolves from `strings.taskViews` so
// callers can pass AR_STRINGS; the exported constants keep English labels.
// ===========================================================================

type TaskViewsKey = keyof FieldOpsStrings["taskViews"];

const TASK_FILTER_FIELD_LABEL_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  urgency: "urgency",
  type: "type",
  area: "area",
  cod: "hasCod",
});

// Option value -> label key for the urgency + type filter options (and the
// urgency / type group headers, which share these labels).
const TASK_OPTION_LABEL_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  now: "now",
  today: "today",
  later: "later",
  blocker: "typeBlocker",
  delivery: "typeDelivery",
  pickup: "typePickup",
  return: "typeReturn",
  cash: "typeCash",
  break: "typeBreak",
  eor: "typeEor",
  "gate-in": "typeGateIn",
  "scan-out": "typeScanOut",
  hold: "typeHold",
  sort: "typeSort",
  ticket: "typeTicket",
  approval: "typeApproval",
  route_review: "typeRouteReview",
  sync: "typeSync",
});

const TASK_GROUP_LABEL_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  urgency: "urgency",
  none: "groupNone",
  type: "type",
  area: "area",
});

const TASK_SORT_LABEL_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  smart: "sortSmart",
  urgency: "urgency",
  eta: "sortEta",
  priority: "priority",
  type: "sortType",
  title: "sortTitle",
});

const TASK_VIEW_NAME_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  "tv-now": "now",
  "tv-smart": "viewSmart",
  "tv-today": "today",
  "tv-cod": "viewCod",
  "tv-area": "viewArea",
});

const ROUTE_SORT_LABEL_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  sequence: "routeSortSequence",
  sla: "routeSortSla",
  "cod-desc": "routeSortCod",
  name: "routeSortName",
});

const ROUTE_GROUP_LABEL_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  none: "groupNone",
  status: "routeGroupStatus",
  window: "routeGroupWindow",
});

const ROUTE_VIEW_NAME_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  route: "routeViewMine",
  urgent: "routeViewUrgent",
  cod: "routeViewCod",
  fragile: "routeViewFragile",
});

const ROUTE_STATUS_GROUP_LABEL_KEY: Readonly<Record<string, TaskViewsKey>> = Object.freeze({
  done: "statusDone",
  current: "statusCurrent",
  pending: "statusPending",
  sla: "statusSla",
  failed: "statusFailed",
  partial: "statusPartial",
});

function lookupTaskViews(
  map: Readonly<Record<string, TaskViewsKey>>,
  key: string,
  fallback: string,
  strings: FieldOpsStrings,
): string {
  const labelKey = map[key];
  return labelKey !== undefined ? strings.taskViews[labelKey] : fallback;
}

/** Localized label of a task filter field (`MOBILE_V2_TASK_FILTER_FIELDS[].key`). */
export function getMobileV2TaskFilterFieldLabel(
  key: string,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(TASK_FILTER_FIELD_LABEL_KEY, key, key, strings);
}

/** Localized label of a task filter option value; unknown values (areas) pass through. */
export function getMobileV2TaskFilterOptionLabel(
  value: string,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(TASK_OPTION_LABEL_KEY, value, value, strings);
}

/** Localized name of a built-in task saved view; custom views keep their own name. */
export function getMobileV2TaskViewName(
  id: string,
  fallback: string,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(TASK_VIEW_NAME_KEY, id, fallback, strings);
}

/** Localized name of a built-in route saved view; custom views keep their own name. */
export function getMobileV2RouteViewName(
  id: string,
  fallback: string,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(ROUTE_VIEW_NAME_KEY, id, fallback, strings);
}

function taskOption(value: string): MobileV2TaskFilterOption {
  return Object.freeze({ value, label: getMobileV2TaskFilterOptionLabel(value) });
}

// ===========================================================================
// Tasks — filter fields, sorts, groups, saved views
// ===========================================================================

export type MobileV2TaskFilterFieldKind = "enum" | "bool";

export interface MobileV2TaskFilterOption {
  readonly value: string;
  readonly label: string;
}

export interface MobileV2TaskFilterField {
  readonly key: string;
  readonly label: string;
  readonly kind: MobileV2TaskFilterFieldKind;
  /** Enum option list (static fields). Dynamic fields (area) resolve at runtime. */
  readonly options?: ReadonlyArray<MobileV2TaskFilterOption>;
  /** When true, the option list is derived from the live task `area` set. */
  readonly dynamic?: boolean;
}

// Mirrors flow-tasks.jsx TASK_FIELDS for the fields the task row type
// carries. `type` is portable (MobileV2Task.type); `priority` (a
// numeric) and `eta15` (needs ETA-in-minutes) are not surfaced here —
// the task envelope carries a priority *score* and an `eta_iso`
// timestamp, not the design's enum priority / minute ETA (U4: only
// fields whose data the row carries are added).
export const MOBILE_V2_TASK_FILTER_FIELDS: ReadonlyArray<MobileV2TaskFilterField> =
  Object.freeze([
    Object.freeze({
      key: "urgency",
      label: getMobileV2TaskFilterFieldLabel("urgency"),
      kind: "enum" as const,
      options: Object.freeze([
        taskOption("now"),
        taskOption("today"),
        taskOption("later"),
      ]),
    }),
    Object.freeze({
      key: "type",
      label: getMobileV2TaskFilterFieldLabel("type"),
      kind: "enum" as const,
      // Mirrors flow-tasks.jsx TASK_FIELDS `type` options. Each value
      // matches a `MobileV2Task.type` discriminant emitted by
      // resolve_fieldops_tasks_v1 / the task fixtures.
      options: Object.freeze([
        taskOption("blocker"),
        taskOption("delivery"),
        taskOption("pickup"),
        taskOption("return"),
        taskOption("cash"),
        taskOption("break"),
        taskOption("eor"),
        taskOption("gate-in"),
        taskOption("scan-out"),
        taskOption("hold"),
        taskOption("sort"),
        taskOption("ticket"),
        taskOption("approval"),
        taskOption("route_review"),
        taskOption("sync"),
      ]),
    }),
    Object.freeze({
      key: "area",
      label: getMobileV2TaskFilterFieldLabel("area"),
      kind: "enum" as const,
      dynamic: true,
    }),
    Object.freeze({
      key: "cod",
      label: getMobileV2TaskFilterFieldLabel("cod"),
      kind: "bool" as const,
    }),
  ]);

export type MobileV2TaskGroupKey = "urgency" | "none" | "type" | "area";

export interface MobileV2TaskGroupOption {
  readonly key: MobileV2TaskGroupKey;
  readonly label: string;
}

// Mirrors flow-tasks.jsx TASK_GROUPS.
export const MOBILE_V2_TASK_GROUP_OPTIONS: ReadonlyArray<MobileV2TaskGroupOption> =
  Object.freeze([
    Object.freeze({ key: "urgency" as const, label: getMobileV2TaskGroupLabel("urgency") }),
    Object.freeze({ key: "none" as const, label: getMobileV2TaskGroupLabel("none") }),
    Object.freeze({ key: "type" as const, label: getMobileV2TaskGroupLabel("type") }),
    Object.freeze({ key: "area" as const, label: getMobileV2TaskGroupLabel("area") }),
  ]);

export type MobileV2TaskSortKey =
  | "smart"
  | "urgency"
  | "eta"
  | "priority"
  | "type"
  | "title";

export interface MobileV2TaskSortOption {
  readonly key: MobileV2TaskSortKey;
  readonly label: string;
}

// Mirrors flow-tasks.jsx TASK_SORTS (label-for-label). `type` (Type A→Z)
// is portable — MobileV2Task carries `type` (U4).
export const MOBILE_V2_TASK_SORT_OPTIONS: ReadonlyArray<MobileV2TaskSortOption> =
  Object.freeze([
    Object.freeze({ key: "smart" as const, label: getMobileV2TaskSortLabel("smart") }),
    Object.freeze({ key: "urgency" as const, label: getMobileV2TaskSortLabel("urgency") }),
    Object.freeze({ key: "eta" as const, label: getMobileV2TaskSortLabel("eta") }),
    Object.freeze({ key: "priority" as const, label: getMobileV2TaskSortLabel("priority") }),
    Object.freeze({ key: "type" as const, label: getMobileV2TaskSortLabel("type") }),
    Object.freeze({ key: "title" as const, label: getMobileV2TaskSortLabel("title") }),
  ]);

/** Per-key filter selection — enum keys hold a value array, bool keys hold true. */
export type MobileV2TaskFilterState = Readonly<
  Record<string, ReadonlyArray<string> | boolean | undefined>
>;

export interface MobileV2TaskBoardSavedView {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly builtin: boolean;
  readonly filters: MobileV2TaskFilterState;
  readonly sort: MobileV2TaskSortKey;
  readonly group: MobileV2TaskGroupKey;
}

// Mirrors flow-tasks.jsx TASK_DEFAULT_VIEWS (id/name/emoji/config).
export const MOBILE_V2_TASK_DEFAULT_VIEWS: ReadonlyArray<MobileV2TaskBoardSavedView> =
  Object.freeze([
    Object.freeze({
      id: "tv-now",
      name: EN_STRINGS.taskViews.now,
      emoji: "🔥",
      builtin: true,
      filters: Object.freeze({ urgency: Object.freeze(["now"]) }),
      sort: "smart" as const,
      group: "type" as const,
    }),
    Object.freeze({
      id: "tv-smart",
      name: EN_STRINGS.taskViews.viewSmart,
      emoji: "⚡",
      builtin: true,
      filters: Object.freeze({}),
      sort: "smart" as const,
      group: "urgency" as const,
    }),
    Object.freeze({
      id: "tv-today",
      name: EN_STRINGS.taskViews.today,
      emoji: "📅",
      builtin: true,
      filters: Object.freeze({ urgency: Object.freeze(["today", "now"]) }),
      sort: "eta" as const,
      group: "type" as const,
    }),
    Object.freeze({
      id: "tv-cod",
      name: EN_STRINGS.taskViews.viewCod,
      emoji: "💵",
      builtin: true,
      filters: Object.freeze({ cod: true }),
      sort: "eta" as const,
      group: "urgency" as const,
    }),
    Object.freeze({
      id: "tv-area",
      name: EN_STRINGS.taskViews.viewArea,
      emoji: "🗺️",
      builtin: true,
      filters: Object.freeze({}),
      sort: "eta" as const,
      group: "area" as const,
    }),
  ]);

const URGENCY_RANK: Readonly<Record<MobileV2TaskUrgency, number>> = Object.freeze({
  now: 0,
  today: 1,
  later: 2,
});

/** True when a task carries a COD signal (a `cod_amount` in meta or "COD" copy). */
export function mobileV2TaskHasCod(task: MobileV2Task): boolean {
  const amount = task.meta.cod_amount;
  if (typeof amount === "number" && amount > 0) return true;
  const haystack = `${task.title} ${task.sub ?? ""} ${task.meta.cod ?? ""}`;
  return /cod|﷼/i.test(haystack);
}

/** Count the active filter selections (mirrors flow-tasks.jsx activeTaskFilterCount). */
export function countMobileV2TaskFilters(filters: MobileV2TaskFilterState): number {
  let n = 0;
  for (const value of Object.values(filters)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) n += 1;
    } else if (typeof value === "boolean") {
      if (value) n += 1;
    }
  }
  return n;
}

/** Apply the filter selection to a task list (pure; mirrors deriveTasks filter step). */
export function applyMobileV2TaskFilters(
  tasks: ReadonlyArray<MobileV2Task>,
  filters: MobileV2TaskFilterState,
): ReadonlyArray<MobileV2Task> {
  const urgency = filters.urgency;
  const type = filters.type;
  const area = filters.area;
  const cod = filters.cod === true;
  const out = tasks.filter((task) => {
    if (Array.isArray(urgency) && urgency.length > 0 && !urgency.includes(task.urgency)) {
      return false;
    }
    if (Array.isArray(type) && type.length > 0 && !type.includes(task.type)) {
      return false;
    }
    if (Array.isArray(area) && area.length > 0 && !area.includes(task.area ?? "")) {
      return false;
    }
    if (cod && !mobileV2TaskHasCod(task)) return false;
    return true;
  });
  return Object.freeze(out);
}

/** Sort a task list by sort key (pure; mirrors TASK_SORTS comparators). */
export function applyMobileV2TaskSort(
  tasks: ReadonlyArray<MobileV2Task>,
  sort: MobileV2TaskSortKey,
): ReadonlyArray<MobileV2Task> {
  const copy = [...tasks];
  const etaOf = (t: MobileV2Task): number =>
    t.eta_iso !== null ? Date.parse(t.eta_iso) : Number.POSITIVE_INFINITY;
  if (sort === "urgency") {
    copy.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
  } else if (sort === "eta") {
    copy.sort((a, b) => etaOf(a) - etaOf(b));
  } else if (sort === "priority") {
    copy.sort((a, b) => b.priority - a.priority);
  } else if (sort === "type") {
    copy.sort((a, b) => a.type.localeCompare(b.type));
  } else if (sort === "title") {
    copy.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    // smart — urgency × priority × eta
    copy.sort((a, b) => {
      const u = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
      if (u !== 0) return u;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return etaOf(a) - etaOf(b);
    });
  }
  return Object.freeze(copy);
}

export interface MobileV2TaskViewGroup {
  readonly key: string;
  readonly label: string;
  readonly tasks: ReadonlyArray<MobileV2Task>;
}

/** Group a (already sorted) task list by group key (pure; mirrors TASK_GROUPS). */
export function applyMobileV2TaskGroups(
  tasks: ReadonlyArray<MobileV2Task>,
  group: MobileV2TaskGroupKey,
  strings: FieldOpsStrings = EN_STRINGS,
): ReadonlyArray<MobileV2TaskViewGroup> {
  if (group === "none") {
    if (tasks.length === 0) return Object.freeze([]);
    return Object.freeze([
      Object.freeze({ key: "all", label: strings.taskViews.all, tasks }),
    ]);
  }
  const buckets = new Map<string, MobileV2Task[]>();
  const order: string[] = [];
  for (const task of tasks) {
    let key: string;
    if (group === "urgency") key = task.urgency;
    else if (group === "type") key = task.type;
    else key = task.area ?? "—";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(task);
  }
  // Urgency groups follow the canonical now → today → later order.
  const keyOrder =
    group === "urgency"
      ? (["now", "today", "later"] as const).filter((k) => buckets.has(k))
      : order;
  return Object.freeze(
    keyOrder.map((key) => {
      let label: string;
      if (group === "urgency" || group === "type") {
        label = getMobileV2TaskFilterOptionLabel(key, strings);
      } else {
        label = key;
      }
      return Object.freeze({
        key,
        label,
        tasks: Object.freeze(buckets.get(key) ?? []),
      });
    }),
  );
}

/** Distinct, sorted task `area` values — feeds the dynamic Area filter. */
export function collectMobileV2TaskAreas(
  tasks: ReadonlyArray<MobileV2Task>,
): ReadonlyArray<string> {
  const set = new Set<string>();
  for (const t of tasks) {
    if (t.area !== null && t.area.length > 0) set.add(t.area);
  }
  return Object.freeze([...set].sort());
}

// ===========================================================================
// Route — saved views, sorts, groups
// ===========================================================================

export type MobileV2RouteSortKey = "sequence" | "sla" | "cod-desc" | "name";

export interface MobileV2RouteSortOption {
  readonly key: MobileV2RouteSortKey;
  readonly label: string;
}

// Mirrors app-store.jsx STOP_SORTS (sequence / SLA / COD / name).
export const MOBILE_V2_ROUTE_SORT_OPTIONS: ReadonlyArray<MobileV2RouteSortOption> =
  Object.freeze([
    Object.freeze({ key: "sequence" as const, label: getMobileV2RouteSortLabel("sequence") }),
    Object.freeze({ key: "sla" as const, label: getMobileV2RouteSortLabel("sla") }),
    Object.freeze({ key: "cod-desc" as const, label: getMobileV2RouteSortLabel("cod-desc") }),
    Object.freeze({ key: "name" as const, label: getMobileV2RouteSortLabel("name") }),
  ]);

// Route group keys. `window` (time-window buckets derived from the stop
// SLA) is portable because `MobileV2RouteStop` carries `sla`. Area /
// district / priority are NOT included — the route stop row type does
// not carry that data (U4: only fields whose data the row carries are
// added).
export type MobileV2RouteGroupKey = "none" | "status" | "window";

export interface MobileV2RouteGroupOption {
  readonly key: MobileV2RouteGroupKey;
  readonly label: string;
}

// Mirrors app-store.jsx STOP_GROUPS for the fields the route stop row
// type carries (no-grouping / status / time window).
export const MOBILE_V2_ROUTE_GROUP_OPTIONS: ReadonlyArray<MobileV2RouteGroupOption> =
  Object.freeze([
    Object.freeze({ key: "none" as const, label: getMobileV2RouteGroupLabel("none") }),
    Object.freeze({ key: "status" as const, label: getMobileV2RouteGroupLabel("status") }),
    Object.freeze({ key: "window" as const, label: getMobileV2RouteGroupLabel("window") }),
  ]);

export interface MobileV2RouteListView {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly builtin: boolean;
  /** Status values to keep; empty = all. */
  readonly statusFilter: ReadonlyArray<MobileV2RouteStop["status"]>;
  /** When true, keep only COD stops. */
  readonly codOnly: boolean;
  /** When true, keep only fragile stops (route stop carries `fragile`). */
  readonly fragileOnly: boolean;
  /** When true, keep only re-attempt stops (route stop carries `attempts`). */
  readonly reattemptOnly: boolean;
  readonly sort: MobileV2RouteSortKey;
  readonly group: MobileV2RouteGroupKey;
}

// Mirrors app-store.jsx DEFAULT_VIEWS for the route stop list.
export const MOBILE_V2_ROUTE_DEFAULT_VIEWS: ReadonlyArray<MobileV2RouteListView> =
  Object.freeze([
    Object.freeze({
      id: "route",
      name: EN_STRINGS.taskViews.routeViewMine,
      emoji: "🛣",
      builtin: true,
      statusFilter: Object.freeze([]),
      codOnly: false,
      fragileOnly: false,
      reattemptOnly: false,
      sort: "sequence" as const,
      group: "none" as const,
    }),
    Object.freeze({
      id: "urgent",
      name: EN_STRINGS.taskViews.routeViewUrgent,
      emoji: "⚡",
      builtin: true,
      statusFilter: Object.freeze(["sla", "failed"] as const),
      codOnly: false,
      fragileOnly: false,
      reattemptOnly: false,
      sort: "sla" as const,
      group: "status" as const,
    }),
    Object.freeze({
      id: "cod",
      name: EN_STRINGS.taskViews.routeViewCod,
      emoji: "💵",
      builtin: true,
      statusFilter: Object.freeze([]),
      codOnly: true,
      fragileOnly: false,
      reattemptOnly: false,
      sort: "cod-desc" as const,
      group: "none" as const,
    }),
    Object.freeze({
      id: "fragile",
      name: EN_STRINGS.taskViews.routeViewFragile,
      emoji: "📦",
      builtin: false,
      statusFilter: Object.freeze([]),
      codOnly: false,
      // Mirrors app-store.jsx DEFAULT_VIEWS "fragile" view
      // (filters:{ fragile:true, attempts:true }).
      fragileOnly: true,
      reattemptOnly: true,
      sort: "sequence" as const,
      group: "none" as const,
    }),
  ]);

export interface MobileV2RouteViewResult {
  readonly rows: ReadonlyArray<MobileV2RouteStop>;
  readonly groups: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly rows: ReadonlyArray<MobileV2RouteStop>;
  }>;
}

/**
 * Bucket a stop's SLA window (an "HH:MM" string) into a coarse time
 * band — mirrors app-store.jsx STOP_GROUPS `window` group. An
 * unparseable / empty SLA lands in the "No window" bucket.
 */
export function mobileV2RouteWindowBucket(
  sla: string,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  const hour = Number.parseInt(sla.split(":")[0] ?? "", 10);
  if (!Number.isFinite(hour)) return strings.taskViews.windowNone;
  if (hour < 11) return strings.taskViews.windowMorning;
  if (hour < 14) return strings.taskViews.windowMidday;
  return strings.taskViews.windowAfternoon;
}

/**
 * Apply a route view's filter + sort + group to a stop list (pure;
 * mirrors app-store.jsx deriveStops). The `search` term filters on
 * customer / address / id (case-insensitive substring). The optional
 * `fragileOnly` / `reattemptOnly` filters are portable because the
 * `MobileV2RouteStop` row type carries `fragile` / `attempts` (U4).
 */
export function applyMobileV2RouteView(
  stops: ReadonlyArray<MobileV2RouteStop>,
  view: {
    readonly statusFilter: ReadonlyArray<MobileV2RouteStop["status"]>;
    readonly codOnly: boolean;
    readonly fragileOnly?: boolean;
    readonly reattemptOnly?: boolean;
    readonly sort: MobileV2RouteSortKey;
    readonly group: MobileV2RouteGroupKey;
  },
  search: string,
  strings: FieldOpsStrings = EN_STRINGS,
): MobileV2RouteViewResult {
  const term = search.trim().toLowerCase();
  let rows = stops.filter((s) => {
    if (view.statusFilter.length > 0 && !view.statusFilter.includes(s.status)) {
      return false;
    }
    if (view.codOnly && s.cod <= 0) return false;
    if (view.fragileOnly === true && !s.fragile) return false;
    if (view.reattemptOnly === true && s.attempts <= 1) return false;
    if (term.length > 0) {
      const hay = `${s.customer} ${s.address} ${s.id}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
  const sorted = [...rows];
  if (view.sort === "sla") {
    sorted.sort((a, b) => a.sla.localeCompare(b.sla));
  } else if (view.sort === "cod-desc") {
    sorted.sort((a, b) => b.cod - a.cod);
  } else if (view.sort === "name") {
    sorted.sort((a, b) => a.customer.localeCompare(b.customer));
  } else {
    sorted.sort((a, b) => a.seq - b.seq);
  }
  rows = sorted;

  if (view.group === "none") {
    return Object.freeze({
      rows: Object.freeze(rows),
      groups: Object.freeze([]),
    });
  }
  const buckets = new Map<string, MobileV2RouteStop[]>();
  const order: string[] = [];
  for (const s of rows) {
    const key = view.group === "window" ? mobileV2RouteWindowBucket(s.sla, strings) : s.status;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(s);
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    groups: Object.freeze(
      order.map((key) =>
        Object.freeze({
          key,
          // The `window` group key IS the human label; `status`
          // resolves through the status-label map.
          label:
            view.group === "window"
              ? key
              : lookupTaskViews(ROUTE_STATUS_GROUP_LABEL_KEY, key, key, strings),
          rows: Object.freeze(buckets.get(key) ?? []),
        }),
      ),
    ),
  });
}

/** Label for a route sort key (used in the chip + subtitle). */
export function getMobileV2RouteSortLabel(
  key: MobileV2RouteSortKey,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(ROUTE_SORT_LABEL_KEY, key, strings.taskViews.routeSortSequence, strings);
}

/** Label for a route group key (used in the chip). */
export function getMobileV2RouteGroupLabel(
  key: MobileV2RouteGroupKey,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(ROUTE_GROUP_LABEL_KEY, key, strings.taskViews.groupNone, strings);
}

/** Label for a task sort key. */
export function getMobileV2TaskSortLabel(
  key: MobileV2TaskSortKey,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(TASK_SORT_LABEL_KEY, key, strings.taskViews.sortSmartShort, strings);
}

/** Label for a task group key. */
export function getMobileV2TaskGroupLabel(
  key: MobileV2TaskGroupKey,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  return lookupTaskViews(TASK_GROUP_LABEL_KEY, key, strings.taskViews.groupNone, strings);
}

// ===========================================================================
// Route → Live-route map projection
// ===========================================================================

/** Live-route map envelope projected from resolved route stops. */
export interface MobileV2RouteMapProjection {
  readonly routeId: string;
  readonly pendingCount: number;
  readonly distanceLeftKm: number;
  readonly alerts: ReadonlyArray<MobileV2MapAlert>;
  readonly mapStops: ReadonlyArray<MobileV2MapStop>;
  readonly upcoming: ReadonlyArray<MobileV2MapStop>;
  readonly active: MobileV2MapStop | null;
}

/** Project a single resolved route stop into a `MobileV2MapStop`. */
function routeStopToMapStop(stop: MobileV2RouteStop): MobileV2MapStop {
  return Object.freeze({
    id: stop.id,
    seq: stop.seq,
    customer: stop.customer,
    address: stop.address,
    sla: stop.sla,
    // The route resolver does not carry per-stop ETA / distance (those
    // need a live geocoding/optimizer pass). They project as 0 — an
    // honest "not computed" value — never a fabricated estimate.
    etaMin: 0,
    distanceKm: 0,
    cod: stop.cod,
    latitude: stop.latitude ?? null,
    longitude: stop.longitude ?? null,
    accuracyM: stop.accuracyM ?? null,
    shortAddress: stop.shortAddress ?? null,
    geocodingStatus: stop.geocodingStatus ?? null,
    geocodingAccuracy: stop.geocodingAccuracy ?? null,
    geocodingProvider: stop.geocodingProvider ?? null,
    geocodingMatch: stop.geocodingMatch ?? null,
  });
}

/**
 * Project resolved route stops into the Live-route map envelope —
 * engineering re-audit E2. The map screen previously rendered the
 * `MOBILE_V2_PREVIEW_ROUTE` fixture unconditionally in the production
 * native shell; it now derives from `useFieldopsRouteRpc` output via
 * this pure projection.
 *
 *   - `active`   — the stop in `current` status (the one being worked).
 *   - `mapStops` — every stop in sequence order, including done stops, so
 *     completed routes can still render coordinate-backed map proof.
 *   - `upcoming` — every stop not yet `done` (current + sla + pending),
 *     in route-sequence order; this is the bottom carousel.
 *   - `pendingCount` — count of `upcoming` (stops still to complete).
 *   - `distanceLeftKm` — 0 (no resolver-supplied route distance yet).
 *   - `alerts` — empty (no live traffic/hazard resolver yet).
 *
 * The fixture remains the preview/offline fallback only; the production
 * shell calls this with resolver-driven rows.
 */
export function projectMobileV2RouteMap(
  rows: ReadonlyArray<MobileV2RouteStop>,
  routeId: string,
): MobileV2RouteMapProjection {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const mapStops = ordered.map(routeStopToMapStop);
  const upcoming = ordered
    .filter((s) => s.status !== "done")
    .map(routeStopToMapStop);
  const activeStop = ordered.find((s) => s.status === "current");
  return Object.freeze({
    routeId,
    pendingCount: upcoming.length,
    distanceLeftKm: 0,
    alerts: Object.freeze([]),
    mapStops: Object.freeze(mapStops),
    upcoming: Object.freeze(upcoming),
    active: activeStop !== undefined ? routeStopToMapStop(activeStop) : null,
  });
}
