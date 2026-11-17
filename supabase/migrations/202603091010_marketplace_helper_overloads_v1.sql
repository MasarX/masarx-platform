-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Reconcile marketplace helper overloads for workspaces and browser facades

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091010_marketplace_helper_overloads_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketplace_can_read_request_v1(
  p_request_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE((
    SELECT
      public.is_platform_user()
      OR public.marketplace_org_match_v1(r.requester_organization_id)
      OR (
        COALESCE(r.status, '') IN (
          'published',
          'negotiation',
          'award_pending_acceptance',
          'awarded',
          'provider_accepted',
          'materialized',
          'executing',
          'in_execution',
          'completed'
        )
        AND public.marketplace_current_org_has_approved_participant_v1()
        AND (
          COALESCE(r.release_state, 'private_pool') <> 'private_pool'
          OR public.marketplace_private_pool_contains_v1(
            COALESCE(r.private_pool, '[]'::jsonb),
            public.current_user_org_id()
          )
        )
      )
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
   LIMIT 1
  ), FALSE);
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_application_status_by_token_v1(
  p_status_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_status_token UUID;
BEGIN
  BEGIN
    v_status_token := NULLIF(btrim(COALESCE(p_status_token, '')), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END;

  RETURN public.marketplace_application_status_by_token_v1(v_status_token);
END;
$function$;

CREATE OR REPLACE FUNCTION api.marketplace_application_status_by_token_v1(
  p_status_token TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_application_status_by_token_v1(p_status_token);
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_can_read_request_v1(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_application_status_by_token_v1(TEXT) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) TO authenticated, anon, service_role;

SELECT pg_advisory_unlock(hashtext('202603091010_marketplace_helper_overloads_v1'));
COMMIT;
