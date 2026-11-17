-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Fix ensure_audit_triggers to ignore dropped tables
-- Purpose:
--   - Some environments (including long-lived preview projects) may have applied an
--     earlier ensure_audit_triggers definition that can error when table_contracts
--     contains rows for tables that were later dropped (schema cleanup).
--   - This migration replaces ensure_audit_triggers with a contract-driven, catalog-safe
--     implementation that only targets existing public tables.
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

COMMIT;

