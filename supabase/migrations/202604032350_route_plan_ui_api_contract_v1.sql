-- Migration: Route plan UI/API contract v1
-- Purpose:
--   - Expose route_plans through the browser-safe api schema.
--   - Add authenticated UI RPCs that derive actor/org context server-side and
--     keep service-only lifecycle functions off the direct browser contract.
--   - Wire route_plans into access_control_policy, ui_read_registry, and
--     ui_navigation for Console/Portal route-operations discovery.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604032350_route_plan_ui_api_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Browser-safe api route_plans projection
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW api.route_plans
WITH (security_invoker = true) AS
SELECT *
FROM public.route_plans;

REVOKE ALL ON api.route_plans FROM PUBLIC;
REVOKE ALL ON api.route_plans FROM anon;
GRANT SELECT ON api.route_plans TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) UI auth/capability helpers
-------------------------------------------------------------------------------

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
    IF scope_type <> 'tenant' THEN
      RAISE EXCEPTION 'route plan ui write requires tenant scope'
        USING ERRCODE = '42501';
    END IF;
    IF organization_id IS NULL THEN
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

REVOKE ALL ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_route_plan_actor_context_v1(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_route_plan_visible_v1(
  p_route_plan_id UUID,
  p_action TEXT DEFAULT 'read'
)
RETURNS public.route_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_plan public.route_plans%ROWTYPE;
BEGIN
  IF p_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'ui_route_plan_visible_v1 requires route_plan_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1(p_action)
   LIMIT 1;

  SELECT *
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = p_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'route plan % not found', p_route_plan_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_ctx.is_platform AND v_plan.organization_id IS DISTINCT FROM v_ctx.organization_id THEN
    RAISE EXCEPTION 'route plan % is outside the current organization', p_route_plan_id
      USING ERRCODE = '42501';
  END IF;

  RETURN v_plan;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_route_plan_visible_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_plan_visible_v1(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.ui_route_plan_visible_v1(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_route_plan_visible_v1(UUID, TEXT) TO service_role;

-------------------------------------------------------------------------------
-- 3) UI RPCs + api wrappers
-------------------------------------------------------------------------------

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
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'organization_id', v_ctx.organization_id,
      'requested_by_user_id', v_ctx.user_id
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.create_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_create_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for route_plans. Derives organization_id/requested_by_user_id from the current tenant session.';

REVOKE ALL ON FUNCTION public.ui_create_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_route_plan_resolve_stops_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plan public.route_plans%ROWTYPE;
BEGIN
  SELECT *
    INTO v_plan
    FROM public.ui_route_plan_visible_v1(p_route_plan_id, 'read');

  RETURN public.route_plan_resolve_stops_v1(v_plan.id);
END;
$function$;

COMMENT ON FUNCTION public.ui_route_plan_resolve_stops_v1(UUID) IS
  'Authenticated UI read-path for route_plan stop resolution.';

REVOKE ALL ON FUNCTION public.ui_route_plan_resolve_stops_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_plan_resolve_stops_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_route_plan_resolve_stops_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_freeze_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  stop_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_plan public.route_plans%ROWTYPE;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_route_plan_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_freeze_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_plan_id := NULL;
  END;

  SELECT *
    INTO v_plan
    FROM public.ui_route_plan_visible_v1(v_route_plan_id, 'write');

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id' - 'actor_user_id' - 'actor_system');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'route_plan_id', v_plan.id,
      'actor_user_id', v_ctx.user_id,
      'actor_system', 'route_plan_ui'
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.freeze_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_freeze_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for route_plan freeze with server-derived actor context.';

REVOKE ALL ON FUNCTION public.ui_freeze_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_freeze_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_freeze_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_apply_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_plan public.route_plans%ROWTYPE;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_route_plan_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_apply_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_plan_id := NULL;
  END;

  SELECT *
    INTO v_plan
    FROM public.ui_route_plan_visible_v1(v_route_plan_id, 'write');

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id' - 'actor_user_id' - 'actor_system');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'route_plan_id', v_plan.id,
      'actor_user_id', v_ctx.user_id,
      'actor_system', 'route_plan_ui'
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.apply_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_apply_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for route_plan apply with server-derived actor context.';

REVOKE ALL ON FUNCTION public.ui_apply_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_apply_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_apply_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_start_route_plan_apply_workflow_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_plan public.route_plans%ROWTYPE;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_route_plan_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_start_route_plan_apply_workflow_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_plan_id := NULL;
  END;

  SELECT *
    INTO v_plan
    FROM public.ui_route_plan_visible_v1(v_route_plan_id, 'write');

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id' - 'actor_user_id' - 'actor_system');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'route_plan_id', v_plan.id,
      'actor_user_id', v_ctx.user_id,
      'actor_system', 'route_plan_ui'
    )
  );

  RETURN public.start_route_plan_apply_workflow_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_start_route_plan_apply_workflow_v1(JSONB) IS
  'Authenticated UI write-path for route_plan apply workflow start with server-derived actor context.';

REVOKE ALL ON FUNCTION public.ui_start_route_plan_apply_workflow_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_start_route_plan_apply_workflow_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_start_route_plan_apply_workflow_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_create_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  created BOOLEAN,
  status TEXT,
  version INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_create_route_plan_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_create_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_create_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_route_plan_resolve_stops_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_route_plan_resolve_stops_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_route_plan_resolve_stops_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_route_plan_resolve_stops_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_route_plan_resolve_stops_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_freeze_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  stop_count INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_freeze_route_plan_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_freeze_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_freeze_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_freeze_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_apply_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN,
  status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_apply_route_plan_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_apply_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_apply_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_apply_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_start_route_plan_apply_workflow_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_start_route_plan_apply_workflow_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_start_route_plan_apply_workflow_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_start_route_plan_apply_workflow_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_start_route_plan_apply_workflow_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) access_control_policy: add route_plans capabilities/resource map
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_caps JSONB := '[]'::jsonb;
  v_role_source JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_cap JSONB;
  v_role JSONB;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'route_plans.read',
      'label', 'Route plans read',
      'category', 'operations',
      'description', 'Read route planning projections, constraints, and optimization status.'
    ),
    jsonb_build_object(
      'key', 'route_plans.write',
      'label', 'Route plans write',
      'category', 'operations',
      'description', 'Create, freeze, and apply route planning projections.'
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    FOR v_cap IN
      SELECT value
      FROM jsonb_array_elements(v_new_caps) AS value
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_caps) AS item(value)
        WHERE item.value->>'key' = v_cap->>'key'
      ) THEN
        v_caps := v_caps || jsonb_build_array(v_cap);
      END IF;
    END LOOP;

    v_role_source := COALESCE(v_current->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_role_source) IS DISTINCT FROM 'array' THEN
      v_role_source := '[]'::jsonb;
    END IF;

    v_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value
      FROM jsonb_array_elements(v_role_source) AS value
    LOOP
      IF v_role->>'key' = 'ops_admin' THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          to_jsonb(ARRAY(
            SELECT DISTINCT cap
            FROM (
              SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
              UNION ALL
              SELECT unnest(ARRAY['route_plans.read', 'route_plans.write']) AS cap
            ) AS caps
            ORDER BY cap
          )),
          FALSE
        );
      END IF;

      v_roles := v_roles || jsonb_build_array(v_role);
    END LOOP;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{route_plans}',
      jsonb_build_object(
        'read', 'route_plans.read',
        'write', 'route_plans.write'
      ),
      TRUE
    );

    v_next := jsonb_set(v_current, '{capabilities}', v_caps, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_roles, TRUE);
    v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose route_plans capabilities and resource map through access_control_policy.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 5) ui_read_registry: add/sync route_plans resource against api.route_plans
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_next_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_has_route_plans BOOLEAN := FALSE;
  v_route_plans_resource JSONB := jsonb_build_object(
    'key', 'route_plans',
    'label', 'Route Plans',
    'relation', 'api.route_plans',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'route_plans.read',
    'capability_write', 'route_plans.write',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'branch_id',
      'planned_date',
      'status',
      'status_reason',
      'requested_by_user_id',
      'requested_at',
      'solved_at',
      'applied_at',
      'inputs',
      'constraints',
      'solution',
      'version',
      'metadata',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'planned_date', 'column', 'planned_date', 'op', 'eq'),
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq')
    ),
    'column_labels', jsonb_build_object(
      'planned_date', 'Planned date',
      'status_reason', 'Status reason',
      'requested_by_user_id', 'Requested by',
      'requested_at', 'Requested at',
      'solved_at', 'Solved at',
      'applied_at', 'Applied at'
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_next_resources := '[]'::jsonb;
    v_has_route_plans := FALSE;

    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_resource->>'key' = 'route_plans' THEN
        v_has_route_plans := TRUE;
        v_next_resources := v_next_resources || jsonb_build_array(v_resource || v_route_plans_resource);
      ELSE
        v_next_resources := v_next_resources || jsonb_build_array(v_resource);
      END IF;
    END LOOP;

    IF NOT v_has_route_plans THEN
      v_next_resources := v_next_resources || jsonb_build_array(v_route_plans_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose route_plans through ui_read_registry on api.route_plans.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 6) ui_navigation: add/sync route_plans into Console + Portal operations
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_apps JSONB := '{}'::jsonb;
  v_console JSONB := '{}'::jsonb;
  v_portal JSONB := '{}'::jsonb;
  v_sections JSONB := '[]'::jsonb;
  v_next_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB := '[]'::jsonb;
  v_next_items JSONB := '[]'::jsonb;
  v_item JSONB;
  v_has_operations BOOLEAN := FALSE;
  v_has_item BOOLEAN := FALSE;
  v_console_item JSONB := jsonb_build_object(
    'id', 'console-route-plans',
    'label', 'Route Plans',
    'href', '/console/resources/route_plans',
    'resource', 'route_plans',
    'capability', 'route_plans.read'
  );
  v_portal_item JSONB := jsonb_build_object(
    'id', 'portal-route-plans',
    'label', 'Route Plans',
    'href', '/portal/resources/route_plans',
    'resource', 'route_plans',
    'capability', 'route_plans.read'
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_apps := COALESCE(v_current->'apps', '{}'::jsonb);
    IF jsonb_typeof(v_apps) IS DISTINCT FROM 'object' THEN
      v_apps := '{}'::jsonb;
    END IF;

    v_console := COALESCE(v_apps->'console', '{}'::jsonb);
    IF jsonb_typeof(v_console) IS DISTINCT FROM 'object' THEN
      v_console := '{}'::jsonb;
    END IF;

    v_sections := COALESCE(v_console->'sections', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_next_sections := '[]'::jsonb;
    v_has_operations := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_items := COALESCE(v_section->'items', '[]'::jsonb);
        IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
          v_items := '[]'::jsonb;
        END IF;

        v_next_items := '[]'::jsonb;
        v_has_item := FALSE;

        FOR v_item IN
          SELECT value
          FROM jsonb_array_elements(v_items) AS value
        LOOP
          IF v_item->>'resource' = 'route_plans' THEN
            v_has_item := TRUE;
            v_next_items := v_next_items || jsonb_build_array(v_item || v_console_item);
          ELSE
            v_next_items := v_next_items || jsonb_build_array(v_item);
          END IF;
        END LOOP;

        IF NOT v_has_item THEN
          v_next_items := v_next_items || jsonb_build_array(v_console_item);
        END IF;

        v_next_sections := v_next_sections || jsonb_build_array(
          jsonb_set(v_section, '{items}', v_next_items, TRUE)
        );
      ELSE
        v_next_sections := v_next_sections || jsonb_build_array(v_section);
      END IF;
    END LOOP;

    IF NOT v_has_operations THEN
      v_next_sections := v_next_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'operations',
          'label', 'Operations',
          'items', jsonb_build_array(v_console_item)
        )
      );
    END IF;

    v_console := jsonb_set(v_console, '{sections}', v_next_sections, TRUE);
    v_apps := jsonb_set(v_apps, '{console}', v_console, TRUE);

    v_portal := COALESCE(v_apps->'portal', '{}'::jsonb);
    IF jsonb_typeof(v_portal) IS DISTINCT FROM 'object' THEN
      v_portal := '{}'::jsonb;
    END IF;

    v_sections := COALESCE(v_portal->'sections', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_next_sections := '[]'::jsonb;
    v_has_operations := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_items := COALESCE(v_section->'items', '[]'::jsonb);
        IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
          v_items := '[]'::jsonb;
        END IF;

        v_next_items := '[]'::jsonb;
        v_has_item := FALSE;

        FOR v_item IN
          SELECT value
          FROM jsonb_array_elements(v_items) AS value
        LOOP
          IF v_item->>'resource' = 'route_plans' THEN
            v_has_item := TRUE;
            v_next_items := v_next_items || jsonb_build_array(v_item || v_portal_item);
          ELSE
            v_next_items := v_next_items || jsonb_build_array(v_item);
          END IF;
        END LOOP;

        IF NOT v_has_item THEN
          v_next_items := v_next_items || jsonb_build_array(v_portal_item);
        END IF;

        v_next_sections := v_next_sections || jsonb_build_array(
          jsonb_set(v_section, '{items}', v_next_items, TRUE)
        );
      ELSE
        v_next_sections := v_next_sections || jsonb_build_array(v_section);
      END IF;
    END LOOP;

    IF NOT v_has_operations THEN
      v_next_sections := v_next_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'operations',
          'label', 'Operations',
          'items', jsonb_build_array(v_portal_item)
        )
      );
    END IF;

    v_portal := jsonb_set(v_portal, '{sections}', v_next_sections, TRUE);
    v_apps := jsonb_set(v_apps, '{portal}', v_portal, TRUE);

    v_next := jsonb_set(v_current, '{apps}', v_apps, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose route_plans in Console and Portal operations navigation.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604032350_route_plan_ui_api_contract_v1'));
COMMIT;
