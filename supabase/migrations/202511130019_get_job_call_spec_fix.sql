-- Migration: get_job_call_spec qualification fix

BEGIN;

CREATE OR REPLACE FUNCTION public.get_job_call_spec(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, pg_temp'
AS $$
DECLARE
    v_job RECORD;
    v_template RECORD;
    v_spec JSONB;
BEGIN
    SELECT oc.*
    INTO v_job
    FROM public.outbound_calls oc
    WHERE oc.id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'get_job_call_spec: job % not found', p_job_id;
    END IF;

    IF v_job.url IS NOT NULL THEN
        v_spec := jsonb_build_object(
            'url', v_job.url,
            'method', v_job.method,
            'headers', COALESCE(v_job.headers, '{}'::jsonb),
            'body', COALESCE(v_job.body, '{}'::jsonb)
        );
    ELSE
        SELECT ot.*
        INTO v_template
        FROM public.operation_templates ot
        WHERE ot.provider_id = v_job.target_id
          AND ot.operation_name = v_job.call_type
        LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'get_job_call_spec: no operation template for job %', p_job_id;
        END IF;

        v_spec := jsonb_build_object(
            'url', v_template.url_template,
            'method', v_template.method,
            'headers', COALESCE(v_template.headers_template, '{}'::jsonb),
            'body', COALESCE(v_template.body_template, '{}'::jsonb)
        );
    END IF;

    RETURN v_spec;
END;
$$;

COMMIT;

