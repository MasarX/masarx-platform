-- W8 branch lifecycle write RPCs are authenticated operator actions.
-- Revoke explicit anon EXECUTE drift on public RPCs while preserving the
-- authenticated/service_role contract used by Console V2 and API wrappers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031760_w8_branch_rpc_anon_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION
  public.branch_create_v1(jsonb),
  public.branch_update_v1(jsonb),
  public.mark_branch_oos_v1(jsonb),
  public.branch_zone_assign_v1(jsonb),
  public.branch_zone_unassign_v1(jsonb)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.branch_create_v1(jsonb),
  public.branch_update_v1(jsonb),
  public.mark_branch_oos_v1(jsonb),
  public.branch_zone_assign_v1(jsonb),
  public.branch_zone_unassign_v1(jsonb)
TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605031760_w8_branch_rpc_anon_lockdown_v1'));
COMMIT;
