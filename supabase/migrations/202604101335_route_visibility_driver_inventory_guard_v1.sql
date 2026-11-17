-- Plan: PLAN-202604-b06-route-run-execution-manifest / Step: E01
-- Migration: Keep driver route visibility assignment-scoped even when tenant write capability resolves true

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101335_route_visibility_driver_inventory_guard_v1'));
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
  v_actor_user_type TEXT := NULL;
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_actor_org_id UUID := public.current_user_org_id();
  v_claim_role TEXT := NULLIF(
    btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')),
    ''
  );
  v_is_service BOOLEAN := v_claim_role = 'service_role'
    OR (
      v_claim_role IS NULL
      AND session_user IN ('postgres', 'supabase_admin', 'service_role')
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

  BEGIN
    v_actor_user_id := auth.uid();
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT NULLIF(btrim(COALESCE(u.user_type, '')), '')
      INTO v_actor_user_type
      FROM public.users u
     WHERE u.id = v_actor_user_id
       AND u.organization_id = p_organization_id
     LIMIT 1;
  END IF;

  v_effective_scope_id := COALESCE(v_scope_id, v_actor_org_id);

  IF public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_effective_scope_id)
     AND COALESCE(v_actor_user_type, '') <> 'driver' THEN
    RETURN TRUE;
  END IF;

  IF NOT public.user_has_resource_capability_v1('routes', 'read', v_scope_type, v_effective_scope_id) THEN
    RETURN FALSE;
  END IF;

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
  'Executor-safe route visibility helper. Tenant operators with routes.write see the full tenant route inventory; drivers remain limited to their assigned route inventory.';

SELECT pg_advisory_unlock(hashtext('202604101335_route_visibility_driver_inventory_guard_v1'));

COMMIT;
