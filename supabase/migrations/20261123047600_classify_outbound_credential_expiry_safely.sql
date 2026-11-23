BEGIN;

SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Patch the catalog's CREATE OR REPLACE definition so earlier resolver fixes stay in place.
DO $expiry$
DECLARE
  v_definition text := pg_get_functiondef('public.get_job_call_spec_without_ingress_vault_v1(uuid)'::regprocedure);
  v_old constant text := $predicate$NOT COALESCE((pac.credentials->>'revoked')::boolean, false)$predicate$;
BEGIN
  IF cardinality(string_to_array(v_definition, v_old)) <> 2 THEN
    RAISE EXCEPTION 'Expected one revoked-marker cast in the outbound credential expiry guard';
  END IF;

  -- Match get_provider_auth_credentials: only explicitly false markers permit expiry classification.
  EXECUTE replace(v_definition, v_old,
    $predicate$lower(COALESCE(pac.credentials->>'revoked', 'false')) IN ('false', 'f', 'no', 'n', '0', 'off')$predicate$);
END;
$expiry$;

-- The implementation stays callable only by its owner through the definer chain.
REVOKE EXECUTE ON FUNCTION public.get_job_call_spec_without_ingress_vault_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role, edge_api_caller_role;

COMMIT;
