import { createE2EDatabasePool } from "./db";

export type LookupValue = {
  value: string;
  label: string;
  sortOrder: number;
  isDefault: boolean;
  description: string | null;
  metadata: unknown;
};

export type LookupCategory = {
  category: string;
  description: string | null;
  valueCount: number;
};

const valuesCache = new Map<string, LookupValue[]>();
let categoriesCache: LookupCategory[] | null = null;

function normalizeLookupRow(row: Record<string, unknown>): LookupValue {
  return {
    value: String(row.value ?? "").trim(),
    label: String(row.label ?? "").trim(),
    sortOrder: typeof row.sort_order === "number" ? row.sort_order : 0,
    isDefault: Boolean(row.is_default),
    description:
      typeof row.description === "string" ? row.description : null,
    metadata: row.metadata ?? null,
  };
}

/**
 * Fetch all active lookup values for a given category.
 * Uses a direct DB query (service-role pool) to avoid requiring an
 * authenticated user session — E2E discovery runs before any user context.
 * Results are cached per-process for the lifetime of the test run.
 */
export async function fetchLookupValues(
  category: string
): Promise<LookupValue[]> {
  const key = category.trim().toLowerCase();
  if (!key) return [];
  const cached = valuesCache.get(key);
  if (cached) return cached;

  const { pool } = await createE2EDatabasePool(`lookup:${key}`);
  try {
    const res = await pool.query(
      `SELECT lv.value,
              lv.label,
              lv.description,
              lv.sort_order,
              lv.is_default,
              COALESCE(lv.metadata, '{}'::jsonb) AS metadata
         FROM lookup_definitions ld
         JOIN lookup_values lv ON lv.lookup_definition_id = ld.id
        WHERE ld.category = $1
          AND lv.status = 'active'
          AND (lv.effective_from IS NULL OR lv.effective_from <= now())
          AND (lv.effective_until IS NULL OR lv.effective_until > now())
        ORDER BY lv.sort_order NULLS LAST, lv.label, lv.value`,
      [key]
    );
    const values = (res.rows ?? []).map(normalizeLookupRow);
    valuesCache.set(key, values);
    return values;
  } finally {
    await pool.end();
  }
}

/**
 * Convenience wrapper — returns just the canonical value strings for a
 * lookup category (e.g. `["created", "in_transit", "delivered"]`).
 */
export async function fetchLookupValueStrings(
  category: string
): Promise<string[]> {
  const values = await fetchLookupValues(category);
  return values.map((v) => v.value).filter(Boolean);
}

/**
 * Fetch ALL lookup categories with their active-value counts.
 * Cached per-process.
 */
export async function fetchLookupCategories(): Promise<LookupCategory[]> {
  if (categoriesCache) return categoriesCache;

  const { pool } = await createE2EDatabasePool("lookup:categories");
  try {
    const res = await pool.query(
      `SELECT ld.category,
              ld.description,
              COUNT(lv.id) FILTER (
                WHERE lv.status = 'active'
                  AND (lv.effective_from IS NULL OR lv.effective_from <= now())
                  AND (lv.effective_until IS NULL OR lv.effective_until > now())
              )::int AS value_count
         FROM lookup_definitions ld
         LEFT JOIN lookup_values lv ON lv.lookup_definition_id = ld.id
        GROUP BY ld.category, ld.description
        ORDER BY ld.category`
    );
    const categories: LookupCategory[] = (res.rows ?? []).map(
      (row: Record<string, unknown>) => ({
        category: String(row.category ?? "").trim(),
        description:
          typeof row.description === "string" ? row.description : null,
        valueCount:
          typeof row.value_count === "number" ? row.value_count : 0,
      })
    );
    categoriesCache = categories;
    return categories;
  } finally {
    await pool.end();
  }
}
