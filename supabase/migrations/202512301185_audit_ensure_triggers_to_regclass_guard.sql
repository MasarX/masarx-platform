-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Guard ensure_audit_triggers with to_regclass()
-- Purpose:
--   - ensure_audit_triggers is invoked during contract refresh migrations.
--   - Some environments can have stale public.table_contracts rows for tables that were
--     dropped pre-production; relying on ::regclass casts or DROP TRIGGER ... ON <table>
--     can raise SQLSTATE 42P01.
--   - Make reconciliation registry-safe by skipping any table_contracts row whose target
--     relation no longer exists.
BEGIN;
SET search_path TO public, extensions, pg_temp;

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
  v_rel regclass;
  v_row_created boolean;
  v_truncate_created boolean;
BEGIN
  FOR r IN
    SELECT tc.table_schema, tc.table_name, tc.audit_enabled
    FROM public.table_contracts tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name <> 'audit_table_changes'
      AND tc.table_name NOT LIKE 'audit_table_changes%'
    ORDER BY tc.table_schema, tc.table_name
  LOOP
    v_row_created := false;
    v_truncate_created := false;

    v_rel := to_regclass(format('%I.%I', r.table_schema, r.table_name));
    IF v_rel IS NULL THEN
      CONTINUE;
    END IF;

    -- Only base tables + partitioned parents (skip partitions and non-table relkinds).
    PERFORM 1
    FROM pg_class c
    WHERE c.oid = v_rel::oid
      AND c.relkind IN ('r','p')
      AND c.relispartition = false;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF r.audit_enabled IS TRUE THEN
      PERFORM 1
      FROM pg_trigger t
      WHERE t.tgrelid = v_rel::oid
        AND t.tgname = 'audit_row_change';
      IF NOT FOUND THEN
        EXECUTE format(
          'CREATE TRIGGER audit_row_change BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.audit_capture_row_change()',
          r.table_schema,
          r.table_name
        );
        v_row_created := true;
      END IF;

      PERFORM 1
      FROM pg_trigger t
      WHERE t.tgrelid = v_rel::oid
        AND t.tgname = 'audit_truncate_change';
      IF NOT FOUND THEN
        EXECUTE format(
          'CREATE TRIGGER audit_truncate_change AFTER TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION public.audit_capture_row_change()',
          r.table_schema,
          r.table_name
        );
        v_truncate_created := true;
      END IF;
    ELSE
      EXECUTE format('DROP TRIGGER IF EXISTS audit_row_change ON %I.%I', r.table_schema, r.table_name);
      EXECUTE format('DROP TRIGGER IF EXISTS audit_truncate_change ON %I.%I', r.table_schema, r.table_name);
    END IF;

    table_name := r.table_name;
    created_row_trigger := v_row_created;
    created_truncate_trigger := v_truncate_created;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.ensure_audit_triggers()
  IS 'Reconciles audit triggers based on table_contracts.audit_enabled, skipping missing tables via to_regclass().';

COMMIT;

