-- Migration: context_extract_from_mapping workflow handler

BEGIN;

SET search_path TO public, workflow_handlers, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.context_extract_from_mapping_v1(
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
    v_step_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_mapping_id UUID := COALESCE(
        NULLIF(v_step_metadata->>'context_mapping_id', '')::UUID,
        NULLIF(v_step_metadata->>'mapping_config_id', '')::UUID,
        NULLIF(v_ctx->>'context_mapping_id', '')::UUID,
        NULLIF(v_ctx->>'response_mapping_id', '')::UUID
    );
    v_mapping JSONB;
    v_context_template JSONB;
    v_render_context JSONB;
    v_patch JSONB := '{}'::jsonb;
    v_response public.workflow_handler_response;
BEGIN
    IF v_mapping_id IS NULL THEN
        v_response.status := 'completed';
        v_response.workflow_status := NULL;
        v_response.next_run_at := NULL;
        v_response.retry_attempt := 1;
        v_response.max_retries := 1;
        v_response.last_error := NULL;
        v_response.context_patch := '{}'::jsonb;
        v_response.operation_result := jsonb_build_object(
            'mapping_config_id', NULL,
            'applied_context_patch', '{}'::jsonb
        );
        RETURN v_response;
    END IF;

    SELECT mapping_config
      INTO v_mapping
      FROM public.mapping_configs
     WHERE id = v_mapping_id;

    IF v_mapping IS NULL THEN
        RAISE EXCEPTION 'context_extract_from_mapping_v1: mapping_config % not found', v_mapping_id;
    END IF;

    v_context_template := COALESCE(v_mapping->'context_patch', '{}'::jsonb);
    IF jsonb_typeof(v_context_template) IS DISTINCT FROM 'object' AND jsonb_typeof(v_context_template) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'context_extract_from_mapping_v1: mapping_config % context_patch must be object or array', v_mapping_id;
    END IF;

    v_render_context := jsonb_build_object(
        'context', v_ctx,
        'step_metadata', v_step_metadata,
        'operation_result', COALESCE(p_operation_result, '{}'::jsonb)
    );

    v_patch := jsonb_strip_nulls(COALESCE(render_template(v_context_template, v_render_context), '{}'::jsonb));

    v_response.context_patch := v_patch;
    v_response.operation_result := jsonb_build_object(
        'mapping_config_id', v_mapping_id,
        'applied_context_patch', v_patch
    );
    v_response.status := 'completed';
    v_response.workflow_status := NULL;
    v_response.next_run_at := NULL;
    v_response.retry_attempt := 1;
    v_response.max_retries := 1;
    v_response.last_error := NULL;

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.context_extract_from_mapping_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Apply mapping_configs.context_patch to workflow context to expose computed values for later steps.';

INSERT INTO operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES (
    'context_extract_from_mapping',
    'workflow_handlers',
    'context_extract_from_mapping_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Render mapping_configs.context_patch and merge into workflow context.',
    NULL
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

COMMIT;
