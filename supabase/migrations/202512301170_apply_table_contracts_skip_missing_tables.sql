-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Harden apply_table_contracts to skip missing tables
-- Purpose:
--   - In long-lived preview environments, schema cleanup may drop tables while
--     public.table_contracts still contains historical rows.
--   - apply_table_contracts must be catalog-safe and operate only on tables that
--     currently exist, otherwise db push can fail with SQLSTATE 42P01.
BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.apply_table_contracts(
  p_table_schema TEXT DEFAULT 'public'
)
RETURNS TABLE (
  table_schema TEXT,
  table_name TEXT,
  created_at_action TEXT,
  updated_at_action TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  r RECORD;
  v_created_action TEXT;
  v_updated_action TEXT;
  v_source_type TEXT;
  v_source_generated TEXT;
  v_expr TEXT;
  v_trigger TEXT;
BEGIN
  FOR r IN
    SELECT tc.table_schema,
           tc.table_name,
           tc.created_at_required,
           tc.created_at_source_column,
           tc.updated_at_required,
           tc.updated_at_source_column
    FROM public.table_contracts tc
    JOIN pg_namespace n ON n.nspname = tc.table_schema
    JOIN pg_class c
      ON c.relnamespace = n.oid
     AND c.relname = tc.table_name
    WHERE tc.table_schema = COALESCE(NULLIF(btrim(p_table_schema), ''), 'public')
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
    ORDER BY tc.table_schema, tc.table_name
  LOOP
    v_created_action := 'none';
    v_updated_action := 'none';

    ----------------------------------------------------------------------------
    -- created_at
    ----------------------------------------------------------------------------
    IF r.created_at_required IS TRUE THEN
      PERFORM 1
      FROM information_schema.columns c
      WHERE c.table_schema = r.table_schema
        AND c.table_name = r.table_name
        AND c.column_name = 'created_at';
      IF NOT FOUND THEN
        IF r.created_at_source_column IS NOT NULL THEN
          SELECT c.data_type
            INTO v_source_type
            FROM information_schema.columns c
           WHERE c.table_schema = r.table_schema
             AND c.table_name = r.table_name
             AND c.column_name = r.created_at_source_column
           LIMIT 1;

          IF FOUND THEN
            v_expr := CASE
              WHEN v_source_type = 'timestamp with time zone'
                THEN format('%I', r.created_at_source_column)
              WHEN v_source_type = 'timestamp without time zone'
                THEN format('%I AT TIME ZONE ''UTC''', r.created_at_source_column)
              ELSE
                format('%I', r.created_at_source_column)
            END;

            EXECUTE format(
              'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ GENERATED ALWAYS AS (%s) STORED',
              r.table_schema,
              r.table_name,
              v_expr
            );
            v_created_action := format('generated:%s', r.created_at_source_column);
          END IF;
        END IF;

        IF v_created_action = 'none' THEN
          EXECUTE format(
            'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
            r.table_schema,
            r.table_name
          );
          v_created_action := 'physical:default_now';
        END IF;
      END IF;
    END IF;

    ----------------------------------------------------------------------------
    -- updated_at
    ----------------------------------------------------------------------------
    IF r.updated_at_required IS TRUE THEN
      PERFORM 1
      FROM information_schema.columns c
      WHERE c.table_schema = r.table_schema
        AND c.table_name = r.table_name
        AND c.column_name = 'updated_at';
      IF NOT FOUND THEN
        IF r.updated_at_source_column IS NOT NULL THEN
          SELECT c.data_type
            INTO v_source_type
            FROM information_schema.columns c
           WHERE c.table_schema = r.table_schema
             AND c.table_name = r.table_name
             AND c.column_name = r.updated_at_source_column
           LIMIT 1;

          IF FOUND THEN
            v_expr := CASE
              WHEN v_source_type = 'timestamp with time zone'
                THEN format('%I', r.updated_at_source_column)
              WHEN v_source_type = 'timestamp without time zone'
                THEN format('%I AT TIME ZONE ''UTC''', r.updated_at_source_column)
              ELSE
                format('%I', r.updated_at_source_column)
            END;

            EXECUTE format(
              'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ GENERATED ALWAYS AS (%s) STORED',
              r.table_schema,
              r.table_name,
              v_expr
            );
            v_updated_action := format('generated:%s', r.updated_at_source_column);
          END IF;
        END IF;

        IF v_updated_action = 'none' THEN
          EXECUTE format(
            'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
            r.table_schema,
            r.table_name
          );
          v_updated_action := 'physical:default_now';
        END IF;
      END IF;

      -- Ensure trigger for physical updated_at columns.
      SELECT COALESCE(c.is_generated, 'NEVER')
        INTO v_source_generated
        FROM information_schema.columns c
       WHERE c.table_schema = r.table_schema
         AND c.table_name = r.table_name
         AND c.column_name = 'updated_at'
       LIMIT 1;

      IF v_source_generated = 'NEVER' THEN
        v_trigger := left(format('trg_%s_set_updated_at', r.table_name), 63);
        PERFORM 1
          FROM pg_catalog.pg_trigger tg
         WHERE tg.tgrelid = format('%I.%I', r.table_schema, r.table_name)::regclass
           AND tg.tgname = v_trigger;
        IF NOT FOUND THEN
          EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
            v_trigger,
            r.table_schema,
            r.table_name
          );
        END IF;
      END IF;
    END IF;

    table_schema := r.table_schema;
    table_name := r.table_name;
    created_at_action := v_created_action;
    updated_at_action := v_updated_action;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$function$;

COMMENT ON FUNCTION public.apply_table_contracts(TEXT)
  IS 'Applies table_contracts timestamp requirements (canonical created_at/updated_at + updated_at triggers) for existing tables only (skips missing tables).';

COMMIT;

