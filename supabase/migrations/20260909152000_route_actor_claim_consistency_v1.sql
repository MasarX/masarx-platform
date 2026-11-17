BEGIN;
SET LOCAL lock_timeout = '30s';
SET search_path TO public, extensions, pg_temp;

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
  v_jwt_role TEXT := lower(NULLIF(btrim(COALESCE(auth.jwt() ->> 'role', '')), ''));
  v_claims JSONB := NULLIF(COALESCE(current_setting('request.jwt.claims', true), ''), '')::jsonb;
  v_role_setting TEXT := lower(NULLIF(btrim(COALESCE(current_setting('role', true), '')), ''));
  v_claim_role TEXT := COALESCE(
    v_jwt_role,
    lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '')),
    lower(NULLIF(btrim(COALESCE(v_claims ->> 'role', '')), ''))
  );
  v_is_service BOOLEAN := FALSE;
  v_effective_scope_id UUID := NULL;
  v_effective_driver_user_id UUID := p_driver_user_id;
BEGIN
  IF v_role_setting = 'none' THEN
    v_role_setting := NULL;
  END IF;

  v_is_service := v_claim_role = 'service_role'
    OR (
      v_claim_role IS NULL
      AND v_role_setting = 'service_role'
    )
    OR (
      v_claim_role IS NULL
      AND v_role_setting IS NULL
      AND session_user IN ('postgres', 'supabase_admin', 'service_role')
    );

  IF v_is_service THEN
    RETURN TRUE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  -- A supplied tenant organization claim cannot contradict actor/route scope.
  -- Omitted claims remain compatible; service authority retains its existing path.
  IF v_claims ? 'organization_id'
     AND (
       jsonb_typeof(v_claims->'organization_id') IS DISTINCT FROM 'string'
       OR lower(v_claims->>'organization_id') IS DISTINCT FROM v_actor_org_id::text
       OR lower(v_claims->>'organization_id') IS DISTINCT FROM p_organization_id::text
     ) THEN
    RETURN FALSE;
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

  IF v_effective_driver_user_id IS NULL AND p_route_run_id IS NOT NULL THEN
    SELECT COALESCE(
             rr.driver_user_id,
             NULLIF(btrim(COALESCE(rr.metadata #>> '{route_assignment,driver_user_id}', '')), '')::uuid
           )
      INTO v_effective_driver_user_id
      FROM public.route_runs rr
     WHERE rr.id = p_route_run_id
       AND rr.organization_id = p_organization_id
     LIMIT 1;
  END IF;

  IF v_effective_driver_user_id IS NOT NULL AND v_effective_driver_user_id = v_actor_user_id THEN
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

COMMIT;
