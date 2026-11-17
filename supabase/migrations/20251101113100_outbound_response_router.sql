-- Migration: Outbound response router foundation
-- Purpose: Introduce a shared workflow hook for outbound HTTP responses while
--          keeping existing flows unchanged until they opt-in.
-- Alignment: SIMPLE � SCALABLE � DYNAMIC � prepares for provider-driven workflows
--             without hard-coding behaviour.

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.process_outbound_response_v1(
    p_job outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_result JSONB := jsonb_build_object(
        'handled', FALSE,
        'call_type', p_job.call_type,
        'operation_template_id', COALESCE(p_job.context->>'operation_template_id', NULL)
    );
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_outbound_response_v1(outbound_calls, JSONB)
    IS 'Shared extension point for provider-specific outbound response handling. Returns {handled: bool, ...} metadata.';

CREATE OR REPLACE FUNCTION orchestrate_api_response_processing(
    p_job_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_job outbound_calls%ROWTYPE;
    v_status_code INT;
    v_response JSONB;
    v_processed JSONB;
    v_success BOOLEAN;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    SELECT *
    INTO v_job
    FROM outbound_calls
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'orchestrate_api_response_processing: outbound job % not found', p_job_id;
    END IF;

    v_status_code := COALESCE(v_job.response_status_code, 0);
    v_response := COALESCE(v_job.response_body, '{}'::jsonb);

    v_processed := workflow_handlers.process_outbound_response_v1(v_job, v_response);

    IF COALESCE((v_processed->>'handled')::BOOLEAN, FALSE) THEN
        PERFORM store_response(p_job_id, v_response, v_status_code);
    END IF;

    v_success := (v_status_code BETWEEN 200 AND 299);

    RETURN jsonb_build_object(
        'status', CASE WHEN v_success THEN 'success' ELSE 'error' END,
        'job_id', p_job_id,
        'status_code', v_status_code,
        'processed_metadata', v_processed
    );
END;
$$;

COMMENT ON FUNCTION orchestrate_api_response_processing(UUID)
    IS 'Entry point invoked after outbound HTTP execution; delegates to workflow handlers and optionally store_response().' ;

COMMIT;
