-- Migration: Logs / Observability RLS Hardening
-- Purpose: Enforce service_role-only access on log/observability tables and all partitions.
-- Tables: decision_log, webhook_log, api_call_log
-- Notes: Uses dynamic partition enumeration to avoid hardcoding partition names.

BEGIN;

DO $$
DECLARE
  t RECORD;
  p RECORD;
  base TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'public.decision_log',
      'public.webhook_log',
      'public.api_call_log'
    ]) AS tbl
  LOOP
    base := t.tbl;

    -- Enable RLS on parent table (if it exists)
    EXECUTE format('ALTER TABLE IF EXISTS %s ENABLE ROW LEVEL SECURITY', base);

    -- Revoke broad access
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', base);
    EXECUTE format('REVOKE ALL ON %s FROM anon', base);
    EXECUTE format('REVOKE ALL ON %s FROM authenticated', base);

    -- Service-role policy
    EXECUTE format('DROP POLICY IF EXISTS %I_service_policy ON %s', split_part(base, '.', 2), base);
    EXECUTE format(
      'CREATE POLICY %I_service_policy ON %s FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
      split_part(base, '.', 2),
      base
    );

    -- Ensure all existing partitions also have RLS enabled
    FOR p IN
      SELECT c.oid::regclass AS partition_name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = base::regclass
    LOOP
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p.partition_name);
    END LOOP;
  END LOOP;
END$$;

COMMIT;
