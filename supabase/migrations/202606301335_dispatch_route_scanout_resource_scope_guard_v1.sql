-- Migration: Dispatch route scan-out resource scope guard v1
-- Purpose:
--   - Fail closed when the dedicated route scan-out executor is invoked with a
--     resource key that does not match the command registry resource scope.
--   - Preserve the existing canonical scan ledger, reconciliation, and
--     departure confirmation delegation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606301335_dispatch_route_scanout_resource_scope_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_execute_route_run_scanout_v1(
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
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_action_key TEXT := NULLIF(btrim(COALESCE(p_action_key, '')), '');
  v_resource_key TEXT := NULLIF(btrim(COALESCE(p_resource_key, '')), '');
  v_expected_resource_key TEXT := NULL;
  v_command JSONB := NULL;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_id_text TEXT := NULL;
  v_route_run_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
  v_ops_session_id UUID := NULL;
  v_device_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_visible_route JSONB := NULL;
  v_route_run public.route_runs%ROWTYPE;
  v_route_stop public.route_stops%ROWTYPE;
  v_params JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
  v_barcode TEXT := NULL;
  v_notes TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_scan RECORD;
  v_departure JSONB := '{}'::jsonb;
  v_manifest JSONB := '{}'::jsonb;
  v_scan_out JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF v_action_key IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 requires action key';
  END IF;
  IF v_resource_key IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = v_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 unknown command %', v_action_key;
  END IF;

  IF COALESCE(v_command->>'schema_category', '') LIKE 'resource:%' THEN
    v_expected_resource_key := NULLIF(substring(v_command->>'schema_category' from length('resource:') + 1), '');
  END IF;
  IF v_expected_resource_key IS NOT NULL AND v_resource_key <> v_expected_resource_key THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 resource key % does not match command resource %',
      v_resource_key,
      v_expected_resource_key
      USING ERRCODE = '42501';
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
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
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 selection above maximum %', v_max;
  END IF;

  v_params := COALESCE(v_command #> '{execution,params}', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);
  IF jsonb_typeof(v_params) IS DISTINCT FROM 'object' THEN
    v_params := '{}'::jsonb;
  END IF;

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_route_run_id := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 invalid route_run id %', COALESCE(v_selection_id_text, '')
      USING ERRCODE = '23514';
  END IF;

  v_visible_route := public.ui_get_resource_v1(v_resource_key, v_route_run_id);
  IF v_visible_route IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 route_run % is not visible in resource %', v_route_run_id, v_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 route_run % not found', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  BEGIN v_route_stop_id := NULLIF(v_params->>'route_stop_id', '')::uuid; EXCEPTION WHEN others THEN v_route_stop_id := NULL; END;
  BEGIN v_task_id := NULLIF(v_params->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_ops_session_id := NULLIF(v_params->>'ops_session_id', '')::uuid; EXCEPTION WHEN others THEN v_ops_session_id := NULL; END;
  BEGIN v_device_id := NULLIF(v_params->>'device_id', '')::uuid; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_params->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;

  IF v_route_stop_id IS NOT NULL THEN
    SELECT *
      INTO v_route_stop
      FROM public.route_stops rs
     WHERE rs.id = v_route_stop_id
       AND rs.route_run_id = v_route_run_id
     LIMIT 1;
    IF v_route_stop.id IS NULL THEN
      RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 route_stop % is outside route_run %', v_route_stop_id, v_route_run_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_action_key = 'routes.scan_load' THEN
    v_barcode := NULLIF(btrim(COALESCE(v_params->>'barcode', '')), '');
    IF v_barcode IS NULL THEN
      RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 requires barcode'
        USING ERRCODE = '23514';
    END IF;

    v_notes := NULLIF(btrim(COALESCE(v_params->>'notes', '')), '');
    v_metadata := COALESCE(v_params->'metadata', '{}'::jsonb);
    IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
      v_metadata := '{}'::jsonb;
    END IF;
    v_metadata := public.jsonb_deep_merge(
      v_metadata,
      jsonb_strip_nulls(
        jsonb_build_object(
          'source', 'ui_execute_route_run_scanout_v1',
          'action_key', v_action_key,
          'resource_key', v_resource_key,
          'notes', v_notes
        )
      )
    );
    v_idempotency_key := NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), '');
    IF v_idempotency_key IS NULL THEN
      v_idempotency_key := format('route-load-ui:%s:%s', v_route_run_id, gen_random_uuid());
    END IF;

    SELECT *
      INTO v_scan
      FROM public.record_scan_event_v1(
        jsonb_strip_nulls(
          jsonb_build_object(
            'idempotency_key', v_idempotency_key,
            'device_id', v_device_id,
            'ops_session_id', v_ops_session_id,
            'route_run_id', v_route_run_id,
            'route_stop_id', v_route_stop_id,
            'branch_id', COALESCE(v_branch_id, v_route_run.branch_id),
            'scan_type', 'load',
            'barcode', v_barcode,
            'captured_at', NULLIF(v_params->>'captured_at', ''),
            'lat', NULLIF(v_params->>'lat', ''),
            'lng', NULLIF(v_params->>'lng', ''),
            'accuracy_m', NULLIF(v_params->>'accuracy_m', ''),
            'metadata', v_metadata
          )
        )
      )
     LIMIT 1;

    v_scan_out := COALESCE(public.route_run_scan_out_reconciliation_v1(v_route_run_id), '{}'::jsonb);
    v_manifest := COALESCE(public.ui_route_run_execution_manifest_v1(v_route_run_id), '{}'::jsonb);

    RETURN jsonb_build_object(
      'status', 'route_load_scan_recorded',
      'action_key', v_action_key,
      'resource_key', v_resource_key,
      'count', 1,
      'route_run_id', v_route_run_id,
      'route_stop_id', v_route_stop_id,
      'scan_event_id', v_scan.scan_event_id,
      'scan_created', v_scan.created,
      'scan_out', v_scan_out,
      'route_execution_manifest', v_manifest,
      'items', jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'route_run_id', v_route_run_id,
            'route_stop_id', v_route_stop_id,
            'scan_event_id', v_scan.scan_event_id,
            'scan_created', v_scan.created,
            'barcode', v_barcode,
            'scan_out', v_scan_out
          )
        )
      )
    );
  ELSIF v_action_key = 'routes.confirm_departure' THEN
    v_departure := COALESCE(
      public.ui_confirm_route_run_departure_v1(
        jsonb_strip_nulls(
          jsonb_build_object(
            'route_run_id', v_route_run_id,
            'route_stop_id', v_route_stop_id,
            'task_id', v_task_id,
            'ops_session_id', v_ops_session_id
          )
        )
      ),
      '{}'::jsonb
    );
    v_manifest := COALESCE(public.ui_route_run_execution_manifest_v1(v_route_run_id), '{}'::jsonb);

    RETURN jsonb_build_object(
      'status', 'route_departure_confirmed',
      'action_key', v_action_key,
      'resource_key', v_resource_key,
      'count', 1,
      'route_run_id', v_route_run_id,
      'route_stop_id', v_route_stop_id,
      'task_id', v_task_id,
      'scan_out', COALESCE(v_departure->'scan_out', v_manifest->'scan_out', '{}'::jsonb),
      'route_departure', COALESCE(v_departure->'route_departure', v_manifest->'route_departure', '{}'::jsonb),
      'route_execution_manifest', v_manifest,
      'items', jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'route_run_id', v_route_run_id,
            'route_stop_id', v_route_stop_id,
            'task_id', v_task_id,
            'departure', v_departure
          )
        )
      )
    );
  END IF;

  RAISE EXCEPTION 'ui_execute_route_run_scanout_v1 unsupported action key %', v_action_key;
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_run_scanout_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Dedicated registry-driven UI action executor for route-load scan-out and departure confirmation. Delegates to record_scan_event_v1, route_run_scan_out_reconciliation_v1, and ui_confirm_route_run_departure_v1 while enforcing the command registry resource scope.';

SELECT pg_advisory_unlock(hashtext('202606301335_dispatch_route_scanout_resource_scope_guard_v1'));
COMMIT;
