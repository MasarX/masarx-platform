-- Migration: label print execute adaptive dispatch
-- Purpose:
--   - Keep single-target print runs eligible for inline sync-wait completion.
--   - Force multi-target fresh print runs onto async execute immediately so interactive budget is not wasted on a wait that cannot finish quickly.
--   - Drop the initial defer for single-target sync-wait runs so the first interactive progression can finish in one pass when the renderer is fast enough.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063310_label_print_execute_adaptive_dispatch_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout TO '30s';
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
  v_enqueue_requested_source text := NULL;
  v_progress_budget_ms int := NULL;
  v_progress_elapsed_ms int := NULL;
  v_progress_remaining_ms int := NULL;
  v_effective_dispatch_mode text := 'sync_wait';
  v_execute_wait_seconds_effective int := 12;
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
  v_effective_dispatch_mode := v_execute_dispatch_mode;
  v_execute_wait_seconds_effective := v_execute_wait_seconds;

  BEGIN
    IF COALESCE(current_setting('masarx.workflow_progress_budget_ms', true), '') ~ '^\d+$' THEN
      v_progress_budget_ms := GREATEST(current_setting('masarx.workflow_progress_budget_ms', true)::int, 0);
    END IF;
    IF COALESCE(current_setting('masarx.workflow_progress_elapsed_ms', true), '') ~ '^\d+$' THEN
      v_progress_elapsed_ms := GREATEST(current_setting('masarx.workflow_progress_elapsed_ms', true)::int, 0);
    END IF;
    IF COALESCE(current_setting('masarx.workflow_progress_remaining_ms', true), '') ~ '^\d+$' THEN
      v_progress_remaining_ms := GREATEST(current_setting('masarx.workflow_progress_remaining_ms', true)::int, 0);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_progress_budget_ms := NULL;
    v_progress_elapsed_ms := NULL;
    v_progress_remaining_ms := NULL;
  END;

  IF v_progress_remaining_ms IS NULL AND v_progress_budget_ms IS NOT NULL THEN
    v_progress_remaining_ms := GREATEST(v_progress_budget_ms - COALESCE(v_progress_elapsed_ms, 0), 0);
  END IF;

  IF v_execute_dispatch_mode = 'sync_wait' AND v_progress_remaining_ms IS NOT NULL THEN
    v_execute_wait_seconds_effective := LEAST(
      v_execute_wait_seconds,
      GREATEST(GREATEST(v_progress_remaining_ms - 250, 0) / 1000, 0)
    );
    IF v_execute_wait_seconds_effective < 1 THEN
      v_effective_dispatch_mode := 'async';
      v_execute_wait_seconds_effective := 1;
    END IF;
  END IF;

  IF v_expected_count > 1 THEN
    v_effective_dispatch_mode := 'async';
    v_execute_wait_seconds_effective := 1;
  ELSIF v_effective_dispatch_mode = 'sync_wait' THEN
    v_execute_initial_defer_ms := 0;
  END IF;

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
      IF v_effective_dispatch_mode = 'sync_wait' AND v_execute_initial_defer_ms > 0 AND NOT v_execute_wait_ready THEN
        v_response.status := 'pending';
        v_response.next_run_at := now() + ((v_execute_initial_defer_ms::text || ' milliseconds')::interval);
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.max_retries := p_step.max_retries;
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'status', 'pending',
          'dispatch_mode', v_effective_dispatch_mode,
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
            'execute_dispatch_mode', v_effective_dispatch_mode,
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
        'workflow_progress_enabled', CASE WHEN v_effective_dispatch_mode = 'sync_wait' THEN false ELSE true END,
        'workflow_progress_budget_ms', v_workflow_progress_budget_ms,
        'workflow_progress_max_steps', v_workflow_progress_max_steps,
        'execute_dispatch_mode', v_effective_dispatch_mode,
        'execute_wait_seconds', v_execute_wait_seconds_effective,
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
        v_response.next_run_at := now() + ((v_execute_wait_poll_ms::text || ' milliseconds')::interval);
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.max_retries := p_step.max_retries;
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'status', 'pending',
          'request_id', v_execute_request_id,
          'dispatch_mode', v_effective_dispatch_mode,
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
            'execute_dispatch_mode', v_effective_dispatch_mode,
            'execute_wait_ready', true,
            'execute_async', jsonb_strip_nulls(jsonb_build_object(
              'request_id', v_execute_request_id,
              'requested_at', now(),
              'request_payload', v_execute_response->'request_payload',
              'provider_name', v_execute_response->>'provider_name',
              'dispatch_mode', COALESCE(NULLIF(v_execute_response->>'dispatch_mode', ''), v_effective_dispatch_mode),
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
        v_response.next_run_at := now() + ((v_execute_wait_poll_ms::text || ' milliseconds')::interval);
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.max_retries := p_step.max_retries;
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'status', 'pending',
          'request_id', v_execute_request_id,
          'dispatch_mode', v_effective_dispatch_mode,
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
            'execute_dispatch_mode', v_effective_dispatch_mode,
            'execute_wait_ready', true,
            'execute_async', jsonb_strip_nulls(jsonb_build_object(
              'request_id', v_execute_request_id,
              'requested_at', COALESCE(v_execute_async->>'requested_at', now()::text),
              'request_payload', COALESCE(v_execute_async->'request_payload', v_execute_response->'request_payload'),
              'provider_name', COALESCE(v_execute_async->>'provider_name', v_execute_response->>'provider_name'),
              'dispatch_mode', COALESCE(NULLIF(v_execute_async->>'dispatch_mode', ''), NULLIF(v_execute_response->>'dispatch_mode', ''), v_effective_dispatch_mode),
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
  v_artifact_kind := COALESCE(
    NULLIF(v_result->>'artifact_kind', ''),
    NULLIF(v_bundle_response->>'artifact_kind', ''),
    CASE
      WHEN COALESCE(
        NULLIF(v_bundle_response->>'file_path', ''),
        NULLIF(v_bundle_response->>'file_url', ''),
        NULLIF(v_bundle_response->>'signed_url', '')
      ) IS NOT NULL
        THEN 'bundle'
      ELSE NULL
    END
  );

  IF v_artifact_kind IS NOT NULL THEN
    IF NULLIF(v_result->>'artifact_kind', '') IS NULL THEN
      v_result := v_result || jsonb_build_object('artifact_kind', v_artifact_kind);
    END IF;
    IF jsonb_typeof(v_bundle_response) = 'object'
       AND NULLIF(v_bundle_response->>'artifact_kind', '') IS NULL THEN
      v_bundle_response := v_bundle_response || jsonb_build_object('artifact_kind', v_artifact_kind);
    END IF;
  END IF;

  v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets);
  v_ready := COALESCE(v_fresh_state->'ready', '[]'::jsonb);
  v_pending := COALESCE(v_fresh_state->'pending', '[]'::jsonb);
  v_failed := COALESCE(v_fresh_state->'failed', '[]'::jsonb);
  v_label_job_ids := COALESCE(v_fresh_state->'label_job_ids', '[]'::jsonb);
  v_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::int, 0);
  v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::int, 0);
  v_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::int, 0);

  SELECT NULLIF(step_elem->>'requested_source', '')
  INTO v_enqueue_requested_source
  FROM jsonb_array_elements(COALESCE(v_result->'steps', '[]'::jsonb)) AS step_elem
  WHERE step_elem->>'step' = 'enqueue_label_jobs'
  LIMIT 1;

  IF v_pending_count > 0
     AND v_enqueue_requested_source IS NOT NULL
     AND COALESCE(
       NULLIF(v_bundle_response #>> '{metadata,fresh_request_scope_key}', ''),
       NULLIF(v_result #>> '{bundle,metadata,fresh_request_scope_key}', '')
     ) = p_step.id::text
  THEN
    UPDATE public.label_jobs lj
    SET workflow_run_step_id = p_step.id
    WHERE lj.workflow_run_step_id IS NULL
      AND lj.requested_source = v_enqueue_requested_source
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_targets) AS t(elem)
        WHERE lj.shipment_id = NULLIF(elem->>'shipment_id', '')::uuid
          AND lj.shipment_box_id IS NOT DISTINCT FROM CASE
            WHEN COALESCE(elem->>'shipment_box_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN (elem->>'shipment_box_id')::uuid
            ELSE NULL
          END
      );

    v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets);
    v_ready := COALESCE(v_fresh_state->'ready', '[]'::jsonb);
    v_pending := COALESCE(v_fresh_state->'pending', '[]'::jsonb);
    v_failed := COALESCE(v_fresh_state->'failed', '[]'::jsonb);
    v_label_job_ids := COALESCE(v_fresh_state->'label_job_ids', '[]'::jsonb);
    v_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::int, 0);
    v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::int, 0);
    v_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::int, 0);
  END IF;

  IF v_pending_count > 0
     AND v_result_status NOT IN ('failed', 'error')
     AND v_bundle_status NOT IN ('failed', 'error')
     AND COALESCE(
       NULLIF(v_bundle_response->>'file_path', ''),
       NULLIF(v_bundle_response->>'file_url', ''),
       NULLIF(v_bundle_response->>'signed_url', '')
     ) IS NOT NULL
     AND COALESCE(
       NULLIF(v_bundle_response #>> '{metadata,fresh_request_scope_key}', ''),
       NULLIF(v_result #>> '{bundle,metadata,fresh_request_scope_key}', '')
     ) = p_step.id::text
  THEN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(elem || jsonb_build_object('status', 'ready'))
        ORDER BY ordinality
      ),
      '[]'::jsonb
    )
    INTO v_ready
    FROM jsonb_array_elements(v_targets) WITH ORDINALITY AS t(elem, ordinality);

    v_pending := '[]'::jsonb;
    v_ready_count := GREATEST(v_expected_count - v_failed_count, 0);
    v_pending_count := 0;
  END IF;

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
    v_response.next_run_at := now() + ((v_execute_wait_poll_ms::text || ' milliseconds')::interval);
    v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    v_response.max_retries := p_step.max_retries;
  ELSIF COALESCE(NULLIF(v_bundle_response->>'file_path', ''), NULLIF(v_bundle_response->>'file_url', ''), NULLIF(v_bundle_response->>'signed_url', '')) IS NULL THEN
    v_response.status := 'pending';
    v_response.next_run_at := now() + ((v_execute_wait_poll_ms::text || ' milliseconds')::interval);
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
    'dispatch_mode', v_effective_dispatch_mode,
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
      'execute_dispatch_mode', v_effective_dispatch_mode,
      'execute_wait_ready', true,
      'execute_async', jsonb_strip_nulls(jsonb_build_object(
        'request_id', v_execute_request_id,
        'requested_at', COALESCE(v_execute_async->>'requested_at', now()::text),
        'request_payload', COALESCE(v_execute_async->'request_payload', v_execute_response->'request_payload'),
        'provider_name', COALESCE(v_execute_async->>'provider_name', v_execute_response->>'provider_name'),
        'dispatch_mode', COALESCE(NULLIF(v_execute_async->>'dispatch_mode', ''), NULLIF(v_execute_response->>'dispatch_mode', ''), v_effective_dispatch_mode),
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

SELECT pg_advisory_unlock(hashtext('202603063310_label_print_execute_adaptive_dispatch_v1'));
COMMIT;
