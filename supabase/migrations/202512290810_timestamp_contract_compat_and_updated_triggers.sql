-- Migration: Timestamp contract compatibility columns + updated_at trigger standardization
-- Date: 2025-12-29
BEGIN;

-------------------------------------------------------------------------------
-- 1) Compatibility: expose created_at for log/event tables that use `timestamp`
--    without duplicating data (generated column).
-------------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_expr TEXT;
BEGIN
  FOR r IN
    SELECT c.table_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      JOIN pg_catalog.pg_class pc
        ON pc.relname = c.table_name
      JOIN pg_catalog.pg_namespace pn
        ON pn.oid = pc.relnamespace
       AND pn.nspname = c.table_schema
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND pc.relkind IN ('r','p')
       AND pc.relispartition = false
       AND c.column_name = 'timestamp'
       AND NOT EXISTS (
         SELECT 1
           FROM information_schema.columns c2
          WHERE c2.table_schema = c.table_schema
            AND c2.table_name = c.table_name
            AND c2.column_name = 'created_at'
       )
  LOOP
    v_expr := CASE
      WHEN r.data_type = 'timestamp with time zone' THEN '"timestamp"'
      ELSE '"timestamp" AT TIME ZONE ''UTC'''
    END;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ GENERATED ALWAYS AS (%s) STORED',
      r.table_name,
      v_expr
    );
  END LOOP;
END $$;

-------------------------------------------------------------------------------
-- 2) Compatibility: expose updated_at for tables that use `last_updated`
--    without duplicating data (generated column).
-------------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_expr TEXT;
BEGIN
  FOR r IN
    SELECT c.table_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      JOIN pg_catalog.pg_class pc
        ON pc.relname = c.table_name
      JOIN pg_catalog.pg_namespace pn
        ON pn.oid = pc.relnamespace
       AND pn.nspname = c.table_schema
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND pc.relkind IN ('r','p')
       AND pc.relispartition = false
       AND c.column_name = 'last_updated'
       AND NOT EXISTS (
         SELECT 1
           FROM information_schema.columns c2
          WHERE c2.table_schema = c.table_schema
            AND c2.table_name = c.table_name
            AND c2.column_name = 'updated_at'
       )
  LOOP
    v_expr := CASE
      WHEN r.data_type = 'timestamp with time zone' THEN 'last_updated'
      ELSE 'last_updated AT TIME ZONE ''UTC'''
    END;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ GENERATED ALWAYS AS (%s) STORED',
      r.table_name,
      v_expr
    );
  END LOOP;
END $$;

-------------------------------------------------------------------------------
-- 3) Ensure mutable tables with a physical updated_at column have a trigger
--    to maintain it automatically on UPDATE.
-------------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_trigger TEXT;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      JOIN pg_catalog.pg_class pc
        ON pc.relname = c.table_name
      JOIN pg_catalog.pg_namespace pn
        ON pn.oid = pc.relnamespace
       AND pn.nspname = c.table_schema
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND pc.relkind IN ('r','p')
       AND pc.relispartition = false
       AND c.column_name = 'updated_at'
       AND COALESCE(c.is_generated, 'NEVER') = 'NEVER'
  LOOP
    -- Postgres identifiers are capped at 63 bytes; keep trigger names stable.
    v_trigger := left(format('trg_%s_set_updated_at', r.table_name), 63);
    PERFORM 1
      FROM pg_catalog.pg_trigger tg
     WHERE tg.tgrelid = format('public.%I', r.table_name)::regclass
       AND tg.tgname = v_trigger;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
        v_trigger,
        r.table_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
