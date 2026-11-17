-- Migration: label reprint active-version ordering fix
-- Purpose:
--   - Preserve the single-active-version invariant during label reprints.
--   - Supersede the prior active version before inserting the new active row so
--     the partial unique index on public.label_versions stays satisfiable.

BEGIN;

CREATE OR REPLACE FUNCTION public.complete_label_job(
    p_job_id UUID,
    p_status TEXT,
    p_file_url TEXT,
    p_file_size_bytes INTEGER,
    p_renderer_metadata JSONB DEFAULT NULL::JSONB,
    p_error_reason TEXT DEFAULT NULL::TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_job public.label_jobs%ROWTYPE;
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
    v_existing_label public.labels%ROWTYPE;
    v_existing_job_version public.label_versions%ROWTYPE;
    v_inserted_label BOOLEAN := FALSE;
    v_active_version_id UUID := NULL;
    v_active_version_number INTEGER := NULL;
    v_new_version_id UUID := NULL;
    v_new_version_number INTEGER := NULL;
    v_next_print_count INTEGER := 1;
    v_reprint_reason TEXT := NULL;
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
    FROM public.label_jobs
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

    IF lower(p_status) = 'succeeded'
       AND lower(v_job.status) = 'succeeded'
       AND v_job.completed_at IS NOT NULL THEN
        RETURN;
    END IF;

    v_reprint_reason := NULLIF(btrim(COALESCE(v_job.reprint_reason, '')), '');

    IF lower(p_status) = 'succeeded' THEN
        v_barcode := NULLIF(v_renderer ->> 'barcode', '');

        IF v_job.shipment_box_id IS NOT NULL THEN
            SELECT barcode
            INTO v_barcode
            FROM public.shipment_boxes
            WHERE id = v_job.shipment_box_id;
        END IF;

        IF v_barcode IS NULL THEN
            SELECT sb.barcode
            INTO v_barcode
            FROM public.shipment_boxes sb
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

        SELECT *
        INTO v_existing_job_version
        FROM public.label_versions
        WHERE label_job_id = v_job.id
        LIMIT 1
        FOR UPDATE;

        IF v_job.label_id IS NOT NULL THEN
            SELECT *
            INTO v_existing_label
            FROM public.labels
            WHERE id = v_job.label_id
              AND shipment_id = v_job.shipment_id
            FOR UPDATE;
        END IF;

        IF NOT FOUND THEN
            SELECT *
            INTO v_existing_label
            FROM public.labels
            WHERE shipment_id = v_job.shipment_id
              AND barcode = v_barcode
            ORDER BY generated_at DESC
            LIMIT 1
            FOR UPDATE;
        END IF;

        IF NOT FOUND AND v_existing_job_version.id IS NOT NULL THEN
            SELECT *
            INTO v_existing_label
            FROM public.labels
            WHERE id = v_existing_job_version.label_id
              AND shipment_id = v_existing_job_version.shipment_id
            FOR UPDATE;
        END IF;

        IF FOUND THEN
            v_label_id := v_existing_label.id;
            v_next_print_count := COALESCE(v_existing_label.print_count, 0) + 1;
        ELSE
            v_label_id := COALESCE(v_job.label_id, gen_random_uuid());

            INSERT INTO public.labels (
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
                renderer_metadata,
                active_version_id,
                active_version_number
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
                '{}'::jsonb,
                v_renderer,
                NULL,
                1
            )
            RETURNING *
            INTO v_existing_label;

            v_inserted_label := TRUE;
            v_next_print_count := 1;
        END IF;

        IF v_existing_job_version.id IS NOT NULL THEN
            v_new_version_id := v_existing_job_version.id;
            v_new_version_number := v_existing_job_version.version_number;
        ELSIF v_inserted_label THEN
            v_new_version_id := gen_random_uuid();
            v_new_version_number := 1;
        ELSE
            SELECT label_version_id, version_number
            INTO v_active_version_id, v_active_version_number
            FROM public.ensure_label_active_version_v1(v_existing_label.id, v_existing_label.shipment_id);

            IF lower(v_job.job_purpose) = 'reprint' THEN
                v_new_version_id := gen_random_uuid();
                v_new_version_number := COALESCE(v_active_version_number, 0) + 1;
            ELSE
                v_new_version_id := v_active_version_id;
                v_new_version_number := COALESCE(v_active_version_number, 1);
            END IF;
        END IF;

        v_label_metadata := jsonb_strip_nulls(jsonb_build_object(
            'label_job_id', v_job.id,
            'template', v_job.template_snapshot,
            'active_version_id', v_new_version_id,
            'active_version_number', v_new_version_number,
            'requested_source', v_job.requested_source,
            'reprint_reason', v_reprint_reason
        ));

        IF v_existing_job_version.id IS NOT NULL THEN
            UPDATE public.label_versions
            SET version_status = COALESCE(v_existing_job_version.version_status, 'active'),
                job_purpose = v_job.job_purpose,
                requested_source = COALESCE(v_job.requested_source, requested_source),
                reprint_reason = COALESCE(v_reprint_reason, reprint_reason),
                label_type = v_job.label_type,
                barcode = v_barcode,
                barcode_format = v_barcode_format,
                layout_template_id = v_job.template_id,
                file_url = p_file_url,
                file_size_bytes = COALESCE(p_file_size_bytes, 0),
                generated_by = v_job.requested_by,
                generated_at = v_now,
                print_count = v_next_print_count,
                last_printed_at = v_now,
                metadata = v_label_metadata,
                renderer_metadata = v_renderer,
                updated_at = v_now
            WHERE id = v_existing_job_version.id;
        ELSIF v_inserted_label OR lower(v_job.job_purpose) = 'reprint' THEN
            IF lower(v_job.job_purpose) = 'reprint' AND v_active_version_id IS NOT NULL THEN
                UPDATE public.label_versions
                SET version_status = 'superseded',
                    superseded_by_version_id = v_new_version_id,
                    superseded_at = v_now,
                    updated_at = v_now
                WHERE id = v_active_version_id
                  AND id <> v_new_version_id;
            END IF;

            INSERT INTO public.label_versions (
                id,
                label_id,
                shipment_id,
                organization_id,
                client_id,
                label_job_id,
                version_number,
                version_status,
                job_purpose,
                requested_source,
                reprint_reason,
                supersedes_version_id,
                superseded_by_version_id,
                superseded_at,
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
                renderer_metadata,
                created_at,
                updated_at
            )
            VALUES (
                v_new_version_id,
                v_existing_label.id,
                v_existing_label.shipment_id,
                v_existing_label.organization_id,
                v_existing_label.client_id,
                v_job.id,
                v_new_version_number,
                'active',
                v_job.job_purpose,
                v_job.requested_source,
                v_reprint_reason,
                CASE
                    WHEN lower(v_job.job_purpose) = 'reprint' THEN v_active_version_id
                    ELSE NULL
                END,
                NULL,
                NULL,
                v_job.label_type,
                v_barcode,
                v_barcode_format,
                v_job.template_id,
                p_file_url,
                COALESCE(p_file_size_bytes, 0),
                v_job.requested_by,
                v_now,
                v_next_print_count,
                v_now,
                v_label_metadata,
                v_renderer,
                v_now,
                v_now
            );
        ELSE
            UPDATE public.label_versions
            SET requested_source = COALESCE(v_job.requested_source, requested_source),
                label_type = v_job.label_type,
                barcode = v_barcode,
                barcode_format = v_barcode_format,
                layout_template_id = v_job.template_id,
                file_url = p_file_url,
                file_size_bytes = COALESCE(p_file_size_bytes, 0),
                generated_by = v_job.requested_by,
                generated_at = v_now,
                print_count = v_next_print_count,
                last_printed_at = v_now,
                metadata = v_label_metadata,
                renderer_metadata = v_renderer,
                updated_at = v_now
            WHERE id = v_active_version_id;
        END IF;

        UPDATE public.labels
        SET file_url = p_file_url,
            file_size_bytes = COALESCE(p_file_size_bytes, 0),
            generated_by = v_job.requested_by,
            generated_at = v_now,
            last_printed_at = v_now,
            print_count = v_next_print_count,
            label_type = v_job.label_type,
            layout_template_id = v_job.template_id,
            barcode_format = v_barcode_format,
            metadata = v_label_metadata,
            renderer_metadata = v_renderer,
            active_version_id = v_new_version_id,
            active_version_number = v_new_version_number
        WHERE id = v_existing_label.id
          AND shipment_id = v_existing_label.shipment_id;

        UPDATE public.label_jobs
        SET status = 'succeeded',
            completed_at = v_now,
            lease_expires_at = NULL,
            output_file_url = p_file_url,
            output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
            renderer_metadata = v_renderer,
            error_reason = NULL,
            label_id = v_existing_label.id
        WHERE id = v_job.id;

        INSERT INTO public.shipment_actions (
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
            jsonb_strip_nulls(jsonb_build_object(
                'label_job_id', v_job.id,
                'label_id', v_existing_label.id,
                'label_version_id', v_new_version_id,
                'label_version_number', v_new_version_number,
                'supersedes_label_version_id', CASE
                    WHEN lower(v_job.job_purpose) = 'reprint' THEN v_active_version_id
                    ELSE NULL
                END,
                'reprint_reason', v_reprint_reason,
                'attempts', v_job.attempts,
                'template_version', v_job.template_version
            )),
            v_now,
            v_now,
            'label_renderer'
        );

        PERFORM public.log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_job',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'complete_label_job',
            p_decision_outcome := 'render_succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'label_id', v_existing_label.id,
                'label_version_id', v_new_version_id,
                'label_version_number', v_new_version_number,
                'supersedes_label_version_id', CASE
                    WHEN lower(v_job.job_purpose) = 'reprint' THEN v_active_version_id
                    ELSE NULL
                END,
                'file_url', p_file_url,
                'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                'attempts', v_job.attempts + 1,
                'template_id', v_job.template_id,
                'template_version', v_job.template_version,
                'barcode', v_renderer->'barcode'
            )),
            p_decision_reason := v_reprint_reason,
            p_settings_resolution_id := v_settings_resolution_id
        );

        PERFORM public.log_decision(
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
                'barcode', v_renderer->'barcode',
                'label_version_id', v_new_version_id,
                'label_version_number', v_new_version_number
            )),
            p_decision_reason := COALESCE(v_reprint_reason, 'rendered'),
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
            UPDATE public.label_jobs
            SET status = 'failed',
                completed_at = v_now,
                lease_expires_at = NULL,
                renderer_metadata = v_renderer,
                error_reason = COALESCE(p_error_reason, 'max_attempts_exceeded')
            WHERE id = v_job.id;

            PERFORM public.log_decision(
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
            UPDATE public.label_jobs
            SET status = 'pending',
                lease_expires_at = NULL,
                scheduled_at = v_now + make_interval(secs => v_retry_seconds),
                renderer_metadata = v_renderer,
                error_reason = p_error_reason
            WHERE id = v_job.id;

            PERFORM public.log_decision(
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
    END IF;
END;
$function$;

COMMIT;
