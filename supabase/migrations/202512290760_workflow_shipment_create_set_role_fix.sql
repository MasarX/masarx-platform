-- Plan: PLAN-202512-shipment-references-ssot / Step: S95
-- Migration: Fix workflow shipment create handler role setting
-- Purpose:
--   - PostgreSQL forbids `SET LOCAL ROLE ...` inside SECURITY DEFINER functions.
--   - Remove role switching and rely on SECURITY DEFINER ownership for required access.
-- Date: 2025-12-29

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_create_v1(
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
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_ctx_patch JSONB := COALESCE(v_ctx->'workflow'->'context_patch', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
    v_resource JSONB := COALESCE(v_payload->'resource', '{}'::jsonb);

    v_org UUID := COALESCE(
        NULLIF(v_ctx->>'organization_id', '')::UUID,
        NULLIF(v_ctx_patch->>'organization_id', '')::UUID
    );
    v_client UUID := COALESCE(
        NULLIF(v_ctx->>'client_id', '')::UUID,
        NULLIF(v_ctx_patch->>'client_id', '')::UUID
    );
    v_sender UUID := COALESCE(
        NULLIF(v_ctx->>'sender_id', '')::UUID,
        NULLIF(v_ctx_patch->>'sender_id', '')::UUID
    );
    v_planned_id UUID := COALESCE(
        NULLIF(v_ctx->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx->>'planned_resource_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_resource_id', '')::UUID,
        NULLIF((v_ctx->'shipment'->>'id'), '')::UUID,
        NULLIF((v_ctx_patch->'shipment'->>'id'), '')::UUID
    );
    v_planned_tracking TEXT := COALESCE(
        NULLIF(v_ctx->>'planned_tracking_number', ''),
        NULLIF(v_ctx_patch->>'planned_tracking_number', ''),
        NULLIF((v_ctx->'shipment'->>'tracking_number'), ''),
        NULLIF((v_ctx_patch->'shipment'->>'tracking_number'), '')
    );
    v_service_type TEXT := COALESCE(NULLIF(v_ctx->>'service_type', ''), 'delivery');
    v_status TEXT := COALESCE(NULLIF(v_ctx->>'initial_status', ''), 'pending');
    v_metadata_source UUID := COALESCE(
        NULLIF(v_ctx->>'webhook_id', '')::UUID,
        NULLIF(v_ctx_patch->>'webhook_id', '')::UUID
    );

    v_client_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'client_reference_number', ''),
        NULLIF(v_ctx_patch->>'client_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_resource->>'client_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,client_reference_number}', '')
    );
    v_carrier_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'carrier_reference_number', ''),
        NULLIF(v_ctx_patch->>'carrier_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_resource->>'carrier_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,carrier_reference_number}', '')
    );

    v_logistics_refs JSONB;
    v_reference_map JSONB := '{}'::jsonb;
    v_refs JSONB := '{}'::jsonb;
    v_ref_meta JSONB;

    v_correlation_id UUID;
    v_row_id UUID;
    v_tracking_number TEXT;
    v_operation TEXT := 'inserted';
    v_result public.workflow_handler_response;
BEGIN
    BEGIN
      v_correlation_id := NULLIF(v_ctx->>'correlation_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_correlation_id := NULL;
    END;
    IF v_correlation_id IS NULL THEN
      BEGIN
        v_correlation_id := NULLIF(v_ctx_patch->>'correlation_id', '')::UUID;
      EXCEPTION
        WHEN others THEN
          v_correlation_id := NULL;
      END;
    END IF;

    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN
        RAISE EXCEPTION 'execute_shipment_create_v1: missing required context (org %, client %, tracking %)',
            v_org, v_client, v_planned_tracking;
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    -- Seed reference_map from any provided "references" object (row-driven types).
    IF jsonb_typeof(v_resource->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_resource->'references';
    END IF;
    IF jsonb_typeof(v_ctx->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx->'references';
    END IF;
    IF jsonb_typeof(v_ctx_patch->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx_patch->'references';
    END IF;

    -- Optional multi-value logistics references (supports array or string).
    v_logistics_refs := NULL;
    IF jsonb_typeof(v_resource->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_resource->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_resource->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_resource->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_number';
    END IF;

    v_refs := jsonb_strip_nulls(
      v_reference_map || jsonb_build_object(
        'client_reference_number', NULLIF(btrim(v_client_reference), ''),
        'carrier_reference_number', NULLIF(btrim(v_carrier_reference), '')
      )
    );
    IF v_logistics_refs IS NOT NULL THEN
      v_refs := jsonb_strip_nulls(v_refs || jsonb_build_object('logistics_reference_number', v_logistics_refs));
    END IF;

    BEGIN
        INSERT INTO public.shipments (
            id,
            organization_id,
            client_id,
            sender_id,
            service_type,
            tracking_number,
            carrier_reference_number,
            client_reference_number,
            status,
            box_count,
            metadata
        )
        VALUES (
            v_planned_id,
            v_org,
            v_client,
            v_sender,
            v_service_type,
            v_planned_tracking,
            NULLIF(btrim(v_carrier_reference), ''),
            NULLIF(btrim(v_client_reference), ''),
            v_status,
            1,
            jsonb_strip_nulls(jsonb_build_object(
                'created_by', 'workflow',
                'workflow_run_id', p_run.id,
                'source_webhook_id', v_metadata_source
            ))
        )
        ON CONFLICT (client_id, tracking_upper) DO NOTHING;
    EXCEPTION
        WHEN unique_violation THEN
            -- Likely conflict on (client_id, client_reference_upper): reuse existing shipment.
            IF NULLIF(btrim(v_client_reference), '') IS NULL THEN
              RAISE;
            END IF;

            SELECT shipment_id, tracking_number
              INTO v_row_id, v_tracking_number
              FROM public.find_shipment_by_client_reference_v1(v_client, v_client_reference)
             LIMIT 1;

            IF v_row_id IS NULL THEN
              RAISE;
            END IF;

            v_operation := 'reused_client_reference';

            PERFORM public.log_decision(
              p_organization_id := v_org,
              p_decision_category := 'shipment_create',
              p_resource_type := 'shipment',
              p_resource_id := v_row_id,
              p_decision_point := 'client_reference_unique',
              p_decision_outcome := 'reused_existing_shipment',
              p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
              p_correlation_id := v_correlation_id,
              p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'planned_shipment_id', v_planned_id,
                'planned_tracking_number', v_planned_tracking,
                'client_reference_number', NULLIF(btrim(v_client_reference), ''),
                'existing_tracking_number', v_tracking_number
              )),
              p_decision_reason := 'client_reference_number already exists for this client',
              p_settings_resolution_id := NULL
            );
    END;

    IF v_row_id IS NULL THEN
      SELECT id, tracking_number
        INTO v_row_id, v_tracking_number
        FROM public.shipments
       WHERE client_id = v_client
         AND tracking_upper = upper(v_planned_tracking)
       LIMIT 1;

      IF v_row_id IS NULL THEN
        v_row_id := v_planned_id;
        v_tracking_number := v_planned_tracking;
      ELSIF v_row_id <> v_planned_id THEN
        v_operation := 'reused_tracking';
      END IF;
    END IF;

    -- Best-effort: if shipment exists, fill missing reference columns (do not overwrite).
    UPDATE public.shipments
    SET client_reference_number = COALESCE(NULLIF(btrim(public.shipments.client_reference_number), ''), NULLIF(btrim(v_client_reference), ''), public.shipments.client_reference_number),
        carrier_reference_number = COALESCE(NULLIF(btrim(public.shipments.carrier_reference_number), ''), NULLIF(btrim(v_carrier_reference), ''), public.shipments.carrier_reference_number),
        updated_at = now()
    WHERE id = v_row_id
      AND client_id = v_client
      AND (
        ((public.shipments.client_reference_number IS NULL OR btrim(public.shipments.client_reference_number) = '') AND NULLIF(btrim(v_client_reference), '') IS NOT NULL)
        OR ((public.shipments.carrier_reference_number IS NULL OR btrim(public.shipments.carrier_reference_number) = '') AND NULLIF(btrim(v_carrier_reference), '') IS NOT NULL)
      );

    -- Upsert canonical references (SSOT).
    IF v_row_id IS NOT NULL AND v_refs IS NOT NULL AND v_refs <> '{}'::jsonb THEN
      v_ref_meta := jsonb_strip_nulls(jsonb_build_object(
        'source', 'workflow',
        'workflow_run_id', p_run.id,
        'workflow_run_step_id', p_step.id,
        'webhook_id', v_metadata_source
      ));

      PERFORM public.upsert_shipment_reference_numbers_v1(
        p_organization_id := v_org,
        p_client_id := v_client,
        p_shipment_id := v_row_id,
        p_reference_map := v_refs,
        p_source_type := 'workflow',
        p_source_id := NULL,
        p_metadata := v_ref_meta
      );
    END IF;

    v_result.status := 'completed';
    v_result.workflow_status := CASE
      WHEN v_operation = 'reused_client_reference' AND v_planned_id IS NOT NULL AND v_row_id <> v_planned_id THEN 'completed'
      ELSE NULL
    END;
    v_result.next_run_at := NULL;
    v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_row_id,
        'tracking_number', v_tracking_number,
        'operation', v_operation
    ));
    v_result.context_patch := jsonb_build_object(
        'shipment', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row_id,
            'tracking_number', v_tracking_number,
            'client_reference_number', NULLIF(btrim(v_client_reference), '')
        ))
    );
    v_result.last_error := NULL;
    v_result.retry_attempt := 1;
    v_result.max_retries := 1;

    RETURN v_result;
END;
$function$;

COMMIT;

