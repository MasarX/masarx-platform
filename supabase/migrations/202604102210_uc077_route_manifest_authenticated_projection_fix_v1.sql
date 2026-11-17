-- Plan: PLAN-202604-b06-closeout / Step: Harden authenticated route manifest projections

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102210_uc077_route_manifest_authenticated_projection_fix_v1'));
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
  v_claim_role TEXT := NULLIF(
    btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')),
    ''
  );
  v_is_service BOOLEAN := v_claim_role = 'service_role'
    OR (
      v_claim_role IS NULL
      AND session_user IN ('postgres', 'supabase_admin')
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

COMMENT ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID)
  IS 'Executor-safe route visibility helper. Explicit service_role claims bypass scope guards; authenticated route readers are limited to tenant-write inventory or their owned assignment.';

CREATE OR REPLACE FUNCTION public.ui_route_run_assignment_projection_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_route_run public.route_runs%ROWTYPE;
BEGIN
  SELECT *
    INTO v_route_run
    FROM public.ui_route_run_visible_v1(p_route_run_id, 'read');

  RETURN COALESCE(
    public.route_run_assignment_projection_v1(v_route_run.id),
    COALESCE(v_route_run.metadata->'route_assignment', '{}'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_route_run_assignment_projection_v1(UUID)
  IS 'Authenticated route-run assignment projection wrapper. Enforces route visibility before exposing the canonical assignment JSON used by browser-safe route views.';

REVOKE ALL ON FUNCTION public.ui_route_run_assignment_projection_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_run_assignment_projection_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_route_run_assignment_projection_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_runs
WITH (security_invoker = true) AS
SELECT
  rr.id,
  rr.organization_id,
  rr.branch_id,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.status,
  rr.planned_date,
  rr.planned_start_at,
  rr.planned_end_at,
  rr.started_at,
  rr.ended_at,
  rr.metadata,
  rr.created_at,
  rr.updated_at,
  rr.idempotency_key,
  rr.idempotency_hash,
  rr.route_plan_id,
  COALESCE(
    public.ui_route_run_assignment_projection_v1(rr.id),
    COALESCE(rr.route_assignment, '{}'::jsonb)
  ) AS route_assignment,
  public.ui_route_run_execution_manifest_v1(rr.id) AS route_execution_manifest
FROM public.route_runs_visible_v1 rr;

REVOKE ALL ON FUNCTION public.route_run_assignment_projection_v1(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.route_run_execution_manifest_build_v1(UUID) FROM authenticated;

SELECT pg_advisory_unlock(hashtext('202604102210_uc077_route_manifest_authenticated_projection_fix_v1'));

COMMIT;
