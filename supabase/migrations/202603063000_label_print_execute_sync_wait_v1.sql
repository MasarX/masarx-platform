-- Migration: label print execute deferred sync-wait optimization
-- Purpose:
--   - Reduce shipments label print latency by allowing the workflow execute step to wait directly on the renderer result.
--   - Keep workflow as the audit envelope while avoiding the extra async handoff when the renderer can finish within a bounded wait window.
--   - Keep the initial command path responsive by deferring the first sync-wait attempt to the follow-up workflow/status progression.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063000_label_print_execute_sync_wait_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout TO '30s';

UPDATE public.schema_registry
SET schema = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(schema, '{}'::jsonb),
          '{properties,execute_dispatch_mode}',
          jsonb_build_object('type', 'string', 'enum', jsonb_build_array('async', 'sync_wait')),
          true
        ),
        '{properties,execute_wait_seconds}',
        jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 60),
        true
      ),
      '{properties,execute_initial_defer_ms}',
      jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 5000),
      true
    ),
    updated_at = now()
WHERE category = 'label_print_policy';

WITH current_global AS (
  SELECT settings_version_id
  FROM public.settings
  WHERE category = 'label_print_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY last_updated DESC
  LIMIT 1
),
updated_version AS (
  UPDATE public.settings_versions sv
  SET value = jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(sv.value, '{}'::jsonb),
            '{execute_dispatch_mode}',
            COALESCE(sv.value->'execute_dispatch_mode', to_jsonb('sync_wait'::text)),
            true
          ),
          '{execute_wait_seconds}',
          COALESCE(sv.value->'execute_wait_seconds', to_jsonb(12)),
          true
        ),
        '{execute_initial_defer_ms}',
        COALESCE(sv.value->'execute_initial_defer_ms', to_jsonb(250)),
        true
      ),
      change_reason = 'Add deferred sync-wait execute controls for label print workflow latency reduction',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  FROM current_global cg
  WHERE sv.id = cg.settings_version_id
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = uv.value,
    last_updated = workflow_now()
FROM updated_version uv
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND s.settings_version_id = uv.id;

CREATE OR REPLACE FUNCTION public.dispatch_api_request_wait_v1(
  p_url TEXT,
  p_method TEXT DEFAULT 'POST',
  p_headers JSONB DEFAULT '{}'::jsonb,
  p_body JSONB DEFAULT '{}'::jsonb,
  p_timeout_seconds INT DEFAULT NULL,
  p_wait_seconds INT DEFAULT NULL,
  p_poll_ms INT DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_start_time TIMESTAMPTZ := clock_timestamp();
  v_timeout_seconds INT := GREATEST(COALESCE(p_timeout_seconds, 30), 1);
  v_wait_seconds INT := GREATEST(COALESCE(p_wait_seconds, GREATEST(COALESCE(p_timeout_seconds, 30), 1)), 1);
  v_poll_ms INT := LEAST(GREATEST(COALESCE(p_poll_ms, 100), 25), 5000);
  v_deadline TIMESTAMPTZ := clock_timestamp() + make_interval(secs => v_wait_seconds);
  v_request_id BIGINT;
  v_check JSONB := '{}'::jsonb;
  v_completed BOOLEAN := FALSE;
  v_status INT := 202;
  v_headers JSONB := '{}'::jsonb;
  v_body JSONB := '{}'::jsonb;
  v_iterations INT := 0;
  v_status_text TEXT := '';
BEGIN
  v_request_id := public.dispatch_api_request_v1(
    p_url,
    p_method,
    COALESCE(p_headers, '{}'::jsonb),
    COALESCE(p_body, '{}'::jsonb),
    v_timeout_seconds
  );

  LOOP
    BEGIN
      v_check := COALESCE(public.check_async_response(v_request_id), '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      v_check := '{}'::jsonb;
    END;

    v_completed := COALESCE((v_check->>'completed')::BOOLEAN, FALSE);
    EXIT WHEN v_completed;
    EXIT WHEN clock_timestamp() >= v_deadline;

    PERFORM pg_sleep(v_poll_ms::NUMERIC / 1000.0);
    v_iterations := v_iterations + 1;
  END LOOP;

  IF v_completed THEN
    v_status_text := COALESCE(NULLIF(v_check->>'status', ''), '');
    IF v_status_text ~ '^\d+$' THEN
      v_status := v_status_text::INT;
    END IF;
    v_headers := COALESCE(v_check->'headers', '{}'::jsonb);
    v_body := COALESCE(v_check->'body', '{}'::jsonb);

    RETURN jsonb_build_object(
      'status', v_status,
      'headers', v_headers,
      'body', v_body,
      'completed', TRUE,
      'request_id', v_request_id,
      'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
      'poll_iterations', v_iterations + 1,
      'wait_seconds', v_wait_seconds,
      'wait_poll_ms', v_poll_ms,
      'wait_poll_iterations', v_iterations + 1
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 202,
    'headers', '{}'::jsonb,
    'body', jsonb_build_object(
      'message', 'HTTP request accepted - response pending',
      'request_id', v_request_id,
      'poll_sql', format('SELECT * FROM check_async_response(%s);', v_request_id),
      'note', 'Call check_async_response(request_id) or query net._http_response for completion'
    ),
    'completed', FALSE,
    'request_id', v_request_id,
    'latency_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000)::INT,
    'poll_iterations', v_iterations,
    'wait_seconds', v_wait_seconds,
    'wait_poll_ms', v_poll_ms,
    'wait_poll_iterations', v_iterations
  );
END;
$$;

COMMENT ON FUNCTION public.dispatch_api_request_wait_v1(TEXT, TEXT, JSONB, JSONB, INT, INT, INT)
  IS 'Direct pg_net dispatch + bounded wait helper that reuses dispatch_api_request_v1/check_async_response without edge-dispatch indirection.';

REVOKE ALL ON FUNCTION public.dispatch_api_request_wait_v1(TEXT, TEXT, JSONB, JSONB, INT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_api_request_wait_v1(TEXT, TEXT, JSONB, JSONB, INT, INT, INT) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.dispatch_api_request_wait_v1(TEXT, TEXT, JSONB, JSONB, INT, INT, INT) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer_print_sync_v1(
  p_workflow_run_id uuid,
  p_workflow_run_step_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_print_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_org_id uuid := NULL;
  v_workflow_progress_enabled boolean := true;
  v_workflow_progress_budget_ms int := 1200;
  v_workflow_progress_max_steps int := 10;
  v_execute_dispatch_mode text := 'async';
  v_execute_wait_seconds int := 12;
  v_execute_wait_poll_ms int := 100;
  v_provider jsonb;
  v_headers jsonb;
  v_request_body jsonb;
  v_request_id bigint;
  v_response jsonb := '{}'::jsonb;
  v_enabled_text text := '';
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires workflow_run_id';
  END IF;
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires workflow_run_step_id';
  END IF;
  IF jsonb_typeof(v_print_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires object payload';
  END IF;

  IF jsonb_typeof(v_print_payload->'print') = 'object' THEN
    v_print_payload := v_print_payload->'print';
  END IF;

  v_org_id := COALESCE(
    NULLIF(v_print_payload->>'organization_id', '')::uuid,
    NULLIF(p_payload->>'organization_id', '')::uuid
  );
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires organization_id in payload';
  END IF;

  v_enabled_text := lower(COALESCE(NULLIF(v_print_payload->>'workflow_progress_enabled', ''), 'true'));
  v_workflow_progress_enabled := v_enabled_text IN ('1', 't', 'true', 'y', 'yes', 'on');

  IF COALESCE(v_print_payload->>'workflow_progress_budget_ms', '') ~ '^\d+$' THEN
    v_workflow_progress_budget_ms := LEAST(GREATEST((v_print_payload->>'workflow_progress_budget_ms')::int, 25), 5000);
  END IF;
  IF COALESCE(v_print_payload->>'workflow_progress_max_steps', '') ~ '^\d+$' THEN
    v_workflow_progress_max_steps := LEAST(GREATEST((v_print_payload->>'workflow_progress_max_steps')::int, 1), 50);
  END IF;

  v_execute_dispatch_mode := lower(COALESCE(NULLIF(v_print_payload->>'execute_dispatch_mode', ''), 'async'));
  IF v_execute_dispatch_mode NOT IN ('async', 'sync_wait') THEN
    v_execute_dispatch_mode := 'async';
  END IF;
  IF COALESCE(v_print_payload->>'execute_wait_seconds', '') ~ '^\d+$' THEN
    v_execute_wait_seconds := LEAST(GREATEST((v_print_payload->>'execute_wait_seconds')::int, 1), 60);
  END IF;
  IF COALESCE(v_print_payload->>'execute_wait_poll_ms', '') ~ '^\d+$' THEN
    v_execute_wait_poll_ms := LEAST(GREATEST((v_print_payload->>'execute_wait_poll_ms')::int, 25), 1000);
  END IF;

  IF v_execute_dispatch_mode = 'sync_wait' THEN
    v_workflow_progress_enabled := FALSE;
  END IF;

  v_print_payload := jsonb_strip_nulls(
    v_print_payload || jsonb_build_object(
      'organization_id', v_org_id,
      'workflow_run_id', p_workflow_run_id,
      'workflow_run_step_id', p_workflow_run_step_id,
      'workflow_progress_enabled', v_workflow_progress_enabled,
      'workflow_progress_budget_ms', v_workflow_progress_budget_ms,
      'workflow_progress_max_steps', v_workflow_progress_max_steps,
      'execute_dispatch_mode', v_execute_dispatch_mode,
      'execute_wait_seconds', v_execute_wait_seconds,
      'execute_wait_poll_ms', v_execute_wait_poll_ms
    )
  );

  v_provider := public.resolve_label_renderer_invoke_config_v1(v_org_id);
  v_headers := jsonb_build_object(
    'content-type', 'application/json',
    'authorization', concat('Bearer ', v_provider->>'invoke_secret')
  );
  v_request_body := jsonb_build_object(
    'organization_id', v_org_id,
    'print', v_print_payload
  );

  IF v_execute_dispatch_mode = 'sync_wait' THEN
    v_response := public.dispatch_api_request_wait_v1(
      v_provider->>'invoke_url',
      'POST',
      v_headers,
      v_request_body,
      COALESCE(NULLIF(v_provider->>'timeout_seconds', '')::int, 15),
      LEAST(v_execute_wait_seconds, COALESCE(NULLIF(v_provider->>'timeout_seconds', '')::int, 15)),
      v_execute_wait_poll_ms
    );

    RETURN jsonb_strip_nulls(
      v_response || jsonb_build_object(
        'provider_name', v_provider->>'provider_name',
        'request_payload', v_request_body,
        'dispatch_mode', v_execute_dispatch_mode
      )
    );
  END IF;

  v_request_id := public.dispatch_api_request_v1(
    v_provider->>'invoke_url',
    'POST',
    v_headers,
    v_request_body,
    COALESCE(NULLIF(v_provider->>'timeout_seconds', '')::int, 15)
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 202,
    'completed', false,
    'request_id', v_request_id,
    'provider_name', v_provider->>'provider_name',
    'request_payload', v_request_body,
    'dispatch_mode', v_execute_dispatch_mode
  ));
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer_print_sync_v1(uuid, uuid, jsonb)
  IS 'Invoke label-renderer print_sync with row-driven async or bounded sync-wait dispatch and canonical workflow payload fields.';

REVOKE ALL ON FUNCTION public.invoke_label_renderer_print_sync_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer_print_sync_v1(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_execute_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_response public.workflow_handler_response;
  v_context jsonb := COALESCE(p_run.context, '{}'::jsonb);
  v_payload jsonb := COALESCE(v_context->'payload', '{}'::jsonb);
  v_label_state jsonb := COALESCE(v_context->'label_print', '{}'::jsonb);
  v_policy jsonb := '{}'::jsonb;
  v_org_id uuid := NULL;
  v_requested_by uuid := NULL;
  v_shipments jsonb := '[]'::jsonb;
  v_options jsonb := '{}'::jsonb;
  v_target_state jsonb := '{}'::jsonb;
  v_targets jsonb := '[]'::jsonb;
  v_grouped_shipments jsonb := '[]'::jsonb;
  v_out_of_scope jsonb := '[]'::jsonb;
  v_invalid_boxes jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_counts_patch jsonb := '{}'::jsonb;
  v_fresh_state jsonb := '{}'::jsonb;
  v_ready jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_label_job_ids jsonb := '[]'::jsonb;
  v_execute_async jsonb := COALESCE(v_label_state->'execute_async', '{}'::jsonb);
  v_execute_request_id bigint := NULL;
  v_execute_request_id_text text := '';
  v_execute_response jsonb := COALESCE(v_label_state->'execute_response', '{}'::jsonb);
  v_result jsonb := '{}'::jsonb;
  v_result_status text := '';
  v_bundle_response jsonb := '{}'::jsonb;
  v_bundle_status text := '';
  v_last_error text := NULL;
  v_expected_count int := 0;
  v_ready_count int := 0;
  v_pending_count int := 0;
  v_failed_count int := 0;
  v_poll_seconds int := 1;
  v_workflow_progress_budget_ms int := 1200;
  v_workflow_progress_max_steps int := 10;
  v_requested_source text := format('workflow.labels_print_execute:%s', p_step.id);
  v_print_payload jsonb := '{}'::jsonb;
  v_http_response jsonb := '{}'::jsonb;
  v_http_body jsonb := '{}'::jsonb;
  v_http_completed boolean := false;
  v_client_id text := NULL;
  v_sender_id text := NULL;
  v_label_type text := 'shipping';
  v_output_name text := NULL;
  v_expires_seconds int := NULL;
  v_print_mode text := 'print_sync';
  v_artifact_kind text := NULL;
  v_execute_dispatch_mode text := 'sync_wait';
  v_execute_wait_seconds int := 12;
  v_execute_wait_poll_ms int := 100;
  v_execute_initial_defer_ms int := 250;
  v_execute_wait_ready boolean := false;
BEGIN
  v_org_id := COALESCE(
    NULLIF(v_label_state->>'organization_id', '')::uuid,
    NULLIF(v_context->>'organization_id', '')::uuid,
    NULLIF(v_payload->>'organization_id', '')::uuid
  );
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'execute_label_print_execute_v1: organization_id missing from workflow context';
  END IF;

  v_policy := COALESCE(
    v_label_state->'policy',
    public.resolve_settings('label_print_policy', 'tenant', v_org_id),
    public.resolve_settings('label_print_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_requested_by := COALESCE(
    NULLIF(v_context->>'requested_by', '')::uuid,
    NULLIF(v_payload->>'requested_by', '')::uuid,
    NULLIF(v_context->'payload'->>'requested_by', '')::uuid,
    NULLIF(p_run.metadata->>'requested_by', '')::uuid
  );
  v_shipments := COALESCE(v_label_state->'shipments', v_payload->'shipments', '[]'::jsonb);
  v_options := COALESCE(v_label_state->'options', v_payload->'options', '{}'::jsonb);
  v_client_id := NULLIF(COALESCE(v_label_state->>'client_id', v_payload->>'client_id'), '');
  v_sender_id := NULLIF(COALESCE(v_label_state->>'sender_id', v_payload->>'sender_id'), '');
  v_label_type := lower(COALESCE(NULLIF(v_options->>'label_type', ''), NULLIF(v_payload->>'label_type', ''), 'shipping'));
  v_output_name := NULLIF(COALESCE(v_options->>'output_name', v_payload->>'output_name'), '');
  IF COALESCE(v_options->>'expires_seconds', '') ~ '^\d+$' THEN
    v_expires_seconds := GREATEST((v_options->>'expires_seconds')::int, 60);
  ELSIF COALESCE(v_payload->>'expires_seconds', '') ~ '^\d+$' THEN
    v_expires_seconds := GREATEST((v_payload->>'expires_seconds')::int, 60);
  END IF;

  v_targets := COALESCE(v_label_state->'targets', '[]'::jsonb);
  v_grouped_shipments := COALESCE(v_label_state->'grouped_shipments', '[]'::jsonb);
  v_out_of_scope := COALESCE(v_label_state->'out_of_scope', '[]'::jsonb);
  v_invalid_boxes := COALESCE(v_label_state->'invalid_boxes', '[]'::jsonb);
  v_counts := COALESCE(v_label_state->'counts', '{}'::jsonb);

  IF jsonb_typeof(v_targets) IS DISTINCT FROM 'array' OR jsonb_array_length(v_targets) = 0 THEN
    v_target_state := public.resolve_label_print_targets_v1(v_org_id, v_shipments);
    v_targets := COALESCE(v_target_state->'targets', '[]'::jsonb);
    v_grouped_shipments := COALESCE(v_target_state->'grouped_shipments', '[]'::jsonb);
    v_out_of_scope := COALESCE(v_target_state->'out_of_scope', '[]'::jsonb);
    v_invalid_boxes := COALESCE(v_target_state->'invalid_boxes', '[]'::jsonb);
    v_counts := COALESCE(v_target_state->'counts', '{}'::jsonb);
  END IF;

  v_expected_count := COALESCE(jsonb_array_length(v_targets), 0);
  v_counts_patch := jsonb_strip_nulls(jsonb_build_object(
    'requested', COALESCE(NULLIF(v_counts->>'requested', '')::int, 0),
    'in_scope', COALESCE(NULLIF(v_counts->>'in_scope', '')::int, 0),
    'expected', v_expected_count,
    'out_of_scope', COALESCE(jsonb_array_length(v_out_of_scope), 0),
    'invalid_box_requests', COALESCE(jsonb_array_length(v_invalid_boxes), 0)
  ));
  v_counts := COALESCE(v_counts, '{}'::jsonb) || v_counts_patch;

  IF COALESCE(v_policy->>'poll_interval_seconds', '') ~ '^\d+$' THEN
    v_poll_seconds := LEAST(GREATEST((v_policy->>'poll_interval_seconds')::int, 1), 300);
  END IF;
  IF COALESCE(v_policy->>'bundle_inline_progress_budget_ms', '') ~ '^\d+$' THEN
    v_workflow_progress_budget_ms := LEAST(GREATEST((v_policy->>'bundle_inline_progress_budget_ms')::int, 25), 5000);
  END IF;
  IF COALESCE(v_policy->>'bundle_inline_progress_max_steps', '') ~ '^\d+$' THEN
    v_workflow_progress_max_steps := LEAST(GREATEST((v_policy->>'bundle_inline_progress_max_steps')::int, 1), 50);
  END IF;

  v_execute_dispatch_mode := lower(COALESCE(
    NULLIF(v_label_state->>'execute_dispatch_mode', ''),
    NULLIF(v_policy->>'execute_dispatch_mode', ''),
    'sync_wait'
  ));
  IF v_execute_dispatch_mode NOT IN ('async', 'sync_wait') THEN
    v_execute_dispatch_mode := 'sync_wait';
  END IF;
  IF COALESCE(v_policy->>'execute_wait_seconds', '') ~ '^\d+$' THEN
    v_execute_wait_seconds := LEAST(GREATEST((v_policy->>'execute_wait_seconds')::int, 1), 60);
  END IF;
  IF COALESCE(v_policy->>'execute_initial_defer_ms', '') ~ '^\d+$' THEN
    v_execute_initial_defer_ms := LEAST(GREATEST((v_policy->>'execute_initial_defer_ms')::int, 0), 5000);
  END IF;
  IF COALESCE(v_policy->>'quick_poll_interval_ms', '') ~ '^\d+$' THEN
    v_execute_wait_poll_ms := LEAST(GREATEST((v_policy->>'quick_poll_interval_ms')::int, 25), 1000);
  END IF;
  v_execute_wait_ready := lower(COALESCE(NULLIF(v_label_state->>'execute_wait_ready', ''), 'false')) IN ('1', 't', 'true', 'y', 'yes', 'on');

  IF v_expected_count = 0 THEN
    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_response.last_error := 'no_printable_label_targets';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'failed',
      'error', 'no_printable_label_targets',
      'counts', v_counts,
      'out_of_scope', v_out_of_scope,
      'invalid_boxes', v_invalid_boxes
    ));
    v_response.context_patch := jsonb_build_object(
      'label_print', jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'requested_by', v_requested_by,
        'shipments', v_grouped_shipments,
        'targets', v_targets,
        'grouped_shipments', v_grouped_shipments,
        'out_of_scope', v_out_of_scope,
        'invalid_boxes', v_invalid_boxes,
        'counts', v_counts,
        'options', v_options,
        'policy', v_policy,
        'fresh_generation_required', true,
        'fresh_resolve_mode', 'workflow_scope_only',
        'fresh_request_scope_key', p_step.id::text,
        'requested_source', v_requested_source,
        'execute_dispatch_mode', v_execute_dispatch_mode
      ))
    );
    RETURN v_response;
  END IF;

  IF lower(COALESCE(NULLIF(p_operation_result->>'external_step_result', ''), 'false')) IN ('1', 't', 'true', 'y', 'yes', 'on') THEN
    v_result := COALESCE(p_operation_result->'execute', p_operation_result->'body', p_operation_result);
    IF jsonb_typeof(v_result) IS DISTINCT FROM 'object' THEN
      v_result := '{}'::jsonb;
    END IF;
    IF jsonb_typeof(p_operation_result->'bundle') = 'object'
       AND COALESCE(jsonb_typeof(v_result->'bundle'), '') IS DISTINCT FROM 'object' THEN
      v_result := v_result || jsonb_build_object('bundle', p_operation_result->'bundle');
    END IF;
    IF NULLIF(v_result->>'status', '') IS NULL AND NULLIF(p_operation_result->>'status', '') IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('status', p_operation_result->>'status');
    END IF;
    IF NULLIF(v_result->>'mode', '') IS NULL
       AND COALESCE(NULLIF(p_operation_result->>'print_mode', ''), NULLIF(p_operation_result->>'mode', '')) IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('mode', COALESCE(NULLIF(p_operation_result->>'print_mode', ''), NULLIF(p_operation_result->>'mode', '')));
    END IF;
    IF NULLIF(v_result->>'artifact_kind', '') IS NULL AND NULLIF(p_operation_result->>'artifact_kind', '') IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('artifact_kind', p_operation_result->>'artifact_kind');
    END IF;
    IF NULLIF(v_result->>'source', '') IS NULL AND NULLIF(p_operation_result->>'source', '') IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('source', p_operation_result->>'source');
    END IF;
  ELSE
    v_execute_request_id_text := COALESCE(
      NULLIF(v_execute_async->>'request_id', ''),
      NULLIF(v_execute_response->>'request_id', '')
    );
    IF v_execute_request_id_text ~ '^[0-9]+$' THEN
      v_execute_request_id := v_execute_request_id_text::bigint;
    END IF;

    IF v_execute_request_id IS NULL THEN
      IF v_execute_dispatch_mode = 'sync_wait' AND v_execute_initial_defer_ms > 0 AND NOT v_execute_wait_ready THEN
        v_response.status := 'pending';
        v_response.next_run_at := now() + ((v_execute_initial_defer_ms::text || ' milliseconds')::interval);
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.max_retries := p_step.max_retries;
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'status', 'pending',
          'dispatch_mode', v_execute_dispatch_mode,
          'counts', v_counts,
          'ready', '[]'::jsonb,
          'pending', v_targets,
          'failed', '[]'::jsonb
        ));
        v_response.context_patch := jsonb_build_object(
          'label_print', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'requested_by', v_requested_by,
            'shipments', v_grouped_shipments,
            'targets', v_targets,
            'grouped_shipments', v_grouped_shipments,
            'out_of_scope', v_out_of_scope,
            'invalid_boxes', v_invalid_boxes,
            'counts', v_counts,
            'options', v_options,
            'policy', v_policy,
            'ready', '[]'::jsonb,
            'pending', v_targets,
            'failed', '[]'::jsonb,
            'fresh_generation_required', true,
            'fresh_resolve_mode', 'workflow_scope_only',
            'fresh_request_scope_key', p_step.id::text,
            'requested_source', v_requested_source,
            'execute_dispatch_mode', v_execute_dispatch_mode,
            'execute_wait_ready', true
          ))
        );
        RETURN v_response;
      END IF;

      v_print_payload := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'label_type', v_label_type,
        'shipments', v_grouped_shipments,
        'output_name', v_output_name,
        'expires_seconds', v_expires_seconds,
        'workflow_progress_enabled', CASE WHEN v_execute_dispatch_mode = 'sync_wait' THEN false ELSE true END,
        'workflow_progress_budget_ms', v_workflow_progress_budget_ms,
        'workflow_progress_max_steps', v_workflow_progress_max_steps,
        'execute_dispatch_mode', v_execute_dispatch_mode,
        'execute_wait_seconds', v_execute_wait_seconds,
        'execute_wait_poll_ms', v_execute_wait_poll_ms,
        'metadata', jsonb_strip_nulls(
          public.jsonb_deep_merge(
            COALESCE(v_options->'metadata', '{}'::jsonb),
            jsonb_build_object(
              'correlation_id', NULLIF(v_context->>'correlation_id', ''),
              'fresh_generation_required', true,
              'fresh_request_scope_key', p_step.id::text,
              'requested_source', v_requested_source
            )
          )
        )
      ));

      v_execute_response := public.invoke_label_renderer_print_sync_v1(
        p_run.id,
        p_step.id,
        v_print_payload
      );
      v_execute_request_id_text := NULLIF(v_execute_response->>'request_id', '');
      IF v_execute_request_id_text ~ '^[0-9]+$' THEN
        v_execute_request_id := v_execute_request_id_text::bigint;
      END IF;

      IF COALESCE((v_execute_response->>'completed')::boolean, false)
         AND jsonb_typeof(v_execute_response->'body') = 'object' THEN
        v_result := COALESCE(v_execute_response->'body', '{}'::jsonb);
      ELSE
        v_response.status := 'pending';
        v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.max_retries := p_step.max_retries;
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'status', 'pending',
          'request_id', v_execute_request_id,
          'dispatch_mode', v_execute_dispatch_mode,
          'counts', v_counts,
          'ready', '[]'::jsonb,
          'pending', v_targets,
          'failed', '[]'::jsonb
        ));
        v_response.context_patch := jsonb_build_object(
          'label_print', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'requested_by', v_requested_by,
            'shipments', v_grouped_shipments,
            'targets', v_targets,
            'grouped_shipments', v_grouped_shipments,
            'out_of_scope', v_out_of_scope,
            'invalid_boxes', v_invalid_boxes,
            'counts', v_counts,
            'options', v_options,
            'policy', v_policy,
            'ready', '[]'::jsonb,
            'pending', v_targets,
            'failed', '[]'::jsonb,
            'fresh_generation_required', true,
            'fresh_resolve_mode', 'workflow_scope_only',
            'fresh_request_scope_key', p_step.id::text,
            'requested_source', v_requested_source,
            'execute_dispatch_mode', v_execute_dispatch_mode,
            'execute_wait_ready', true,
            'execute_async', jsonb_strip_nulls(jsonb_build_object(
              'request_id', v_execute_request_id,
              'requested_at', now(),
              'request_payload', v_execute_response->'request_payload',
              'provider_name', v_execute_response->>'provider_name',
              'dispatch_mode', COALESCE(NULLIF(v_execute_response->>'dispatch_mode', ''), v_execute_dispatch_mode),
              'completed', false
            ))
          ))
        );
        RETURN v_response;
      END IF;
    ELSIF v_execute_request_id IS NOT NULL THEN
      BEGIN
        v_http_response := COALESCE(public.check_async_response(v_execute_request_id), '{}'::jsonb);
        v_http_completed := COALESCE((v_http_response->>'completed')::boolean, false);
        IF jsonb_typeof(v_http_response->'body') = 'object' THEN
          v_http_body := v_http_response->'body';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_http_response := '{}'::jsonb;
        v_http_body := '{}'::jsonb;
        v_http_completed := false;
      END;

      IF NOT v_http_completed THEN
        v_response.status := 'pending';
        v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.max_retries := p_step.max_retries;
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'status', 'pending',
          'request_id', v_execute_request_id,
          'dispatch_mode', v_execute_dispatch_mode,
          'counts', v_counts,
          'ready', COALESCE(v_label_state->'ready', '[]'::jsonb),
          'pending', COALESCE(v_label_state->'pending', v_targets),
          'failed', COALESCE(v_label_state->'failed', '[]'::jsonb)
        ));
        v_response.context_patch := jsonb_build_object(
          'label_print', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'requested_by', v_requested_by,
            'shipments', v_grouped_shipments,
            'targets', v_targets,
            'grouped_shipments', v_grouped_shipments,
            'out_of_scope', v_out_of_scope,
            'invalid_boxes', v_invalid_boxes,
            'counts', v_counts,
            'options', v_options,
            'policy', v_policy,
            'ready', COALESCE(v_label_state->'ready', '[]'::jsonb),
            'pending', COALESCE(v_label_state->'pending', v_targets),
            'failed', COALESCE(v_label_state->'failed', '[]'::jsonb),
            'fresh_generation_required', true,
            'fresh_resolve_mode', 'workflow_scope_only',
            'fresh_request_scope_key', p_step.id::text,
            'requested_source', v_requested_source,
            'execute_dispatch_mode', v_execute_dispatch_mode,
            'execute_wait_ready', true,
            'execute_async', jsonb_strip_nulls(jsonb_build_object(
              'request_id', v_execute_request_id,
              'requested_at', COALESCE(v_execute_async->>'requested_at', now()::text),
              'request_payload', COALESCE(v_execute_async->'request_payload', v_execute_response->'request_payload'),
              'provider_name', COALESCE(v_execute_async->>'provider_name', v_execute_response->>'provider_name'),
              'dispatch_mode', COALESCE(NULLIF(v_execute_async->>'dispatch_mode', ''), NULLIF(v_execute_response->>'dispatch_mode', ''), v_execute_dispatch_mode),
              'completed', false
            ))
          ))
        );
        RETURN v_response;
      END IF;

      v_result := COALESCE(v_http_body, '{}'::jsonb);
    END IF;
  END IF;

  v_result_status := lower(COALESCE(NULLIF(v_result->>'status', ''), 'ok'));
  v_bundle_response := COALESCE(v_result->'bundle', '{}'::jsonb);
  v_bundle_status := lower(COALESCE(NULLIF(v_bundle_response->>'status', ''), v_result_status, 'ok'));
  v_print_mode := COALESCE(NULLIF(v_result->>'mode', ''), 'print_sync');
  v_artifact_kind := COALESCE(NULLIF(v_result->>'artifact_kind', ''), NULLIF(v_bundle_response->>'artifact_kind', ''));

  v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets);
  v_ready := COALESCE(v_fresh_state->'ready', '[]'::jsonb);
  v_pending := COALESCE(v_fresh_state->'pending', '[]'::jsonb);
  v_failed := COALESCE(v_fresh_state->'failed', '[]'::jsonb);
  v_label_job_ids := COALESCE(v_fresh_state->'label_job_ids', '[]'::jsonb);
  v_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::int, 0);
  v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::int, 0);
  v_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::int, 0);

  v_counts := COALESCE(v_counts, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'ready', v_ready_count,
    'pending', v_pending_count,
    'failed', v_failed_count,
    'expected', v_expected_count,
    'bundled', CASE
      WHEN COALESCE(v_bundle_response #>> '{counts,bundled}', '') ~ '^\d+$' THEN (v_bundle_response #>> '{counts,bundled}')::int
      ELSE NULL
    END
  ));

  IF v_result_status IN ('failed', 'error') OR v_bundle_status IN ('failed', 'error') OR NULLIF(v_result->>'error', '') IS NOT NULL THEN
    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_last_error := COALESCE(NULLIF(v_result->>'error', ''), NULLIF(v_bundle_response->>'error', ''), 'label_print_execute_failed');
    v_response.last_error := v_last_error;
  ELSIF v_pending_count > 0 THEN
    v_response.status := 'pending';
    v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
    v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    v_response.max_retries := p_step.max_retries;
  ELSIF COALESCE(NULLIF(v_bundle_response->>'file_path', ''), NULLIF(v_bundle_response->>'file_url', ''), NULLIF(v_bundle_response->>'signed_url', '')) IS NULL THEN
    v_response.status := 'pending';
    v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
    v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    v_response.max_retries := p_step.max_retries;
  ELSE
    v_response.status := 'completed';
  END IF;

  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'status', CASE
      WHEN v_response.status = 'completed' THEN 'ok'
      ELSE v_response.status
    END,
    'execute', v_result,
    'bundle', CASE WHEN jsonb_typeof(v_bundle_response) = 'object' THEN v_bundle_response ELSE NULL END,
    'counts', v_counts,
    'ready', v_ready,
    'pending', v_pending,
    'failed', v_failed,
    'artifact_kind', v_artifact_kind,
    'print_mode', v_print_mode,
    'dispatch_mode', v_execute_dispatch_mode,
    'request_id', v_execute_request_id,
    'error', CASE WHEN v_response.status = 'failed' THEN v_last_error ELSE NULL END
  ));

  v_response.context_patch := jsonb_build_object(
    'label_print', jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'requested_by', v_requested_by,
      'shipments', v_grouped_shipments,
      'targets', v_targets,
      'grouped_shipments', v_grouped_shipments,
      'out_of_scope', v_out_of_scope,
      'invalid_boxes', v_invalid_boxes,
      'counts', v_counts,
      'options', v_options,
      'policy', v_policy,
      'ready', v_ready,
      'pending', v_pending,
      'failed', v_failed,
      'label_job_ids', v_label_job_ids,
      'fresh_generation_required', true,
      'fresh_resolve_mode', 'workflow_scope_only',
      'fresh_request_scope_key', p_step.id::text,
      'requested_source', v_requested_source,
      'execute_dispatch_mode', v_execute_dispatch_mode,
      'execute_wait_ready', true,
      'execute_async', jsonb_strip_nulls(jsonb_build_object(
        'request_id', v_execute_request_id,
        'requested_at', COALESCE(v_execute_async->>'requested_at', now()::text),
        'request_payload', COALESCE(v_execute_async->'request_payload', v_execute_response->'request_payload'),
        'provider_name', COALESCE(v_execute_async->>'provider_name', v_execute_response->>'provider_name'),
        'dispatch_mode', COALESCE(NULLIF(v_execute_async->>'dispatch_mode', ''), NULLIF(v_execute_response->>'dispatch_mode', ''), v_execute_dispatch_mode),
        'completed', CASE WHEN v_response.status = 'completed' THEN true ELSE NULL END
      )),
      'execute_response', v_result,
      'bundle_response', CASE WHEN jsonb_typeof(v_bundle_response) = 'object' THEN v_bundle_response ELSE NULL END,
      'artifact_kind', v_artifact_kind,
      'print_mode', v_print_mode
    ))
  );

  RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_execute_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Hybrid print workflow execute step with row-driven deferred sync-wait dispatch, async fallback, and canonical finalize/audit context patching.';

SELECT pg_advisory_unlock(hashtext('202603063000_label_print_execute_sync_wait_v1'));
COMMIT;
