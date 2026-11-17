-- Migration: Ensure audit triggers attach to all public tables
-- Purpose: Keep audit_table_changes truly global by catching new tables created after initial bootstrap.
-- Date: 2025-12-13 10:10 UTC

BEGIN;

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
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND c.relname NOT IN ('audit_table_changes')
      AND c.relname NOT LIKE 'audit_table_changes%'
    ORDER BY c.relname
  LOOP
    v_row_created := false;
    v_truncate_created := false;

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

    table_name := r.relname;
    created_row_trigger := v_row_created;
    created_truncate_trigger := v_truncate_created;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.ensure_audit_triggers()
  IS 'Idempotently attaches audit_row_change and audit_truncate_change triggers to all public tables (excluding audit_table_changes).';

-- Ensure pg_cron is available
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Unschedule existing to avoid duplicates
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit_ensure_triggers') THEN
    PERFORM cron.unschedule('audit_ensure_triggers');
  END IF;
END $$;

-- Run weekly shortly after partition maintenance (Sunday 00:10 UTC)
SELECT cron.schedule(
  'audit_ensure_triggers',
  '10 0 * * 0',
  $$SELECT * FROM public.ensure_audit_triggers();$$
);

-- Apply once now (idempotent)
SELECT * FROM public.ensure_audit_triggers();

COMMIT;

