-- Migration: Dispatch route scanout UI read registry v1
-- Purpose:
--   - Register the Dispatch route-run resources consumed by Console V2 through
--     the canonical ui_list_resource_v1 read path.
--   - Add narrow security-invoker projection views for Dispatch labels and
--     picker rows instead of bypassing the shared registry/RPC contract.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607031430_dispatch_route_scanout_ui_read_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_route_run_directory;
CREATE VIEW public.v_route_run_directory
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
  ('RUN-' || upper(substr(replace(rr.id::text, '-', ''), 1, 6))) AS run_display_id,
  CASE
    WHEN b.id IS NULL THEN NULL
    WHEN NULLIF(b.code, '') IS NOT NULL AND NULLIF(b.name, '') IS NOT NULL THEN b.code || ' · ' || b.name
    ELSE COALESCE(NULLIF(b.name, ''), NULLIF(b.code, ''))
  END AS branch_label,
  b.code AS branch_code,
  b.branch_type,
  COALESCE(NULLIF(u.full_name, ''), u.email, rr.driver_user_id::text) AS driver_label,
  COALESCE(NULLIF(v.plate_number, ''), v.vin, rr.vehicle_id::text) AS vehicle_label,
  COALESCE(stop_counts.stop_count, 0)::int AS stop_count,
  COALESCE(stop_counts.cod_total, 0)::numeric AS cod_total,
  NULLIF(rr.route_assignment->>'route_run_assignment_id', '')::uuid AS assignment_id,
  NULLIF(rr.route_assignment->>'assignment_status', '') AS assignment_status,
  NULLIF(rr.route_assignment->>'assignment_mode', '') AS assignment_mode,
  NULLIF(rr.route_assignment->>'assignment_version', '')::int AS assignment_version,
  NULLIF(rr.route_assignment->>'assigned_at', '')::timestamptz AS assignment_assigned_at,
  NULLIF(rr.route_assignment->>'driver_user_id', '')::uuid AS assignment_driver_user_id,
  NULLIF(rr.route_assignment->>'vehicle_id', '')::uuid AS assignment_vehicle_id,
  NULLIF(COALESCE(rr.route_assignment->'partner', '{}'::jsonb), '{}'::jsonb) AS partner_payload,
  COALESCE(
    NULLIF(rr.route_assignment#>>'{partner,partner_name}', ''),
    NULLIF(rr.route_assignment#>>'{partner,partner_id}', '')
  ) AS partner_name,
  NULLIF(rr.route_assignment->>'assignment_mode', '') IN ('partner_fleet', 'alternate_capacity_pool') AS is_partner_run
FROM api.route_runs rr
LEFT JOIN public.branches b
  ON b.id = rr.branch_id
LEFT JOIN public.users u
  ON u.id = rr.driver_user_id
LEFT JOIN public.vehicles v
  ON v.id = rr.vehicle_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int AS stop_count,
    COALESCE(SUM(COALESCE(rs.cod_amount, 0)), 0)::numeric AS cod_total
  FROM api.route_stops rs
  WHERE rs.route_run_id = rr.id
) AS stop_counts ON TRUE;

COMMENT ON VIEW public.v_route_run_directory
  IS 'Dispatch route-run directory projection for Console V2 labels, counters, and current assignment state. SSOT remains route_runs, route_stops, and route_run_assignments.';

REVOKE ALL ON TABLE public.v_route_run_directory FROM PUBLIC;
REVOKE ALL ON TABLE public.v_route_run_directory FROM anon;
GRANT SELECT ON TABLE public.v_route_run_directory TO authenticated, service_role;

DROP VIEW IF EXISTS public.driver_profile_picker_v1;
CREATE VIEW public.driver_profile_picker_v1
WITH (security_invoker = true) AS
SELECT
  dp.user_id AS id,
  dp.organization_id,
  COALESCE(NULLIF(u.full_name, ''), NULLIF(driver.full_name, ''), u.email, driver.email, dp.driver_code, dp.user_id::text) AS name,
  dp.driver_code,
  NULLIF(dp.metadata->>'phone', '') AS phone,
  COALESCE(u.email, driver.email) AS user_email,
  dp.status,
  active_assignment.vehicle_id,
  '[]'::jsonb AS skills
FROM public.driver_profiles dp
LEFT JOIN public.users u
  ON u.id = dp.user_id
LEFT JOIN LATERAL public.fleet_driver_identity_v1(dp.organization_id, dp.user_id) driver
  ON u.id IS NULL
LEFT JOIN LATERAL (
  SELECT va.vehicle_id
  FROM public.vehicle_assignments va
  WHERE va.organization_id = dp.organization_id
    AND va.assigned_to_user_id = dp.user_id
    AND COALESCE(NULLIF(va.status, ''), 'active') = 'active'
    AND va.ended_at IS NULL
  ORDER BY va.started_at DESC NULLS LAST, va.created_at DESC, va.id DESC
  LIMIT 1
) AS active_assignment ON TRUE;

COMMENT ON VIEW public.driver_profile_picker_v1
  IS 'Narrow driver picker projection for Dispatch and related route assignment surfaces. SSOT remains driver_profiles plus active vehicle_assignments.';

REVOKE ALL ON TABLE public.driver_profile_picker_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.driver_profile_picker_v1 FROM anon;
GRANT SELECT ON TABLE public.driver_profile_picker_v1 TO authenticated, service_role;

DROP VIEW IF EXISTS public.v_vehicle_directory;
CREATE VIEW public.v_vehicle_directory
WITH (security_invoker = true) AS
SELECT
  v.id,
  v.organization_id,
  v.branch_id,
  v.vehicle_type_id,
  v.status,
  v.plate_number,
  v.plate_number AS plate,
  v.plate_number AS code,
  v.vin,
  v.make,
  v.model,
  v.model_year,
  v.color,
  v.is_active,
  v.metadata,
  v.created_at,
  v.updated_at,
  vt.name AS vehicle_type_label,
  vt.name AS type_name,
  vt.key AS vehicle_type_key,
  active_assignment.assigned_to_user_id AS current_driver_user_id,
  COALESCE(NULLIF(driver_user.full_name, ''), driver_user.email) AS current_driver_label,
  COALESCE(active_assignment.branch_id, v.branch_id) AS current_branch_id,
  active_assignment.branch_id AS active_assignment_branch_id,
  active_assignment.started_at AS active_assignment_started_at,
  CASE
    WHEN active_assignment.started_at IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - active_assignment.started_at)))::int
  END AS assignment_age_seconds,
  CASE
    WHEN b.id IS NULL THEN NULL
    WHEN NULLIF(b.code, '') IS NOT NULL AND NULLIF(b.name, '') IS NOT NULL THEN b.code || ' · ' || b.name
    ELSE COALESCE(NULLIF(b.name, ''), NULLIF(b.code, ''))
  END AS branch_label,
  (v.status = 'oos') AS is_oos,
  (v.status = 'in_maintenance') AS is_in_maintenance
FROM public.vehicles v
LEFT JOIN public.vehicle_types vt
  ON vt.id = v.vehicle_type_id
LEFT JOIN public.branches b
  ON b.id = v.branch_id
LEFT JOIN LATERAL (
  SELECT va.assigned_to_user_id, va.branch_id, va.started_at
  FROM public.vehicle_assignments va
  WHERE va.organization_id = v.organization_id
    AND va.vehicle_id = v.id
    AND COALESCE(NULLIF(va.status, ''), 'active') = 'active'
    AND va.ended_at IS NULL
  ORDER BY va.started_at DESC NULLS LAST, va.created_at DESC, va.id DESC
  LIMIT 1
) AS active_assignment ON TRUE
LEFT JOIN public.users driver_user
  ON driver_user.id = active_assignment.assigned_to_user_id;

COMMENT ON VIEW public.v_vehicle_directory
  IS 'Dispatch/fleet vehicle directory projection for Console V2 labels and active assignment readback. SSOT remains vehicles and vehicle_assignments.';

REVOKE ALL ON TABLE public.v_vehicle_directory FROM PUBLIC;
REVOKE ALL ON TABLE public.v_vehicle_directory FROM anon;
GRANT SELECT ON TABLE public.v_vehicle_directory TO authenticated, service_role;

DROP POLICY IF EXISTS route_run_assignments_select_policy ON public.route_run_assignments;
CREATE POLICY route_run_assignments_select_policy
  ON public.route_run_assignments
  FOR SELECT
  TO authenticated
  USING (public.route_run_actor_can_read_v1(organization_id, route_run_id, driver_user_id));

DROP POLICY IF EXISTS route_run_assignment_events_select_policy ON public.route_run_assignment_events;
CREATE POLICY route_run_assignment_events_select_policy
  ON public.route_run_assignment_events
  FOR SELECT
  TO authenticated
  USING (public.route_run_actor_can_read_v1(organization_id, route_run_id, driver_user_id));

DROP POLICY IF EXISTS route_stop_reassignment_events_select_policy ON public.route_stop_reassignment_events;
CREATE POLICY route_stop_reassignment_events_select_policy
  ON public.route_stop_reassignment_events
  FOR SELECT
  TO authenticated
  USING (
    public.route_run_actor_can_read_v1(organization_id, source_route_run_id, NULL)
    OR public.route_run_actor_can_read_v1(organization_id, target_route_run_id, NULL)
  );

GRANT SELECT ON TABLE public.route_run_assignments TO authenticated;
GRANT SELECT ON TABLE public.route_run_assignment_events TO authenticated;
GRANT SELECT ON TABLE public.route_stop_reassignment_events TO authenticated;

-- Create only missing api.* contract views so specialized projections remain intact.
DO $$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
BEGIN
  CREATE SCHEMA IF NOT EXISTS api;
  REVOKE ALL ON SCHEMA api FROM PUBLIC;
  REVOKE USAGE ON SCHEMA api FROM anon;
  GRANT USAGE ON SCHEMA api TO authenticated;
  GRANT USAGE ON SCHEMA api TO service_role;

  FOR r IN
    SELECT t.tablename
    FROM public.security_rls_user_facing t
    LEFT JOIN pg_catalog.pg_class c
      ON c.relname = t.tablename
     AND c.relkind = 'v'
    LEFT JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace
     AND n.nspname = 'api'
    WHERE n.oid IS NULL
    ORDER BY t.tablename
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE VIEW api.%I WITH (security_invoker = true) AS SELECT * FROM public.%I',
      r.tablename,
      r.tablename
    );

    EXECUTE format('REVOKE ALL ON api.%I FROM PUBLIC', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM anon', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM authenticated', r.tablename);

    v_public_ref := format('public.%I', r.tablename);
    v_auth_select := has_table_privilege('authenticated', v_public_ref, 'select');
    v_auth_insert := has_table_privilege('authenticated', v_public_ref, 'insert');
    v_auth_update := has_table_privilege('authenticated', v_public_ref, 'update');
    v_auth_delete := has_table_privilege('authenticated', v_public_ref, 'delete');

    IF v_auth_select THEN
      EXECUTE format('GRANT SELECT ON api.%I TO authenticated', r.tablename);
    END IF;
    IF v_auth_insert THEN
      EXECUTE format('GRANT INSERT ON api.%I TO authenticated', r.tablename);
    END IF;
    IF v_auth_update THEN
      EXECUTE format('GRANT UPDATE ON api.%I TO authenticated', r.tablename);
    END IF;
    IF v_auth_delete THEN
      EXECUTE format('GRANT DELETE ON api.%I TO authenticated', r.tablename);
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api.%I TO service_role', r.tablename);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION api.route_run_scan_out_reconciliation_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.route_run_scan_out_reconciliation_v1($1);
$function$;

COMMENT ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID)
  IS 'Browser-safe API wrapper for canonical route-run scan-out reconciliation used by Console V2 Dispatch.';

REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_read_registry_dispatch_route_scanout_resources_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'key', 'route_runs',
      'label', 'Route Runs',
      'relation', 'api.route_runs',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'routes.read',
      'select', jsonb_build_array(
        'id', 'organization_id', 'branch_id', 'driver_user_id', 'vehicle_id',
        'status', 'planned_date', 'planned_start_at', 'planned_end_at',
        'started_at', 'ended_at', 'metadata', 'created_at', 'updated_at',
        'idempotency_key', 'idempotency_hash', 'route_plan_id',
        'route_assignment', 'route_execution_manifest'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'route_plan_id', 'column', 'route_plan_id', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'planned_date', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'route_run_directory',
      'label', 'Route Run Directory',
      'relation', 'public.v_route_run_directory',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'routes.read',
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'planned_date', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'drivers',
      'label', 'Drivers',
      'relation', 'public.driver_profile_picker_v1',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc')
    ),
    jsonb_build_object(
      'key', 'vehicle_directory',
      'label', 'Vehicle Directory',
      'relation', 'public.v_vehicle_directory',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'current_branch_id', 'column', 'current_branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'plate_number', 'direction', 'asc')
    ),
    jsonb_build_object(
      'key', 'route_run_assignments',
      'label', 'Route Run Assignments',
      'relation', 'public.route_run_assignments',
      'id_column', 'id',
      'capability_read', 'routes.read',
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'route_run_id', 'column', 'route_run_id', 'op', 'eq'),
        jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
        jsonb_build_object('key', 'assignment_status', 'column', 'assignment_status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'assigned_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'route_run_assignment_events',
      'label', 'Route Run Assignment Events',
      'relation', 'public.route_run_assignment_events',
      'id_column', 'id',
      'capability_read', 'routes.read',
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'route_run_id', 'column', 'route_run_id', 'op', 'eq'),
        jsonb_build_object('key', 'route_run_assignment_id', 'column', 'route_run_assignment_id', 'op', 'eq'),
        jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'route_stop_reassignment_events',
      'label', 'Route Stop Reassignment Events',
      'relation', 'public.route_stop_reassignment_events',
      'id_column', 'id',
      'capability_read', 'routes.read',
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'route_stop_id', 'column', 'route_stop_id', 'op', 'eq'),
        jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
        jsonb_build_object('key', 'source_route_run_id', 'column', 'source_route_run_id', 'op', 'eq'),
        jsonb_build_object('key', 'target_route_run_id', 'column', 'target_route_run_id', 'op', 'eq'),
        jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    )
  );
$function$;

COMMENT ON FUNCTION public.ui_read_registry_dispatch_route_scanout_resources_v1()
  IS 'Canonical ui_read_registry resource payloads required by the Console V2 Dispatch route scan-out/departure surface.';

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_next_resources JSONB := '[]'::jsonb;
  v_dispatch_resources JSONB := public.ui_read_registry_dispatch_route_scanout_resources_v1();
  v_item JSONB := NULL;
  v_resource JSONB := NULL;
  v_keys TEXT[] := ARRAY[
    'route_runs',
    'route_run_directory',
    'drivers',
    'vehicle_directory',
    'route_run_assignments',
    'route_run_assignment_events',
    'route_stop_reassignment_events'
  ];
  v_key TEXT;
  v_found BOOLEAN;
  v_next JSONB;
BEGIN
  FOR v_setting IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND sv.effective_until IS NULL
  LOOP
    v_current := COALESCE(v_setting.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_next_resources := '[]'::jsonb;
    FOR v_item IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      SELECT value
        INTO v_resource
        FROM jsonb_array_elements(v_dispatch_resources) AS value
       WHERE value->>'key' = v_item->>'key'
       LIMIT 1;

      IF v_resource IS NULL THEN
        v_next_resources := v_next_resources || jsonb_build_array(v_item);
      ELSE
        v_next_resources := v_next_resources || jsonb_build_array(v_resource);
      END IF;
    END LOOP;

    FOREACH v_key IN ARRAY v_keys
    LOOP
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_next_resources) AS value
        WHERE value->>'key' = v_key
      )
      INTO v_found;

      IF NOT v_found THEN
        SELECT value
          INTO v_resource
          FROM jsonb_array_elements(v_dispatch_resources) AS value
         WHERE value->>'key' = v_key
         LIMIT 1;
        v_next_resources := v_next_resources || jsonb_build_array(v_resource);
      END IF;
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Register Dispatch route scan-out resources for canonical ui_list_resource_v1 reads',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202607031430_dispatch_route_scanout_ui_read_registry_v1'));

COMMIT;
