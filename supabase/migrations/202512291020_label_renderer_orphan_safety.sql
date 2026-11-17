-- Migration: Label renderer orphan safety (lease guard + non-blocking decision logging)
-- Date: 2025-12-29
--
-- Purpose:
--  - Prevent label-renderer from leasing label_jobs whose scope no longer exists (orphan org/client).
--  - Ensure label job completion never fails the core operation due to decision_log insert failures.
--  - Keep behavior generic and reusable (single helper for non-blocking decision logging).
BEGIN;

-------------------------------------------------------------------------------
-- 1) Helper: safe_log_decision (best-effort decision_log insert)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.safe_log_decision(
    p_organization_id UUID,
    p_decision_category TEXT,
    p_resource_type TEXT,
    p_resource_id UUID,
    p_decision_point TEXT,
    p_decision_outcome TEXT,
    p_performed_by_system TEXT,
    p_correlation_id UUID DEFAULT NULL,
    p_decision_inputs JSONB DEFAULT '{}'::jsonb,
    p_decision_reason TEXT DEFAULT NULL,
    p_settings_resolution_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_id UUID;
    v_err TEXT;
    v_state TEXT;
BEGIN
    BEGIN
        v_id := public.log_decision(
            p_organization_id := p_organization_id,
            p_decision_category := p_decision_category,
            p_resource_type := p_resource_type,
            p_resource_id := p_resource_id,
            p_decision_point := p_decision_point,
            p_decision_outcome := p_decision_outcome,
            p_performed_by_system := p_performed_by_system,
            p_correlation_id := p_correlation_id,
            p_decision_inputs := p_decision_inputs,
            p_decision_reason := p_decision_reason,
            p_settings_resolution_id := p_settings_resolution_id
        );
        RETURN v_id;
    EXCEPTION
        WHEN others THEN
            GET STACKED DIAGNOSTICS
                v_err = MESSAGE_TEXT,
                v_state = RETURNED_SQLSTATE;

            IF p_organization_id IS NOT NULL THEN
                BEGIN
                    INSERT INTO public.ops_alerts (
                        organization_id,
                        alert_type,
                        severity,
                        message,
                        details,
                        decision_log_id,
                        correlation_id,
                        created_at
                    )
                    VALUES (
                        p_organization_id,
                        'decision_log_insert_failed',
                        'error',
                        'safe_log_decision failed to insert decision_log row',
                        jsonb_strip_nulls(jsonb_build_object(
                            'sqlstate', v_state,
                            'error', v_err,
                            'decision_category', p_decision_category,
                            'resource_type', p_resource_type,
                            'resource_id', p_resource_id,
                            'decision_point', p_decision_point,
                            'decision_outcome', p_decision_outcome,
                            'performed_by_system', p_performed_by_system
                        )),
                        NULL,
                        p_correlation_id,
                        now()
                    );
                EXCEPTION
                    WHEN others THEN
                        NULL;
                END;
            END IF;
            RETURN NULL;
    END;
END;
$function$;

COMMENT ON FUNCTION public.safe_log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT, UUID)
  IS 'Best-effort wrapper for log_decision: traps insert failures and emits an ops_alert (non-blocking).';

-------------------------------------------------------------------------------
-- 2) Label job leasing: guard against orphaned scope (org/client)
-------------------------------------------------------------------------------
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
        SELECT lj.*
        INTO v_job
        FROM public.label_jobs lj
        JOIN public.organizations o ON o.id = lj.organization_id
        JOIN public.clients c ON c.id = lj.client_id AND c.organization_id = lj.organization_id
        WHERE lj.id = p_job_id
          AND lj.status = 'pending'
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
        SELECT lj.id
        FROM public.label_jobs lj
        JOIN public.organizations o ON o.id = lj.organization_id
        JOIN public.clients c ON c.id = lj.client_id AND c.organization_id = lj.organization_id
        WHERE lj.status = 'pending'
          AND lj.scheduled_at <= now()
          AND lj.attempts < lj.max_attempts
          AND (p_organization_id IS NULL OR lj.organization_id = p_organization_id)
          AND p_job_id IS NULL
        ORDER BY lj.scheduled_at, lj.created_at
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

-------------------------------------------------------------------------------
-- 3) Label job completion: make decision_log emission non-blocking
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_label_job(
    p_job_id UUID,
    p_status TEXT,
    p_file_url TEXT,
    p_file_size_bytes INTEGER,
    p_renderer_metadata JSONB DEFAULT NULL::jsonb,
    p_error_reason TEXT DEFAULT NULL::text
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_barcode TEXT;
    v_barcode_format TEXT;
    v_label_id UUID;
    v_label_metadata JSONB;
    v_retry_seconds INTEGER;
    v_retry_length INTEGER;
    v_index INTEGER;
    v_max_delay INTEGER := 3600;
    v_renderer JSONB := COALESCE(p_renderer_metadata, '{}'::jsonb);
    v_settings_resolution_id UUID := NULL;
BEGIN
    -- Prefer linking decisions to the label_render_policy resolution id (if provided).
    v_settings_resolution_id := NULLIF(v_renderer #>> '{settings_resolution,label_render_policy}', '')::uuid;

    SELECT *
    INTO v_job
    FROM label_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    IF lower(p_status) = 'succeeded' THEN
        IF v_job.shipment_box_id IS NOT NULL THEN
            SELECT barcode
            INTO v_barcode
            FROM shipment_boxes
            WHERE id = v_job.shipment_box_id;
        END IF;

        IF v_barcode IS NULL THEN
            SELECT sb.barcode
            INTO v_barcode
            FROM shipment_boxes sb
            WHERE sb.shipment_id = v_job.shipment_id
            ORDER BY sb.box_number
            LIMIT 1;
        END IF;

        v_barcode := COALESCE(
            v_barcode,
            v_job.template_snapshot -> 'label_config' ->> 'fallback_barcode'
        );

        IF v_barcode IS NULL THEN
            RAISE EXCEPTION 'Unable to resolve barcode for label job %', p_job_id;
        END IF;

        v_barcode_format := COALESCE(
            v_job.template_snapshot -> 'label_config' ->> 'barcode_format',
            v_job.template_snapshot -> 'renderer_config' -> 'barcode' ->> 'type',
            'CODE128'
        );

        v_label_id := COALESCE(v_job.label_id, gen_random_uuid());

        v_label_metadata := jsonb_build_object(
            'label_job_id', v_job.id,
            'template', v_job.template_snapshot
        );

        -- Idempotent upsert on (barcode, shipment_id): reuse/update existing labels
        INSERT INTO labels (
            id,
            shipment_id,
            organization_id,
            client_id,
            label_type,
            barcode,
            barcode_format,
            layout_template_id,
            file_url,
            file_size_bytes,
            generated_by,
            generated_at,
            print_count,
            last_printed_at,
            metadata,
            renderer_metadata
        )
        VALUES (
            v_label_id,
            v_job.shipment_id,
            v_job.organization_id,
            v_job.client_id,
            v_job.label_type,
            v_barcode,
            v_barcode_format,
            v_job.template_id,
            p_file_url,
            COALESCE(p_file_size_bytes, 0),
            v_job.requested_by,
            v_now,
            1,
            v_now,
            v_label_metadata,
            v_renderer
        )
        ON CONFLICT ON CONSTRAINT labels_barcode_shipment_id_key DO UPDATE
        SET file_url = EXCLUDED.file_url,
            file_size_bytes = EXCLUDED.file_size_bytes,
            generated_by = EXCLUDED.generated_by,
            generated_at = EXCLUDED.generated_at,
            last_printed_at = EXCLUDED.last_printed_at,
            print_count = labels.print_count + 1,
            label_type = EXCLUDED.label_type,
            layout_template_id = EXCLUDED.layout_template_id,
            barcode_format = EXCLUDED.barcode_format,
            metadata = EXCLUDED.metadata,
            renderer_metadata = EXCLUDED.renderer_metadata
        RETURNING id INTO v_label_id;

        UPDATE label_jobs
        SET status = 'succeeded',
            completed_at = v_now,
            lease_expires_at = NULL,
            output_file_url = p_file_url,
            output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
            renderer_metadata = v_renderer,
            error_reason = NULL,
            label_id = v_label_id
        WHERE id = v_job.id;

        INSERT INTO shipment_actions (
            id,
            shipment_id,
            organization_id,
            client_id,
            action_type,
            action_category,
            action_data,
            timestamp,
            created_at,
            performed_by_system
        )
        VALUES (
            gen_random_uuid(),
            v_job.shipment_id,
            v_job.organization_id,
            v_job.client_id,
            'label_generated',
            'operational',
            jsonb_build_object(
                'label_job_id', v_job.id,
                'label_id', v_label_id,
                'attempts', v_job.attempts,
                'template_version', v_job.template_version
            ),
            v_now,
            v_now,
            'label_renderer'
        );

        PERFORM public.safe_log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_job',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'complete_label_job',
            p_decision_outcome := 'render_succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'label_id', v_label_id,
                'file_url', p_file_url,
                'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                'attempts', v_job.attempts + 1,
                'template_id', v_job.template_id,
                'template_version', v_job.template_version,
                'barcode', v_renderer->'barcode'
            )),
            p_decision_reason := NULL,
            p_settings_resolution_id := v_settings_resolution_id
        );
    ELSE
        v_retry_length := COALESCE(jsonb_array_length(v_job.retry_state), 0);
        IF v_retry_length >= v_job.attempts AND v_job.attempts > 0 THEN
            v_index := v_job.attempts;
            v_retry_seconds := COALESCE((v_job.retry_state ->> (v_index - 1))::INTEGER, 0);
        ELSE
            v_retry_seconds := 0;
        END IF;
        IF v_retry_seconds <= 0 THEN
            v_retry_seconds := LEAST(v_max_delay, 60 * (2 ^ GREATEST(v_job.attempts - 1, 0)));
        END IF;
        v_retry_seconds := LEAST(v_max_delay, GREATEST(v_retry_seconds, 30));

        IF v_job.attempts >= v_job.max_attempts THEN
            UPDATE label_jobs
            SET status = 'failed',
                completed_at = v_now,
                lease_expires_at = NULL,
                renderer_metadata = v_renderer,
                error_reason = COALESCE(p_error_reason, 'max_attempts_exceeded')
            WHERE id = v_job.id;

            PERFORM public.safe_log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_failed',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version,
                    'barcode', v_renderer->'barcode'
                )),
                p_decision_reason := COALESCE(p_error_reason, 'max_attempts_exceeded'),
                p_settings_resolution_id := v_settings_resolution_id
            );
        ELSE
            UPDATE label_jobs
            SET status = 'pending',
                lease_expires_at = NULL,
                scheduled_at = v_now + make_interval(secs => v_retry_seconds),
                renderer_metadata = v_renderer,
                error_reason = p_error_reason
            WHERE id = v_job.id;

            PERFORM public.safe_log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_retry_scheduled',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'next_attempt_in_seconds', v_retry_seconds,
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version,
                    'barcode', v_renderer->'barcode'
                )),
                p_decision_reason := p_error_reason,
                p_settings_resolution_id := v_settings_resolution_id
            );
        END IF;
    END IF;
END;
$function$;

COMMIT;

