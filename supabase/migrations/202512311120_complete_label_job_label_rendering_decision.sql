-- Migration: complete_label_job logs label_rendering decisions (SSOT, faster edge)
-- Purpose:
--  - Centralize label_rendering decisions inside complete_label_job so Edge does not
--    write decision_log directly (lower latency, SSOT).
--  - Propagate correlation_id + settings_resolution_id from renderer_metadata for
--    end-to-end tracing.
-- Notes:
--  - Edge must include `renderer_metadata.correlation_id` and
--    `renderer_metadata.settings_resolution.label_render_policy` when available.

BEGIN;

SET search_path TO public, pg_temp;

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
    v_correlation_id UUID := NULL;
    v_duration_ms NUMERIC := NULL;
BEGIN
    BEGIN
        v_settings_resolution_id := NULLIF(v_renderer #>> '{settings_resolution,label_render_policy}', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
        v_settings_resolution_id := NULL;
    END;

    BEGIN
        v_correlation_id := NULLIF(v_renderer #>> '{correlation_id}', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
        v_correlation_id := NULL;
    END;

    BEGIN
        v_duration_ms := NULLIF(v_renderer #>> '{timings,total_ms}', '')::numeric;
    EXCEPTION WHEN OTHERS THEN
        v_duration_ms := NULL;
    END;

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

        PERFORM log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_job',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'complete_label_job',
            p_decision_outcome := 'render_succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := v_correlation_id,
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

        -- SSOT: label_rendering attempt outcome + timings for observability.
        PERFORM log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_rendering',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'label_renderer',
            p_decision_outcome := 'succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'template_id', v_job.template_id,
                'template_version', v_job.template_version,
                'duration_ms', v_duration_ms,
                'timings', v_renderer->'timings',
                'barcode', v_renderer->'barcode'
            )),
            p_decision_reason := 'rendered',
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

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_failed',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := v_correlation_id,
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

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_retry_scheduled',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := v_correlation_id,
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

        -- Record attempt failure for observability, even if the job will retry.
        PERFORM log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_rendering',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'label_renderer',
            p_decision_outcome := 'failed',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'template_id', v_job.template_id,
                'template_version', v_job.template_version,
                'duration_ms', v_duration_ms,
                'timings', v_renderer->'timings',
                'barcode', v_renderer->'barcode'
            )),
            p_decision_reason := COALESCE(p_error_reason, 'render_failed'),
            p_settings_resolution_id := v_settings_resolution_id
        );
    END IF;
END;
$function$;

COMMIT;

