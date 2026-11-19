-- Console V2 API Gateway shipment lineage.
--
-- API Gateway shipment creation already materializes the canonical shipment,
-- recipient, address, COD, and reference rows. Console V2 shipment drawers also
-- need shipment-scoped lineage so the Audit and Decisions tabs are not empty
-- after a successful provider materialization.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605141330_api_gateway_shipment_materialization_lineage_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_def TEXT;
  v_marker TEXT := E'\n  IF v_operation = ''reused'' THEN\n';
  v_insert TEXT := E'\n  IF NOT EXISTS (\n    SELECT 1\n      FROM public.shipment_actions sa\n     WHERE sa.shipment_id = v_shipment_id\n       AND sa.action_type = ''api_gateway_materialized''\n       AND sa.action_data->>''api_gateway_request_id'' = v_request.id::text\n  ) THEN\n    INSERT INTO public.shipment_actions (\n      id,\n      shipment_id,\n      organization_id,\n      client_id,\n      action_type,\n      action_category,\n      canonical_status,\n      action_data,\n      timestamp,\n      created_at,\n      performed_by_system\n    )\n    VALUES (\n      gen_random_uuid(),\n      v_shipment_id,\n      v_org,\n      v_client,\n      ''api_gateway_materialized'',\n      ''operational'',\n      v_shipment_status,\n      jsonb_strip_nulls(jsonb_build_object(\n        ''api_gateway_request_id'', v_request.id,\n        ''outbound_call_id'', p_job.id,\n        ''route_id'', v_route.id,\n        ''source_id'', v_source,\n        ''sender_id'', v_sender,\n        ''provider_id'', v_provider_id,\n        ''provider_name'', v_provider_name,\n        ''provider_shipment_id'', NULLIF(btrim(v_provider_shipment_id), ''''),\n        ''provider_reference_id'', NULLIF(btrim(v_provider_reference_id), ''''),\n        ''provider_tracking_number'', NULLIF(btrim(v_tracking_number), ''''),\n        ''client_reference_number'', NULLIF(btrim(v_client_reference), ''''),\n        ''recipient_id'', v_recipient_id,\n        ''origin_address_id'', v_origin_address_id,\n        ''destination_address_id'', v_destination_address_id,\n        ''cod_amount'', v_cod_amount,\n        ''operation'', v_operation,\n        ''correlation_id'', v_corr\n      )),\n      now(),\n      now(),\n      ''workflow_handlers.process_api_gateway_shipment_create_v1''\n    );\n  END IF;\n\n  IF NOT EXISTS (\n    SELECT 1\n      FROM public.decision_log dl\n     WHERE dl.resource_type = ''shipment''\n       AND dl.resource_id = v_shipment_id\n       AND dl.decision_point = ''api_gateway_materialization''\n       AND dl.decision_inputs->>''api_gateway_request_id'' = v_request.id::text\n  ) THEN\n    PERFORM public.log_decision(\n      p_organization_id := v_org,\n      p_decision_category := ''shipment_create'',\n      p_resource_type := ''shipment'',\n      p_resource_id := v_shipment_id,\n      p_decision_point := ''api_gateway_materialization'',\n      p_decision_outcome := CASE\n        WHEN v_operation = ''inserted'' THEN ''materialized''\n        ELSE ''linked_existing_shipment''\n      END,\n      p_performed_by_system := ''workflow_handlers.process_api_gateway_shipment_create_v1'',\n      p_correlation_id := v_corr,\n      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(\n        ''api_gateway_request_id'', v_request.id,\n        ''outbound_call_id'', p_job.id,\n        ''route_id'', v_route.id,\n        ''source_id'', v_source,\n        ''sender_id'', v_sender,\n        ''provider_id'', v_provider_id,\n        ''provider_name'', v_provider_name,\n        ''provider_shipment_id'', NULLIF(btrim(v_provider_shipment_id), ''''),\n        ''provider_reference_id'', NULLIF(btrim(v_provider_reference_id), ''''),\n        ''provider_tracking_number'', NULLIF(btrim(v_tracking_number), ''''),\n        ''client_reference_number'', NULLIF(btrim(v_client_reference), ''''),\n        ''recipient_id'', v_recipient_id,\n        ''origin_address_id'', v_origin_address_id,\n        ''destination_address_id'', v_destination_address_id,\n        ''cod_amount'', v_cod_amount,\n        ''operation'', v_operation\n      )),\n      p_decision_reason := ''API Gateway provider success materialized canonical shipment readback'',\n      p_settings_resolution_id := NULL\n    );\n  END IF;\n';
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls, jsonb, public.api_gateway_requests, public.api_routes)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 definition not found';
  END IF;

  IF position('api_gateway_materialization' IN v_def) > 0
     AND position('api_gateway_materialized' IN v_def) > 0 THEN
    RAISE NOTICE 'process_api_gateway_shipment_create_v1 already emits shipment-scoped API Gateway lineage';
    RETURN;
  END IF;

  IF position(v_marker IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected process_api_gateway_shipment_create_v1 reuse decision marker not found';
  END IF;

  v_def := replace(v_def, v_marker, v_insert || v_marker);
  EXECUTE v_def;

  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls, jsonb, public.api_gateway_requests, public.api_routes)'::regprocedure
  ) INTO v_def;

  IF position('api_gateway_materialization' IN v_def) = 0
     OR position('api_gateway_materialized' IN v_def) = 0 THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 lineage patch did not apply';
  END IF;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_api_gateway_shipment_create_v1(
  public.outbound_calls,
  jsonb,
  public.api_gateway_requests,
  public.api_routes
) IS 'API Gateway shipment-create postprocessor. Materializes canonical shipment readback and emits shipment-scoped action/decision lineage for Console V2 drawer audit proof.';

SELECT pg_advisory_unlock(hashtext('202605141330_api_gateway_shipment_materialization_lineage_v1'));

COMMIT;
