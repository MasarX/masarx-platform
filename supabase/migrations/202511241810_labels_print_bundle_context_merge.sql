-- Migration: Labels print bundle context merge fix
-- Purpose: Preserve label_print context fields when applying bundle_response by
--          including prior state fields in the context_patch (shallow merge safe).

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_response public.workflow_handler_response;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_policy JSONB;
    v_options JSONB := COALESCE(v_label_state->'options', '{}'::jsonb);
    v_ready JSONB := COALESCE(v_label_state->'ready', '[]'::jsonb);
    v_counts JSONB := COALESCE(v_label_state->'counts', '{}'::jsonb);
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_expires_seconds INT;
    v_max_labels INT;
    v_bundle_payload JSONB;
    v_label_ids JSONB := '[]'::jsonb;
    v_file_urls JSONB := '[]'::jsonb;
    v_result JSONB;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: organization_id missing from context';
    END IF;

    v_policy := COALESCE(
        v_label_state->'policy',
        resolve_settings('label_print_policy', 'tenant', v_org_id),
        resolve_settings('label_print_policy', 'global', NULL),
        '{}'::jsonb
    );

    v_expires_seconds := COALESCE(
        (v_options->>'expires_seconds')::INT,
        (v_policy->>'default_expires_seconds')::INT
    );

    IF v_expires_seconds IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: default_expires_seconds missing for organization %', v_org_id;
    END IF;

    v_max_labels := COALESCE(
        (v_policy->>'max_labels_per_bundle')::INT
    );

    IF v_max_labels IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: max_labels_per_bundle missing for organization %', v_org_id;
    END IF;

    IF COALESCE(jsonb_array_length(v_ready), 0) = 0 THEN
        v_ready := COALESCE(
            (
                SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'shipment_id', l.shipment_id,
                    'shipment_box_id', NULL,
                    'box_number', NULL,
                    'label_id', l.id,
                    'file_url', l.file_url,
                    'label_type', l.label_type,
                    'generated_at', l.generated_at
                )), '[]'::jsonb)
                FROM labels l
                WHERE l.shipment_id = ANY (
                    SELECT (ship->>'shipment_id')::uuid
                    FROM jsonb_array_elements(COALESCE(v_context->'payload'->'shipments', '[]'::jsonb)) AS ship
                )
            ),
            '[]'::jsonb
        );
    END IF;

    IF COALESCE(jsonb_array_length(v_ready), 0) > v_max_labels THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: ready labels (%) exceed max bundle limit (%)',
            jsonb_array_length(v_ready), v_max_labels;
    END IF;

    v_label_ids := COALESCE(
        (SELECT jsonb_agg(elem->'label_id') FROM jsonb_array_elements(v_ready) elem),
        '[]'::jsonb
    );
    v_file_urls := COALESCE(
        (SELECT jsonb_agg(elem->'file_url') FROM jsonb_array_elements(v_ready) elem),
        '[]'::jsonb
    );

    v_bundle_payload := jsonb_build_object(
        'bundle', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'file_urls', v_file_urls,
            'label_ids', v_label_ids,
            'expires_seconds', v_expires_seconds,
            'metadata', jsonb_build_object('counts', v_counts, 'options', v_options)
        ))
    );

    v_result := invoke_label_renderer(NULL, v_bundle_payload);

    IF COALESCE(v_result->>'status', '') NOT IN ('ok', 'idle', 'completed') THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := COALESCE(v_result->>'error', 'label_bundle_failed');
        v_response.operation_result := v_result;
        RETURN v_response;
    END IF;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('status','ok','bundle', v_result));
    v_response.context_patch := jsonb_build_object('label_print', jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'counts', v_counts,
        'options', v_options,
        'policy', v_policy,
        'ready', v_ready,
        'bundle_response', v_result
    )));

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Bundle labels via edge; preserves label_print context by including prior fields in context_patch.';

COMMIT;
