-- Migration: Guard api_gateway materialize against context/request mismatch
-- Purpose:
--   - Ensure workflow context organization/client matches api_gateway_request before materialization.
--   - Prevent cross-tenant request materialization if run context is stale or tampered.
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_api_gateway_materialize_addresses_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
SECURITY DEFINER
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_api JSONB := COALESCE(v_ctx->'api_gateway', '{}'::jsonb);
  v_org UUID := NULLIF(v_ctx->>'organization_id', '')::uuid;
  v_client UUID := NULLIF(v_ctx->>'client_id', '')::uuid;
  v_request_id UUID;
  v_request public.api_gateway_requests%ROWTYPE;
  v_route public.api_routes%ROWTYPE;
  v_policy JSONB;
  v_post JSONB;
  v_extract JSONB;
  v_request_body JSONB;

  v_origin JSONB;
  v_destination JSONB;
  v_origin_address_id UUID;
  v_destination_address_id UUID;
  v_dest_coords JSONB;

  v_response public.workflow_handler_response;
BEGIN
  v_request_id := NULLIF(v_api->>'api_gateway_request_id', '')::uuid;
  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway materialize: api_gateway_request_id missing in run.context.api_gateway';
  END IF;

  SELECT * INTO v_request
  FROM public.api_gateway_requests
  WHERE id = v_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'api_gateway materialize: request % not found', v_request_id;
  END IF;

  IF v_request.organization_id IS DISTINCT FROM v_org
     OR v_request.client_id IS DISTINCT FROM v_client THEN
    RAISE EXCEPTION 'api_gateway materialize: request org/client mismatch';
  END IF;

  SELECT * INTO v_route
  FROM public.api_routes
  WHERE id = v_request.route_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'api_gateway materialize: route % not found', v_request.route_id;
  END IF;

  v_policy := COALESCE(v_route.policy, '{}'::jsonb);
  v_post := COALESCE(v_policy->'postprocess', '{}'::jsonb);
  v_extract := COALESCE(v_post->'extract', '{}'::jsonb);
  v_request_body := COALESCE(v_api->'request_body', v_request.request_body, '{}'::jsonb);

  v_origin := workflow_handlers.api_gateway_materialize_address_v1(v_request.organization_id, v_request.client_id, v_request_body, v_extract, 'origin');
  v_destination := workflow_handlers.api_gateway_materialize_address_v1(v_request.organization_id, v_request.client_id, v_request_body, v_extract, 'destination');

  BEGIN
    v_origin_address_id := NULLIF(v_origin->>'address_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_origin_address_id := NULL;
  END;

  BEGIN
    v_destination_address_id := NULLIF(v_destination->>'address_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_destination_address_id := NULL;
  END;

  v_dest_coords := COALESCE(v_destination->'provided_coordinates', NULL);

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'origin', v_origin,
    'destination', v_destination
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'api_gateway', jsonb_build_object(
      'materialized', jsonb_strip_nulls(jsonb_build_object(
        'origin_address_id', v_origin_address_id,
        'destination_address_id', v_destination_address_id,
        'destination_provided_coordinates', v_dest_coords
      ))
    ),
    -- Standardize keys for downstream geocoding workflow.
    'address_id', v_destination_address_id,
    'geocoding', jsonb_strip_nulls(jsonb_build_object(
      'provided_coordinates', v_dest_coords
    ))
  ));

  UPDATE public.workflow_run_steps
  SET operation_result = v_response.operation_result,
      updated_at = v_now
  WHERE id = p_step.id;

  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_api_gateway_materialize_addresses_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Workflow handler: materialize origin/destination addresses for an api_gateway_request_id (uses route policy postprocess.extract) and patches run.context with destination address_id + provided_coordinates.';

COMMIT;
