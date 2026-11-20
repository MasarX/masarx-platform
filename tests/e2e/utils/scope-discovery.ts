import { createE2EDatabasePool } from "./db";

export type ScopeLevel = {
  scopeType: string;
  ladderRank: number;
  description: string | null;
  isEnabled: boolean;
  entityTable: string | null;
  idColumn: string;
};

let ladderCache: ScopeLevel[] | null = null;

/**
 * Fetch the scope type registry ordered by ladder rank.
 * Returns only rows that have an explicit ladder_rank (i.e. participate in
 * the override ladder). Cached per-process.
 */
export async function fetchScopeLadder(): Promise<ScopeLevel[]> {
  if (ladderCache) return ladderCache;

  const { pool } = await createE2EDatabasePool("scope-ladder");
  try {
    const res = await pool.query(
      `SELECT scope_type,
              ladder_rank,
              description,
              is_enabled,
              entity_table::text AS entity_table,
              id_column
         FROM scope_type_registry
        WHERE ladder_rank IS NOT NULL
        ORDER BY ladder_rank`
    );
    const levels: ScopeLevel[] = (res.rows ?? []).map(
      (row: Record<string, unknown>) => ({
        scopeType: String(row.scope_type ?? "").trim(),
        ladderRank:
          typeof row.ladder_rank === "number" ? row.ladder_rank : 0,
        description:
          typeof row.description === "string" ? row.description : null,
        isEnabled: row.is_enabled !== false,
        entityTable:
          typeof row.entity_table === "string"
            ? row.entity_table.trim()
            : null,
        idColumn: String(row.id_column ?? "id").trim(),
      })
    );
    ladderCache = levels;
    return levels;
  } finally {
    await pool.end();
  }
}

/**
 * Fetch ALL scope types (including non-ladder entries).
 */
export async function fetchAllScopeTypes(): Promise<ScopeLevel[]> {
  const { pool } = await createE2EDatabasePool("scope-all");
  try {
    const res = await pool.query(
      `SELECT scope_type,
              COALESCE(ladder_rank, -1) AS ladder_rank,
              description,
              is_enabled,
              entity_table::text AS entity_table,
              id_column
         FROM scope_type_registry
        ORDER BY COALESCE(ladder_rank, 999999), scope_type`
    );
    return (res.rows ?? []).map((row: Record<string, unknown>) => ({
      scopeType: String(row.scope_type ?? "").trim(),
      ladderRank:
        typeof row.ladder_rank === "number" ? row.ladder_rank : -1,
      description:
        typeof row.description === "string" ? row.description : null,
      isEnabled: row.is_enabled !== false,
      entityTable:
        typeof row.entity_table === "string"
          ? row.entity_table.trim()
          : null,
      idColumn: String(row.id_column ?? "id").trim(),
    }));
  } finally {
    await pool.end();
  }
}
