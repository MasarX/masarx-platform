BEGIN;

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

    IF v_response.context_patch IS NOT NULL THEN
        UPDATE workflow_runs
        SET context = jsonb_set(
                COALESCE(context, '{}'::jsonb) || v_response.context_patch,
                '{workflow,context_patch}',
                jsonb_strip_nulls(
                    COALESCE(context->'workflow'->'context_patch', '{}'::jsonb) || v_response.context_patch
                ),
                TRUE
            ),
            updated_at = now()
        WHERE id = p_run.id;
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

COMMIT;
