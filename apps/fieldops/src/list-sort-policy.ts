// Resolve sorting from list_sort_policy.
//
// Contract: the resolver `public.resolve_list_sort_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     default_sort_key: "due_asc",
//     sorts: [
//       { key: "due_asc",       label_en: "Due ↑",      label_ar: "...", field: "due_at",     direction: "asc" },
//       { key: "due_desc",      label_en: "Due ↓",      label_ar: "...", field: "due_at",     direction: "desc" },
//       { key: "priority_desc", label_en: "Priority ↓", label_ar: "...", field: "priority",   direction: "desc" },
//       { key: "distance_asc",  label_en: "Distance ↑", label_ar: "...", field: "distance_m", direction: "asc" }
//     ]
//   }
//
// This module:
//  1. Defines the typed shape (ListSortPolicyValue)
//  2. Normalizes the JSONB into a strict-typed object (defensive parse)
//  3. Provides the pure sorter `applySort(items, sortKey, sortConfig)` that
//     sorts a list by the chosen sort option's field+direction, handling
//     null/missing values gracefully (always sorted last).
//  4. Ships a STATIC fallback that mirrors the global default seed, so
//     consumers stay legible while the network query is in flight or offline.
//
//
// behavior must read through resolver functions, not hardcoded code-side maps.
// The resolved policy defines sort choices and defaults by surface.

export type ListSortDirection = "asc" | "desc";

export type ListSort = {
  key: string;
  label_en: string;
  label_ar: string;
  field: string;
  direction: ListSortDirection;
};

export type ListSortPolicyValue = {
  version: number;
  default_sort_key: string;
  sorts: ListSort[];
};

const VALID_DIRECTIONS: ReadonlySet<ListSortDirection> = new Set(["asc", "desc"]);

function coerceDirection(input: unknown, fallback: ListSortDirection): ListSortDirection {
  if (typeof input !== "string") return fallback;
  return VALID_DIRECTIONS.has(input as ListSortDirection)
    ? (input as ListSortDirection)
    : fallback;
}

// Mirror of the migration seed (see supabase/migrations/202604241710_list_sort_policy_v1.sql).
// Kept in sync intentionally: when offline / pre-fetch, the sort dropdown
// should match the global default the server would have returned.
export const STATIC_LIST_SORT: ListSortPolicyValue = {
  version: 1,
  default_sort_key: "due_asc",
  sorts: [
    {
      key: "due_asc",
      label_en: "Due ↑",
      label_ar: "الاستحقاق ↑",
      field: "due_at",
      direction: "asc",
    },
    {
      key: "due_desc",
      label_en: "Due ↓",
      label_ar: "الاستحقاق ↓",
      field: "due_at",
      direction: "desc",
    },
    {
      key: "priority_desc",
      label_en: "Priority ↓",
      label_ar: "الأولوية ↓",
      field: "priority",
      direction: "desc",
    },
    {
      key: "distance_asc",
      label_en: "Distance ↑",
      label_ar: "المسافة ↑",
      field: "distance_m",
      direction: "asc",
    },
  ],
};

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// ListSortPolicyValue. Defensive: any malformed entry is dropped, and if no
// valid sorts remain we fall back to the static seed so a bad row in
// production cannot brick the sort dropdown.
//
// If `default_sort_key` does not match any known sort entry, it is rewritten
// to the first valid sort's key so callers can rely on it always being valid.
export function normalizeListSortPolicy(raw: unknown): ListSortPolicyValue {
  if (!raw || typeof raw !== "object") return STATIC_LIST_SORT;
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const rawSorts = obj.sorts;
  const sorts: ListSort[] = [];
  if (Array.isArray(rawSorts)) {
    for (const entry of rawSorts) {
      if (!entry || typeof entry !== "object") continue;
      const s = entry as Record<string, unknown>;
      const key = typeof s.key === "string" && s.key.length > 0 ? s.key : null;
      const labelEn =
        typeof s.label_en === "string" && s.label_en.length > 0 ? s.label_en : null;
      const labelAr =
        typeof s.label_ar === "string" && s.label_ar.length > 0 ? s.label_ar : null;
      const field =
        typeof s.field === "string" && s.field.length > 0 ? s.field : null;
      if (key === null || labelEn === null || labelAr === null || field === null) continue;
      const direction = coerceDirection(s.direction, "asc");
      sorts.push({ key, label_en: labelEn, label_ar: labelAr, field, direction });
    }
  }

  if (sorts.length === 0) {
    return {
      version,
      default_sort_key: STATIC_LIST_SORT.default_sort_key,
      sorts: [...STATIC_LIST_SORT.sorts],
    };
  }

  // Resolve the default_sort_key against the actual sorts list.
  const requestedDefault =
    typeof obj.default_sort_key === "string" && obj.default_sort_key.length > 0
      ? obj.default_sort_key
      : null;
  const matchesRequested =
    requestedDefault !== null && sorts.some((s) => s.key === requestedDefault);
  const default_sort_key = matchesRequested ? requestedDefault! : sorts[0]!.key;

  return { version, default_sort_key, sorts };
}

// Compare two values for sort. Nulls/undefineds always sort last regardless
// of direction (stable, predictable UX — drivers shouldn't see a wall of
// "missing" rows at the top of the list).
function compareValues(a: unknown, b: unknown, direction: ListSortDirection): number {
  const aMissing = a === null || a === undefined || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b === null || b === undefined || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1; // a sorts after b
  if (bMissing) return -1; // b sorts after a

  let cmp = 0;
  if (typeof a === "number" && typeof b === "number") {
    cmp = a - b;
  } else {
    // Fallback: string compare (covers due_at ISO strings, etc.)
    const aStr = String(a);
    const bStr = String(b);
    if (aStr < bStr) cmp = -1;
    else if (aStr > bStr) cmp = 1;
    else cmp = 0;
  }

  return direction === "asc" ? cmp : -cmp;
}

// Pure sorter: sort a list of items by the chosen sort option. Returns a new
// array (does not mutate input). If the sortKey doesn't match any entry in the
// policy, falls back to the policy's `default_sort_key`. If that also doesn't
// match, returns the input order unchanged (defensive).
export function applySort<T extends Record<string, unknown>>(
  items: readonly T[],
  sortKey: string | null | undefined,
  sortConfig: ListSortPolicyValue,
): T[] {
  const sorts = sortConfig.sorts;
  if (sorts.length === 0) return [...items];

  const targetKey =
    typeof sortKey === "string" && sortKey.length > 0
      ? sortKey
      : sortConfig.default_sort_key;

  let chosen = sorts.find((s) => s.key === targetKey);
  if (!chosen) {
    chosen = sorts.find((s) => s.key === sortConfig.default_sort_key);
  }
  if (!chosen) return [...items];

  const field = chosen.field;
  const direction = chosen.direction;
  return [...items].sort((a, b) => compareValues(a[field], b[field], direction));
}
