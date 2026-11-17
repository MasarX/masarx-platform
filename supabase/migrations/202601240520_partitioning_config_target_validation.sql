-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Clean up invalid partitioning_config targets + prevent future drift (SSOT)
-- Notes:
-- - partitioning_config.table_name must reference a top-level table in the public schema.
-- - Misconfigured rows can break partition tree traversal and operational guardrails.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Cleanup: remove any rows referencing missing/non-table relations
-------------------------------------------------------------------------------

WITH bad AS (
  SELECT pc.table_name
  FROM public.partitioning_config pc
  LEFT JOIN pg_namespace n
    ON n.nspname = 'public'
  LEFT JOIN pg_class c
    ON c.relname = pc.table_name
   AND c.relnamespace = n.oid
  WHERE c.oid IS NULL
     OR c.relispartition = true
     OR c.relkind NOT IN ('r', 'p')
)
DELETE FROM public.partitioning_config pc
USING bad
WHERE pc.table_name = bad.table_name;

-------------------------------------------------------------------------------
-- 2) Enforcement: validate table_name on insert/update (row-driven config hygiene)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.partitioning_config_validate_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_relkind "char";
  v_relispartition BOOLEAN;
BEGIN
  IF NEW.table_name IS NULL OR btrim(NEW.table_name) = '' THEN
    RAISE EXCEPTION 'partitioning_config.table_name must be non-empty'
      USING ERRCODE = '23514';
  END IF;

  SELECT c.relkind, c.relispartition
  INTO v_relkind, v_relispartition
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = NEW.table_name
  LIMIT 1;

  IF v_relkind IS NULL THEN
    RAISE EXCEPTION 'partitioning_config.table_name must reference an existing public table: "%"', NEW.table_name
      USING ERRCODE = '23514';
  END IF;

  IF v_relispartition OR v_relkind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'partitioning_config.table_name must reference a top-level public table (not a partition/index/view): "%"', NEW.table_name
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.partitioning_config_validate_target()
  SET search_path = public, extensions, pg_temp;

DROP TRIGGER IF EXISTS trg_partitioning_config_validate_target ON public.partitioning_config;

CREATE TRIGGER trg_partitioning_config_validate_target
BEFORE INSERT OR UPDATE OF table_name ON public.partitioning_config
FOR EACH ROW
EXECUTE FUNCTION public.partitioning_config_validate_target();

COMMIT;

