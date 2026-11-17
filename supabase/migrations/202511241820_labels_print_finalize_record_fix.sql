-- Migration: record_label_print fix to include organization_id and client_id
-- Purpose: Ensure shipment_actions inserts satisfy NOT NULL FKs without hardcoding.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION record_label_print(
    p_bundle_id UUID,
    p_org_id UUID,
    p_requested_by UUID,
    p_correlation_id TEXT,
    p_signed_url TEXT,
    p_file_path TEXT,
    p_counts JSONB,
    p_errors JSONB,
    p_included JSONB
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_row RECORD;
    v_decision_id UUID;
    v_item JSONB;
    v_shipment_id UUID;
    v_label_ids JSONB;
    v_client_id UUID;
BEGIN
    v_decision_id := log_decision(
        p_organization_id := p_org_id,
        p_decision_category := 'label_print',
        p_resource_type := 'label_bundle',
        p_resource_id := p_bundle_id,
        p_decision_point := 'labels_print_request',
        p_decision_outcome := 'completed',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := CASE WHEN p_correlation_id ~ '^[0-9a-fA-F-]{8}-' THEN p_correlation_id::uuid ELSE NULL END,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'file_path', p_file_path,
            'signed_url', p_signed_url,
            'counts', COALESCE(p_counts, '{}'::jsonb),
            'errors', COALESCE(p_errors, '{}'::jsonb)
        )),
        p_decision_reason := NULL
    );

    IF p_included IS NOT NULL AND jsonb_typeof(p_included) = 'array' THEN
        FOR v_row IN SELECT value FROM jsonb_array_elements(p_included) AS t(value) LOOP
            v_item := v_row.value;
            v_shipment_id := NULLIF(v_item->>'shipment_id', '')::uuid;
            v_label_ids := COALESCE(v_item->'label_ids', '[]'::jsonb);

            IF v_shipment_id IS NULL THEN CONTINUE; END IF;

            SELECT client_id INTO v_client_id FROM shipments WHERE id = v_shipment_id;

            INSERT INTO shipment_actions (
                id, shipment_id, action_type, action_category,
                action_data, "timestamp", created_at, performed_by_system,
                organization_id, client_id
            ) VALUES (
                gen_random_uuid(), v_shipment_id,
                'label_printed', 'operational',
                jsonb_strip_nulls(jsonb_build_object(
                    'bundle_id', p_bundle_id,
                    'label_ids', v_label_ids,
                    'counts', p_counts,
                    'errors', p_errors,
                    'requested_by', p_requested_by,
                    'file_path', p_file_path
                )),
                now(), now(), 'workflow_engine',
                p_org_id, v_client_id
            )
            ON CONFLICT DO NOTHING;
        END LOOP;
    END IF;

    RETURN v_decision_id;
END;
$$;

COMMENT ON FUNCTION record_label_print(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB)
    IS 'Persist decision_log and shipment_actions audit entries for label bundling responses (includes org/client).';

COMMIT;

