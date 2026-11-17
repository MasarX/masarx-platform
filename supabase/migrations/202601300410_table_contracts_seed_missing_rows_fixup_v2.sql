-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Fixup seed for table_contracts rows (v2; append-only).
-- Purpose:
--   - Ensure public.table_contracts contains rows for any public base tables created
--     after prior table_contracts baseline/fixup seeds (append-only; idempotent).

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  r RECORD;
  v_created_source TEXT;
  v_updated_source TEXT;
  v_updated_required BOOLEAN;
  v_audit_enabled BOOLEAN;
BEGIN
  FOR r IN
    SELECT n.nspname AS table_schema, c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND c.relname <> 'spatial_ref_sys'
      AND NOT EXISTS (
        SELECT 1
        FROM public.table_contracts tc
        WHERE tc.table_schema = n.nspname
          AND tc.table_name = c.relname
      )
    ORDER BY c.relname
  LOOP
    v_created_source := NULL;
    v_updated_source := NULL;
    v_updated_required := TRUE;
    v_audit_enabled := TRUE;

    -- Default: disable audit + updated_at for internal ledgers/logs/metrics.
    IF r.table_name = 'audit_table_changes'
       OR r.table_name LIKE 'audit_table_changes%'
       OR r.table_name ~* '(_log|_logs|_history|_audit|_events|_actions|_metrics)$'
       OR r.table_name ~* '^benchmark_'
    THEN
      v_updated_required := FALSE;
      v_audit_enabled := FALSE;
    END IF;

    -- Prefer generated `created_at` from an existing non-null time column when
    -- the table is missing `created_at` (avoid redundancy).
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = r.table_schema
        AND c.table_name = r.table_name
        AND c.column_name = 'created_at'
    ) THEN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = r.table_schema
          AND c.table_name = r.table_name
          AND c.column_name = 'timestamp'
          AND c.is_nullable = 'NO'
      ) THEN
        v_created_source := 'timestamp';
      ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = r.table_schema
          AND c.table_name = r.table_name
          AND c.column_name = 'executed_at'
          AND c.is_nullable = 'NO'
      ) THEN
        v_created_source := 'executed_at';
      ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = r.table_schema
          AND c.table_name = r.table_name
          AND c.column_name = 'added_at'
          AND c.is_nullable = 'NO'
      ) THEN
        v_created_source := 'added_at';
      ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = r.table_schema
          AND c.table_name = r.table_name
          AND c.column_name = 'changed_at'
          AND c.is_nullable = 'NO'
      ) THEN
        v_created_source := 'changed_at';
      ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = r.table_schema
          AND c.table_name = r.table_name
          AND c.column_name = 'enrolled_at'
          AND c.is_nullable = 'NO'
      ) THEN
        v_created_source := 'enrolled_at';
      ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = r.table_schema
          AND c.table_name = r.table_name
          AND c.column_name = 'window_started_at'
          AND c.is_nullable = 'NO'
      ) THEN
        v_created_source := 'window_started_at';
      ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = r.table_schema
          AND c.table_name = r.table_name
          AND c.column_name = 'geocoded_at'
          AND c.is_nullable = 'NO'
      ) THEN
        v_created_source := 'geocoded_at';
      END IF;
    END IF;

    -- Prefer generated `updated_at` from legacy `last_updated` when present.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = r.table_schema
        AND c.table_name = r.table_name
        AND c.column_name = 'updated_at'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = r.table_schema
        AND c.table_name = r.table_name
        AND c.column_name = 'last_updated'
        AND c.is_nullable = 'NO'
    ) THEN
      v_updated_source := 'last_updated';
    END IF;

    INSERT INTO public.table_contracts (
      table_schema,
      table_name,
      created_at_required,
      created_at_source_column,
      updated_at_required,
      updated_at_source_column,
      audit_enabled,
      notes
    )
    VALUES (
      r.table_schema,
      r.table_name,
      TRUE,
      v_created_source,
      v_updated_required,
      v_updated_source,
      v_audit_enabled,
      NULL
    )
    ON CONFLICT (table_schema, table_name) DO NOTHING;
  END LOOP;
END $$;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;

