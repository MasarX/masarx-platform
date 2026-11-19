-- Migration: Console V2 shipment geocode refresh must recompute routing/promise
-- Purpose:
--   - Operator refresh-routing actions must not reuse an old completed
--     shipment-scoped geocode workflow after branch/zone mappings change.
--   - Keep the action workflow-engine-first and backend-backed by generating
--     explicit idempotency keys for both the UI action workflow and its nested
--     geocoding workflow.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605090900_console_v2_shipment_update_geocode_fresh_routing_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regprocedure('public.ui_execute_shipment_update_geocode_v1_base(text,text,text[],text,integer,jsonb)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION public.ui_execute_shipment_update_geocode_v1(text,text,text[],text,integer,jsonb)
             RENAME TO ui_execute_shipment_update_geocode_v1_base';
  END IF;
END $$;

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
  v_action_idempotency_key TEXT := NULL;
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
  v_action_idempotency_key := NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), '');
  IF v_action_idempotency_key IS NULL THEN
    v_action_idempotency_key := format('console-v2:shipment-update-geocode:%s', gen_random_uuid());
    v_params := jsonb_set(v_params, '{idempotency_key}', to_jsonb(v_action_idempotency_key), TRUE);
  END IF;

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
        'idempotency_key', v_action_idempotency_key,
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
    'idempotency_key', v_action_idempotency_key,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'shipment_id', v_shipment.id,
          'status', COALESCE(v_step.operation_result->>'status', v_step.workflow_status, v_progress->>'status', 'workflow_started'),
          'workflow_run_id', v_run_id,
          'address_id', v_address_id,
          'geocode_workflow_run_id', NULLIF(v_step.operation_result->>'geocode_workflow_run_id', '')::UUID,
          'geocode_workflow_status', NULLIF(v_step.operation_result->>'geocode_workflow_status', ''),
          'shipment_action_id', NULLIF(v_step.operation_result->>'shipment_action_id', '')::UUID
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) IS
  'Requeue geocoding for a visible shipment from Console/Portal with an explicit workflow idempotency key so each operator action can recompute branch/promise.';

REVOKE ALL ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_address_id UUID := NULL;
  v_template_name TEXT := COALESCE(NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard');
  v_template_id UUID;
  v_workflow_run_id UUID;
  v_nested_context JSONB := '{}'::jsonb;
  v_nested_progress JSONB := '{}'::jsonb;
  v_nested_status TEXT := NULL;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_nested_idempotency_key TEXT := NULL;
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;

  BEGIN
    v_address_id := COALESCE(NULLIF(v_ctx->>'address_id', '')::UUID, NULLIF(v_ctx->>'destination_address_id', '')::UUID);
  EXCEPTION
    WHEN others THEN
      v_address_id := NULL;
  END;

  IF v_address_id IS NULL THEN
    v_address_id := v_target.destination_address_id;
  END IF;

  IF v_address_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_id_missing';
    v_result.operation_result := jsonb_build_object('error', 'address_id_missing');
    RETURN v_result;
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'geocode_template_missing';
    v_result.operation_result := jsonb_build_object('error', 'geocode_template_missing', 'template_name', v_template_name);
    RETURN v_result;
  END IF;

  v_nested_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_ctx->>'geocode_idempotency_key', '')), ''),
    format('shipment-update-geocode:nested:%s:%s', p_run.id, v_address_id)
  );

  v_nested_context := jsonb_strip_nulls(jsonb_build_object(
    'idempotency_key', v_nested_idempotency_key,
    'organization_id', COALESCE(v_target.organization_id, NULLIF(v_ctx->>'organization_id', '')::UUID),
    'client_id', COALESCE(v_target.client_id, NULLIF(v_ctx->>'client_id', '')::UUID),
    'sender_id', COALESCE(v_target.sender_id, NULLIF(v_ctx->>'sender_id', '')::UUID),
    'shipment_id', v_target.shipment_id,
    'destination_address_id', v_address_id,
    'address_id', v_address_id,
    'actor_user_id', NULLIF(v_ctx->>'actor_user_id', ''),
    'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode'),
    'trigger_source', 'manual',
    'parent_workflow_run_id', p_run.id,
    'parent_workflow_step_id', p_step.id
  ));

  v_workflow_run_id := public.start_workflow_run(v_template_id, v_nested_context);

  v_nested_progress := public.progress_workflow_run_until_wait_v1(
    v_workflow_run_id,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_target.shipment_id,
      'client_id', v_target.client_id,
      'destination_address_id', v_address_id,
      'address_id', v_address_id,
      'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode')
    )),
    2500,
    20
  );

  SELECT wr.workflow_status
    INTO v_nested_status
    FROM public.workflow_runs wr
   WHERE wr.id = v_workflow_run_id;

  IF v_target.shipment_id IS NOT NULL THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_target.shipment_id,
      'geocode_request',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'idempotency_key', v_event_id,
        'address_id', v_address_id,
        'workflow_run_id', v_workflow_run_id,
        'workflow_status', v_nested_status,
        'nested_idempotency_key', v_nested_idempotency_key
      )),
      NULL::TEXT,
      NULL::TEXT,
      'workflow_handlers.execute_shipment_update_geocode_v1',
      NULL::UUID,
      NULL::timestamptz
    );
  END IF;

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'address_id', v_address_id,
    'geocode_workflow_run_id', v_workflow_run_id,
    'geocode_workflow_status', v_nested_status,
    'geocode_progress', v_nested_progress,
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Starts a fresh nested geocoding workflow for each operator shipment geocode refresh, progresses it inline, and records geocode_request lineage.';

DO $$
BEGIN
  IF to_regprocedure('workflow_handlers.execute_geo_local_lookup_v1_console_v2_cache_hit_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_local_lookup_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
             RENAME TO execute_geo_local_lookup_v1_console_v2_cache_hit_base';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_local_lookup_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_cache_geocode JSONB := COALESCE(
    v_context->'geocoding'->'selected_geocode',
    v_context->'geocoding'->'cache_geocode'
  );
  v_response public.workflow_handler_response;
BEGIN
  IF v_cache_geocode IS NOT NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'geocode_cache_hit_promoted'
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding',
      jsonb_strip_nulls(jsonb_build_object(
        'selected_geocode', v_cache_geocode,
        'successful', TRUE,
        'manual_review_required', FALSE,
        'require_fallback', FALSE,
        'local_lookup_skipped', TRUE
      ))
    );
    RETURN v_response;
  END IF;

  RETURN workflow_handlers.execute_geo_local_lookup_v1_console_v2_cache_hit_base(
    p_step,
    p_run,
    p_operation_result
  );
EXCEPTION
  WHEN unique_violation THEN
    v_cache_geocode := COALESCE(
      v_context->'geocoding'->'selected_geocode',
      v_context->'geocoding'->'cache_geocode'
    );
    IF v_cache_geocode IS NULL THEN
      RAISE;
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'geocode_cache_hit_promoted_after_attempt_conflict'
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding',
      jsonb_strip_nulls(jsonb_build_object(
        'selected_geocode', v_cache_geocode,
        'successful', TRUE,
        'manual_review_required', FALSE,
        'require_fallback', FALSE,
        'local_lookup_skipped', TRUE
      ))
    );
    RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_geo_local_lookup_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_local_lookup_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Console V2 cache-hit guard: promotes an existing primary geocode from workflow context instead of writing a duplicate local_lookup geocoding_attempt, then delegates to the canonical base handler when no cache exists.';

SELECT pg_advisory_unlock(hashtext('202605090900_console_v2_shipment_update_geocode_fresh_routing_v1'));
COMMIT;
