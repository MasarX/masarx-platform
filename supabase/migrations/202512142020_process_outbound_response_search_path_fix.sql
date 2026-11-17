-- Migration: Fix process_outbound_response_v1 search_path side effects
-- Purpose: Prevent global session search_path mutation that can break callers; rely on function-level SET search_path instead.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.process_outbound_response_v1(
    p_job public.outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('handled', FALSE);
    v_template_id UUID;
    v_template public.operation_templates%ROWTYPE;
BEGIN
    -- Comms first: call_type drives comms handling (independent of operation_name).
    IF p_job.call_type IN ('comms_whatsapp', 'comms_sms', 'comms_email', 'comms_voice') THEN
        v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
        IF v_template_id IS NOT NULL THEN
            SELECT * INTO v_template
              FROM public.operation_templates
             WHERE id = v_template_id;
        END IF;

        IF v_template.id IS NULL THEN
            -- Best-effort fallback to provider-scoped template for response mapping.
            SELECT * INTO v_template
              FROM public.operation_templates ot
             WHERE ot.provider_id = p_job.target_id
               AND ot.call_type = p_job.call_type
             ORDER BY ot.updated_at DESC
             LIMIT 1;
        END IF;

        RETURN workflow_handlers.process_comms_outbound_response_v1(p_job, v_template, p_response);
    END IF;

    -- Geocoding (and any other future outbound response handlers) are routed through the
    -- dedicated geocoding handler, which returns handled=false for non-geocoding jobs.
    RETURN workflow_handlers.process_geocoding_outbound_response_v1(p_job, p_response);
END;
$$;

COMMIT;

