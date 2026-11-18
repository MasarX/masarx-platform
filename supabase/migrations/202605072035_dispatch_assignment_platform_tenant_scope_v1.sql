-- Console V2 dispatch assignment active-tenant scope for platform operators.
--
-- Platform operators use Console V2 through an explicit active tenant lens.
-- Route planning already carries that selected tenant into write RPCs; dispatch
-- route-run assignment must do the same so the browser-safe executor is not a
-- global write surface.

CREATE OR REPLACE FUNCTION public.ui_route_run_actor_context_v1(
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
    RAISE EXCEPTION 'route ui requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_action NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'ui_route_run_actor_context_v1 invalid action %', v_action
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.user_has_resource_capability_v1('routes', v_action, scope_type, scope_id) THEN
    RAISE EXCEPTION 'route ui requires routes.% capability', v_action
      USING ERRCODE = '42501';
  END IF;

  IF v_action = 'write' THEN
    IF NOT is_platform THEN
      IF scope_type <> 'tenant' THEN
        RAISE EXCEPTION 'route ui write requires tenant scope'
          USING ERRCODE = '42501';
      END IF;
      IF organization_id IS NULL THEN
        RAISE EXCEPTION 'route ui write requires organization context'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    IF NOT is_platform AND scope_type <> 'tenant' THEN
      RAISE EXCEPTION 'route ui read requires tenant or platform scope'
        USING ERRCODE = '42501';
    END IF;
    IF NOT is_platform AND organization_id IS NULL THEN
      RAISE EXCEPTION 'route ui read requires organization context'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.ui_route_run_actor_context_v1(TEXT)
  IS 'Returns authenticated route UI actor context. Tenant writes require tenant org context; platform writes are capability-gated and must be bounded by each UI executor active-tenant payload.';

REVOKE ALL ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_execute_route_run_assign_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_ctx RECORD;
  v_registry JSONB := public.resolve_settings_merged(
    'ui_command_registry',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );
  v_command JSONB := NULL;
  v_params JSONB := COALESCE(p_params, '{}'::jsonb);
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_count INT := 0;
  v_route_run_id UUID := NULL;
  v_route_run_org_id UUID := NULL;
  v_requested_org_text TEXT := NULL;
  v_requested_org_id UUID := NULL;
  v_partner JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
  v_prepare_result RECORD;
  v_result RECORD;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_run_actor_context_v1('write')
   LIMIT 1;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 unknown command %', p_action_key;
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 selection above maximum %', v_max;
  END IF;

  BEGIN
    v_route_run_id := NULLIF(COALESCE(v_id, v_ids[1]), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 invalid route id %', COALESCE(v_id, v_ids[1], '')
      USING ERRCODE = '23514';
  END IF;

  IF public.ui_get_resource_v1(p_resource_key, v_route_run_id) IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 route % is not visible in resource %', v_route_run_id, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT rr.organization_id
    INTO v_route_run_org_id
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id;

  IF v_route_run_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 route % not found', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  v_requested_org_text := NULLIF(btrim(COALESCE(v_params->>'organization_id', '')), '');
  IF v_requested_org_text IS NOT NULL THEN
    BEGIN
      v_requested_org_id := v_requested_org_text::uuid;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_route_run_assign_v1 invalid organization_id %', v_requested_org_text
          USING ERRCODE = '23514';
    END;
  END IF;

  IF COALESCE(v_ctx.is_platform, FALSE) THEN
    IF v_requested_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_execute_route_run_assign_v1 platform write requires organization_id'
        USING ERRCODE = '42501';
    END IF;
    IF v_requested_org_id IS DISTINCT FROM v_route_run_org_id THEN
      RAISE EXCEPTION 'ui_execute_route_run_assign_v1 organization_id % does not match route_run organization %', v_requested_org_id, v_route_run_org_id
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_requested_org_id IS NOT NULL
     AND v_requested_org_id IS DISTINCT FROM v_route_run_org_id THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 organization_id % does not match route_run organization %', v_requested_org_id, v_route_run_org_id
      USING ERRCODE = '42501';
  END IF;

  v_partner := COALESCE(v_params->'partner', '{}'::jsonb);
  IF jsonb_typeof(v_partner) IS DISTINCT FROM 'object' THEN
    v_partner := '{}'::jsonb;
  END IF;
  v_partner := jsonb_strip_nulls(
    v_partner
    || jsonb_build_object(
      'partner_id', NULLIF(v_params->>'partner_id', ''),
      'partner_name', NULLIF(v_params->>'partner_name', '')
    )
  );

  v_metadata := COALESCE(v_params->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;
  v_metadata := jsonb_strip_nulls(
    v_metadata
    || jsonb_build_object(
      'reassignment_reason', NULLIF(v_params->>'reassignment_reason', '')
    )
  );

  IF v_partner <> '{}'::jsonb THEN
    SELECT *
      INTO v_prepare_result
      FROM public.route_run_prepare_partner_handoff_v1(
        v_route_run_id,
        NULL,
        NULLIF(v_params->>'notes', ''),
        'route_assignment_ui'
      )
     LIMIT 1;
  END IF;

  SELECT *
    INTO v_result
    FROM public.assign_route_run_v1(
      jsonb_strip_nulls(
        v_params
        || jsonb_build_object(
          'action_key', p_action_key,
          'route_run_id', v_route_run_id,
          'driver_user_id', NULLIF(v_params->>'driver_user_id', ''),
          'vehicle_id', NULLIF(v_params->>'vehicle_id', ''),
          'partner', CASE WHEN v_partner = '{}'::jsonb THEN NULL ELSE v_partner END,
          'partner_id', NULLIF(v_params->>'partner_id', ''),
          'partner_name', NULLIF(v_params->>'partner_name', ''),
          'notes', NULLIF(v_params->>'notes', ''),
          'idempotency_key', NULLIF(v_params->>'idempotency_key', ''),
          'metadata', v_metadata,
          'actor_user_id', v_ctx.user_id,
          'actor_system', 'route_assignment_ui'
        )
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'assigned',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'route_run_id', v_result.route_run_id,
          'route_run_assignment_id', v_result.route_run_assignment_id,
          'assignment_status', v_result.assignment_status,
          'assignment_mode', v_result.assignment_mode,
          'assignment_version', v_result.assignment_version,
          'driver_user_id', v_result.driver_user_id,
          'vehicle_id', v_result.vehicle_id,
          'partner', v_result.partner,
          'stop_task_count', v_result.stop_task_count,
          'assigned_task_count', v_result.assigned_task_count,
          'created', v_result.created
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Dedicated UI command executor for route assignment. Platform Console V2 writes require an active-tenant organization_id matching the selected route_run before delegating to assign_route_run_v1.';

REVOKE ALL ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_run_assign_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_execute_route_run_assign_v1($1, $2, $3, $4, $5, $6);
$function$;

REVOKE ALL ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;
