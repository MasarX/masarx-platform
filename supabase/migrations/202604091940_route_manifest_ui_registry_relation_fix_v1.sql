-- Plan: PLAN-202604-b06-route-run-ui-contract / Step: E02
-- Migration: route_manifest_ui_registry_relation_fix_v1
-- Purpose:
--   - Keep browser-safe api.route_runs and api.route_stops views for direct API reads.
--   - Repoint generic ui_list_resource_v1/ui_get_resource_v1 access for routes and
--     route_stops back to the RLS-backed public tables because the generic readers
--     fail closed on views.
--   - Rebuild the api.route_runs/api.route_stops views directly over the base
--     tables so browser-safe reads do not depend on the security-invoker public
--     views that have been destabilizing local verification.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604091940_route_manifest_ui_registry_relation_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_next_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
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
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_resource->>'key' = 'routes' THEN
        v_resource := jsonb_set(
          v_resource,
          '{relation}',
          to_jsonb('public.route_runs'::text),
          TRUE
        );
      ELSIF v_resource->>'key' = 'route_stops' THEN
        v_resource := jsonb_set(
          v_resource,
          '{relation}',
          to_jsonb('public.route_stops'::text),
          TRUE
        );
      END IF;

      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Route generic resource readers must point at RLS-backed public.route_runs/public.route_stops instead of executor views.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DROP VIEW IF EXISTS api.route_runs;

CREATE VIEW api.route_runs AS
SELECT
  rr.*,
  COALESCE(
    public.route_run_assignment_projection_v1(rr.id),
    COALESCE(rr.metadata->'route_assignment', '{}'::jsonb)
  ) AS route_assignment,
  public.route_run_execution_manifest_build_v1(rr.id) AS route_execution_manifest
FROM public.route_runs rr
WHERE public.route_run_actor_can_read_v1(
  rr.organization_id,
  rr.id,
  rr.driver_user_id
);

COMMENT ON VIEW api.route_runs IS
  'Browser-safe executor-scoped route_run manifest projection built directly from public.route_runs.';

REVOKE ALL ON api.route_runs FROM PUBLIC;
REVOKE ALL ON api.route_runs FROM anon;
GRANT SELECT ON api.route_runs TO authenticated, service_role;

DROP VIEW IF EXISTS api.route_stops;

CREATE VIEW api.route_stops AS
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
  COALESCE(
    public.route_run_assignment_projection_v1(rr.id),
    COALESCE(rr.metadata->'route_assignment', '{}'::jsonb)
  ) AS route_assignment
FROM public.route_stops rs
JOIN public.route_runs rr
  ON rr.id = rs.route_run_id
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection built directly from public.route_stops.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604091940_route_manifest_ui_registry_relation_fix_v1'));
COMMIT;
