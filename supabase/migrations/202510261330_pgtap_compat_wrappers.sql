-- Migration: Provide pgTAP compatibility wrappers in public for moved extension
-- Some environments install pgTAP into the 'extensions' schema. Our tests call
-- col_is_pk(schema, table, cols text[]). Create a compatible wrapper.

BEGIN;

CREATE OR REPLACE FUNCTION public.col_is_pk(
  p_schema TEXT,
  p_table TEXT,
  p_cols TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  WITH pk AS (
    SELECT i.indkey, c.oid AS rel_oid
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = p_schema
      AND c.relname = p_table
      AND i.indisprimary = TRUE
  ), cols AS (
    SELECT att.attname, arr.ord
    FROM pk
    CROSS JOIN LATERAL unnest(pk.indkey) WITH ORDINALITY AS arr(attnum, ord)
    JOIN pg_attribute att
      ON att.attrelid = pk.rel_oid
     AND att.attnum = arr.attnum
    ORDER BY arr.ord
  )
  SELECT COALESCE(array_agg(attname::TEXT ORDER BY ord), ARRAY[]::TEXT[]) = p_cols::TEXT[] FROM cols;
$$;

COMMENT ON FUNCTION public.col_is_pk(TEXT, TEXT, TEXT[])
  IS 'Compatibility wrapper for pgTAP col_is_pk when the extension resides outside the search_path.';

COMMIT;
