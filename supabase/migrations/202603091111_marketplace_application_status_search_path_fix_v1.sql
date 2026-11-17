-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Align marketplace application status API wrapper with SECURITY DEFINER search_path policy

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091111_marketplace_application_status_search_path_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION api.marketplace_application_status_by_token_v1(
  p_status_token TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_application_status_by_token_v1(p_status_token);
$function$;

GRANT EXECUTE ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) TO authenticated, anon, service_role;

SELECT pg_advisory_unlock(hashtext('202603091111_marketplace_application_status_search_path_fix_v1'));
COMMIT;
