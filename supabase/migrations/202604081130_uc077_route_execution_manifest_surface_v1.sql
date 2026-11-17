-- Migration: UC077 route execution manifest surface v1
-- Purpose:
--   - Keep route-run reads executor-safe by scoping direct route visibility to
--     operators with routes.write and drivers who own the assignment.
--   - Expose the canonical stop list / manifest lane through ui_read_registry
--     and browser-safe api.route_stops.
--   - Preserve the shared Console/Portal resource workspace pattern so routes
--     and route_stops drill down through the same SSOT read contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604081130_uc077_route_execution_manifest_surface_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Executor-safe route visibility helper
-------------------------------------------------------------------------------

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
  v_claim_role TEXT := COALESCE(
    NULLIF(btrim(COALESCE(auth.jwt() ->> 'role', '')), ''),
    NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '')
  );
  v_is_service BOOLEAN := v_claim_role = 'service_role';
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
  'Executor-safe route visibility helper. routes.write sees the tenant route inventory; routes.read without write is limited to the driver-owned route assignment.';

REVOKE ALL ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Scoped route and route-stop manifest projections
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.route_runs_visible_v1
WITH (security_invoker = true) AS
SELECT
  rr.*,
  COALESCE(rr.metadata->'route_assignment', '{}'::jsonb) AS route_assignment
FROM public.route_runs rr
WHERE public.route_run_actor_can_read_v1(
  rr.organization_id,
  rr.id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_runs_visible_v1 IS
  'Executor-safe route_run projection for shared UI and browser-safe API reads.';

REVOKE ALL ON TABLE public.route_runs_visible_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.route_runs_visible_v1 FROM anon;
GRANT SELECT ON TABLE public.route_runs_visible_v1 TO authenticated, service_role;

CREATE OR REPLACE VIEW public.route_stops_visible_v1
WITH (security_invoker = true) AS
SELECT
  rs.*,
  rr.status AS route_run_status,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.branch_id,
  rr.route_plan_id,
  rr.planned_date,
  rr.planned_start_at AS route_planned_start_at,
  rr.planned_end_at AS route_planned_end_at,
  COALESCE(rr.metadata->'route_assignment', '{}'::jsonb) AS route_assignment
FROM public.route_stops rs
JOIN public.route_runs rr
  ON rr.id = rs.route_run_id
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_stops_visible_v1 IS
  'Executor-safe route_stop manifest projection scoped to the visible route inventory.';

REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM anon;
GRANT SELECT ON TABLE public.route_stops_visible_v1 TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_runs
WITH (security_invoker = true) AS
SELECT *
FROM public.route_runs_visible_v1;

REVOKE ALL ON api.route_runs FROM PUBLIC;
REVOKE ALL ON api.route_runs FROM anon;
GRANT SELECT ON api.route_runs TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3) access_control_policy + ui registry wiring
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resource_map JSONB := '{}'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{route_stops}',
      jsonb_build_object(
        'read', 'routes.read',
        'write', 'routes.write'
      ),
      TRUE
    );

    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'uc077 route stop manifest surface wiring',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_console_sections JSONB := '[]'::jsonb;
  v_portal_sections JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.category,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category IN ('ui_read_registry', 'ui_navigation')
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    IF v_row.category = 'ui_read_registry' THEN
      v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
      IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
        v_resources := '[]'::jsonb;
      END IF;

      v_resources := (
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        FROM jsonb_array_elements(v_resources) AS value
        WHERE value->>'key' NOT IN ('routes', 'route_stops')
      );

      v_resources := v_resources || jsonb_build_array(
        jsonb_build_object(
          'key', 'routes',
          'label', 'Routes',
          'relation', 'public.route_runs_visible_v1',
          'capability_read', 'routes.read',
          'primary_key', 'id',
          'default_sort', jsonb_build_array(
            jsonb_build_object('key', 'planned_date', 'direction', 'desc'),
            jsonb_build_object('key', 'created_at', 'direction', 'desc')
          ),
          'select_fields', jsonb_build_array(
            'id',
            'organization_id',
            'branch_id',
            'driver_user_id',
            'vehicle_id',
            'status',
            'planned_date',
            'planned_start_at',
            'planned_end_at',
            'route_plan_id',
            'route_assignment',
            'metadata',
            'created_at',
            'updated_at'
          ),
          'filters', jsonb_build_array(
            jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
            jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
            jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
            jsonb_build_object('key', 'route_plan_id', 'column', 'route_plan_id', 'op', 'eq')
          )
        ),
        jsonb_build_object(
          'key', 'route_stops',
          'label', 'Route Stops',
          'relation', 'public.route_stops_visible_v1',
          'capability_read', 'routes.read',
          'primary_key', 'id',
          'default_sort', jsonb_build_array(
            jsonb_build_object('key', 'route_run_id', 'direction', 'asc'),
            jsonb_build_object('key', 'sequence_order', 'direction', 'asc')
          ),
          'select_fields', jsonb_build_array(
            'id',
            'organization_id',
            'route_run_id',
            'client_id',
            'shipment_id',
            'stop_kind',
            'sequence_order',
            'planned_start_at',
            'planned_end_at',
            'route_run_status',
            'driver_user_id',
            'vehicle_id',
            'branch_id',
            'route_plan_id',
            'planned_date',
            'route_planned_start_at',
            'route_planned_end_at',
            'route_assignment',
            'metadata',
            'created_at',
            'updated_at'
          ),
          'filters', jsonb_build_array(
            jsonb_build_object('key', 'route_run_id', 'column', 'route_run_id', 'op', 'eq'),
            jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
            jsonb_build_object('key', 'stop_kind', 'column', 'stop_kind', 'op', 'eq'),
            jsonb_build_object('key', 'route_run_status', 'column', 'route_run_status', 'op', 'eq'),
            jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq')
          )
        )
      );

      v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);
    ELSE
      v_console_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
      v_portal_sections := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);

      WITH console_sections AS (
        SELECT COALESCE(jsonb_agg(
          CASE
            WHEN section.value->>'id' = 'operations' THEN
              jsonb_set(
                section.value,
                '{items}',
                (
                  SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                      'id', 'route-stops',
                      'label', 'Route Stops',
                      'href', '/console/resources/route_stops',
                      'resource', 'route_stops',
                      'capability', 'routes.read'
                    )
                  )
                  FROM jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
                  WHERE item.value->>'resource' <> 'route_stops'
                ),
                TRUE
              )
            ELSE section.value
          END
        ), '[]'::jsonb) AS sections
        FROM jsonb_array_elements(v_console_sections) AS section(value)
      ),
      portal_sections AS (
        SELECT COALESCE(jsonb_agg(
          CASE
            WHEN section.value->>'id' = 'operations' THEN
              jsonb_set(
                section.value,
                '{items}',
                (
                  SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                      'id', 'route-stops',
                      'label', 'Route Stops',
                      'href', '/portal/resources/route_stops',
                      'resource', 'route_stops',
                      'capability', 'routes.read'
                    )
                  )
                  FROM jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
                  WHERE item.value->>'resource' <> 'route_stops'
                ),
                TRUE
              )
            ELSE section.value
          END
        ), '[]'::jsonb) AS sections
        FROM jsonb_array_elements(v_portal_sections) AS section(value)
      )
      SELECT
        jsonb_set(
          jsonb_set(v_current, '{apps,console,sections}', console_sections.sections, TRUE),
          '{apps,portal,sections}',
          portal_sections.sections,
          TRUE
        )
      INTO v_next
      FROM console_sections, portal_sections;
    END IF;

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'uc077 route execution manifest surface wiring',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604081130_uc077_route_execution_manifest_surface_v1'));
COMMIT;
