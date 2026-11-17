-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Fix lookup contract enforcement for partitioned tables (preserve allowed_values support)
-- Notes:
-- - For partitioned tables, row-level triggers may execute with TG_TABLE_NAME referencing a partition.
-- - Always resolve the partition root via pg_partition_root(TG_RELID) before reading lookup_column_contracts.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.enforce_lookup_column_contracts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
  v_row JSONB;
  v_val TEXT;
  v_def_id UUID;
  v_allow_inactive BOOLEAN;
  v_root REGCLASS;
  v_table_schema TEXT;
  v_table_name TEXT;
BEGIN
  v_row := to_jsonb(NEW);

  v_root := COALESCE(pg_partition_root(TG_RELID::regclass), TG_RELID::regclass);

  SELECT n.nspname, c.relname
  INTO v_table_schema, v_table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = v_root::oid;

  IF v_table_schema IS NULL OR v_table_name IS NULL THEN
    v_table_schema := TG_TABLE_SCHEMA;
    v_table_name := TG_TABLE_NAME;
  END IF;

  FOR rec IN
    SELECT column_name, lookup_category, allow_inactive, allowed_values
    FROM public.lookup_column_contracts
    WHERE table_schema = v_table_schema
      AND table_name = v_table_name
  LOOP
    v_val := v_row ->> rec.column_name;
    IF v_val IS NULL THEN
      CONTINUE;
    END IF;

    IF btrim(v_val) = '' THEN
      RAISE EXCEPTION
        'Invalid lookup value for %.%.%: empty string is not allowed (category "%")',
        v_table_schema, v_table_name, rec.column_name, rec.lookup_category
        USING ERRCODE = '23514';
    END IF;

    IF rec.allowed_values IS NOT NULL AND NOT (v_val = ANY (rec.allowed_values)) THEN
      RAISE EXCEPTION
        'Invalid lookup value for %.%.%: "%" is not an allowed value for category "%"',
        v_table_schema, v_table_name, rec.column_name, v_val, rec.lookup_category
        USING ERRCODE = '23514';
    END IF;

    v_allow_inactive := rec.allow_inactive;

    SELECT d.id
    INTO v_def_id
    FROM public.lookup_definitions d
    WHERE d.category = rec.lookup_category;

    IF v_def_id IS NULL THEN
      RAISE EXCEPTION
        'Lookup category "%" is not registered in lookup_definitions (required for %.%.%)',
        rec.lookup_category, v_table_schema, v_table_name, rec.column_name
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      WHERE lv.lookup_definition_id = v_def_id
        AND lv.value = v_val
        AND lv.retired_at IS NULL
        AND (v_allow_inactive OR lv.status = 'active')
        AND (lv.effective_from IS NULL OR lv.effective_from <= now())
        AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ) THEN
      RAISE EXCEPTION
        'Invalid lookup value for %.%.%: "%" is not an allowed value for category "%"',
        v_table_schema, v_table_name, rec.column_name, v_val, rec.lookup_category
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_lookup_column_contracts()
  SET search_path = public, extensions, pg_temp;

COMMIT;

