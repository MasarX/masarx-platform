-- Migration: Fix orchestrate_api_response_processing search_path side effects
-- Purpose: Prevent global session search_path mutation (set_config(..., FALSE)) that can break callers (e.g., pgTAP) and is unsafe.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.orchestrate_api_response_processing(
    p_job_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_status_code INT;
    v_response JSONB;
    v_processed JSONB;
    v_success BOOLEAN;
BEGIN
    SELECT *
    INTO v_job
    FROM public.outbound_calls
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'orchestrate_api_response_processing: outbound job % not found', p_job_id;
    END IF;

    v_status_code := COALESCE(v_job.response_status_code, 0);
    v_response := COALESCE(v_job.response_body, '{}'::jsonb);

    v_processed := workflow_handlers.process_outbound_response_v1(v_job, v_response);

    IF COALESCE((v_processed->>'handled')::BOOLEAN, FALSE) THEN
        PERFORM public.store_response(p_job_id, v_response, v_status_code);
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

COMMIT;

