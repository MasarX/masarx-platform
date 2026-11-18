-- W8 branch lifecycle write RPCs are authenticated operator actions.
-- Revoke explicit anon EXECUTE drift on public RPCs while preserving the
-- authenticated/service_role contract used by Console V2 and API wrappers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031760_w8_branch_rpc_anon_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_signature TEXT;
  v_fn REGPROCEDURE;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.branch_create_v1(jsonb)',
    'public.branch_update_v1(jsonb)',
    'public.mark_branch_oos_v1(jsonb)',
    'public.branch_zone_assign_v1(jsonb)',
    'public.branch_zone_unassign_v1(jsonb)'
  ]::text[]
  LOOP
    v_fn := to_regprocedure(v_signature);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'Expected branch lifecycle RPC not found: %', v_signature;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn);
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031760_w8_branch_rpc_anon_lockdown_v1'));
COMMIT;
