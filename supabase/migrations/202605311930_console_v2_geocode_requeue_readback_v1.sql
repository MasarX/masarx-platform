-- Migration: Console V2 geocode requeue readback
-- Purpose:
--   Surface backend-backed geocode/manual-review outcomes from the nested
--   geocoding workflow so Console can reconcile the same operator context
--   after a requeue without reload or toast-only proof.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605311930_console_v2_geocode_requeue_readback_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(
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
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_address_id UUID := NULL;
  v_template_name TEXT := COALESCE(NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard');
  v_template_id UUID;
  v_workflow_run_id UUID;
  v_nested_context JSONB := '{}'::jsonb;
  v_nested_progress JSONB := '{}'::jsonb;
  v_nested_status TEXT := NULL;
  v_nested_last_error JSONB := NULL;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_nested_idempotency_key TEXT := NULL;
  v_manual_review_task_id UUID := NULL;
  v_geocoding_attempt_id UUID := NULL;
  v_geocode_id UUID := NULL;
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;

  BEGIN
    v_address_id := COALESCE(NULLIF(v_ctx->>'address_id', '')::UUID, NULLIF(v_ctx->>'destination_address_id', '')::UUID);
  EXCEPTION
    WHEN others THEN
      v_address_id := NULL;
  END;

  IF v_address_id IS NULL THEN
    v_address_id := v_target.destination_address_id;
  END IF;

  IF v_address_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_id_missing';
    v_result.operation_result := jsonb_build_object('error', 'address_id_missing');
    RETURN v_result;
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'geocode_template_missing';
    v_result.operation_result := jsonb_build_object('error', 'geocode_template_missing', 'template_name', v_template_name);
    RETURN v_result;
  END IF;

  v_nested_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_ctx->>'geocode_idempotency_key', '')), ''),
    format('shipment-update-geocode:nested:%s:%s', p_run.id, v_address_id)
  );

  v_nested_context := jsonb_strip_nulls(jsonb_build_object(
    'idempotency_key', v_nested_idempotency_key,
    'organization_id', COALESCE(v_target.organization_id, NULLIF(v_ctx->>'organization_id', '')::UUID),
    'client_id', COALESCE(v_target.client_id, NULLIF(v_ctx->>'client_id', '')::UUID),
    'sender_id', COALESCE(v_target.sender_id, NULLIF(v_ctx->>'sender_id', '')::UUID),
    'shipment_id', v_target.shipment_id,
    'destination_address_id', v_address_id,
    'address_id', v_address_id,
    'actor_user_id', NULLIF(v_ctx->>'actor_user_id', ''),
    'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode'),
    'trigger_source', 'manual',
    'parent_workflow_run_id', p_run.id,
    'parent_workflow_step_id', p_step.id
  ));

  v_workflow_run_id := public.start_workflow_run(v_template_id, v_nested_context);

  v_nested_progress := public.progress_workflow_run_until_wait_v1(
    v_workflow_run_id,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_target.shipment_id,
      'client_id', v_target.client_id,
      'destination_address_id', v_address_id,
      'address_id', v_address_id,
      'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode')
    )),
    2500,
    20
  );

  SELECT wr.workflow_status, wr.last_error
    INTO v_nested_status, v_nested_last_error
    FROM public.workflow_runs wr
   WHERE wr.id = v_workflow_run_id;

  SELECT mrt.id
    INTO v_manual_review_task_id
    FROM public.manual_review_tasks mrt
   WHERE mrt.address_id = v_address_id
     AND (
       mrt.metadata->>'workflow_run_id' = v_workflow_run_id::text
       OR mrt.shipment_id = v_target.shipment_id
     )
   ORDER BY mrt.created_at DESC NULLS LAST
   LIMIT 1;

  SELECT ga.id
    INTO v_geocoding_attempt_id
    FROM public.geocoding_attempts ga
    JOIN public.workflow_run_steps wrs
      ON wrs.id = ga.workflow_run_step_id
   WHERE ga.address_id = v_address_id
     AND wrs.workflow_run_id = v_workflow_run_id
   ORDER BY ga.created_at DESC NULLS LAST
   LIMIT 1;

  SELECT g.id
    INTO v_geocode_id
    FROM public.geocodes g
   WHERE g.address_id = v_address_id
     AND g.client_id = v_target.client_id
     AND g.is_primary IS TRUE
     AND (g.expires_at IS NULL OR g.expires_at > now())
   ORDER BY g.geocoded_at DESC NULLS LAST
   LIMIT 1;

  IF v_target.shipment_id IS NOT NULL THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_target.shipment_id,
      'geocode_request',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'idempotency_key', v_event_id,
        'address_id', v_address_id,
        'workflow_run_id', v_workflow_run_id,
        'workflow_status', v_nested_status,
        'workflow_last_error', v_nested_last_error,
        'manual_review_task_id', v_manual_review_task_id,
        'geocoding_attempt_id', v_geocoding_attempt_id,
        'geocode_id', v_geocode_id,
        'nested_idempotency_key', v_nested_idempotency_key
      )),
      NULL::TEXT,
      NULL::TEXT,
      'workflow_handlers.execute_shipment_update_geocode_v1',
      NULL::UUID,
      NULL::timestamptz
    );
  END IF;

  IF lower(COALESCE(v_nested_status, '')) IN ('failed', 'cancelled', 'blocked') THEN
    v_result.status := 'failed';
    v_result.last_error := COALESCE(
      NULLIF(v_nested_progress->>'error', ''),
      NULLIF(v_nested_last_error->>'error', ''),
      'nested_geocode_workflow_' || lower(COALESCE(v_nested_status, 'failed'))
    );
  ELSE
    v_result.status := 'completed';
  END IF;

  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'address_id', v_address_id,
    'geocode_workflow_run_id', v_workflow_run_id,
    'geocode_workflow_status', v_nested_status,
    'geocode_workflow_last_error', v_nested_last_error,
    'manual_review_task_id', v_manual_review_task_id,
    'geocoding_attempt_id', v_geocoding_attempt_id,
    'geocode_id', v_geocode_id,
    'geocode_progress', v_nested_progress,
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Starts a fresh nested geocoding workflow for each operator shipment geocode refresh, progresses it inline, records geocode_request lineage, propagates terminal failures, and returns same-context readback ids for manual review, attempts, and geocode rows.';

SELECT pg_advisory_unlock(hashtext('202605311930_console_v2_geocode_requeue_readback_v1'));
COMMIT;
