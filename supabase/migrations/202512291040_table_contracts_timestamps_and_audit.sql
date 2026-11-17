-- Migration: Row-driven table contracts (timestamps + audit enablement)
-- Date: 2025-12-29
--
-- Purpose:
--   - Establish a single source of truth for per-table timestamp/audit requirements.
--   - Enforce canonical timestamp naming (`created_at`, `updated_at`) without hardcoding table branches.
--   - Allow row-driven audit trigger exclusion to prevent redundant auditing of internal ledgers/logs.
BEGIN;

-------------------------------------------------------------------------------
-- 1) Contract table: public.table_contracts
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.table_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_schema TEXT NOT NULL DEFAULT 'public',
  table_name TEXT NOT NULL,

  created_at_required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at_source_column TEXT NULL,

  updated_at_required BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at_source_column TEXT NULL,

  audit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT table_contracts_schema_nonempty CHECK (btrim(table_schema) <> ''),
  CONSTRAINT table_contracts_name_nonempty CHECK (btrim(table_name) <> ''),
  CONSTRAINT table_contracts_unique UNIQUE (table_schema, table_name),
  CONSTRAINT table_contracts_created_source_nonempty CHECK (
    created_at_source_column IS NULL OR btrim(created_at_source_column) <> ''
  ),
  CONSTRAINT table_contracts_updated_source_nonempty CHECK (
    updated_at_source_column IS NULL OR btrim(updated_at_source_column) <> ''
  ),
  CONSTRAINT table_contracts_created_source_requires_created CHECK (
    created_at_source_column IS NULL OR created_at_required = TRUE
  ),
  CONSTRAINT table_contracts_updated_source_requires_updated CHECK (
    updated_at_source_column IS NULL OR updated_at_required = TRUE
  )
);

COMMENT ON TABLE public.table_contracts
  IS 'Row-driven per-table contract: canonical timestamps + audit enablement (SSOT for enforcement).';

ALTER TABLE public.table_contracts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.table_contracts FROM PUBLIC;
REVOKE ALL ON TABLE public.table_contracts FROM anon;
REVOKE ALL ON TABLE public.table_contracts FROM authenticated;

DROP POLICY IF EXISTS table_contracts_service_policy ON public.table_contracts;
CREATE POLICY table_contracts_service_policy
  ON public.table_contracts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP TRIGGER IF EXISTS trg_table_contracts_set_updated_at ON public.table_contracts;
CREATE TRIGGER trg_table_contracts_set_updated_at
  BEFORE UPDATE ON public.table_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) Seed baseline contract rows from current schema (idempotent)
-------------------------------------------------------------------------------
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

-------------------------------------------------------------------------------
-- 3) Replace ensure_audit_triggers to honor row-driven contract (audit_enabled)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_audit_triggers()
RETURNS TABLE (
  table_name text,
  created_row_trigger boolean,
  created_truncate_trigger boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  r RECORD;
  v_row_created boolean;
  v_truncate_created boolean;
BEGIN
  FOR r IN
    SELECT c.relname, tc.audit_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN public.table_contracts tc
      ON tc.table_schema = n.nspname
     AND tc.table_name = c.relname
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND c.relname NOT IN ('audit_table_changes')
      AND c.relname NOT LIKE 'audit_table_changes%'
    ORDER BY c.relname
  LOOP
    v_row_created := false;
    v_truncate_created := false;

    IF r.audit_enabled IS TRUE THEN
      PERFORM 1
      FROM pg_trigger t
      WHERE t.tgrelid = format('public.%I', r.relname)::regclass
        AND t.tgname = 'audit_row_change';
      IF NOT FOUND THEN
        EXECUTE format(
          'CREATE TRIGGER audit_row_change BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_capture_row_change()',
          r.relname
        );
        v_row_created := true;
      END IF;

      PERFORM 1
      FROM pg_trigger t
      WHERE t.tgrelid = format('public.%I', r.relname)::regclass
        AND t.tgname = 'audit_truncate_change';
      IF NOT FOUND THEN
        EXECUTE format(
          'CREATE TRIGGER audit_truncate_change AFTER TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.audit_capture_row_change()',
          r.relname
        );
        v_truncate_created := true;
      END IF;
    ELSE
      EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON public.%I', r.relname);
      EXECUTE format('DROP TRIGGER IF EXISTS audit_truncate_change ON public.%I', r.relname);
    END IF;

    table_name := r.relname;
    created_row_trigger := v_row_created;
    created_truncate_trigger := v_truncate_created;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.ensure_audit_triggers()
  IS 'Reconciles audit triggers for public tables based on table_contracts.audit_enabled (create when enabled; drop when disabled).';

-------------------------------------------------------------------------------
-- 4) Enforcer: apply_table_contracts (timestamps + audit trigger removal)
-------------------------------------------------------------------------------
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
    WHERE tc.table_schema = COALESCE(NULLIF(btrim(p_table_schema), ''), 'public')
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
  IS 'Applies table_contracts timestamp requirements (canonical created_at/updated_at + updated_at triggers).';

-------------------------------------------------------------------------------
-- 5) Apply once now: enforce timestamp contract + remove audit triggers, then
--    re-attach audit triggers for enabled tables via ensure_audit_triggers()
-------------------------------------------------------------------------------
SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;
