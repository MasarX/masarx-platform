-- Migration: Labels print finalize sets bundle_response in context
-- Purpose: Ensure run context contains bundle_response after finalize step

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_finalize_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
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
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_requested_by UUID := p_run.requested_by;
    v_correlation_id TEXT := NULLIF(v_context->>'correlation_id', '');
    v_signed_url TEXT := v_bundle->>'signed_url';
    v_file_path TEXT := COALESCE(v_bundle->>'file_path', v_bundle->>'file_url');
    v_bundle_id UUID := COALESCE(NULLIF(v_bundle->>'bundle_id', '')::uuid, gen_random_uuid());
    v_included JSONB := '[]'::jsonb;
    v_first_url TEXT;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_print_finalize_v1: organization_id missing';
    END IF;

    -- If bundle missing, synthesize from first ready file URL
    IF COALESCE(jsonb_typeof(v_bundle),'null') <> 'object' OR jsonb_object_length(v_bundle) = 0 THEN
        SELECT (jsonb_array_elements(v_ready)->> 'file_url') INTO v_first_url LIMIT 1;
        IF v_first_url IS NOT NULL THEN
            v_bundle := jsonb_build_object('status','ok','bundle_id', v_bundle_id, 'file_path', v_first_url);
            v_file_path := v_first_url;
        END IF;
    END IF;

    v_included := (
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'shipment_id', elem->>'shipment_id',
            'label_ids', jsonb_build_array(elem->'label_id')
        )))
        FROM jsonb_array_elements(v_ready) elem
    );

    PERFORM record_label_print(
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
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('status','ok','bundle', v_bundle));
    v_response.context_patch := jsonb_build_object('label_print', jsonb_build_object('bundle_response', v_bundle));

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_finalize_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Finalize label print; logs decision and ensures bundle_response present in run context.';

COMMIT;