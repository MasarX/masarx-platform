-- Migration: Console V2 fleet live projection contract
-- Purpose:
--   Align the live ui_read_registry relations with the exact row shapes used
--   by Console V2 fleet operator screens. These are read-only projection views;
--   mutations continue to route through the canonical fleet RPCs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051500_console_v2_fleet_live_projection_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_fleet_driver_options
  WITH (security_invoker = true)
AS
SELECT
  d.user_id AS id,
  d.id AS driver_profile_id,
  d.user_id,
  d.organization_id,
  d.user_full_name AS name,
  d.user_full_name,
  d.user_email,
  d.driver_code,
  d.status,
  d.current_vehicle_id AS vehicle_id,
  d.current_vehicle_id,
  d.current_branch_id,
  d.vehicle_label,
  d.branch_label,
  d.created_at,
  d.updated_at
FROM public.v_driver_directory d;

COMMENT ON VIEW public.v_fleet_driver_options IS
  'Console V2 vehicle assignment picker projection. id is the driver user id expected by assign_driver_to_vehicle_v1; driver_profile_id preserves profile lineage. SSOT remains driver_profiles/users/v_driver_directory.';

REVOKE ALL ON public.v_fleet_driver_options FROM PUBLIC;
REVOKE ALL ON public.v_fleet_driver_options FROM anon;
GRANT SELECT ON public.v_fleet_driver_options TO authenticated;
GRANT SELECT ON public.v_fleet_driver_options TO service_role;

-- Fleet screens display assigned driver labels without access to the user directory.
CREATE FUNCTION public.fleet_driver_display_name_v1(p_organization_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $identity$
  SELECT u.full_name
  FROM public.users u
  WHERE u.id = p_user_id
    AND u.organization_id = p_organization_id
    AND (
      EXISTS (
        SELECT 1 FROM public.driver_profiles d
        WHERE d.organization_id = u.organization_id AND d.user_id = u.id
      )
      OR EXISTS (
        SELECT 1 FROM public.vehicle_assignments va
        WHERE va.organization_id = u.organization_id AND va.assigned_to_user_id = u.id
      )
    )
    AND (SELECT public.user_has_capability_v1('fleet.read'))
    AND (
      (SELECT public.is_platform_user())
      OR (
        (SELECT public.current_user_scope_type()) = 'tenant'
        AND u.organization_id = (SELECT public.current_user_org_id())
        AND u.organization_id = (SELECT public.current_user_scope_id())
      )
    );
$identity$;
REVOKE ALL ON FUNCTION public.fleet_driver_display_name_v1(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fleet_driver_display_name_v1(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_vehicle_assignment_directory
  WITH (security_invoker = true)
AS
SELECT
  va.id,
  va.organization_id,
  va.vehicle_id,
  va.assigned_to_user_id,
  va.assigned_to_user_id AS driver_user_id,
  COALESCE(
    u.full_name,
    CASE WHEN u.id IS NULL THEN public.fleet_driver_display_name_v1(va.organization_id, va.assigned_to_user_id) END,
    'Unassigned driver'
  ) AS driver_name,
  va.branch_id,
  va.status,
  va.started_at,
  va.ended_at,
  va.metadata,
  va.created_at,
  va.updated_at
FROM public.vehicle_assignments va
LEFT JOIN public.users u ON u.id = va.assigned_to_user_id;

COMMENT ON VIEW public.v_vehicle_assignment_directory IS
  'Console V2 vehicle assignment history projection with driver_user_id compatibility alias and operator-facing driver_name. SSOT remains vehicle_assignments.';

REVOKE ALL ON public.v_vehicle_assignment_directory FROM PUBLIC;
REVOKE ALL ON public.v_vehicle_assignment_directory FROM anon;
GRANT SELECT ON public.v_vehicle_assignment_directory TO authenticated;
GRANT SELECT ON public.v_vehicle_assignment_directory TO service_role;

CREATE OR REPLACE VIEW public.v_vehicle_event_directory
  WITH (security_invoker = true)
AS
SELECT
  ve.id,
  ve.organization_id,
  ve.vehicle_id,
  ve.event_type,
  ve.occurred_at,
  ve.odometer_km,
  ve.fuel_liters,
  ve.cost_amount,
  ve.cost_currency,
  ve.actor_user_id,
  COALESCE(u.full_name, ve.actor_system, 'System') AS actor_name,
  ve.actor_system,
  ve.notes,
  ve.artifact_id,
  ve.metadata,
  ve.metadata AS payload,
  ve.created_at
FROM public.vehicle_events ve
LEFT JOIN public.users u ON u.id = ve.actor_user_id;

COMMENT ON VIEW public.v_vehicle_event_directory IS
  'Console V2 vehicle event projection with operator-facing actor_name and payload compatibility alias. SSOT remains vehicle_events.metadata.';

REVOKE ALL ON public.v_vehicle_event_directory FROM PUBLIC;
REVOKE ALL ON public.v_vehicle_event_directory FROM anon;
GRANT SELECT ON public.v_vehicle_event_directory TO authenticated;
GRANT SELECT ON public.v_vehicle_event_directory TO service_role;

CREATE OR REPLACE VIEW public.v_vehicle_type_directory
  WITH (security_invoker = true)
AS
SELECT
  vt.id,
  vt.organization_id,
  vt.key,
  vt.name,
  vt.is_active,
  NULLIF(vt.metadata->>'capacity_kg', '')::NUMERIC AS capacity_kg,
  NULLIF(vt.metadata->>'capacity_m3', '')::NUMERIC AS capacity_m3,
  NULLIF(vt.metadata->>'axles', '')::INTEGER AS axles,
  NULLIF(vt.metadata->>'max_speed_kph', '')::INTEGER AS max_speed_kph,
  vt.metadata->>'fuel_type' AS fuel_type,
  vt.metadata,
  vt.created_at,
  vt.updated_at
FROM public.vehicle_types vt;

COMMENT ON VIEW public.v_vehicle_type_directory IS
  'Console V2 vehicle type projection with top-level capacity/attribute fields resolved from vehicle_types.metadata. SSOT remains vehicle_types.';

REVOKE ALL ON public.v_vehicle_type_directory FROM PUBLIC;
REVOKE ALL ON public.v_vehicle_type_directory FROM anon;
GRANT SELECT ON public.v_vehicle_type_directory TO authenticated;
GRANT SELECT ON public.v_vehicle_type_directory TO service_role;

DO $do$
DECLARE
  v_required_keys TEXT[] := ARRAY[
    'drivers',
    'vehicle_assignments',
    'vehicle_events',
    'vehicle_types'
  ];
  v_contract_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'drivers',
      'relation', 'public.v_fleet_driver_options',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
        jsonb_build_object('key', 'vehicle_id', 'column', 'vehicle_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_assignments',
      'relation', 'public.v_vehicle_assignment_directory',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'started_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'vehicle_id', 'column', 'vehicle_id', 'op', 'eq'),
        jsonb_build_object('key', 'assigned_to_user_id', 'column', 'assigned_to_user_id', 'op', 'eq'),
        jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_events',
      'relation', 'public.v_vehicle_event_directory',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'capability_write', 'fleet.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'vehicle_id', 'column', 'vehicle_id', 'op', 'eq'),
        jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'vehicle_types',
      'relation', 'public.v_vehicle_type_directory',
      'id_column', 'id',
      'capability_read', 'fleet.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'key', 'column', 'key', 'op', 'ilike'),
        jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq')
      )
    )
  );
  v_row RECORD;
  v_filtered JSONB;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
  LOOP
    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_row.cached_value->'resources', '[]'::jsonb))
        WITH ORDINALITY AS resource(value, ordinality)
     WHERE NOT (resource.value->>'key' = ANY(v_required_keys));

    v_next := jsonb_set(
      v_row.cached_value,
      '{resources}',
      v_filtered || v_contract_resources,
      TRUE
    );

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now(),
           change_reason = 'Align Console V2 fleet live resource projection contracts'
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.setting_id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605051500_console_v2_fleet_live_projection_contract_v1'));

COMMIT;
