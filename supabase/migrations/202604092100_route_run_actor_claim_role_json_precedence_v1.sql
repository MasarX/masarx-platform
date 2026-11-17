-- Plan: PLAN-202604-b06-route-run-execution-manifest / Step: E04
-- Migration: route_run_actor_claim_role_json_precedence_v1
-- Purpose:
--   - Keep route manifest visibility fail-closed when a session updates
--     request.jwt.claims but has not yet refreshed request.jwt.claim.role.
--   - Prefer the canonical JSON claims payload over the scalar role setting
--     when detecting authenticated vs service execution inside the
--     route_run_actor_can_read_v1 helper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604092100_route_run_actor_claim_role_json_precedence_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_run_actor_can_read_v1(
  p_organization_id UUID,
  p_route_run_id UUID,
  p_driver_user_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_user_id UUID := NULL;
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_actor_org_id UUID := public.current_user_org_id();
  v_claims_json JSONB := CASE
    WHEN NULLIF(btrim(COALESCE(current_setting('request.jwt.claims', true), '')), '') IS NULL THEN '{}'::jsonb
    ELSE current_setting('request.jwt.claims', true)::jsonb
  END;
  v_claim_role TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_claims_json->>'role', '')), ''),
    NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '')
  );
  v_is_service BOOLEAN := v_claim_role = 'service_role'
    OR (
      session_user IN ('postgres', 'supabase_admin')
      AND COALESCE(v_claim_role, '') NOT IN ('authenticated', 'anon')
    );
  v_effective_scope_id UUID := NULL;
BEGIN
  IF v_is_service THEN
    RETURN TRUE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  IF v_scope_type <> 'tenant' THEN
    RETURN FALSE;
  END IF;

  IF v_actor_org_id IS NULL OR v_actor_org_id IS DISTINCT FROM p_organization_id THEN
    RETURN FALSE;
  END IF;

  v_effective_scope_id := COALESCE(v_scope_id, v_actor_org_id);

  IF public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_effective_scope_id) THEN
    RETURN TRUE;
  END IF;

  IF NOT public.user_has_resource_capability_v1('routes', 'read', v_scope_type, v_effective_scope_id) THEN
    RETURN FALSE;
  END IF;

  BEGIN
    v_actor_user_id := auth.uid();
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  IF v_actor_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF p_driver_user_id IS NOT NULL AND p_driver_user_id = v_actor_user_id THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.route_run_assignments rra
     WHERE rra.organization_id = p_organization_id
       AND rra.route_run_id = p_route_run_id
       AND rra.driver_user_id = v_actor_user_id
       AND rra.assignment_status IN ('assigned', 'acknowledged', 'accepted')
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) IS
  'Executor-safe route visibility helper. routes.write sees the tenant route inventory; routes.read without write is limited to the driver-owned route assignment. JSON JWT claims take precedence over stale scalar role state.';

REVOKE ALL ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) TO authenticated, service_role;

COMMIT;
