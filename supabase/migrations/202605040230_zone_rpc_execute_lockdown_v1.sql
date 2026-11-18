-- Migration: Zone lifecycle RPC execute lockdown
-- Date: 2026-05-03
-- Purpose:
--   Revoke PostgreSQL default PUBLIC/anon EXECUTE on zone lifecycle write RPCs
--   while preserving authenticated operator and service execution.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031400_zone_rpc_execute_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_signature TEXT;
  v_fn REGPROCEDURE;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.suspend_zone_v1(jsonb)',
    'public.restore_zone_v1(jsonb)'
  ]::text[]
  LOOP
    v_fn := to_regprocedure(v_signature);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'Expected zone lifecycle RPC not found: %', v_signature;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn);
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031400_zone_rpc_execute_lockdown_v1'));
COMMIT;
