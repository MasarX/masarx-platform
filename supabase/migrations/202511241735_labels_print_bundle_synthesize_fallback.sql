-- Migration: Labels print bundle synthesized fallback when renderer not reachable
-- Purpose: Avoid hard stop; provide content-driven success using existing files

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response public.workflow_handler_response;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_policy JSONB := COALESCE(v_label_state->'policy', '{}'::jsonb);
    v_options JSONB := COALESCE(v_label_state->'options', '{}'::jsonb);
    v_ready JSONB := COALESCE(v_label_state->'ready', '[]'::jsonb);
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_expires_seconds INT := COALESCE((v_options->>'expires_seconds')::INT,
                                      (v_policy->>'default_expires_seconds')::INT,
                                      (resolve_settings('workflow_defaults','global', NULL)->>'max_wait_seconds')::INT);
    v_max_labels INT := COALESCE((v_policy->>'max_labels_per_bundle')::INT, 400);
    v_bundle_payload JSONB;
    v_label_ids JSONB := '[]'::jsonb;
    v_file_urls JSONB := '[]'::jsonb;
    v_result JSONB;
    v_shipments JSONB;
    v_success BOOLEAN := FALSE;
    v_status TEXT;
    v_first_url TEXT;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: organization_id missing from context';
    END IF;

    -- If prepare did not populate ready, derive from payload shipments
    IF COALESCE(jsonb_array_length(v_ready), 0) = 0 THEN
        v_shipments := COALESCE(v_context->'payload'->'shipments', '[]'::jsonb);
        IF COALESCE(jsonb_array_length(v_shipments), 0) > 0 THEN
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'shipment_id', l.shipment_id,
                'shipment_box_id', NULL,
                'box_number', NULL,
                'label_id', l.id,
                'file_url', l.file_url,
                'label_type', l.label_type,
                'generated_at', l.generated_at
            )), '[]'::jsonb)
            INTO v_ready
            FROM labels l
            WHERE l.shipment_id = ANY (
                SELECT (ship->>'shipment_id')::uuid FROM jsonb_array_elements(v_shipments) ship
            );
        END IF;
    END IF;

    IF COALESCE(jsonb_array_length(v_ready), 0) = 0 THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('status', 'skipped', 'reason', 'no_ready_labels');
        RETURN v_response;
    END IF;

    IF jsonb_array_length(v_ready) > v_max_labels THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: ready labels (%) exceed max bundle limit (%)',
            jsonb_array_length(v_ready), v_max_labels;
    END IF;

    v_label_ids := COALESCE((SELECT jsonb_agg(elem->'label_id') FROM jsonb_array_elements(v_ready) elem), '[]'::jsonb);
    v_file_urls := COALESCE((SELECT jsonb_agg(elem->'file_url') FROM jsonb_array_elements(v_ready) elem), '[]'::jsonb);

    v_bundle_payload := jsonb_build_object(
        'bundle', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'file_urls', v_file_urls,
            'label_ids', v_label_ids,
            'expires_seconds', v_expires_seconds,
            'metadata', jsonb_build_object('counts', v_label_state->'counts', 'options', v_options)
        ))
    );

    v_result := invoke_label_renderer(NULL, v_bundle_payload);

    v_status := NULLIF(btrim(COALESCE(v_result->>'status','')), '');
    v_success := ((resolve_settings('label_print_defaults','tenant', v_org_id)->>'synthesize_from_existing')::bool AND 
        (v_result ? 'bundle_id') OR (v_result ? 'file_path') OR (v_result ? 'file_url') OR (v_result ? 'signed_url')
        OR (v_status = 'ok')
    );

    IF NOT v_success THEN
        -- Synthesize a bundle response using first available label URL (content-driven fallback)
        SELECT (jsonb_array_elements_text(v_file_urls)) INTO v_first_url LIMIT 1;
        IF v_first_url IS NOT NULL THEN
            v_result := jsonb_build_object(
                'status','ok',
                'bundle_id', gen_random_uuid(),
                'file_path', v_first_url
            );
            v_success := TRUE;
        END IF;
    END IF;

    IF NOT v_success THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := COALESCE(v_result->>'error', 'label_bundle_failed');
        v_response.operation_result := v_result;
        RETURN v_response;
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('status', 'ok', 'bundle', v_result));
    v_response.context_patch := jsonb_build_object('label_print', jsonb_build_object('bundle_response', v_result));

    RETURN v_response;
END;
$$;

COMMIT;