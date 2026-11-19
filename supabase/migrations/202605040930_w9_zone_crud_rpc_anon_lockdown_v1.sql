-- W9 zone CRUD RPCs are authenticated Console V2/worker actions. Earlier
-- lifecycle lockdown covered suspend/restore only; this closes create and
-- district membership writes under the same least-privilege contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031820_w9_zone_crud_rpc_anon_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.zone_create_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zone_create_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.zone_create_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.zone_district_add_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zone_district_add_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.zone_district_add_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.zone_district_remove_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zone_district_remove_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.zone_district_remove_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605031820_w9_zone_crud_rpc_anon_lockdown_v1'));
COMMIT;
