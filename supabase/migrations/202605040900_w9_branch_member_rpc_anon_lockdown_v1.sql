-- W9 branch membership write RPCs are authenticated Console V2/worker actions.
-- Keep browser/public schema exposure least-privilege: authenticated and
-- service_role only, never anon.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031790_w9_branch_member_rpc_anon_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.add_branch_member_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_branch_member_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.add_branch_member_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.remove_branch_member_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_branch_member_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.remove_branch_member_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.add_branch_member_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.add_branch_member_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.add_branch_member_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.remove_branch_member_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.remove_branch_member_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.remove_branch_member_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605031790_w9_branch_member_rpc_anon_lockdown_v1'));
COMMIT;
