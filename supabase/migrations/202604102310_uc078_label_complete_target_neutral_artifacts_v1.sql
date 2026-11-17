-- Migration: restore target-neutral label completion to label_artifacts
-- Purpose:
--   - Keep the shipment reprint implementation intact under a preserved name.
--   - Route target-neutral label completions to label_artifacts instead of labels.

BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.complete_label_job(
    UUID,
    TEXT,
    TEXT,
    INTEGER,
    JSONB,
    TEXT
) RENAME TO complete_label_job_shipment_v1;

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
        IF v_job.shipment_id IS NULL THEN
            v_barcode := NULLIF(v_renderer ->> 'barcode', '');
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
            v_label_metadata := jsonb_strip_nulls(
                jsonb_build_object(
                    'label_job_id', v_job.id,
                    'template', v_job.template_snapshot,
                    'target', CASE
                        WHEN v_job.target_type IS NULL THEN NULL
                        ELSE jsonb_build_object(
                            'target_type', v_job.target_type,
                            'target_id', v_job.target_id,
                            'target_box_id', v_job.target_box_id
                        )
                    END,
                    'target_metadata', CASE
                        WHEN v_job.target_type IS NULL THEN NULL
                        ELSE COALESCE(v_job.target_metadata, '{}'::jsonb)
                    END,
                    'requested_source', v_job.requested_source,
                    'reprint_reason', v_reprint_reason
                )
            );

            INSERT INTO public.label_artifacts (
                id,
                organization_id,
                client_id,
                target_type,
                target_id,
                target_box_id,
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
                source_label_job_id,
                metadata,
                renderer_metadata
            )
            VALUES (
                v_label_id,
                v_job.organization_id,
                v_job.client_id,
                v_job.target_type,
                v_job.target_id,
                v_job.target_box_id,
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
                v_job.id,
                v_label_metadata,
                v_renderer
            )
            ON CONFLICT (source_label_job_id) DO UPDATE
            SET file_url = EXCLUDED.file_url,
                file_size_bytes = EXCLUDED.file_size_bytes,
                generated_by = EXCLUDED.generated_by,
                generated_at = EXCLUDED.generated_at,
                last_printed_at = EXCLUDED.last_printed_at,
                print_count = public.label_artifacts.print_count + 1,
                metadata = EXCLUDED.metadata,
                renderer_metadata = EXCLUDED.renderer_metadata;

            UPDATE public.label_jobs
            SET status = 'succeeded',
                completed_at = v_now,
                lease_expires_at = NULL,
                output_file_url = p_file_url,
                output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
                renderer_metadata = v_renderer,
                error_reason = NULL,
                label_id = v_label_id
            WHERE id = v_job.id;

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
                    'label_id', v_label_id,
                    'file_url', p_file_url,
                    'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                    'attempts', v_job.attempts + 1,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version,
                    'target_type', v_job.target_type,
                    'target_id', v_job.target_id,
                    'target_box_id', v_job.target_box_id
                )),
                p_decision_reason := COALESCE(v_reprint_reason, 'rendered'),
                p_settings_resolution_id := v_settings_resolution_id
            );

            RETURN;
        END IF;

        PERFORM public.complete_label_job_shipment_v1(
            p_job_id,
            p_status,
            p_file_url,
            p_file_size_bytes,
            p_renderer_metadata,
            p_error_reason
        );
        RETURN;
    END IF;

    PERFORM public.complete_label_job_shipment_v1(
        p_job_id,
        p_status,
        p_file_url,
        p_file_size_bytes,
        p_renderer_metadata,
        p_error_reason
    );
END;
$function$;

COMMENT ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
    IS 'Mark a label job as succeeded or failed, keep shipment-backed labels current via the preserved shipment function, and persist target-neutral renders in label_artifacts.';

REVOKE ALL ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) TO edge_label_renderer_role;

COMMIT;
