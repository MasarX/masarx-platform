-- Migration: Schema-qualify label workflow helpers and checksum recompute
-- Date: 2025-11-20 21:10 UTC

BEGIN;

CREATE OR REPLACE FUNCTION public.compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_job public.label_jobs%ROWTYPE;
    v_payload JSONB;
BEGIN
    SELECT *
    INTO v_job
    FROM public.label_jobs
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    SELECT to_jsonb(payload)
    INTO v_payload
    FROM public.shipment_label_payload_v payload
    WHERE payload.shipment_id = v_job.shipment_id
      AND (
            v_job.shipment_box_id IS NULL
            OR payload.shipment_box_id = v_job.shipment_box_id
          )
    ORDER BY payload.box_number NULLS FIRST
    LIMIT 1;

    RETURN jsonb_build_object(
        'job', jsonb_build_object(
            'id', v_job.id,
            'organization_id', v_job.organization_id,
            'client_id', v_job.client_id,
            'shipment_id', v_job.shipment_id,
            'shipment_box_id', v_job.shipment_box_id,
            'label_type', v_job.label_type,
            'attempts', v_job.attempts,
            'max_attempts', v_job.max_attempts,
            'template', v_job.template_snapshot,
            'renderer_hint', v_job.renderer_hint,
            'retry_state', v_job.retry_state
        ),
        'payload', COALESCE(v_payload, '{}'::jsonb)
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.lease_label_job(
    p_organization_id UUID DEFAULT NULL,
    p_lease_seconds INTEGER DEFAULT 300,
    p_job_id UUID DEFAULT NULL
)
RETURNS public.label_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_job public.label_jobs%ROWTYPE;
    v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
BEGIN
    IF p_job_id IS NOT NULL THEN
        SELECT *
        INTO v_job
        FROM public.label_jobs
        WHERE id = p_job_id
          AND status = 'pending'
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN NULL;
        END IF;

        IF p_organization_id IS NOT NULL
           AND v_job.organization_id <> p_organization_id THEN
            RAISE EXCEPTION 'Label job % does not belong to organization %', p_job_id, p_organization_id;
        END IF;

        UPDATE public.label_jobs
        SET status = 'in_progress',
            attempts = public.label_jobs.attempts + 1,
            last_attempt_at = now(),
            lease_expires_at = now() + v_lease_interval
        WHERE id = v_job.id
        RETURNING * INTO v_job;

        RETURN v_job;
    END IF;

    WITH candidate AS (
        SELECT id
        FROM public.label_jobs
        WHERE status = 'pending'
          AND scheduled_at <= now()
          AND attempts < max_attempts
          AND (p_organization_id IS NULL OR organization_id = p_organization_id)
          AND p_job_id IS NULL
        ORDER BY scheduled_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.label_jobs lj
    SET status = 'in_progress',
        attempts = lj.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + v_lease_interval
    FROM candidate
    WHERE lj.id = candidate.id
    RETURNING lj.*
    INTO v_job;

    RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.workflow_refresh_steps_checksum(
    p_template_id UUID,
    p_increment_version BOOLEAN DEFAULT TRUE
)
RETURNS TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
    v_checksum TEXT;
BEGIN
    SELECT md5(
        COALESCE(
            string_agg(
                concat_ws(
                    '|',
                    sequence_order,
                    operation_name,
                    COALESCE(next_operation_name, ''),
                    COALESCE(operation_settings_category, ''),
                    COALESCE(transition_condition, ''),
                    COALESCE(condition_jsonlogic::TEXT, ''),
                    COALESCE(manual_action_required::TEXT, 'false'),
                    COALESCE(enabled::TEXT, 'true'),
                    COALESCE(metadata::TEXT, ''),
                    COALESCE(handler_key, ''),
                    COALESCE(handler_version, '')
                ),
                '||'
                ORDER BY sequence_order
            ),
            ''
        )
    )
    INTO v_checksum
    FROM public.workflow_template_steps
    WHERE workflow_template_id = p_template_id;

    UPDATE public.workflow_templates
    SET steps_checksum = v_checksum,
        version = CASE WHEN p_increment_version THEN version + 1 ELSE version END,
        updated_at = now()
    WHERE id = p_template_id;

    RETURN v_checksum;
END;
$function$;

COMMIT;
