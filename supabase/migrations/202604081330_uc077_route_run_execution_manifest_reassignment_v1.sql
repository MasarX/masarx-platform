-- Plan: PLAN-202604-b06-route-run-execution-manifest / Step: E01
-- Migration: UC077 route run execution manifest + reassignment normalization v1
-- Date: 2026-04-08
--
-- Goals:
--   - Expose a browser-safe route-run execution manifest + stop list over the existing route_run SSOT.
--   - Prefer the authoritative route_run_assignments projection over the copied route_runs metadata payload.
--   - Normalize reassignment as an explicit audit/event shape without forking route assignment truth.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604081330_uc077_route_run_execution_manifest_reassignment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical assignment projection helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_assignment_projection_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_assignment public.route_run_assignments%ROWTYPE;
BEGIN
  IF p_route_run_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_assignment
    FROM public.route_run_assignments rra
   WHERE rra.route_run_id = p_route_run_id
   LIMIT 1;

  IF v_assignment.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_assignment_id', v_assignment.id,
      'assignment_status', v_assignment.assignment_status,
      'assignment_mode', v_assignment.assignment_mode,
      'assignment_version', v_assignment.assignment_version,
      'driver_user_id', v_assignment.driver_user_id,
      'vehicle_id', v_assignment.vehicle_id,
      'partner', v_assignment.partner,
      'assigned_by_user_id', v_assignment.assigned_by_user_id,
      'assigned_at', v_assignment.assigned_at,
      'notes', v_assignment.notes,
      'metadata', NULLIF(v_assignment.metadata, '{}'::jsonb),
      'responded_by_user_id', v_assignment.responded_by_user_id,
      'acknowledged_at', v_assignment.acknowledged_at,
      'accepted_at', v_assignment.accepted_at,
      'refused_at', v_assignment.refused_at,
      'refusal_reason', v_assignment.refusal_reason,
      'response_notes', v_assignment.response_notes,
      'response_metadata', NULLIF(v_assignment.response_metadata, '{}'::jsonb)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_assignment_projection_v1(UUID)
  IS 'Canonical JSON projection of the current route_run assignment state from route_run_assignments.';

REVOKE ALL ON FUNCTION public.route_run_assignment_projection_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_assignment_projection_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_assignment_projection_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_assignment_projection_v1(UUID) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Route-run execution manifest + stop list
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_execution_manifest_build_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_route_run public.route_runs%ROWTYPE;
  v_assignment JSONB := '{}'::jsonb;
  v_route_plan_pack JSONB := NULL;
  v_stops JSONB := '[]'::jsonb;
  v_stop_count INT := 0;
  v_completed_stop_count INT := 0;
  v_open_stop_task_count INT := 0;
  v_manifest_core JSONB := '{}'::jsonb;
BEGIN
  IF p_route_run_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = p_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_assignment := COALESCE(public.route_run_assignment_projection_v1(v_route_run.id), '{}'::jsonb);

  IF v_route_run.route_plan_id IS NOT NULL THEN
    v_route_plan_pack := public.route_plan_execution_pack_v1(v_route_run.route_plan_id);
  END IF;

  SELECT
    COALESCE(jsonb_agg(item.stop_payload ORDER BY item.sequence_order, item.route_stop_created_at, item.route_stop_id), '[]'::jsonb),
    COUNT(*)::INT,
    COUNT(*) FILTER (
      WHERE item.shipment_action IS NOT NULL
         OR item.task_status = 'completed'
         OR v_route_run.status = 'completed'
    )::INT,
    COUNT(*) FILTER (
      WHERE item.task_status IS NULL OR item.task_status NOT IN ('completed', 'canceled')
    )::INT
    INTO v_stops,
         v_stop_count,
         v_completed_stop_count,
         v_open_stop_task_count
    FROM (
      SELECT
        rs.id AS route_stop_id,
        rs.sequence_order,
        rs.created_at AS route_stop_created_at,
        NULLIF(btrim(COALESCE(rs.metadata->>'shipment_action', '')), '') AS shipment_action,
        COALESCE(t.status, '') AS task_status,
        jsonb_strip_nulls(
          jsonb_build_object(
            'route_stop_id', rs.id,
            'sequence_order', rs.sequence_order,
            'stop_kind', rs.stop_kind,
            'planned_window_start_at', rs.planned_window_start_at,
            'planned_window_end_at', rs.planned_window_end_at,
            'shipment_id', rs.shipment_id,
            'client_id', rs.client_id,
            'shipment_tracking_number', s.tracking_number,
            'shipment_status', s.status,
            'route_stop_metadata', NULLIF(rs.metadata, '{}'::jsonb),
            'task',
              CASE
                WHEN t.id IS NULL THEN NULL
                ELSE jsonb_strip_nulls(
                  jsonb_build_object(
                    'task_id', t.id,
                    'status', t.status,
                    'assigned_to', t.assigned_to,
                    'workflow_run_id', t.workflow_run_id
                  )
                )
              END
          )
        ) AS stop_payload
      FROM public.route_stops rs
      JOIN public.shipments s
        ON s.id = rs.shipment_id
       AND s.client_id = rs.client_id
      LEFT JOIN LATERAL (
        SELECT
          t.id,
          t.status,
          t.assigned_to,
          t.workflow_run_id
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.resource_type = 'route_stop'
         AND t.resource_id = rs.id
         AND tt.organization_id = v_route_run.organization_id
         AND tt.key = 'route_stop_execute'
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1
      ) t ON TRUE
      WHERE rs.route_run_id = v_route_run.id
    ) AS item;

  v_manifest_core := jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_route_run.id,
      'organization_id', v_route_run.organization_id,
      'branch_id', v_route_run.branch_id,
      'route_plan_id', v_route_run.route_plan_id,
      'planned_date', v_route_run.planned_date,
      'route_run_status', v_route_run.status,
      'started_at', v_route_run.started_at,
      'ended_at', v_route_run.ended_at,
      'driver_user_id', v_route_run.driver_user_id,
      'vehicle_id', v_route_run.vehicle_id,
      'route_plan_execution_pack_hash', NULLIF(COALESCE(v_route_run.metadata->>'route_plan_execution_pack_hash', ''), ''),
      'route_assignment', NULLIF(v_assignment, '{}'::jsonb),
      'published_execution_pack_hash', NULLIF(COALESCE(v_route_plan_pack->>'execution_pack_hash', ''), ''),
      'stop_count', v_stop_count,
      'completed_stop_count', v_completed_stop_count,
      'open_stop_task_count', v_open_stop_task_count,
      'stops', v_stops,
      'source', jsonb_strip_nulls(
        jsonb_build_object(
          'resource', 'route_runs',
          'route_plan_id', v_route_run.route_plan_id,
          'route_plan_execution_pack_hash', NULLIF(COALESCE(v_route_run.metadata->>'route_plan_execution_pack_hash', ''), ''),
          'route_run_assignment_id', NULLIF(v_assignment->>'route_run_assignment_id', '')
        )
      )
    )
  );

  RETURN jsonb_set(
    v_manifest_core,
    '{manifest_hash}',
    to_jsonb(public.route_plan_execution_pack_hash_v1(v_manifest_core)),
    TRUE
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_execution_manifest_build_v1(UUID)
  IS 'Canonical route_run execution-manifest builder with stop list + current assignment overlay for executor surfaces.';

REVOKE ALL ON FUNCTION public.route_run_execution_manifest_build_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_execution_manifest_build_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_execution_manifest_build_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_execution_manifest_build_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.route_run_execution_manifest_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.route_run_execution_manifest_build_v1($1);
$function$;

COMMENT ON FUNCTION public.route_run_execution_manifest_v1(UUID)
  IS 'Service read-path for the canonical route_run execution manifest.';

REVOKE ALL ON FUNCTION public.route_run_execution_manifest_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_execution_manifest_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_execution_manifest_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_execution_manifest_v1(UUID) TO service_role;

-------------------------------------------------------------------------------
-- 3) Browser-safe route visibility + manifest RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_route_run_visible_v1(
  p_route_run_id UUID,
  p_action TEXT DEFAULT 'read'
)
RETURNS public.route_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_route_run public.route_runs%ROWTYPE;
BEGIN
  IF p_route_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_route_run_visible_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_ctx
    FROM public.ui_route_run_actor_context_v1(p_action)
   LIMIT 1;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = p_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'route_run % not found', p_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_ctx.is_platform AND v_route_run.organization_id IS DISTINCT FROM v_ctx.organization_id THEN
    RAISE EXCEPTION 'route_run % is outside the current organization', p_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.route_run_actor_can_read_v1(
    v_route_run.organization_id,
    v_route_run.id,
    v_route_run.driver_user_id
  ) THEN
    RAISE EXCEPTION 'route_run % is not visible to the current actor', p_route_run_id
      USING ERRCODE = '42501';
  END IF;

  RETURN v_route_run;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_route_run_visible_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_run_visible_v1(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.ui_route_run_visible_v1(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_route_run_visible_v1(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_route_run_execution_manifest_v1(
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

  RETURN public.route_run_execution_manifest_build_v1(v_route_run.id);
END;
$function$;

COMMENT ON FUNCTION public.ui_route_run_execution_manifest_v1(UUID)
  IS 'Authenticated UI read-path for the canonical route_run execution manifest.';

REVOKE ALL ON FUNCTION public.ui_route_run_execution_manifest_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_run_execution_manifest_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_route_run_execution_manifest_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_route_run_execution_manifest_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_route_run_execution_manifest_v1($1);
$function$;

REVOKE ALL ON FUNCTION api.ui_route_run_execution_manifest_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_route_run_execution_manifest_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_route_run_execution_manifest_v1(UUID) TO authenticated, service_role;

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
    public.route_run_assignment_projection_v1(rr.id),
    COALESCE(rr.route_assignment, '{}'::jsonb)
  ) AS route_assignment,
  public.route_run_execution_manifest_build_v1(rr.id) AS route_execution_manifest
FROM public.route_runs_visible_v1 rr;

REVOKE ALL ON api.route_runs FROM PUBLIC;
REVOKE ALL ON api.route_runs FROM anon;
GRANT SELECT ON api.route_runs TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Reassignment normalization at the DB edge
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_assignments_capture_reassignment_metadata_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_executor_changed BOOLEAN := FALSE;
  v_previous_assignment JSONB := NULL;
BEGIN
  IF NEW.metadata IS NULL OR jsonb_typeof(NEW.metadata) IS DISTINCT FROM 'object' THEN
    NEW.metadata := '{}'::jsonb;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  v_executor_changed :=
    OLD.assignment_mode IS DISTINCT FROM NEW.assignment_mode
    OR OLD.driver_user_id IS DISTINCT FROM NEW.driver_user_id
    OR OLD.vehicle_id IS DISTINCT FROM NEW.vehicle_id
    OR COALESCE(OLD.partner, '{}'::jsonb) IS DISTINCT FROM COALESCE(NEW.partner, '{}'::jsonb);

  IF NOT v_executor_changed THEN
    RETURN NEW;
  END IF;

  v_previous_assignment := jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_assignment_id', OLD.id,
      'assignment_status', OLD.assignment_status,
      'assignment_mode', OLD.assignment_mode,
      'assignment_version', OLD.assignment_version,
      'driver_user_id', OLD.driver_user_id,
      'vehicle_id', OLD.vehicle_id,
      'partner', OLD.partner,
      'assigned_by_user_id', OLD.assigned_by_user_id,
      'assigned_at', OLD.assigned_at,
      'notes', OLD.notes,
      'metadata', NULLIF(COALESCE(OLD.metadata, '{}'::jsonb) - 'previous_assignment', '{}'::jsonb),
      'responded_by_user_id', OLD.responded_by_user_id,
      'acknowledged_at', OLD.acknowledged_at,
      'accepted_at', OLD.accepted_at,
      'refused_at', OLD.refused_at,
      'refusal_reason', OLD.refusal_reason,
      'response_notes', OLD.response_notes,
      'response_metadata', NULLIF(OLD.response_metadata, '{}'::jsonb)
    )
  );

  NEW.metadata := jsonb_strip_nulls(
    COALESCE(NEW.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'previous_assignment', v_previous_assignment
    )
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_run_assignments_capture_reassignment_metadata ON public.route_run_assignments;
CREATE TRIGGER trg_route_run_assignments_capture_reassignment_metadata
  BEFORE INSERT OR UPDATE ON public.route_run_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.route_run_assignments_capture_reassignment_metadata_v1();

CREATE OR REPLACE FUNCTION public.route_run_assignment_events_normalize_reassignment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_assignment public.route_run_assignments%ROWTYPE;
  v_previous_assignment JSONB := NULL;
  v_reassignment_reason TEXT := NULL;
BEGIN
  IF NEW.payload IS NULL OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN
    NEW.payload := '{}'::jsonb;
  END IF;

  IF NEW.event_type <> 'assigned' OR COALESCE(NEW.assignment_version, 0) <= 1 OR NEW.to_status <> 'assigned' THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_assignment
    FROM public.route_run_assignments rra
   WHERE rra.id = NEW.route_run_assignment_id
   LIMIT 1;

  IF v_assignment.id IS NULL THEN
    RETURN NEW;
  END IF;

  v_previous_assignment := v_assignment.metadata->'previous_assignment';
  v_reassignment_reason := NULLIF(btrim(COALESCE(v_assignment.metadata->>'reassignment_reason', '')), '');

  NEW.event_type := 'reassigned';
  NEW.payload := jsonb_strip_nulls(
    COALESCE(NEW.payload, '{}'::jsonb)
    || jsonb_build_object(
      'previous_assignment', v_previous_assignment,
      'reassignment_reason', v_reassignment_reason
    )
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_run_assignment_events_normalize_reassignment ON public.route_run_assignment_events;
CREATE TRIGGER trg_route_run_assignment_events_normalize_reassignment
  BEFORE INSERT ON public.route_run_assignment_events
  FOR EACH ROW
  EXECUTE FUNCTION public.route_run_assignment_events_normalize_reassignment_v1();

-------------------------------------------------------------------------------
-- 5) UI executor + command-registry alias for reassignment
-------------------------------------------------------------------------------

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
  v_partner JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
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
  IS 'Dedicated UI command executor for route assignment and reassignment. Keeps route assignment off the generic ui_execute_command_v1 path while preserving the standard bulk-action payload contract.';

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

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_commands := (
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      FROM jsonb_array_elements(v_commands) AS value
      WHERE value->>'key' NOT IN ('routes.assign', 'routes.reassign')
    );

    v_commands := v_commands || jsonb_build_array(
      jsonb_build_object(
        'key', 'routes.assign',
        'label', 'Assign route',
        'schema_category', 'resource:routes',
        'capability', 'routes.write',
        'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
        'execution', jsonb_build_object(
          'type', 'rpc',
          'rpc', 'ui_execute_route_run_assign_v1'
        ),
        'input_schema', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'driver_user_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'vehicle_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'partner_id', jsonb_build_object('type', 'string'),
            'partner_name', jsonb_build_object('type', 'string'),
            'notes', jsonb_build_object('type', 'string'),
            'reassignment_reason', jsonb_build_object('type', 'string')
          )
        )
      ),
      jsonb_build_object(
        'key', 'routes.reassign',
        'label', 'Reassign route',
        'schema_category', 'resource:routes',
        'capability', 'routes.write',
        'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
        'execution', jsonb_build_object(
          'type', 'rpc',
          'rpc', 'ui_execute_route_run_assign_v1'
        ),
        'input_schema', jsonb_build_object(
          'type', 'object',
          'required', jsonb_build_array('reassignment_reason'),
          'properties', jsonb_build_object(
            'driver_user_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'vehicle_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'partner_id', jsonb_build_object('type', 'string'),
            'partner_name', jsonb_build_object('type', 'string'),
            'notes', jsonb_build_object('type', 'string'),
            'reassignment_reason', jsonb_build_object('type', 'string', 'minLength', 1)
          )
        )
      )
    );

    v_next := jsonb_set(v_current, '{commands}', v_commands, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.id;
  END LOOP;
END;
$do$;

COMMIT;
