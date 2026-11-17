-- Migration: reserve_identifiers workflow handler (generic + shipment alias)

BEGIN;

SET search_path TO public, workflow_handlers, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.reserve_identifiers_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_step_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_resource_type TEXT := COALESCE(
        NULLIF(v_step_metadata->>'resource_type', ''),
        NULLIF(v_ctx->>'resource_type', ''),
        'shipment'
    );
    v_tracking_scope_type TEXT := COALESCE(
        NULLIF(v_step_metadata->>'tracking_scope_type', ''),
        NULLIF(v_ctx->>'tracking_scope_type', '')
    );
    v_tracking_scope_id UUID := COALESCE(
        NULLIF(v_step_metadata->>'tracking_scope_id', '')::UUID,
        NULLIF(v_ctx->>'tracking_scope_id', '')::UUID
    );
    v_org UUID := NULLIF(v_ctx->>'organization_id', '')::UUID;
    v_client UUID := NULLIF(v_ctx->>'client_id', '')::UUID;
    v_sender UUID := NULLIF(v_ctx->>'sender_id', '')::UUID;
    v_planned_id UUID := NULLIF(v_ctx->>'planned_resource_id', '')::UUID;
    v_planned_tracking TEXT := NULLIF(v_ctx->>'planned_tracking_number', '');
    v_tracking_policy JSONB;
    v_scope_type TEXT;
    v_scope_id UUID;
    v_response public.workflow_handler_response;
BEGIN
    -- Derive tracking scope from context when not provided explicitly.
    IF v_tracking_scope_type IS NULL THEN
        IF v_client IS NOT NULL THEN
            v_tracking_scope_type := 'client';
        ELSIF v_sender IS NOT NULL THEN
            v_tracking_scope_type := 'sender';
        ELSE
            v_tracking_scope_type := 'tenant';
        END IF;
    END IF;

    IF v_tracking_scope_id IS NULL THEN
        IF v_tracking_scope_type = 'client' THEN
            v_tracking_scope_id := v_client;
        ELSIF v_tracking_scope_type = 'sender' THEN
            v_tracking_scope_id := v_sender;
        ELSE
            v_tracking_scope_id := v_org;
        END IF;
    END IF;

    IF v_tracking_scope_id IS NULL OR v_tracking_scope_type IS NULL THEN
        RAISE EXCEPTION 'reserve_identifiers_v1: unable to determine tracking scope (type %, id %)', v_tracking_scope_type, v_tracking_scope_id;
    END IF;

    -- Generate identifiers only when not already planned.
    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    IF v_resource_type = 'shipment' THEN
        IF v_planned_tracking IS NULL THEN
            v_tracking_policy := resolve_settings('tracking_policy', v_tracking_scope_type, v_tracking_scope_id);
            v_planned_tracking := generate_tracking_number(v_tracking_scope_type, v_tracking_scope_id, v_tracking_policy);
        END IF;
        v_response.context_patch := jsonb_build_object(
            'planned_resource_id', v_planned_id,
            'planned_tracking_number', v_planned_tracking,
            'planned_shipment_id', v_planned_id
        );
        v_response.operation_result := jsonb_build_object(
            'resource_type', v_resource_type,
            'tracking_scope_type', v_tracking_scope_type,
            'tracking_scope_id', v_tracking_scope_id,
            'planned_resource_id', v_planned_id,
            'planned_tracking_number', v_planned_tracking
        );
    ELSE
        v_response.context_patch := jsonb_build_object(
            'planned_resource_id', v_planned_id
        );
        v_response.operation_result := jsonb_build_object(
            'resource_type', v_resource_type,
            'tracking_scope_type', v_tracking_scope_type,
            'tracking_scope_id', v_tracking_scope_id,
            'planned_resource_id', v_planned_id
        );
    END IF;

    v_response.status := 'completed';
    v_response.workflow_status := NULL;
    v_response.next_run_at := NULL;
    v_response.retry_attempt := 1;
    v_response.max_retries := 1;
    v_response.last_error := NULL;

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.reserve_identifiers_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Reserve identifiers (resource id + tracking) using tracking_policy; updates run context with planned values.';

-- Convenience alias for shipment flows.
CREATE OR REPLACE FUNCTION workflow_handlers.reserve_shipment_identifiers_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_step public.workflow_run_steps := p_step;
BEGIN
    v_step.metadata := jsonb_strip_nulls(COALESCE(p_step.metadata, '{}'::jsonb) || jsonb_build_object('resource_type', 'shipment'));
    RETURN workflow_handlers.reserve_identifiers_v1(v_step, p_run, p_operation_result);
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.reserve_shipment_identifiers_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Reserve shipment identifiers (planned id + tracking) via reserve_identifiers_v1.';

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
VALUES
    ('reserve_identifiers', 'workflow_handlers', 'reserve_identifiers_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Reserve identifiers for a resource using tracking_policy.', NULL),
    ('reserve_shipment_identifiers', 'workflow_handlers', 'reserve_shipment_identifiers_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Reserve shipment id + tracking.', NULL)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

COMMIT;
