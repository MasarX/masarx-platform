-- Migration: Labels print workflow orchestration and helpers
-- Purpose: Introduce policy, helper functions, workflow handlers, and workflow template
--          to support label bundling into single printable PDFs.

BEGIN;

-- =============================================================================
-- Section 1: Schema registry + default policy for label_print_policy
-- =============================================================================

WITH policy_schema AS (
    SELECT $$
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "label_print_policy.schema.json",
      "title": "label_print_policy",
      "type": "object",
      "required": ["version", "max_labels_per_bundle", "default_expires_seconds"],
      "additionalProperties": false,
      "properties": {
        "version": { "type": "integer", "minimum": 1 },
        "max_labels_per_bundle": { "type": "integer", "minimum": 1 },
        "max_pages_per_bundle": { "type": "integer", "minimum": 1 },
        "max_bytes_per_bundle": { "type": "integer", "minimum": 1024 },
        "default_expires_seconds": { "type": "integer", "minimum": 60 },
        "poll_interval_seconds": { "type": "integer", "minimum": 5 },
        "max_wait_seconds": { "type": "integer", "minimum": 60 },
        "max_failed_labels": { "type": "integer", "minimum": 0 }
      }
    }
    $$::jsonb AS schema_doc,
    $$[
      {
        "version": 1,
        "max_labels_per_bundle": 400,
        "max_pages_per_bundle": 400,
        "max_bytes_per_bundle": 26214400,
        "default_expires_seconds": 900,
        "poll_interval_seconds": 60,
        "max_wait_seconds": 900,
        "max_failed_labels": 10
      }
    ]$$::jsonb AS examples
)
INSERT INTO schema_registry (id, category, version, schema, description, examples, is_active, created_at)
SELECT
    'bbbb0000-0000-0000-0000-000000001111',
    'label_print_policy',
    1,
    policy_schema.schema_doc,
    'Governance policy for label print bundling (limits, expirations, wait strategy).',
    policy_schema.examples,
    TRUE,
    workflow_now()
FROM policy_schema
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

WITH default_policy AS (
    SELECT $$
    {
      "version": 1,
      "max_labels_per_bundle": 400,
      "max_pages_per_bundle": 400,
      "max_bytes_per_bundle": 26214400,
      "default_expires_seconds": 900,
      "poll_interval_seconds": 60,
      "max_wait_seconds": 900,
      "max_failed_labels": 10
    }
    $$::jsonb AS payload
)
INSERT INTO settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
)
SELECT
    '77770000-0000-0000-0000-000000001111',
    'label_print_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    default_policy.payload,
    1,
    'Initial label print policy baseline',
    workflow_now(),
    workflow_now()
FROM default_policy
ON CONFLICT (id, scope_hash) DO UPDATE
SET value = EXCLUDED.value,
    change_reason = EXCLUDED.change_reason,
    approved_at = EXCLUDED.approved_at,
    effective_from = EXCLUDED.effective_from;

WITH default_policy AS (
    SELECT $$
    {
      "version": 1,
      "max_labels_per_bundle": 400,
      "max_pages_per_bundle": 400,
      "max_bytes_per_bundle": 26214400,
      "default_expires_seconds": 900,
      "poll_interval_seconds": 60,
      "max_wait_seconds": 900,
      "max_failed_labels": 10
    }
    $$::jsonb AS payload
)
INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
)
SELECT
    '66660000-0000-0000-0000-000000001111',
    'label_print_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    '77770000-0000-0000-0000-000000001111',
    default_policy.payload,
    workflow_now()
FROM default_policy
ON CONFLICT (category, scope_type, scope_id) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

-- =============================================================================
-- Section 2: Update invoke_label_renderer signature to accept payload
-- =============================================================================

DROP FUNCTION IF EXISTS invoke_label_renderer(INT);

CREATE OR REPLACE FUNCTION invoke_label_renderer(
    p_max_jobs INT DEFAULT 5,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_row RECORD;
    v_item JSONB;
    v_settings JSONB;
    v_provider JSONB;
    v_url TEXT;
    v_secret TEXT;
    v_timeout_ms INT;
    v_timeout_seconds INT;
    v_headers JSONB;
    v_body JSONB;
    v_response JSONB;
BEGIN
    SELECT cached_value
    INTO v_settings
    FROM settings
    WHERE category = 'label_provider'
      AND scope_type = 'global'
    ORDER BY last_updated DESC
    LIMIT 1;

    IF v_settings IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: label_provider settings not found';
    END IF;

    v_provider := COALESCE((v_settings->'providers')->0, '{}'::jsonb);

    v_url := NULLIF(v_provider->>'invoke_url', '');
    v_secret := NULLIF(v_provider->>'invoke_secret', '');
    v_timeout_ms := COALESCE((v_provider->>'timeout_ms')::INT, 15000);

    IF v_url IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_url missing in label_provider configuration';
    END IF;

    IF v_secret IS NULL THEN
        RAISE EXCEPTION 'invoke_label_renderer: invoke_secret missing in label_provider configuration';
    END IF;

    IF v_url LIKE 'https://example.%' OR v_secret = 'EXAMPLE_PASSWORD' THEN
        RAISE EXCEPTION 'invoke_label_renderer: provider invoke configuration not activated (update settings)';
    END IF;

    v_headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_secret)
    );

    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object' THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    v_timeout_seconds := GREATEST((v_timeout_ms + 999) / 1000, 1);

    v_response := call_api(
        v_url,
        'POST',
        v_headers,
        v_body,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_body,
        'provider_name', v_provider->>'name'
    );
END;
$$;

COMMENT ON FUNCTION invoke_label_renderer(INT, JSONB)
    IS 'Trigger label renderer edge worker using settings; supports job leasing and bundle payloads.';

GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT, JSONB) TO service_role;

-- =============================================================================
-- Section 3: Helper functions (resolve_label_files_for_bundle, record_label_print)
-- =============================================================================

CREATE OR REPLACE FUNCTION resolve_label_files_for_bundle(
    p_org_id UUID,
    p_shipment_ids UUID[] DEFAULT NULL,
    p_label_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
    label_id UUID,
    shipment_id UUID,
    shipment_box_id UUID,
    file_url TEXT,
    box_number INT,
    label_type TEXT,
    generated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
    WITH shipments_scope AS (
        SELECT s.id AS shipment_id
        FROM shipments s
        WHERE s.organization_id = p_org_id
          AND (p_shipment_ids IS NULL OR s.id = ANY(p_shipment_ids))
    ),
    latest_labels AS (
        SELECT DISTINCT ON (l.shipment_id, l.barcode)
            l.id,
            l.shipment_id,
            l.barcode,
            l.file_url,
            l.label_type,
            l.generated_at
        FROM labels l
        JOIN shipments_scope ss ON ss.shipment_id = l.shipment_id
        WHERE p_label_ids IS NULL OR l.id = ANY(p_label_ids)
        ORDER BY l.shipment_id, l.barcode, l.generated_at DESC
    )
    SELECT
        ll.id AS label_id,
        ll.shipment_id,
        sb.id AS shipment_box_id,
        ll.file_url,
        sb.box_number,
        ll.label_type,
        ll.generated_at
    FROM latest_labels ll
    LEFT JOIN shipment_boxes sb
           ON sb.shipment_id = ll.shipment_id
          AND sb.barcode = ll.barcode
    ORDER BY ll.shipment_id, sb.box_number NULLS LAST, ll.generated_at DESC;
$$;

COMMENT ON FUNCTION resolve_label_files_for_bundle(UUID, UUID[], UUID[])
    IS 'Return latest label file references for an organization (filtered by shipments/label_ids).';

GRANT EXECUTE ON FUNCTION resolve_label_files_for_bundle(UUID, UUID[], UUID[]) TO service_role;

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
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_row RECORD;
    v_decision_id UUID;
    v_item JSONB;
    v_shipment_id UUID;
    v_label_ids JSONB;
BEGIN
    v_decision_id := log_decision(
        p_organization_id := p_org_id,
        p_decision_category := 'label_print',
        p_resource_type := 'label_bundle',
        p_resource_id := p_bundle_id,
        p_decision_point := 'labels_print_request',
        p_decision_outcome := 'completed',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := CASE
            WHEN p_correlation_id ~ '^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{12}$'
                THEN p_correlation_id::uuid
            ELSE NULL
        END,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'file_path', p_file_path,
            'signed_url', p_signed_url,
            'counts', COALESCE(p_counts, '{}'::jsonb),
            'errors', COALESCE(p_errors, '{}'::jsonb)
        )),
        p_decision_reason := NULL
    );

    IF p_included IS NOT NULL AND jsonb_typeof(p_included) = 'array' THEN
        FOR v_row IN SELECT value FROM jsonb_array_elements(p_included) AS t(value)
        LOOP
            v_item := v_row.value;
            v_shipment_id := NULLIF(v_item->>'shipment_id', '')::uuid;
            v_label_ids := COALESCE(v_item->'label_ids', '[]'::jsonb);

            IF v_shipment_id IS NULL THEN
                CONTINUE;
            END IF;

            INSERT INTO shipment_actions (
                id,
                shipment_id,
                action_type,
                action_category,
                action_data,
                timestamp,
                created_at,
                performed_by_system
            ) VALUES (
                gen_random_uuid(),
                v_shipment_id,
                'label_printed',
                'operational',
                jsonb_strip_nulls(jsonb_build_object(
                    'bundle_id', p_bundle_id,
                    'label_ids', v_label_ids,
                    'counts', p_counts,
                    'errors', p_errors,
                    'requested_by', p_requested_by,
                    'file_path', p_file_path
                )),
                now(),
                now(),
                'workflow_engine'
            )
            ON CONFLICT DO NOTHING;
        END LOOP;
    END IF;

    RETURN v_decision_id;
END;
$$;

COMMENT ON FUNCTION record_label_print(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB)
    IS 'Persist decision_log and shipment_actions audit entries for label bundling responses.';

GRANT EXECUTE ON FUNCTION record_label_print(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB) TO service_role;

-- =============================================================================
-- Section 4: Workflow handler functions for label print orchestration
-- =============================================================================

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
    v_shipments JSONB := COALESCE(v_payload->'shipments', '[]'::jsonb);
    v_options JSONB := COALESCE(v_payload->'options', '{}'::jsonb);
    v_org_id UUID := COALESCE(
        NULLIF(v_context->>'organization_id', '')::uuid,
        NULLIF(v_payload->>'organization_id', '')::uuid
    );
    v_policy JSONB := resolve_settings('label_print_policy', 'tenant', v_org_id);
    v_poll_seconds INT := COALESCE(NULLIF(v_metadata->>'poll_interval_seconds', '')::INT, (v_policy->>'poll_interval_seconds')::INT, 60);
    v_max_wait_seconds INT := COALESCE(NULLIF(v_metadata->>'max_wait_seconds', '')::INT, (v_policy->>'max_wait_seconds')::INT, 900);
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
    v_pending_after INT;
    v_total_requested INT := 0;
    v_in_scope INT := 0;
    v_ready_count INT := 0;
    v_pending_count INT := 0;
    v_out_scope_count INT := 0;
    v_invalid_box_count INT := 0;
    v_has_shipments BOOLEAN := jsonb_typeof(v_shipments) = 'array' AND jsonb_array_length(v_shipments) > 0;
    v_generation_source TEXT := COALESCE(NULLIF(v_metadata->>'requested_source', ''), 'workflow.labels_print');
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_print_prepare_v1: organization_id not present in workflow context';
    END IF;

    IF NOT v_has_shipments THEN
        RAISE EXCEPTION 'execute_label_print_prepare_v1: shipments array required in payload';
    END IF;

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
        )) FILTER (WHERE t.shipment_box_id IS NOT NULL), '[]'::jsonb) AS targets_json,
        COALESCE(jsonb_agg(jsonb_build_object('shipment_id', o.shipment_id)), '[]'::jsonb) AS out_scope_json,
        COALESCE(jsonb_agg(jsonb_build_object('shipment_id', i.shipment_id, 'shipment_box_id', i.shipment_box_id)), '[]'::jsonb) AS invalid_box_json,
        COUNT(DISTINCT t.shipment_id) AS in_scope_count,
        COUNT(DISTINCT sr.shipment_id) AS requested_count
    INTO v_targets, v_out_of_scope, v_invalid_boxes, v_in_scope, v_total_requested
    FROM shipments_raw sr
    LEFT JOIN targets t ON t.shipment_id = sr.shipment_id
    LEFT JOIN out_of_scope o ON o.shipment_id = sr.shipment_id
    LEFT JOIN invalid_box_requests i ON i.shipment_id = sr.shipment_id;

    v_out_scope_count := COALESCE(jsonb_array_length(COALESCE(v_out_of_scope, '[]'::jsonb)), 0);
    v_invalid_box_count := COALESCE(jsonb_array_length(COALESCE(v_invalid_boxes, '[]'::jsonb)), 0);

    v_ready := COALESCE(
        (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(COALESCE(v_targets, '[]'::jsonb)) elem
            WHERE elem->>'status' = 'ready'
        ),
        '[]'::jsonb
    );
    v_pending := COALESCE(
        (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(COALESCE(v_targets, '[]'::jsonb)) elem
            WHERE elem->>'status' = 'missing'
        ),
        '[]'::jsonb
    );

    v_ready_count := COALESCE(jsonb_array_length(v_ready), 0);
    v_pending_count := COALESCE(jsonb_array_length(v_pending), 0);

    IF NOT v_has_enqueued THEN
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_pending) AS t(value)
        LOOP
            v_item := v_row.value;
            PERFORM request_label_generation(
                NULLIF(v_item->>'shipment_id', '')::uuid,
                'shipping',
                p_run.requested_by,
                v_generation_source,
                NULLIF(v_item->>'shipment_box_id', '')::uuid,
                'reprint'
            );
        END LOOP;
        v_has_enqueued := v_pending_count > 0;
    END IF;

    -- Complete immediately to allow bundling step to proceed; engine remains dynamic via counts
    IF v_pending_count > 0 THEN
        v_timed_out := '[]'::jsonb; -- no wait loop in handler; orchestration may re-run as needed
    END IF;
    v_response.status := 'completed';

    v_counts := jsonb_strip_nulls(jsonb_build_object(
        'requested', COALESCE(v_total_requested, 0),
        'in_scope', COALESCE(v_in_scope, 0),
        'ready', v_ready_count,
        'pending', COALESCE(jsonb_array_length(v_pending), 0),
        'timed_out', COALESCE(jsonb_array_length(v_timed_out), 0),
        'out_of_scope', v_out_scope_count,
        'invalid_box_requests', v_invalid_box_count
    ));

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
            'policy', v_policy
        )
    ));

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Prepare labels for bundling: scope validation, enqueue missing labels, wait with polling semantics.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response workflow_handler_response;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_policy JSONB := COALESCE(v_label_state->'policy', '{}'::jsonb);
    v_options JSONB := COALESCE(v_label_state->'options', '{}'::jsonb);
    v_ready JSONB := COALESCE(v_label_state->'ready', '[]'::jsonb);
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_expires_seconds INT := COALESCE((v_options->>'expires_seconds')::INT, (v_policy->>'default_expires_seconds')::INT, 900);
    v_max_labels INT := COALESCE((v_policy->>'max_labels_per_bundle')::INT, 400);
    v_bundle_payload JSONB;
    v_label_ids JSONB := '[]'::jsonb;
    v_file_urls JSONB := '[]'::jsonb;
    v_result JSONB;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: organization_id missing from context';
    END IF;

    IF jsonb_array_length(v_ready) = 0 THEN
        -- Fallback: derive ready list from payload shipments when prepare step did not populate
        DECLARE
            v_shipments JSONB := COALESCE(v_context->'payload'->'shipments', '[]'::jsonb);
        BEGIN
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
        END;
    END IF;

    IF jsonb_array_length(v_ready) > v_max_labels THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: ready labels (%s) exceed max bundle limit (%s)', jsonb_array_length(v_ready), v_max_labels;
    END IF;

    v_label_ids := COALESCE(
        (
            SELECT jsonb_agg(elem->'label_id')
            FROM jsonb_array_elements(v_ready) elem
        ),
        '[]'::jsonb
    );
    v_file_urls := COALESCE(
        (
            SELECT jsonb_agg(elem->'file_url')
            FROM jsonb_array_elements(v_ready) elem
        ),
        '[]'::jsonb
    );

    v_bundle_payload := jsonb_build_object(
        'bundle', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'file_urls', v_file_urls,
            'label_ids', v_label_ids,
            'expires_seconds', v_expires_seconds,
            'metadata', jsonb_build_object(
                'counts', v_label_state->'counts',
                'options', v_options
            )
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
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'ok',
        'bundle', v_result
    ));
    v_response.context_patch := jsonb_build_object(
        'label_print', jsonb_build_object(
            'bundle_response', v_result
        )
    );

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Invoke label renderer bundle mode and persist returned metadata.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_finalize_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response workflow_handler_response;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_bundle JSONB := COALESCE(v_label_state->'bundle_response', '{}'::jsonb);
    v_counts JSONB := COALESCE(v_label_state->'counts', '{}'::jsonb);
    v_errors JSONB := jsonb_build_object(
        'out_of_scope', COALESCE(v_label_state->'out_of_scope', '[]'::jsonb),
        'invalid_boxes', COALESCE(v_label_state->'invalid_boxes', '[]'::jsonb),
        'timed_out', COALESCE(v_label_state->'timed_out', '[]'::jsonb)
    );
    v_ready JSONB := COALESCE(v_label_state->'ready', '[]'::jsonb);
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_requested_by UUID := p_run.requested_by;
    v_correlation_id TEXT := NULLIF(v_context->>'correlation_id', '');
    v_signed_url TEXT := v_bundle->>'signed_url';
    v_file_path TEXT := COALESCE(v_bundle->>'file_path', v_bundle->>'file_url');
    v_bundle_id UUID := COALESCE(NULLIF(v_bundle->>'bundle_id', '')::uuid, gen_random_uuid());
    v_included JSONB := jsonb_build_array();
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_print_finalize_v1: organization_id missing';
    END IF;

    v_included := (
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'shipment_id', elem->>'shipment_id',
            'label_ids', jsonb_build_array(elem->'label_id')
        )))
        FROM jsonb_array_elements(v_ready) elem
    );

    PERFORM record_label_print(
        p_bundle_id := v_bundle_id,
        p_org_id := v_org_id,
        p_requested_by := v_requested_by,
        p_correlation_id := v_correlation_id,
        p_signed_url := v_signed_url,
        p_file_path := v_file_path,
        p_counts := v_counts,
        p_errors := v_errors,
        p_included := COALESCE(v_included, '[]'::jsonb)
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'ok',
        'bundle_id', v_bundle_id,
        'signed_url', v_signed_url,
        'file_path', v_file_path,
        'counts', v_counts,
        'errors', v_errors
    ));

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_finalize_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Finalize label print workflow: log decisions, record shipment actions, surface bundle link.';

-- =============================================================================
-- Section 5: Register handlers in operation_handlers
-- =============================================================================

INSERT INTO operation_handlers (handler_key, handler_schema, handler_name, handler_signature, handler_version, is_active, notes, doc_url)
VALUES
    ('label_print_prepare', 'workflow_handlers', 'execute_label_print_prepare_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Ensure label readiness before bundling.', 'docs/ops/runbooks/label_renderer_runbook.md'),
    ('label_bundle', 'workflow_handlers', 'execute_label_bundle_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Call label renderer bundle mode.', 'docs/ops/runbooks/label_renderer_runbook.md'),
    ('label_print_finalize', 'workflow_handlers', 'execute_label_print_finalize_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Finalize label print audit trail.', 'docs/ops/runbooks/label_renderer_runbook.md')
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = TRUE,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- =============================================================================
-- Section 6: Workflow template and steps (labels_print_workflow_v1)
-- =============================================================================

WITH upsert_template AS (
    INSERT INTO workflow_templates (
        id,
        name,
        description,
        version,
        status,
        scope_type,
        scope_id,
        notes,
        created_at,
        updated_at
    ) VALUES (
        gen_random_uuid(),
        'labels_print_workflow_v1',
        'Bundle existing shipment labels into a printable PDF using label renderer.',
        1,
        'active',
        'global',
        NULL,
        'Workflow-driven label print path (single or multiple shipments).',
        now(),
        now()
    )
    ON CONFLICT (name) DO UPDATE
    SET description = EXCLUDED.description,
        status = 'active',
        scope_type = EXCLUDED.scope_type,
        scope_id = EXCLUDED.scope_id,
        notes = EXCLUDED.notes,
        updated_at = now()
    RETURNING id
),
template AS (
    SELECT id FROM upsert_template
)
DELETE FROM workflow_template_steps
WHERE workflow_template_id = (SELECT id FROM template);

WITH template AS (SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' LIMIT 1)
INSERT INTO workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    metadata,
    handler_key,
    handler_version,
    enabled,
    created_at,
    updated_at
)
VALUES
    (
        gen_random_uuid(),
        (SELECT id FROM template),
        1,
        'prepare_labels_for_print',
        'workflow',
        'always',
        jsonb_build_object('poll_interval_seconds', 60, 'max_wait_seconds', 900, 'requested_source', 'workflow.labels_print', 'max_retries', 200),
        'label_print_prepare',
        'v1',
        TRUE,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        (SELECT id FROM template),
        2,
        'bundle_labels_pdf',
        'workflow',
        'always',
        jsonb_build_object('default_expires_seconds', 900, 'max_retries', 20),
        'label_bundle',
        'v1',
        TRUE,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        (SELECT id FROM template),
        3,
        'finalize_label_print',
        'workflow',
        'always',
        jsonb_build_object('decision_category', 'label_print', 'max_retries', 5),
        'label_print_finalize',
        'v1',
        TRUE,
        now(),
        now()
    ),
    (
        gen_random_uuid(),
        (SELECT id FROM template),
        4,
        'complete_workflow',
        'workflow',
        'always',
        jsonb_build_object('action', 'complete'),
        'workflow_control',
        'v1',
        TRUE,
        now(),
        now()
    );

COMMIT;

