-- Migration: Labels print prepare started-run payload hydration
-- Purpose: Allow execute_label_print_prepare_v1 to retrieve payload/bundle data
--          from the starter workflow run when follow-up context lacks shipments.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_prepare_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_row RECORD;
    v_item JSONB;
    v_response workflow_handler_response;
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_bundle JSONB := COALESCE(v_payload->'bundle', '{}'::jsonb);
    v_shipments JSONB := COALESCE(v_payload->'shipments', '[]'::jsonb);
    v_options JSONB := COALESCE(v_payload->'options', '{}'::jsonb);
    v_org_id UUID := COALESCE(
        NULLIF(v_context->>'organization_id', '')::uuid,
        NULLIF(v_payload->>'organization_id', '')::uuid,
        NULLIF(v_bundle->>'organization_id', '')::uuid
    );
    v_policy JSONB;
    v_defaults JSONB;
    v_poll_seconds INT;
    v_max_wait_seconds INT;
    v_targets JSONB := '[]'::jsonb;
    v_ready JSONB := '[]'::jsonb;
    v_pending JSONB := '[]'::jsonb;
    v_timed_out JSONB := '[]'::jsonb;
    v_out_of_scope JSONB := '[]'::jsonb;
    v_invalid_boxes JSONB := '[]'::jsonb;
    v_counts JSONB := '{}'::jsonb;
    v_now TIMESTAMPTZ := now();
    v_elapsed INT := GREATEST(0, (extract(epoch FROM (v_now - p_step.enqueued_at)))::INT);
    v_has_enqueued BOOLEAN := COALESCE((v_context->'label_print'->>'generation_enqueued')::BOOLEAN, FALSE);
    v_total_requested INT := 0;
    v_in_scope INT := 0;
    v_ready_count INT := 0;
    v_pending_count INT := 0;
    v_out_scope_count INT := 0;
    v_invalid_box_count INT := 0;
    v_has_shipments BOOLEAN := jsonb_typeof(v_shipments) = 'array' AND jsonb_array_length(v_shipments) > 0;
    v_generation_source TEXT := COALESCE(NULLIF(v_metadata->>'requested_source', ''), 'workflow.labels_print');
    v_label_id_array UUID[] := NULL;
    v_started_run_id UUID;
    v_started_context JSONB := '{}'::jsonb;
BEGIN
    v_started_run_id := COALESCE(
        NULLIF(p_run.metadata->>'started_by_run_id', '')::uuid,
        NULLIF(v_context->>'started_by_run_id', '')::uuid
    );

    IF v_started_run_id IS NOT NULL THEN
        SELECT context
        INTO v_started_context
        FROM workflow_runs
        WHERE id = v_started_run_id;

        IF NOT FOUND OR v_started_context IS NULL THEN
            v_started_context := '{}'::jsonb;
        END IF;
    END IF;

    IF v_org_id IS NULL THEN
        v_org_id := COALESCE(
            NULLIF(v_started_context->>'organization_id', '')::uuid,
            NULLIF(v_started_context->'payload'->>'organization_id', '')::uuid,
            NULLIF(v_started_context->'workflow'->'context_patch'->>'organization_id', '')::uuid
        );
    END IF;

    IF (v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' OR v_payload = '{}'::jsonb) THEN
        v_payload := COALESCE(v_started_context->'payload', '{}'::jsonb);
    END IF;

    IF (v_bundle IS NULL OR jsonb_typeof(v_bundle) <> 'object' OR v_bundle = '{}'::jsonb) THEN
        v_bundle := COALESCE(
            v_payload->'bundle',
            v_started_context->'payload'->'bundle',
            '{}'::jsonb
        );
    END IF;

    IF (NOT v_has_shipments) THEN
        v_shipments := COALESCE(
            v_shipments,
            v_payload->'shipments',
            v_payload->'bundle_shipments',
            v_started_context->'payload'->'shipments',
            v_started_context->'payload'->'bundle_shipments',
            '[]'::jsonb
        );
        v_has_shipments := jsonb_typeof(v_shipments) = 'array' AND jsonb_array_length(v_shipments) > 0;
    END IF;

    IF (v_options IS NULL OR jsonb_typeof(v_options) <> 'object' OR v_options = '{}'::jsonb) THEN
        v_options := COALESCE(
            v_payload->'options',
            v_started_context->'payload'->'options',
            '{}'::jsonb
        );
    END IF;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_print_prepare_v1: organization_id not present in workflow context';
    END IF;

    v_policy := resolve_settings('label_print_policy', 'tenant', v_org_id);
    v_defaults := COALESCE(
        resolve_settings('label_print_defaults', 'tenant', v_org_id),
        resolve_settings('label_print_defaults', 'global', NULL),
        '{}'::jsonb
    );
    v_poll_seconds := COALESCE(NULLIF(v_metadata->>'poll_interval_seconds', '')::INT, (v_policy->>'poll_interval_seconds')::INT, 60);
    v_max_wait_seconds := COALESCE(NULLIF(v_metadata->>'max_wait_seconds', '')::INT, (v_policy->>'max_wait_seconds')::INT, 900);

    -- Try deriving shipments from bundle when not provided explicitly
    IF NOT v_has_shipments THEN
        IF jsonb_typeof(v_bundle->'shipments') = 'array' AND jsonb_array_length(v_bundle->'shipments') > 0 THEN
            v_shipments := v_bundle->'shipments';
            v_has_shipments := TRUE;
        ELSIF jsonb_typeof(v_payload->'bundle_shipments') = 'array' AND jsonb_array_length(v_payload->'bundle_shipments') > 0 THEN
            v_shipments := v_payload->'bundle_shipments';
            v_has_shipments := TRUE;
        END IF;
    END IF;

    -- Fallback: resolve ready labels directly from bundle.label_ids
    IF NOT v_has_shipments THEN
        SELECT array_agg(elem::uuid)
        INTO v_label_id_array
        FROM jsonb_array_elements_text(COALESCE(v_bundle->'label_ids', '[]'::jsonb)) elem;

        IF v_label_id_array IS NOT NULL AND array_length(v_label_id_array, 1) > 0 THEN
            WITH resolved AS (
                SELECT *
                FROM resolve_label_files_for_bundle(v_org_id, NULL, v_label_id_array)
            ),
            shipments_agg AS (
                SELECT
                    jsonb_agg(
                        jsonb_strip_nulls(
                            jsonb_build_object(
                                'shipment_id', r.shipment_id
                            )
                        )
                    ) AS shipments
                FROM resolved r
            )
            SELECT
                COALESCE(
                    jsonb_agg(
                        jsonb_strip_nulls(
                            jsonb_build_object(
                                'shipment_id', r.shipment_id,
                                'shipment_box_id', r.shipment_box_id,
                                'box_number', r.box_number,
                                'label_id', r.label_id,
                                'file_url', r.file_url,
                                'label_type', r.label_type,
                                'generated_at', r.generated_at,
                                'status', 'ready'
                            )
                        )
                    ),
                    '[]'::jsonb
                ),
                COALESCE((SELECT shipments FROM shipments_agg), '[]'::jsonb)
            INTO v_ready, v_shipments
            FROM resolved r;

            v_has_shipments := jsonb_array_length(v_shipments) > 0;
            v_total_requested := jsonb_array_length(v_shipments);
            v_in_scope := v_total_requested;
            v_ready_count := jsonb_array_length(v_ready);
            v_pending := '[]'::jsonb;
            v_timed_out := '[]'::jsonb;
            v_out_of_scope := '[]'::jsonb;
            v_invalid_boxes := '[]'::jsonb;
            v_has_enqueued := FALSE;
        END IF;
    END IF;

    -- If shipments were supplied (or derived) we can attempt the standard shipment/box resolution
    IF v_has_shipments AND jsonb_array_length(v_ready) = 0 THEN
        WITH shipments_raw AS (
            SELECT
                (ship->>'shipment_id')::uuid AS shipment_id,
                ship->'box_ids' AS box_ids
            FROM jsonb_array_elements(v_shipments) AS ship
            WHERE ship ? 'shipment_id'
        ),
        explicit_boxes AS (
            SELECT
                sr.shipment_id,
                box_text::uuid AS shipment_box_id
            FROM shipments_raw sr
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sr.box_ids, '[]'::jsonb)) boxs(box_text)
            WHERE box_text ~ '^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{12}$'
        ),
        in_scope_shipments AS (
            SELECT s.id AS shipment_id, s.organization_id, s.client_id
            FROM shipments s
            JOIN shipments_raw sr ON sr.shipment_id = s.id
            WHERE s.organization_id = v_org_id
        ),
        target_boxes AS (
            SELECT sb.id AS shipment_box_id, sb.shipment_id, sb.box_number, sb.barcode
            FROM in_scope_shipments iss
            JOIN shipment_boxes sb ON sb.shipment_id = iss.shipment_id
            WHERE NOT EXISTS (SELECT 1 FROM explicit_boxes eb WHERE eb.shipment_id = iss.shipment_id)
               OR EXISTS (SELECT 1 FROM explicit_boxes eb WHERE eb.shipment_id = iss.shipment_id AND eb.shipment_box_id = sb.id)
        ),
        latest_labels AS (
            SELECT DISTINCT ON (l.shipment_id, l.barcode)
                l.shipment_id,
                l.barcode,
                l.id,
                l.file_url,
                l.label_type,
                l.generated_at
            FROM labels l
            JOIN in_scope_shipments iss ON iss.shipment_id = l.shipment_id
            ORDER BY l.shipment_id, l.barcode, l.generated_at DESC
        ),
        targets AS (
            SELECT
                tb.shipment_id,
                tb.shipment_box_id,
                tb.box_number,
                ll.id AS label_id,
                ll.file_url,
                ll.label_type,
                ll.generated_at,
                CASE WHEN ll.id IS NULL THEN 'missing' ELSE 'ready' END AS status
            FROM target_boxes tb
            LEFT JOIN latest_labels ll ON ll.shipment_id = tb.shipment_id AND ll.barcode = tb.barcode
        ),
        out_of_scope AS (
            SELECT sr.shipment_id
            FROM shipments_raw sr
            LEFT JOIN in_scope_shipments iss ON iss.shipment_id = sr.shipment_id
            WHERE iss.shipment_id IS NULL
        ),
        invalid_box_requests AS (
            SELECT eb.shipment_id, eb.shipment_box_id
            FROM explicit_boxes eb
            LEFT JOIN shipment_boxes sb ON sb.id = eb.shipment_box_id
            WHERE sb.id IS NULL
        )
        SELECT
            COALESCE(jsonb_agg(jsonb_build_object(
                'shipment_id', t.shipment_id,
                'shipment_box_id', t.shipment_box_id,
                'box_number', t.box_number,
                'label_id', t.label_id,
                'file_url', t.file_url,
                'label_type', t.label_type,
                'generated_at', t.generated_at,
                'status', t.status
            ) ORDER BY t.shipment_id, t.box_number), '[]'::jsonb),
            COALESCE(jsonb_agg(jsonb_build_object('shipment_id', o.shipment_id)), '[]'::jsonb),
            COALESCE(jsonb_agg(jsonb_build_object('shipment_id', i.shipment_id, 'shipment_box_id', i.shipment_box_id)), '[]'::jsonb),
            COUNT(DISTINCT t.shipment_id),
            COUNT(DISTINCT sr.shipment_id)
        INTO v_targets, v_out_of_scope, v_invalid_boxes, v_in_scope, v_total_requested
        FROM shipments_raw sr
        LEFT JOIN targets t ON t.shipment_id = sr.shipment_id
        LEFT JOIN out_of_scope o ON o.shipment_id = sr.shipment_id
        LEFT JOIN invalid_box_requests i ON i.shipment_id = sr.shipment_id;

        v_ready := COALESCE(
            (SELECT jsonb_agg(elem) FROM jsonb_array_elements(v_targets) elem WHERE elem->>'status' = 'ready'),
            '[]'::jsonb
        );
        v_pending := COALESCE(
            (SELECT jsonb_agg(elem) FROM jsonb_array_elements(v_targets) elem WHERE elem->>'status' = 'missing'),
            '[]'::jsonb
        );
        v_ready_count := jsonb_array_length(v_ready);
        v_pending_count := jsonb_array_length(v_pending);
        v_out_scope_count := COALESCE(jsonb_array_length(v_out_of_scope), 0);
        v_invalid_box_count := COALESCE(jsonb_array_length(v_invalid_boxes), 0);
    END IF;

    -- Enqueue missing labels only when pending jobs exist
    IF jsonb_array_length(v_pending) > 0 THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_pending)
        LOOP
            PERFORM request_label_generation(
                NULLIF(v_item->>'shipment_id', '')::uuid,
                'shipping',
                p_run.requested_by,
                v_generation_source,
                NULLIF(v_item->>'shipment_box_id', '')::uuid,
                'reprint'
            );
        END LOOP;
        v_has_enqueued := TRUE;
    END IF;

    IF jsonb_array_length(v_pending) > 0 AND v_elapsed < v_max_wait_seconds THEN
        v_response.status := 'pending';
        v_response.next_run_at := v_now + make_interval(secs => LEAST(GREATEST(v_poll_seconds, 10), 300));
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    ELSE
        IF jsonb_array_length(v_pending) > 0 THEN
            v_timed_out := v_pending;
            v_pending := '[]'::jsonb;
        END IF;
        v_response.status := 'completed';
    END IF;

    v_counts := jsonb_build_object(
        'requested', v_total_requested,
        'in_scope', v_in_scope,
        'ready', v_ready_count,
        'pending', v_pending_count,
        'timed_out', COALESCE(jsonb_array_length(v_timed_out), 0),
        'out_of_scope', v_out_scope_count,
        'invalid_box_requests', v_invalid_box_count
    );

    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', v_response.status,
        'ready', v_ready,
        'pending', v_pending,
        'timed_out', v_timed_out,
        'out_of_scope', v_out_of_scope,
        'invalid_boxes', v_invalid_boxes,
        'counts', v_counts,
        'policy', v_policy
    ));

    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
        'label_print', jsonb_build_object(
            'organization_id', v_org_id,
            'generation_enqueued', v_has_enqueued,
            'ready', v_ready,
            'pending', v_pending,
            'timed_out', v_timed_out,
            'out_of_scope', v_out_of_scope,
            'invalid_boxes', v_invalid_boxes,
            'counts', v_counts,
            'options', v_options,
            'policy', v_policy,
            'shipments', COALESCE(v_shipments, '[]'::jsonb)
        )
    ));

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Prepare label print workflow by resolving payload/bundle data from starter runs and persisting shipment state for downstream steps.';

COMMIT;
