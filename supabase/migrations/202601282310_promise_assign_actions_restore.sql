-- Migration: promise_assign handler restores shipment_actions + stable semantics
-- Date: 2026-01-28
-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S01
--
-- Notes:
-- - Restores shipment_actions emission (promise_assigned) expected by pgTAP.
-- - Keeps promise computation policy-driven and enriches compute context with org/branch/zone/city.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601282310_promise_assign_actions_restore'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_promise_assign_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx RECORD;
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy_ctx JSONB := '{}'::jsonb;
  v_webhook_id UUID;
  v_webhook_source_id UUID;
  v_policy_row RECORD;
  v_has_policy_row BOOLEAN := FALSE;
  v_policy JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := TRUE;
  v_zone_id UUID;
  v_city_id UUID := NULL;
  v_branch_id UUID;
  v_branch_tz TEXT;
  v_ship_service_level TEXT;
  v_ship_service_type TEXT;
  v_existing_promised_date DATE;
  v_promise RECORD;
  v_settings_resolution_id UUID := NULL;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_updated INT := 0;
  v_response public.workflow_handler_response;
  v_reason TEXT := NULL;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);

  IF v_ctx.organization_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'organization_missing');
    RETURN v_response;
  END IF;

  IF v_ctx.shipment_id IS NULL OR v_ctx.client_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  -- Best-effort: include webhook_source_id (top of ladder) when available.
  v_webhook_id := NULL;
  BEGIN
    v_webhook_id := NULLIF(v_context->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NOT NULL THEN
    SELECT wi.webhook_source_id
      INTO v_webhook_source_id
      FROM public.webhook_inbox wi
     WHERE wi.id = v_webhook_id;
  END IF;

  -- Load shipment fields needed for zone/branch + promise.
  SELECT s.zone_id, s.service_level, s.service_type, s.promised_delivery_date
    INTO v_zone_id, v_ship_service_level, v_ship_service_type, v_existing_promised_date
    FROM public.shipments s
   WHERE s.id = v_ctx.shipment_id
     AND s.client_id = v_ctx.client_id
   LIMIT 1;

  IF NOT FOUND THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  IF v_zone_id IS NULL THEN
    v_reason := 'zone_missing';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('assigned', FALSE, 'reason', v_reason));
    RETURN v_response;
  END IF;

  v_branch_id := public.resolve_branch_id_for_zone(v_zone_id);

  IF v_branch_id IS NULL THEN
    v_reason := 'branch_unmapped';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'zone_id', v_zone_id
    ));
    RETURN v_response;
  END IF;

  -- Best-effort: derive city_id for richer matching (zone_districts -> canonical_districts).
  BEGIN
    SELECT cd.city_id
      INTO v_city_id
      FROM public.zone_districts zd
      JOIN public.canonical_districts cd ON cd.id = zd.canonical_district_id
     WHERE zd.zone_id = v_zone_id
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_city_id := NULL;
  END;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_ctx.organization_id,
    'client_id', v_ctx.client_id,
    'sender_id', v_ctx.sender_id,
    'webhook_source_id', v_webhook_source_id,
    'resource_id', v_branch_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_shipment_promise_policy(v_policy_ctx)
   LIMIT 1;

  v_has_policy_row := FOUND;

  IF v_has_policy_row AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_enabled := TRUE;
  END;

  IF NOT v_enabled THEN
    v_reason := 'policy_disabled';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('assigned', FALSE, 'reason', v_reason));
    RETURN v_response;
  END IF;

  -- Determine timezone: branch timezone when enabled + present; otherwise policy timezone (or UTC).
  v_branch_tz := NULL;
  BEGIN
    IF COALESCE((v_policy->>'use_branch_timezone')::BOOLEAN, TRUE) THEN
      SELECT b.timezone INTO v_branch_tz FROM public.branches b WHERE b.id = v_branch_id;
    END IF;
  EXCEPTION
    WHEN others THEN
      v_branch_tz := NULL;
  END;

  v_branch_tz := COALESCE(NULLIF(v_branch_tz, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');

  SELECT *
    INTO v_promise
    FROM public.compute_shipment_promise_v2(
      p_now := v_now,
      p_timezone := v_branch_tz,
      p_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_ctx.organization_id,
        'branch_id', v_branch_id,
        'zone_id', v_zone_id,
        'city_id', v_city_id,
        'service_type', v_ship_service_type,
        'service_level', v_ship_service_level
      )),
      p_policy := v_policy,
      p_promised_delivery_date := v_existing_promised_date
    )
   LIMIT 1;

  IF v_promise.promised_delivery_date IS NULL THEN
    v_reason := 'promise_uncomputable';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'settings_policy', v_policy
    ));
    RETURN v_response;
  END IF;

  -- Record settings provenance when available.
  IF v_has_policy_row AND v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'shipment_promise_policy',
      p_winning_scope_type := COALESCE(v_policy_row.scope_type, 'global'),
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'workflow_run_id', p_step.workflow_run_id,
        'workflow_step_id', p_step.id,
        'shipment_id', v_ctx.shipment_id,
        'shipment_client_id', v_ctx.client_id,
        'zone_id', v_zone_id,
        'city_id', v_city_id,
        'branch_id', v_branch_id,
        'policy_context', v_policy_ctx,
        'promise_debug', v_promise.debug
      )),
      p_merge_notes := NULL
    );
  END IF;

  UPDATE public.shipments s
  SET branch_id = v_branch_id,
      promised_delivery_date = COALESCE(s.promised_delivery_date, v_promise.promised_delivery_date),
      promised_delivery_at = v_promise.promised_delivery_at,
      promised_window_start_at = v_promise.promised_window_start_at,
      promised_window_end_at = v_promise.promised_window_end_at,
      promise_computed_at = v_now,
      promise_settings_resolution_id = v_settings_resolution_id,
      updated_at = v_now,
      version = s.version + 1
  WHERE s.id = v_ctx.shipment_id
    AND s.client_id = v_ctx.client_id
    AND (
      s.branch_id IS DISTINCT FROM v_branch_id
      OR s.promised_delivery_at IS DISTINCT FROM v_promise.promised_delivery_at
      OR s.promised_window_start_at IS DISTINCT FROM v_promise.promised_window_start_at
      OR s.promised_window_end_at IS DISTINCT FROM v_promise.promised_window_end_at
      OR s.promise_settings_resolution_id IS DISTINCT FROM v_settings_resolution_id
      OR (s.promised_delivery_date IS NULL AND v_promise.promised_delivery_date IS NOT NULL)
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.shipment_actions (
      id,
      shipment_id,
      organization_id,
      client_id,
      action_type,
      action_category,
      action_data,
      timestamp,
      created_at,
      performed_by_system
    )
    VALUES (
      gen_random_uuid(),
      v_ctx.shipment_id,
      v_ctx.organization_id,
      v_ctx.client_id,
      'promise_assigned',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'zone_id', v_zone_id,
        'city_id', v_city_id,
        'branch_id', v_branch_id,
        'promised_delivery_date', v_promise.promised_delivery_date,
        'promised_delivery_at', v_promise.promised_delivery_at,
        'promised_window_start_at', v_promise.promised_window_start_at,
        'promised_window_end_at', v_promise.promised_window_end_at,
        'settings_resolution_id', v_settings_resolution_id,
        'workflow_run_id', p_step.workflow_run_id
      )),
      v_now,
      v_now,
      'workflow_engine'
    );
  END IF;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'assigned', (v_updated > 0),
    'reason', CASE WHEN v_updated > 0 THEN NULL ELSE 'no_change' END,
    'zone_id', v_zone_id,
    'city_id', v_city_id,
    'branch_id', v_branch_id,
    'promised_delivery_date', v_promise.promised_delivery_date,
    'promised_delivery_at', v_promise.promised_delivery_at,
    'promised_window_start_at', v_promise.promised_window_start_at,
    'promised_window_end_at', v_promise.promised_window_end_at,
    'settings_resolution_id', v_settings_resolution_id,
    'debug', v_promise.debug
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'shipment', jsonb_build_object(
      'branch_id', v_branch_id,
      'promised_delivery_date', v_promise.promised_delivery_date,
      'promised_delivery_at', v_promise.promised_delivery_at,
      'promised_window_start_at', v_promise.promised_window_start_at,
      'promised_window_end_at', v_promise.promised_window_end_at
    )
  ));

  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_promise_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_promise_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Compute and persist shipment promise fields (branch-aware) using shipment_promise_policy resolved via ladder (compute_shipment_promise_v2 for rule-aware cutoffs + optional blackout shifting). Emits shipment_actions.promise_assigned when updates occur.';

SELECT pg_advisory_unlock(hashtext('202601282310_promise_assign_actions_restore'));
COMMIT;

