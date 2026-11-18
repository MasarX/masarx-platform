-- Console V2 route planning: platform operators work through an active tenant lens.
-- The tenant organization remains caller-selected at the UI/API boundary while
-- route-plan actor and route-plan mutations stay server-derived and capability gated.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605072025_route_plan_platform_tenant_scope_v1'));

CREATE OR REPLACE FUNCTION public.route_plans_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_user_org UUID;
  v_user_scope_type TEXT;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'route_plans: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'route_plans: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_plans: organization mismatch (plan org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.requested_by_user_id IS NOT NULL THEN
    SELECT u.organization_id, u.access_scope_type
      INTO v_user_org, v_user_scope_type
    FROM public.users u
    WHERE u.id = NEW.requested_by_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'route_plans: user % not found', NEW.requested_by_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id
       AND COALESCE(v_user_scope_type, '') IS DISTINCT FROM 'platform' THEN
      RAISE EXCEPTION 'route_plans: organization mismatch (plan org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.route_plans_enforce_org_match_v1() IS
  'Enforces route-plan branch/user organization consistency while allowing platform users to create active-tenant route plans through Console V2.';

CREATE OR REPLACE FUNCTION public.ui_route_plan_actor_context_v1(
  p_action TEXT DEFAULT 'read'
)
RETURNS TABLE (
  user_id UUID,
  organization_id UUID,
  scope_type TEXT,
  scope_id UUID,
  is_platform BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_action TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(p_action, '')), ''), 'read'));
BEGIN
  user_id := auth.uid();
  organization_id := public.current_user_org_id();
  scope_type := COALESCE(public.current_user_scope_type(), 'global');
  scope_id := public.current_user_scope_id();
  is_platform := public.is_platform_user();

  IF user_id IS NULL THEN
    RAISE EXCEPTION 'route plan ui requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_action NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'ui_route_plan_actor_context_v1 invalid action %', v_action
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.user_has_resource_capability_v1('route_plans', v_action, scope_type, scope_id) THEN
    RAISE EXCEPTION 'route plan ui requires route_plans.% capability', v_action
      USING ERRCODE = '42501';
  END IF;

  IF v_action = 'write' THEN
    IF NOT is_platform AND scope_type <> 'tenant' THEN
      RAISE EXCEPTION 'route plan ui write requires tenant scope'
        USING ERRCODE = '42501';
    END IF;
    IF NOT is_platform AND organization_id IS NULL THEN
      RAISE EXCEPTION 'route plan ui write requires organization context'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT is_platform AND scope_type <> 'tenant' THEN
      RAISE EXCEPTION 'route plan ui read requires tenant or platform scope'
        USING ERRCODE = '42501';
    END IF;
    IF NOT is_platform AND organization_id IS NULL THEN
      RAISE EXCEPTION 'route plan ui read requires organization context'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) IS
  'Authenticated route-plan UI actor context. Tenant users derive organization from identity; platform users may write through target-organization inputs on UI mutation wrappers.';

REVOKE ALL ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_create_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  created BOOLEAN,
  status TEXT,
  version INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_requested_org_id UUID := NULL;
  v_target_org_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_requested_org_id := NULLIF(v_input->>'organization_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_requested_org_id := NULL;
  END;

  IF v_ctx.is_platform THEN
    IF v_requested_org_id IS NULL THEN
      RAISE EXCEPTION 'route plan ui write requires target organization context'
        USING ERRCODE = '42501';
    END IF;
    v_target_org_id := v_requested_org_id;
  ELSE
    v_target_org_id := v_ctx.organization_id;
  END IF;

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'route plan ui write requires organization context'
      USING ERRCODE = '42501';
  END IF;

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'organization_id', v_target_org_id,
      'requested_by_user_id', v_ctx.user_id
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.create_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_create_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for route_plans. Tenant users derive organization from identity; platform users must supply the active tenant organization_id.';

REVOKE ALL ON FUNCTION public.ui_create_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_route_plan_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605072025_route_plan_platform_tenant_scope_v1'));
COMMIT;
