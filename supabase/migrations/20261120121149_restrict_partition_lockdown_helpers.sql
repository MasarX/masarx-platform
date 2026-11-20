BEGIN;
SET LOCAL lock_timeout = '10s';

-- Keep grant-changing helpers available only to partition maintenance and migration owners.
REVOKE ALL ON FUNCTION public.enforce_service_only_rls_v1(regclass)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_partition_tree_service_only_v1(regclass)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
