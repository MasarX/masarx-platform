-- Migration: Zone lifecycle RPC execute lockdown
-- Date: 2026-05-03
-- Purpose:
--   Revoke PostgreSQL default PUBLIC/anon EXECUTE on zone lifecycle write RPCs
--   while preserving authenticated operator and service execution.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031400_zone_rpc_execute_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION
  public.suspend_zone_v1(jsonb),
  public.restore_zone_v1(jsonb)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.suspend_zone_v1(jsonb),
  public.restore_zone_v1(jsonb)
TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605031400_zone_rpc_execute_lockdown_v1'));
COMMIT;
