-- Migration: find_extent PostGIS invocation hardening

BEGIN;

DROP FUNCTION IF EXISTS public.find_extent(regclass, text);

CREATE OR REPLACE FUNCTION public.find_extent(
    p_table regclass,
    p_column text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
    v_column text := COALESCE(p_column, 'geom');
    v_schema text;
    v_table text;
    v_extent text;
BEGIN
    SELECT n.nspname, c.relname
    INTO v_schema, v_table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = p_table;

    IF v_schema IS NULL THEN
        RAISE EXCEPTION 'Relation % does not exist', p_table::text;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = v_schema
          AND table_name = v_table
          AND column_name = v_column
    ) THEN
        RAISE EXCEPTION 'Column %.% does not exist on relation %', v_column, v_table, p_table::text;
    END IF;

    EXECUTE format(
        'SELECT public.ST_Extent(%1$I)::text FROM %2$I.%3$I WHERE %1$I IS NOT NULL',
        v_column,
        v_schema,
        v_table
    )
    INTO v_extent;

    RETURN v_extent;
END;
$$;

ALTER FUNCTION public.find_extent(regclass, text) SET search_path = 'public, pg_temp';

COMMIT;

