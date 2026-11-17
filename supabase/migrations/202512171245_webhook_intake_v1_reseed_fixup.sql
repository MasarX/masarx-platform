-- Migration: Re-seed webhook_intake_v1 template + handler (fixup)
-- Purpose:
--   - Ensure the canonical webhook intake entry workflow template (webhook_intake_v1)
--     and its compute_ack step remain present even if rows were deleted/drifted in a
--     cloud database where migrations are append-only.
--   - Ensure the compute_webhook_ack handler is registered and executable.
-- Date: 2025-12-17

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Re-apply the canonical acknowledgement handler (idempotent).
CREATE OR REPLACE FUNCTION workflow_handlers.compute_webhook_ack_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_policy JSONB := COALESCE(v_context->'policy', '{}'::jsonb);
    v_ack JSONB := COALESCE(v_context->'ack', '{}'::jsonb);
    v_validation JSONB := COALESCE(v_context->'validation', '{}'::jsonb);
    v_headers JSONB := COALESCE(v_context->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_context->'payload', '{}'::jsonb);
    v_response_mapping_id UUID := NULLIF(COALESCE(v_context->>'response_mapping_id', ''), '')::UUID;
    v_mapping JSONB;
    v_mode TEXT := COALESCE(v_ack->>'mode', 'accepted_async');
    v_status INT := COALESCE(NULLIF(v_ack->>'status', '')::INT, CASE WHEN v_mode = 'accepted_async' THEN 202 ELSE 200 END);
    v_outcome TEXT := COALESCE(v_ack->>'outcome', 'ack_sent');
    v_reason TEXT := NULLIF(v_ack->>'reason', '');
    v_header_defaults JSONB := COALESCE(v_ack->'header_defaults', '{}'::jsonb);
    v_headers_final JSONB := v_header_defaults;
    v_body JSONB;
    v_response workflow_handler_response;
    v_ack_context JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', false);

    IF v_response_mapping_id IS NOT NULL THEN
        SELECT mapping_config
        INTO v_mapping
        FROM mapping_configs
        WHERE id = v_response_mapping_id;
    END IF;

    -- Merge default headers and computed headers, ensuring content-type.
    IF v_headers ? 'content-type' THEN
        v_headers_final := v_headers_final || jsonb_build_object('content-type', v_headers->>'content-type');
    ELSE
        v_headers_final := v_headers_final || jsonb_build_object('content-type', 'application/json');
    END IF;

    -- Render response body when a mapping is configured; otherwise use a minimal ACK payload.
    IF v_mapping IS NOT NULL THEN
        v_body := jsonb_strip_nulls(jsonb_build_object(
            'webhook_id', NULLIF(COALESCE(v_context->>'webhook_id', ''), '')::UUID,
            'ack_outcome', v_outcome,
            'ack_reason', v_reason,
            'validation', v_validation,
            'payload', v_payload
        ));
        v_body := apply_mapping_transform(v_mapping, v_body);
    ELSE
        v_body := jsonb_strip_nulls(jsonb_build_object(
            'webhook_id', NULLIF(COALESCE(v_context->>'webhook_id', ''), '')::UUID,
            'ack_outcome', v_outcome,
            'ack_reason', v_reason
        ));
    END IF;

    v_ack_context := jsonb_strip_nulls(jsonb_build_object(
        'mode', v_mode,
        'status', v_status,
        'headers', v_headers_final,
        'body', v_body,
        'outcome', v_outcome,
        'reason', v_reason
    ));

    v_response.status := 'completed';
    v_response.operation_result := v_ack_context;
    v_response.context_patch := jsonb_build_object('ack', v_ack_context);

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.compute_webhook_ack_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Compute webhook acknowledgement payload based on intake policy context (fixup re-seed).';

-- Ensure the handler is registered (row-driven execution).
INSERT INTO operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES (
    'compute_webhook_ack',
    'workflow_handlers',
    'compute_webhook_ack_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Render webhook acknowledgement status/headers/body from workflow context (fixup re-seed).',
    'docs/ops/runbooks/webhook_engine_runbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET
    handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- Ensure the canonical webhook intake entry workflow template exists and is active.
DO $$
DECLARE
  v_expected_id CONSTANT UUID := '77770000-0000-0000-0000-000000770001'::uuid;
  v_conflict_id UUID;
BEGIN
  SELECT id
    INTO v_conflict_id
    FROM workflow_templates
   WHERE name = 'webhook_intake_v1'
     AND id <> v_expected_id
   LIMIT 1;

  IF v_conflict_id IS NOT NULL THEN
    -- Best-effort cleanup of a non-canonical row. If it is referenced, this
    -- delete will fail and surface the drift explicitly.
    DELETE FROM workflow_template_steps WHERE workflow_template_id = v_conflict_id;
    DELETE FROM workflow_templates WHERE id = v_conflict_id;
  END IF;
END $$;

INSERT INTO workflow_templates AS wt (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes
)
VALUES (
    '77770000-0000-0000-0000-000000770001',
    'webhook_intake_v1',
    'Canonical webhook intake pipeline; computes acknowledgement before delegating follow-up workflows.',
    1,
    'active',
    'global',
    NULL,
    'Workflow-engine-owned webhook intake ack pipeline (fixup re-seed).'
)
ON CONFLICT (id) DO UPDATE
SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

-- Ensure the first step exists and points to the ack handler.
INSERT INTO workflow_template_steps AS wts (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    manual_action_required,
    enabled
)
VALUES (
    '77770000-0000-0000-0000-000000770011',
    '77770000-0000-0000-0000-000000770001',
    1,
    'compute_ack',
    'workflow',
    'always',
    'compute_webhook_ack',
    'v1',
    '{}'::jsonb,
    FALSE,
    TRUE
)
ON CONFLICT (id) DO UPDATE
SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    operation_settings_category = EXCLUDED.operation_settings_category,
    transition_condition = EXCLUDED.transition_condition,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    metadata = EXCLUDED.metadata,
    manual_action_required = EXCLUDED.manual_action_required,
    enabled = EXCLUDED.enabled,
    updated_at = now();

COMMIT;
