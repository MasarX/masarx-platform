-- Retire legacy UI artifact upsert helper that references dropped webhook_rules.
-- This function is not part of the canonical schema contract and causes db-lint
-- false-positive/real-error drift in preview merge-group verification.

DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_upsert_mapping_artifact_v1'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', v_fn);
  END LOOP;
END;
$$;
