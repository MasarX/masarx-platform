-- Plan: UC223 shipment requeue geocode command / Step: E01
-- Purpose: Add a dedicated guarded shipment geocode requeue RPC and registry command.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604081845_uc223_shipment_update_geocode_command_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-------------------------------------------------------------------------------
-- 1) Dedicated shipment geocode requeue RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_shipment_update_geocode_v1(
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
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(btrim(COALESCE(p_selection_id, '')), '');
  v_count INTEGER := 0;
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_visible_shipment JSONB := NULL;
  v_shipment RECORD;
  v_template_name TEXT := 'shipment_update_geocode_v1';
  v_template_id UUID := NULL;
  v_actor_system TEXT := 'shipment_update_geocode';
  v_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_workflow_status TEXT := NULL;
  v_step_status TEXT := NULL;
  v_inline_attempts INT := 0;
  v_inline_max_attempts INT := 6;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_explicit_input JSONB := '{}'::jsonb;
  v_step RECORD;
  v_address_id UUID := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 unknown command %', p_action_key;
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
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);
  v_template_name := COALESCE(NULLIF(btrim(COALESCE(v_params->>'workflow_template_name', '')), ''), v_template_name);
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_params->>'actor_system', '')), ''), v_actor_system);

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_selection_uuid := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_selection_uuid := NULL;
  END;

  IF v_selection_uuid IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 invalid shipment id %', v_selection_id_text;
  END IF;

  v_visible_shipment := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_shipment IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 shipment % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.destination_address_id
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = v_selection_uuid
  LIMIT 1
  FOR UPDATE;

  IF v_shipment.id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 shipment % not found', v_selection_uuid
      USING ERRCODE = '23503';
  END IF;

  BEGIN
    v_address_id := COALESCE(
      NULLIF(v_params->>'address_id', '')::UUID,
      NULLIF(v_params->>'destination_address_id', '')::UUID,
      v_shipment.destination_address_id
    );
  EXCEPTION
    WHEN others THEN
      v_address_id := v_shipment.destination_address_id;
  END;

  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = v_template_name
     AND wt.status = 'active'
   ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_update_geocode_v1 workflow template not found %', v_template_name
      USING ERRCODE = '23503';
  END IF;

  v_run_id := public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_shipment.organization_id,
        'client_id', v_shipment.client_id,
        'sender_id', v_shipment.sender_id,
        'shipment_id', v_shipment.id,
        'destination_address_id', v_address_id,
        'actor_user_id', v_user_id,
        'actor_system', v_actor_system,
        'payload', v_params
      )
    )
  );

  v_inline_explicit_input := jsonb_strip_nulls(
    jsonb_build_object(
      'shipment_id', v_shipment.id,
      'client_id', v_shipment.client_id,
      'destination_address_id', v_address_id,
      'address_id', v_address_id,
      'actor_user_id', v_user_id,
      'actor_system', v_actor_system
    )
  );

  WHILE v_inline_attempts < v_inline_max_attempts LOOP
    IF v_inline_attempts = 0 THEN
      v_progress := public.progress_workflow_run(v_run_id, v_inline_explicit_input);
    ELSE
      v_progress := public.progress_workflow_run(v_run_id);
    END IF;

    v_inline_attempts := v_inline_attempts + 1;
    v_step_status := lower(NULLIF(v_progress->>'status', ''));

    BEGIN
      v_inline_next_run_at := NULLIF(v_progress->>'next_run_at', '')::TIMESTAMPTZ;
    EXCEPTION
      WHEN others THEN
        v_inline_next_run_at := NULL;
    END;

    SELECT wr.workflow_status
      INTO v_workflow_status
      FROM public.workflow_runs wr
     WHERE wr.id = v_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'cancelled', 'blocked', 'waiting');
    EXIT WHEN v_step_status IN ('failed', 'cancelled', 'blocked', 'waiting');
    EXIT WHEN v_inline_next_run_at IS NOT NULL AND v_inline_next_run_at > now();
  END LOOP;

  SELECT
    wr.workflow_status,
    wr.last_error,
    wts.operation_result,
    wts.last_error AS step_last_error
  INTO v_step
  FROM public.workflow_runs wr
  LEFT JOIN public.workflow_run_steps wts
    ON wts.workflow_run_id = wr.id
  WHERE wr.id = v_run_id
  ORDER BY wts.sequence_order DESC NULLS LAST
  LIMIT 1;

  RETURN jsonb_build_object(
    'status', COALESCE(v_step.operation_result->>'status', v_step.workflow_status, v_progress->>'status', 'workflow_started'),
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'workflow_run_id', v_run_id,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'shipment_id', v_shipment.id,
          'status', COALESCE(v_step.operation_result->>'status', v_step.workflow_status, v_progress->>'status', 'workflow_started'),
          'workflow_run_id', v_run_id,
          'address_id', v_address_id,
          'shipment_action_id', NULLIF(v_step.operation_result->>'shipment_action_id', '')::UUID
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) IS
  'Requeue geocoding for a visible shipment from Console/Portal without widening ui_execute_command_v1.';

REVOKE ALL ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_shipment_update_geocode_v1(
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
AS $fn$
  SELECT public.ui_execute_shipment_update_geocode_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) ui_command_registry: shipments.update_geocode
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
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

    v_next_commands := '[]'::jsonb;

    FOR v_command IN
      SELECT item.value
      FROM jsonb_array_elements(v_commands) AS item(value)
    LOOP
      v_command_key := NULLIF(v_command->>'key', '');
      IF v_command_key = 'shipments.update_geocode' THEN
        v_command := jsonb_build_object(
          'key', 'shipments.update_geocode',
          'label', 'Requeue geocode',
          'description', 'Requeue geocoding for the selected shipment.',
          'capability', 'shipments.write',
          'schema_category', 'resource:shipments',
          'workflow_key', 'shipment_update_geocode_v1',
          'selection', jsonb_build_object(
            'mode', 'single',
            'min_count', 1,
            'max_count', 1,
            'id_param', 'id'
          ),
          'execution', jsonb_build_object(
            'type', 'rpc',
            'rpc', 'ui_execute_shipment_update_geocode_v1',
            'params', jsonb_build_object(
              'workflow_template_name', 'shipment_update_geocode_v1'
            ),
            'confirm', jsonb_build_object(
              'title', 'Requeue geocode?',
              'description', 'This requeues geocoding using the shipment''s current address metadata.',
              'confirm_label', 'Requeue geocode',
              'cancel_label', 'Cancel',
              'tone', 'default'
            )
          )
        );
      END IF;

      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item(value)
      WHERE item.value->>'key' = 'shipments.update_geocode'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(
        jsonb_build_object(
          'key', 'shipments.update_geocode',
          'label', 'Requeue geocode',
          'description', 'Requeue geocoding for the selected shipment.',
          'capability', 'shipments.write',
          'schema_category', 'resource:shipments',
          'workflow_key', 'shipment_update_geocode_v1',
          'selection', jsonb_build_object(
            'mode', 'single',
            'min_count', 1,
            'max_count', 1,
            'id_param', 'id'
          ),
          'execution', jsonb_build_object(
            'type', 'rpc',
            'rpc', 'ui_execute_shipment_update_geocode_v1',
            'params', jsonb_build_object(
              'workflow_template_name', 'shipment_update_geocode_v1'
            ),
            'confirm', jsonb_build_object(
              'title', 'Requeue geocode?',
              'description', 'This requeues geocoding using the shipment''s current address metadata.',
              'confirm_label', 'Requeue geocode',
              'cancel_label', 'Cancel',
              'tone', 'default'
            )
          )
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    IF v_next IS NOT DISTINCT FROM v_current THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_row.version + 1,
           change_reason = 'Add shipments.update_geocode command',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.settings_id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604081845_uc223_shipment_update_geocode_command_v1'));
COMMIT;
