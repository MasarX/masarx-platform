-- Plan: Console V2 dispatch and warehouse recovery live wiring
-- Step: expose missing api-schema wrappers used by browser-bound Console V2.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605032020_console_v2_dispatch_warehouse_recovery_wiring_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.record_scan_event_v1(p_scan JSONB)
RETURNS TABLE (
  scan_event_id UUID,
  created BOOLEAN
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.record_scan_event_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.warehouse_transfer_execute_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.warehouse_transfer_execute_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.preview_dispatch_exception_resolution_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_mode TEXT := '';
  v_min INTEGER := 0;
  v_max INTEGER := NULL;
  v_params JSONB := COALESCE(p_params, '{}'::jsonb);
  v_ids TEXT[] := COALESCE(
    p_selection_ids,
    CASE
      WHEN p_selection_id IS NULL OR btrim(p_selection_id) = '' THEN ARRAY[]::TEXT[]
      ELSE ARRAY[p_selection_id]
    END
  );
  v_count INTEGER := COALESCE(p_selection_count, COALESCE(array_length(v_ids, 1), 0));
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_resolution_action TEXT := NULL;
  v_visible_task JSONB := NULL;
  v_preview JSONB := '{}'::jsonb;
  v_results JSONB := '[]'::jsonb;
  v_blocked_count INTEGER := 0;
  v_preview_count INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_params) IS DISTINCT FROM 'object' THEN
    v_params := '{}'::jsonb;
  END IF;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 requires action key';
  END IF;

  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 requires resource key';
  END IF;

  v_resolution_action := lower(NULLIF(btrim(COALESCE(
    v_params->>'resolution_action',
    v_params->>'ndr_action',
    ''
  )), ''));

  IF v_resolution_action IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 requires resolution_action';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 unknown command %', p_action_key;
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

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 selection above maximum %', v_max;
  END IF;

  FOREACH v_selection_id_text IN ARRAY v_ids LOOP
    BEGIN
      v_selection_uuid := NULLIF(btrim(v_selection_id_text), '')::uuid;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 invalid task id %', v_selection_id_text;
    END;

    IF v_selection_uuid IS NULL THEN
      CONTINUE;
    END IF;

    v_visible_task := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
    IF v_visible_task IS NULL THEN
      RAISE EXCEPTION
        'preview_dispatch_exception_resolution_v1 task % is not visible in resource %',
        v_selection_uuid,
        p_resource_key
        USING ERRCODE = '42501';
    END IF;

    v_preview := public.preview_dispatch_exception_resolution_v1(
      v_selection_uuid,
      v_resolution_action,
      v_params
    );

    IF COALESCE(v_preview->>'decision_status', '') = 'blocked' THEN
      v_blocked_count := v_blocked_count + 1;
    ELSE
      v_preview_count := v_preview_count + 1;
    END IF;

    v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_selection_uuid,
      'status', CASE
        WHEN COALESCE(v_preview->>'decision_status', '') = 'blocked' THEN 'blocked'
        ELSE 'preview'
      END,
      'preview', v_preview
    )));
  END LOOP;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 'preview',
    'count', COALESCE(jsonb_array_length(v_results), 0),
    'preview_count', v_preview_count,
    'blocked_count', v_blocked_count,
    'items', v_results
  ));
END;
$function$;

REVOKE ALL ON FUNCTION api.record_scan_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.record_scan_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.record_scan_event_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.warehouse_transfer_execute_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.warehouse_transfer_execute_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.warehouse_transfer_execute_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.preview_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.preview_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.preview_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION api.record_scan_event_v1(JSONB)
  IS 'API-schema browser wrapper for canonical scan-event intake.';
COMMENT ON FUNCTION api.warehouse_transfer_execute_v1(JSONB)
  IS 'API-schema browser wrapper for canonical warehouse transfer workflow execution.';
COMMENT ON FUNCTION api.preview_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Browser-safe preview wrapper for dispatch exception resolution; enforces command registry visibility and calls public.preview_dispatch_exception_resolution_v1 without applying state changes.';

SELECT pg_advisory_unlock(hashtext('202605032020_console_v2_dispatch_warehouse_recovery_wiring_v1'));

COMMIT;
