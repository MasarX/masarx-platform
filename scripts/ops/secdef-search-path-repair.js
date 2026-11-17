#!/usr/bin/env node
/**
 * secdef-search-path-repair.js
 *
 * CI drift guard: ensure all SECURITY DEFINER functions pin search_path to safe schemas
 * (public, extensions, workflow_handlers, pg_temp).
 *
 * Why this exists:
 * - The cloud CI database is shared across runs/branches, so function search_path can drift
 *   when SECURITY DEFINER functions are replaced without reapplying the search_path attribute.
 * - pgTAP 045_secdef_search_path.sql enforces this invariant; this script repairs drift
 *   deterministically after migrations are applied.
 */
/* eslint-disable no-console */
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[secdef-search-path-repair] DATABASE_URL is required. Set ENV_FILE or export DATABASE_URL.');
  process.exit(1);
}

const SAFE_SEARCH_PATH = 'public, extensions, workflow_handlers, pg_temp';

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;

const findViolationsSql = `
  WITH security_definers AS (
    SELECT
      p.oid,
      n.nspname AS schema_name,
      p.proname AS function_name,
      p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d
      ON d.objid = p.oid
     AND d.deptype = 'e'
    LEFT JOIN pg_extension e
      ON e.oid = d.refobjid
    WHERE p.prosecdef
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgbouncer', 'storage')
      AND e.oid IS NULL
  ),
  parsed_paths AS (
    SELECT
      sd.oid,
      sd.schema_name,
      sd.function_name,
      ARRAY(
        SELECT trim(both ' ' FROM elem)
        FROM unnest(string_to_array(split_part(cfg, '=', 2), ',')) AS elem
      ) AS search_path
    FROM security_definers sd
    LEFT JOIN LATERAL (
      SELECT cfg
      FROM unnest(COALESCE(sd.proconfig, ARRAY[]::text[])) AS cfg
      WHERE cfg ILIKE 'search_path=%'
      LIMIT 1
    ) sp ON TRUE
  )
  SELECT
    oid,
    schema_name,
    function_name,
    pg_get_function_identity_arguments(oid) AS args
  FROM parsed_paths
  WHERE search_path IS NULL
     OR cardinality(search_path) = 0
     OR search_path[1] <> 'public'
     OR search_path[array_upper(search_path, 1)] <> 'pg_temp'
     OR EXISTS (
       SELECT 1
       FROM unnest(search_path) AS elem
       WHERE elem NOT IN ('public', 'extensions', 'pg_temp', 'workflow_handlers')
     )
  ORDER BY schema_name, function_name;
`;

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(findViolationsSql);
    if (!rows.length) {
      console.log('[secdef-search-path-repair] OK (no SECURITY DEFINER search_path drift detected)');
      return;
    }

    console.warn(
      `[secdef-search-path-repair] Detected ${rows.length} SECURITY DEFINER function(s) with unsafe search_path; repairing...`
    );

    await client.query('BEGIN');
    for (const row of rows) {
      const schemaName = row.schema_name;
      const functionName = row.function_name;
      const args = typeof row.args === 'string' ? row.args : '';
      const signature = `${quoteIdent(schemaName)}.${quoteIdent(functionName)}(${args})`;
      await client.query(`ALTER FUNCTION ${signature} SET search_path = ${SAFE_SEARCH_PATH}`);
    }
    await client.query('COMMIT');

    console.log(
      `[secdef-search-path-repair] Repaired ${rows.length} function(s) (search_path=${SAFE_SEARCH_PATH})`
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      // ignore rollback failures
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[secdef-search-path-repair] Failed:', message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();

