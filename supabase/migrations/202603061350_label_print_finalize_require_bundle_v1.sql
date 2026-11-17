-- Migration: label print finalize require real bundle
-- Purpose:
--  - Prevent finalize from fabricating bundle ids before a real bundle artifact exists.
--  - Keep label print workflows in soft-wait mode until bundle response is available or bundle step fails.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061350_label_print_finalize_require_bundle_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_finalize_v1(
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
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_bundle JSONB := COALESCE(v_label_state->'bundle_response', '{}'::jsonb);
    v_counts JSONB := COALESCE(v_label_state->'counts', '{}'::jsonb);
    v_errors JSONB := jsonb_build_object(
        'out_of_scope', COALESCE(v_label_state->'out_of_scope', '[]'::jsonb),
        'invalid_boxes', COALESCE(v_label_state->'invalid_boxes', '[]'::jsonb),
        'timed_out', COALESCE(v_label_state->'timed_out', '[]'::jsonb)
    );
    v_ready JSONB := COALESCE(v_label_state->'ready', '[]'::jsonb);
    v_options JSONB := COALESCE(v_label_state->'options', '{}'::jsonb);
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_requested_by UUID := NULLIF(v_context->>'requested_by', '')::uuid;
    v_correlation_id TEXT := NULLIF(v_context->>'correlation_id', '');
    v_signed_url TEXT;
    v_file_path TEXT;
    v_bundle_id UUID;
    v_included JSONB := '[]'::jsonb;
    v_step_bundle_result JSONB;
    v_bundle_step_status TEXT := NULL;
    v_bundle_async JSONB := COALESCE(v_label_state->'bundle_async', '{}'::jsonb);
    v_bundle_request_id BIGINT := NULLIF(v_bundle_async->>'request_id', '')::BIGINT;
    v_policy JSONB := '{}'::jsonb;
    v_poll_interval_seconds INT := 30;
    v_bundle_missing BOOLEAN := TRUE;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_print_finalize_v1: organization_id missing';
    END IF;

    v_policy := COALESCE(
      v_label_state->'policy',
      public.resolve_settings('label_print_policy', 'tenant', v_org_id),
      public.resolve_settings('label_print_policy', 'global', NULL),
      '{}'::jsonb
    );

    v_poll_interval_seconds := COALESCE(
      NULLIF(v_options->>'poll_interval_seconds', '')::INT,
      NULLIF(v_policy->>'poll_interval_seconds', '')::INT,
      1
    );
    IF v_poll_interval_seconds < 1 THEN
      v_poll_interval_seconds := 1;
    END IF;

    SELECT step_status,
           COALESCE(operation_result->'bundle', operation_result)
    INTO v_bundle_step_status, v_step_bundle_result
    FROM public.workflow_run_steps
    WHERE workflow_run_id = p_run.id
      AND handler_key = 'label_bundle'
    ORDER BY sequence_order DESC
    LIMIT 1;

    IF v_bundle IS NULL OR jsonb_typeof(v_bundle) <> 'object' OR (v_bundle ? 'bundle_id') IS FALSE THEN
        v_bundle := COALESCE(v_step_bundle_result, v_bundle, '{}'::jsonb);
    END IF;

    IF lower(COALESCE(v_bundle->>'status', '')) = 'failed' OR v_bundle_step_status = 'failed' THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := COALESCE(v_bundle->>'error', v_step_bundle_result->>'error', 'label_bundle_failed');
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
            'status', 'failed',
            'bundle', v_bundle,
            'counts', v_counts,
            'errors', v_errors
        ));
        RETURN v_response;
    END IF;

    v_signed_url := NULLIF(v_bundle->>'signed_url', '');
    v_file_path := COALESCE(NULLIF(v_bundle->>'file_path', ''), NULLIF(v_bundle->>'file_url', ''));
    v_bundle_missing := COALESCE(v_signed_url, v_file_path) IS NULL;

    IF v_bundle_missing THEN
        v_response.status := 'pending';
        v_response.next_run_at := now() + make_interval(secs => v_poll_interval_seconds);
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
            'status', 'pending',
            'reason', 'waiting_for_bundle_response',
            'bundle_step_status', v_bundle_step_status,
            'bundle_request_id', v_bundle_request_id,
            'counts', v_counts,
            'errors', v_errors
        ));
        RETURN v_response;
    END IF;

    v_bundle_id := COALESCE(NULLIF(v_bundle->>'bundle_id', '')::uuid, gen_random_uuid());

    v_included := (
        SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'shipment_id', elem->>'shipment_id',
            'label_ids', jsonb_build_array(elem->'label_id')
        ))), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(v_ready, '[]'::jsonb)) elem
    );

    PERFORM public.record_label_print(
        p_bundle_id := v_bundle_id,
        p_org_id := v_org_id,
        p_requested_by := v_requested_by,
        p_correlation_id := v_correlation_id,
        p_signed_url := v_signed_url,
        p_file_path := v_file_path,
        p_counts := v_counts,
        p_errors := v_errors,
        p_included := COALESCE(v_included, '[]'::jsonb)
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'ok',
        'bundle_id', v_bundle_id,
        'signed_url', v_signed_url,
        'file_path', v_file_path,
        'counts', v_counts,
        'errors', v_errors
    ));

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_finalize_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Finalize label print workflow only after a real bundle artifact exists; otherwise remain pending or fail with bundle step state.';

SELECT pg_advisory_unlock(hashtext('202603061350_label_print_finalize_require_bundle_v1'));
COMMIT;
