// Resolve filters from list_filter_policy.
//
// Contract: the resolver `public.resolve_list_filter_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     filters: [
//       { key: "all", label_en: "All", label_ar: "الكل", default: true },
//       { key: "open", label_en: "Open", label_ar: "...", predicate: { status_in: ["open","assigned","queued"] } },
//       ...
//     ]
//   }
//
// This module:
//  1. Defines the typed shape (ListFilterPolicyValue)
//  2. Normalizes the JSONB into a strict-typed object (defensive parse)
//  3. Provides the pure resolver `applyFilterPredicate(items, predicate)` that
//     filters a list of items by their `status` field against status_in.
//  4. Ships a STATIC fallback that mirrors the global default seed, so
//     consumers stay legible while the network query is in flight or offline.
//
//
// behavior must read through resolver functions, not hardcoded code-side maps.
// The resolved policy defines visible filter choices by surface.

export type ListFilterPredicate = {
  status_in?: string[];
};

export type ListFilter = {
  key: string;
  label_en: string;
  label_ar: string;
  default?: boolean;
  predicate?: ListFilterPredicate;
};

export type ListFilterPolicyValue = {
  version: number;
  filters: ListFilter[];
};

// Mirror of the migration seed (see supabase/migrations/202604241700_list_filter_policy_v1.sql).
// Kept in sync intentionally: when offline / pre-fetch, the filter pills
// should match the global default the server would have returned.
export const STATIC_LIST_FILTER: ListFilterPolicyValue = {
  version: 1,
  filters: [
    { key: "all", label_en: "All", label_ar: "الكل", default: true },
    {
      key: "open",
      label_en: "Open",
      label_ar: "مفتوحة",
      predicate: { status_in: ["open", "assigned", "queued"] },
    },
    {
      key: "in_progress",
      label_en: "In progress",
      label_ar: "جاري",
      predicate: { status_in: ["in_progress", "en_route", "arrived"] },
    },
    {
      key: "done",
      label_en: "Done",
      label_ar: "تم",
      predicate: { status_in: ["completed", "done", "closed"] },
    },
    {
      key: "failed",
      label_en: "Failed",
      label_ar: "فشل",
      predicate: { status_in: ["failed", "exception", "rejected"] },
    },
  ],
};

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// ListFilterPolicyValue. Defensive: any malformed entry is dropped, and if no
// valid filters remain we fall back to the static seed so a bad row in
// production cannot brick the filter bar.
export function normalizeListFilterPolicy(
  raw: unknown,
): ListFilterPolicyValue {
  if (!raw || typeof raw !== "object") return STATIC_LIST_FILTER;
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const rawFilters = obj.filters;
  const filters: ListFilter[] = [];
  if (Array.isArray(rawFilters)) {
    for (const entry of rawFilters) {
      if (!entry || typeof entry !== "object") continue;
      const f = entry as Record<string, unknown>;
      const key =
        typeof f.key === "string" && f.key.length > 0 ? f.key : null;
      const labelEn =
        typeof f.label_en === "string" && f.label_en.length > 0 ? f.label_en : null;
      const labelAr =
        typeof f.label_ar === "string" && f.label_ar.length > 0 ? f.label_ar : null;
      if (key === null || labelEn === null || labelAr === null) continue;

      const result: ListFilter = { key, label_en: labelEn, label_ar: labelAr };
      if (typeof f.default === "boolean") {
        result.default = f.default;
      }

      const predRaw = f.predicate;
      if (predRaw && typeof predRaw === "object") {
        const predObj = predRaw as Record<string, unknown>;
        const statusInRaw = predObj.status_in;
        if (Array.isArray(statusInRaw)) {
          const status_in = statusInRaw
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .map((s) => s.toLowerCase());
          if (status_in.length > 0) {
            result.predicate = { status_in };
          }
        }
      }

      filters.push(result);
    }
  }

  if (filters.length === 0) {
    return { version, filters: [...STATIC_LIST_FILTER.filters] };
  }

  return { version, filters };
}

// Pure resolver: filter a list of items by a filter predicate. Items are
// matched by their (lowercased) `status` field against the predicate's
// status_in set. A predicate with no status_in (e.g. the "all" filter) is
// treated as a pass-through that returns the input unchanged.
//
// Items missing a status field are excluded from any non-pass-through filter
// (defensive: would otherwise be silently mis-counted).
export function applyFilterPredicate<T extends { status?: string | null | undefined }>(
  items: readonly T[],
  predicate: ListFilterPredicate | undefined,
): T[] {
  if (!predicate || !predicate.status_in || predicate.status_in.length === 0) {
    return [...items];
  }
  const allowed = new Set(predicate.status_in.map((s) => s.toLowerCase()));
  return items.filter((item) => {
    if (item === null || item === undefined) return false;
    const rawStatus = item.status;
    if (rawStatus === null || rawStatus === undefined) return false;
    const normalized = String(rawStatus).trim().toLowerCase();
    if (normalized.length === 0) return false;
    return allowed.has(normalized);
  });
}
