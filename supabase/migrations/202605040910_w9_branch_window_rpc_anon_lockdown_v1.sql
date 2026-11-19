-- W9 branch window write RPCs are authenticated Console V2/worker actions.
-- Keep public-schema execution least-privilege: authenticated and service_role
-- only, never anon.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031800_w9_branch_window_rpc_anon_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.branch_capacity_window_set_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.branch_capacity_window_set_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.branch_capacity_window_set_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.branch_coverage_window_upsert_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.branch_coverage_window_upsert_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.branch_coverage_window_upsert_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605031800_w9_branch_window_rpc_anon_lockdown_v1'));
COMMIT;
