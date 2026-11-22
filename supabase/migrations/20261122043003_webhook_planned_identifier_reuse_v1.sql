BEGIN;

-- Keep webhook ACK identity stable through follow-up shipment materialization.
-- The intake wrapper plans shipment identifiers before ACKing; the reusable
-- reserve handler must honor those planned values instead of replacing them.
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
    v_ctx_patch JSONB := COALESCE(v_ctx->'workflow'->'context_patch', '{}'::jsonb);
    v_resource_type TEXT := COALESCE(
        NULLIF(v_step_metadata->>'resource_type', ''),
        NULLIF(v_ctx->>'resource_type', ''),
        'shipment'
    );
    v_reserve_identifiers BOOLEAN := TRUE;
    v_tracking_scope_type TEXT := COALESCE(
        NULLIF(v_step_metadata->>'tracking_scope_type', ''),
        NULLIF(v_ctx->>'tracking_scope_type', '')
    );
    v_tracking_scope_id UUID := COALESCE(
        NULLIF(v_step_metadata->>'tracking_scope_id', '')::UUID,
        NULLIF(v_ctx->>'tracking_scope_id', '')::UUID
    );
    v_org UUID := COALESCE(
        NULLIF(v_ctx->>'organization_id', '')::UUID
    );
    v_client UUID := COALESCE(
        NULLIF(v_ctx->>'client_id', '')::UUID
    );
    v_sender UUID := COALESCE(
        NULLIF(v_ctx->>'sender_id', '')::UUID
    );
    v_planned_id UUID := COALESCE(
        NULLIF(v_ctx->>'planned_resource_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_resource_id', '')::UUID,
        CASE
            WHEN v_resource_type = 'shipment' THEN NULLIF(v_ctx->>'planned_shipment_id', '')::UUID
            ELSE NULL
        END,
        CASE
            WHEN v_resource_type = 'shipment' THEN NULLIF(v_ctx_patch->>'planned_shipment_id', '')::UUID
            ELSE NULL
        END
    );
    v_planned_tracking TEXT := COALESCE(
        NULLIF(v_ctx->>'planned_tracking_number', ''),
        NULLIF(v_ctx_patch->>'planned_tracking_number', '')
    );
    v_tracking_policy JSONB;
    v_response public.workflow_handler_response;
BEGIN
    IF lower(COALESCE(v_step_metadata->>'reserve_identifiers', v_ctx->>'reserve_identifiers', v_ctx_patch->>'reserve_identifiers', 'true')) IN ('0', 'false', 'no') THEN
        v_reserve_identifiers := FALSE;
    END IF;
    IF lower(COALESCE(v_step_metadata->>'reserve_new_tracking', v_ctx->>'reserve_new_tracking', v_ctx_patch->>'reserve_new_tracking', 'true')) IN ('0', 'false', 'no')
       AND v_resource_type = 'shipment' THEN
        v_reserve_identifiers := FALSE;
    END IF;

    IF NOT v_reserve_identifiers THEN
        v_response.status := 'completed';
        v_response.workflow_status := NULL;
        v_response.next_run_at := NULL;
        v_response.retry_attempt := 1;
        v_response.max_retries := 1;
        v_response.last_error := NULL;
        v_response.context_patch := '{}'::jsonb;
        v_response.operation_result := jsonb_build_object(
          'resource_type', v_resource_type,
          'reserved', FALSE
        );
        RETURN v_response;
    END IF;

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
            'planned_shipment_id', v_planned_id,
            'workflow', jsonb_build_object(
                'context_patch',
                jsonb_build_object(
                    'planned_resource_id', v_planned_id,
                    'planned_tracking_number', v_planned_tracking,
                    'planned_shipment_id', v_planned_id
                )
            )
        );
        v_response.operation_result := jsonb_build_object(
            'resource_type', v_resource_type,
            'tracking_scope_type', v_tracking_scope_type,
            'tracking_scope_id', v_tracking_scope_id,
            'planned_resource_id', v_planned_id,
            'planned_tracking_number', v_planned_tracking,
            'reserved', TRUE
        );
    ELSE
        v_response.context_patch := jsonb_build_object(
            'planned_resource_id', v_planned_id,
            'workflow', jsonb_build_object(
                'context_patch',
                jsonb_build_object('planned_resource_id', v_planned_id)
            )
        );
        v_response.operation_result := jsonb_build_object(
            'resource_type', v_resource_type,
            'tracking_scope_type', v_tracking_scope_type,
            'tracking_scope_id', v_tracking_scope_id,
            'planned_resource_id', v_planned_id,
            'reserved', TRUE
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
    IS 'Reserve identifiers while reusing planned resource/shipment identifiers already present in workflow context or workflow.context_patch.';

COMMIT;
