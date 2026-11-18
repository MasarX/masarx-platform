-- Migration: Require route-assignment projection and event-ledger readback before UI success.
--
-- The write remains canonical through assign_route_run_v1. This migration adds a
-- browser-safe, scope-checked read seam and configures the shared command runner
-- to poll that seam before routes.assign/routes.reassign can report success.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607141930_dispatch_route_assignment_event_readback_v1'));

CREATE OR REPLACE FUNCTION public.ui_route_run_assignment_readback_v1(
  p_route_run_id UUID,
  p_route_run_assignment_id UUID,
  p_assignment_version INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_route JSONB := NULL;
  v_assignment JSONB := NULL;
  v_event JSONB := NULL;
BEGIN
  IF p_route_run_id IS NULL
     OR p_route_run_assignment_id IS NULL
     OR p_assignment_version IS NULL
     OR p_assignment_version < 1 THEN
    RAISE EXCEPTION 'ui_route_run_assignment_readback_v1 requires a route, assignment, and positive version'
      USING ERRCODE = '23514';
  END IF;

  -- ui_get_resource_v1 applies the live ui_read_registry capability and scope
  -- contract, including driver-versus-operator route visibility.
  v_route := public.ui_get_resource_v1('routes', p_route_run_id);
  IF v_route IS NULL THEN
    RAISE EXCEPTION 'route % is not visible for assignment readback', p_route_run_id
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
           'id', a.id,
           'route_run_id', a.route_run_id,
           'assignment_status', a.assignment_status,
           'assignment_mode', a.assignment_mode,
           'assignment_version', a.assignment_version,
           'driver_user_id', a.driver_user_id,
           'vehicle_id', a.vehicle_id,
           'partner', a.partner,
           'assigned_at', a.assigned_at
         ))
    INTO v_assignment
    FROM public.route_run_assignments a
   WHERE a.id = p_route_run_assignment_id
     AND a.route_run_id = p_route_run_id
     AND a.assignment_version = p_assignment_version;

  SELECT jsonb_strip_nulls(jsonb_build_object(
           'id', e.id,
           'route_run_assignment_id', e.route_run_assignment_id,
           'route_run_id', e.route_run_id,
           'assignment_version', e.assignment_version,
           'event_type', e.event_type,
           'from_status', e.from_status,
           'to_status', e.to_status,
           'assignment_mode', e.assignment_mode,
           'driver_user_id', e.driver_user_id,
           'vehicle_id', e.vehicle_id,
           'partner', e.partner,
           'created_at', e.created_at
         ))
    INTO v_event
    FROM public.route_run_assignment_events e
   WHERE e.route_run_assignment_id = p_route_run_assignment_id
     AND e.route_run_id = p_route_run_id
     AND e.assignment_version = p_assignment_version
   LIMIT 1;

  RETURN jsonb_build_object(
    'visible', v_assignment IS NOT NULL AND v_event IS NOT NULL,
    'route', v_route,
    'assignment', v_assignment,
    'event', v_event
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER)
  IS 'Returns a scope-checked route assignment projection plus its exact append-only event ledger row for same-context UI confirmation.';

REVOKE ALL ON FUNCTION public.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_route_run_assignment_readback_v1(
  p_route_run_id UUID,
  p_route_run_assignment_id UUID,
  p_assignment_version INTEGER
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
  SELECT public.ui_route_run_assignment_readback_v1($1, $2, $3);
$function$;

COMMENT ON FUNCTION api.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER)
  IS 'Browser-safe API wrapper for exact route assignment projection and event-ledger readback.';

REVOKE ALL ON FUNCTION api.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER) TO authenticated, service_role;

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB := '{}'::jsonb;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_next JSONB := '{}'::jsonb;
  v_readback JSONB := jsonb_build_object(
    'rpc', 'ui_route_run_assignment_readback_v1',
    'params', jsonb_build_object(
      'p_route_run_id', jsonb_build_object(
        'source', 'result',
        'path', 'items.0.route_run_id'
      ),
      'p_route_run_assignment_id', jsonb_build_object(
        'source', 'result',
        'path', 'items.0.route_run_assignment_id'
      ),
      'p_assignment_version', jsonb_build_object(
        'source', 'result',
        'path', 'items.0.assignment_version'
      )
    ),
    'success_path', 'visible',
    'max_attempts', 4,
    'delay_ms', 150
  );
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
    WHERE s.category = 'ui_command_registry'
      AND sv.effective_until IS NULL
  LOOP
    v_current := COALESCE(v_setting.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN value->>'key' IN ('routes.assign', 'routes.reassign') THEN
          jsonb_set(value, '{execution,readback}', v_readback, TRUE)
        ELSE value
      END
      ORDER BY ordinal
    ), '[]'::jsonb)
      INTO v_next_commands
      FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS command(value, ordinal);

    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Require exact route assignment event readback before UI success',
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

SELECT pg_advisory_unlock(hashtext('202607141930_dispatch_route_assignment_event_readback_v1'));

COMMIT;
