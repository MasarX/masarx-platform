-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Agreements - SLA promise rules + pricing quote enhancements
-- Date: 2026-01-22
--
-- Goals:
--   - Extend shipment promise computation to support rule-driven overrides (zone/service_level/day_of_week).
--   - Extend pricing quote computation to support tiered distance components and COD fee components.
--   - Keep everything reusable, configuration-driven, and ladder-compliant (no hardcoding).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601220900_agreements_sla_pricing_enhancements_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Promise compute helper v2 (rule-driven overrides inside policy JSON)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_shipment_promise_v2(
  p_now TIMESTAMPTZ,
  p_timezone TEXT,
  p_context JSONB,
  p_policy JSONB,
  p_promised_delivery_date DATE DEFAULT NULL
)
RETURNS TABLE (
  promised_delivery_date DATE,
  promised_window_start_at TIMESTAMPTZ,
  promised_window_end_at TIMESTAMPTZ,
  promised_delivery_at TIMESTAMPTZ,
  debug JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_context, '{}'::jsonb);

  v_tz TEXT := COALESCE(NULLIF(p_timezone, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');
  v_service_level TEXT := COALESCE(NULLIF(v_ctx->>'service_level', ''), NULLIF(v_policy->>'default_service_level', ''));
  v_service_type TEXT := NULLIF(v_ctx->>'service_type', '');
  v_zone_id UUID := NULL;

  v_rules JSONB := COALESCE(v_policy->'rules', '[]'::jsonb);
  v_rule RECORD;
  v_match JSONB;
  v_best_rule JSONB := NULL;
  v_best_idx INT := NULL;
  v_best_priority INT := -1;

  v_local_now TIMESTAMP;
  v_day_of_week INT;
  v_after_cutoff BOOLEAN := FALSE;

  v_cutoff_text TEXT := NULLIF(v_policy->>'cutoff_time', '');
  v_window_start_text TEXT := NULLIF(v_policy->>'delivery_window_start', '');
  v_window_end_text TEXT := NULLIF(v_policy->>'delivery_window_end', '');

  v_default_transit_days INT := NULL;
  v_transit_days INT := NULL;

  v_effective_policy JSONB := v_policy;
  v_effective_promised_date DATE := NULL;
  v_res RECORD;
BEGIN
  IF p_now IS NULL THEN
    p_now := now();
  END IF;

  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
    v_effective_policy := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(v_ctx) <> 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  IF COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE) IS NOT TRUE THEN
    promised_delivery_date := p_promised_delivery_date;
    promised_window_start_at := NULL;
    promised_window_end_at := NULL;
    promised_delivery_at := NULL;
    debug := jsonb_build_object('status', 'disabled');
    RETURN NEXT;
    RETURN;
  END IF;

  BEGIN v_zone_id := NULLIF(v_ctx->>'zone_id', '')::UUID; EXCEPTION WHEN others THEN v_zone_id := NULL; END;

  v_local_now := p_now AT TIME ZONE v_tz;
  v_day_of_week := EXTRACT(DOW FROM v_local_now)::INT;

  -- Base transit days (from policy) when we need to compute the promised date.
  BEGIN
    v_default_transit_days := NULLIF(v_policy->>'default_transit_days', '')::INT;
  EXCEPTION
    WHEN others THEN
      v_default_transit_days := NULL;
  END;

  BEGIN
    v_transit_days := NULLIF((v_policy->'service_level_transit_days'->>v_service_level), '')::INT;
  EXCEPTION
    WHEN others THEN
      v_transit_days := NULL;
  END;

  v_transit_days := COALESCE(v_transit_days, v_default_transit_days);

  -- Apply best matching override rule (optional; forward compatible).
  IF jsonb_typeof(v_rules) <> 'array' THEN
    v_rules := '[]'::jsonb;
  END IF;

  FOR v_rule IN
    SELECT value AS rule, ordinality AS idx
    FROM jsonb_array_elements(v_rules) WITH ORDINALITY
  LOOP
    DECLARE
      v_priority INT := 0;
      v_active BOOLEAN := TRUE;
      v_match_ok BOOLEAN := TRUE;
      v_match_zone TEXT := NULL;
      v_match_level TEXT := NULL;
      v_match_type TEXT := NULL;
      v_match_dow INT := NULL;
    BEGIN
      BEGIN v_priority := COALESCE(NULLIF((v_rule.rule->>'priority'), '')::INT, 0); EXCEPTION WHEN others THEN v_priority := 0; END;
      BEGIN v_active := COALESCE((v_rule.rule->>'is_active')::BOOLEAN, TRUE); EXCEPTION WHEN others THEN v_active := TRUE; END;
      IF v_active IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_match := COALESCE(v_rule.rule->'match', '{}'::jsonb);
      IF jsonb_typeof(v_match) <> 'object' THEN
        v_match := '{}'::jsonb;
      END IF;

      v_match_level := NULLIF(v_match->>'service_level', '');
      IF v_match_level IS NOT NULL AND v_match_level IS DISTINCT FROM v_service_level THEN
        v_match_ok := FALSE;
      END IF;

      v_match_type := NULLIF(v_match->>'service_type', '');
      IF v_match_type IS NOT NULL AND v_service_type IS NOT NULL AND v_match_type IS DISTINCT FROM v_service_type THEN
        v_match_ok := FALSE;
      END IF;

      v_match_zone := NULLIF(v_match->>'zone_id', '');
      IF v_match_zone IS NOT NULL THEN
        IF v_zone_id IS NULL OR v_match_zone IS DISTINCT FROM v_zone_id::text THEN
          v_match_ok := FALSE;
        END IF;
      END IF;

      BEGIN v_match_dow := NULLIF(v_match->>'day_of_week', '')::INT; EXCEPTION WHEN others THEN v_match_dow := NULL; END;
      IF v_match_dow IS NOT NULL AND v_match_dow IS DISTINCT FROM v_day_of_week THEN
        v_match_ok := FALSE;
      END IF;

      IF v_match_ok IS NOT TRUE THEN
        CONTINUE;
      END IF;

      IF v_priority > v_best_priority THEN
        v_best_rule := v_rule.rule;
        v_best_idx := v_rule.idx;
        v_best_priority := v_priority;
      END IF;
    END;
  END LOOP;

  IF v_best_rule IS NOT NULL THEN
    -- Rule-level overrides (optional keys).
    IF NULLIF(v_best_rule->>'cutoff_time', '') IS NOT NULL THEN
      v_cutoff_text := NULLIF(v_best_rule->>'cutoff_time', '');
    END IF;
    IF NULLIF(v_best_rule->>'delivery_window_start', '') IS NOT NULL THEN
      v_window_start_text := NULLIF(v_best_rule->>'delivery_window_start', '');
    END IF;
    IF NULLIF(v_best_rule->>'delivery_window_end', '') IS NOT NULL THEN
      v_window_end_text := NULLIF(v_best_rule->>'delivery_window_end', '');
    END IF;

    BEGIN
      v_transit_days := COALESCE(NULLIF(v_best_rule->>'transit_days', '')::INT, v_transit_days);
    EXCEPTION
      WHEN others THEN
        v_transit_days := v_transit_days;
    END;
  END IF;

  -- Build the effective policy (so downstream debug shows effective values).
  v_effective_policy := v_policy;
  IF v_cutoff_text IS NOT NULL THEN
    v_effective_policy := jsonb_set(v_effective_policy, '{cutoff_time}', to_jsonb(v_cutoff_text), TRUE);
  END IF;
  IF v_window_start_text IS NOT NULL THEN
    v_effective_policy := jsonb_set(v_effective_policy, '{delivery_window_start}', to_jsonb(v_window_start_text), TRUE);
  END IF;
  IF v_window_end_text IS NOT NULL THEN
    v_effective_policy := jsonb_set(v_effective_policy, '{delivery_window_end}', to_jsonb(v_window_end_text), TRUE);
  END IF;

  -- Determine promised date.
  IF p_promised_delivery_date IS NOT NULL THEN
    v_effective_promised_date := p_promised_delivery_date;
  ELSE
    IF v_transit_days IS NULL THEN
      v_effective_promised_date := NULL;
    ELSE
      DECLARE
        v_cutoff TIME := NULL;
        v_base_date DATE := v_local_now::date;
      BEGIN
        BEGIN v_cutoff := CASE WHEN v_cutoff_text IS NULL THEN NULL ELSE v_cutoff_text::time END; EXCEPTION WHEN others THEN v_cutoff := NULL; END;
        IF v_cutoff IS NOT NULL AND (v_local_now::time >= v_cutoff) THEN
          v_base_date := v_base_date + 1;
          v_after_cutoff := TRUE;
        END IF;
        v_effective_promised_date := v_base_date + v_transit_days;
      END;
    END IF;
  END IF;

  SELECT *
    INTO v_res
    FROM public.compute_shipment_promise_v1(
      p_now := p_now,
      p_timezone := v_tz,
      p_service_level := v_service_level,
      p_policy := v_effective_policy,
      p_promised_delivery_date := v_effective_promised_date
    )
   LIMIT 1;

  promised_delivery_date := v_res.promised_delivery_date;
  promised_window_start_at := v_res.promised_window_start_at;
  promised_window_end_at := v_res.promised_window_end_at;
  promised_delivery_at := v_res.promised_delivery_at;

  debug := jsonb_strip_nulls(COALESCE(v_res.debug, '{}'::jsonb) || jsonb_build_object(
    'status', 'computed',
    'rule_index', v_best_idx,
    'rule_priority', NULLIF(v_best_priority, -1),
    'day_of_week', v_day_of_week,
    'after_cutoff', v_after_cutoff,
    'zone_id', v_zone_id,
    'service_type', v_service_type
  ));

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.compute_shipment_promise_v2(TIMESTAMPTZ, TEXT, JSONB, JSONB, DATE) IS
  'Compute shipment promise using shipment_promise_policy plus optional rule-driven overrides (match on zone/service level/type/day_of_week). Returns date + window and an explainable debug payload.';

-------------------------------------------------------------------------------
-- 2) Update promise_assign handler to use compute_shipment_promise_v2 (rule-aware)
-------------------------------------------------------------------------------

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
        'service_type', v_ship_service_type,
        'service_level', v_ship_service_level,
        'zone_id', v_zone_id
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
    'branch_id', v_branch_id,
    'promised_delivery_date', v_promise.promised_delivery_date,
    'promised_delivery_at', v_promise.promised_delivery_at,
    'promised_window_start_at', v_promise.promised_window_start_at,
    'promised_window_end_at', v_promise.promised_window_end_at,
    'settings_resolution_id', v_settings_resolution_id
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
  'Compute and persist shipment promise fields (branch-aware) using shipment_promise_policy resolved via ladder (uses compute_shipment_promise_v2 for rule-aware cutoffs).';

-------------------------------------------------------------------------------
-- 3) Pricing quote enhancements (tiered distance + COD flat + component clamps)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_pricing_quote_v1(
  p_context JSONB,
  p_policy JSONB
)
RETURNS TABLE (
  currency TEXT,
  total_amount NUMERIC,
  breakdown JSONB,
  debug JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_rules JSONB := COALESCE(v_policy->'rules', '[]'::jsonb);
  v_currency TEXT := COALESCE(NULLIF(v_policy->>'currency', ''), 'SAR');
  v_decimals INT := 2;

  v_service_type TEXT := NULLIF(v_context->>'service_type', '');
  v_service_level TEXT := NULLIF(v_context->>'service_level', '');
  v_zone_id UUID := NULL;
  v_distance_km NUMERIC := NULL;
  v_box_count INT := NULL;
  v_cod_amount NUMERIC := NULL;

  v_best_rule JSONB := NULL;
  v_best_idx INT := NULL;
  v_best_priority INT := -1;

  v_rule RECORD;
  v_match JSONB;
  v_components JSONB;
  v_component JSONB;

  v_component_type TEXT;
  v_component_amount NUMERIC;
  v_component_value NUMERIC;
  v_component_min NUMERIC;
  v_component_max NUMERIC;

  v_total NUMERIC := 0;
  v_min_total NUMERIC := NULL;
  v_max_total NUMERIC := NULL;
  v_out_breakdown JSONB := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(v_context) <> 'object' THEN
    v_context := '{}'::jsonb;
  END IF;

  BEGIN v_decimals := COALESCE(NULLIF((v_policy #>> '{rounding,decimals}'), '')::INT, 2); EXCEPTION WHEN others THEN v_decimals := 2; END;

  IF COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE) IS NOT TRUE THEN
    RETURN QUERY
    SELECT v_currency, NULL::NUMERIC, '[]'::jsonb, jsonb_build_object('status', 'disabled');
    RETURN;
  END IF;

  BEGIN v_zone_id := NULLIF(v_context->>'zone_id', '')::UUID; EXCEPTION WHEN others THEN v_zone_id := NULL; END;
  BEGIN v_distance_km := NULLIF(v_context->>'distance_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_distance_km := NULL; END;
  BEGIN v_box_count := NULLIF(v_context->>'box_count', '')::INT; EXCEPTION WHEN others THEN v_box_count := NULL; END;
  BEGIN v_cod_amount := NULLIF(v_context->>'cod_amount', '')::NUMERIC; EXCEPTION WHEN others THEN v_cod_amount := NULL; END;

  IF jsonb_typeof(v_rules) <> 'array' THEN
    v_rules := '[]'::jsonb;
  END IF;

  FOR v_rule IN
    SELECT value AS rule, ordinality AS idx
    FROM jsonb_array_elements(v_rules) WITH ORDINALITY
  LOOP
    DECLARE
      v_priority INT := 0;
      v_active BOOLEAN := TRUE;
      v_match_ok BOOLEAN := TRUE;
      v_zone_text TEXT := NULL;
      v_min_km NUMERIC := NULL;
      v_max_km NUMERIC := NULL;
    BEGIN
      BEGIN v_priority := COALESCE(NULLIF((v_rule.rule->>'priority'), '')::INT, 0); EXCEPTION WHEN others THEN v_priority := 0; END;
      BEGIN v_active := COALESCE((v_rule.rule->>'is_active')::BOOLEAN, TRUE); EXCEPTION WHEN others THEN v_active := TRUE; END;
      IF v_active IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_match := COALESCE(v_rule.rule->'match', '{}'::jsonb);
      IF jsonb_typeof(v_match) <> 'object' THEN
        v_match := '{}'::jsonb;
      END IF;

      IF NULLIF(v_match->>'service_type', '') IS NOT NULL AND NULLIF(v_match->>'service_type', '') IS DISTINCT FROM v_service_type THEN
        v_match_ok := FALSE;
      END IF;
      IF NULLIF(v_match->>'service_level', '') IS NOT NULL AND NULLIF(v_match->>'service_level', '') IS DISTINCT FROM v_service_level THEN
        v_match_ok := FALSE;
      END IF;

      v_zone_text := NULLIF(v_match->>'zone_id', '');
      IF v_zone_text IS NOT NULL THEN
        IF v_zone_id IS NULL OR v_zone_text IS DISTINCT FROM v_zone_id::text THEN
          v_match_ok := FALSE;
        END IF;
      END IF;

      BEGIN v_min_km := NULLIF(v_match->>'distance_km_min', '')::NUMERIC; EXCEPTION WHEN others THEN v_min_km := NULL; END;
      BEGIN v_max_km := NULLIF(v_match->>'distance_km_max', '')::NUMERIC; EXCEPTION WHEN others THEN v_max_km := NULL; END;

      IF v_min_km IS NOT NULL AND (v_distance_km IS NULL OR v_distance_km < v_min_km) THEN
        v_match_ok := FALSE;
      END IF;
      IF v_max_km IS NOT NULL AND (v_distance_km IS NULL OR v_distance_km > v_max_km) THEN
        v_match_ok := FALSE;
      END IF;

      IF v_match_ok IS NOT TRUE THEN
        CONTINUE;
      END IF;

      IF v_priority > v_best_priority THEN
        v_best_rule := v_rule.rule;
        v_best_idx := v_rule.idx;
        v_best_priority := v_priority;
      END IF;
    END;
  END LOOP;

  IF v_best_rule IS NULL THEN
    RETURN QUERY
    SELECT v_currency, NULL::NUMERIC, '[]'::jsonb, jsonb_build_object('status', 'no_match');
    RETURN;
  END IF;

  v_components := COALESCE(v_best_rule->'components', '[]'::jsonb);
  IF jsonb_typeof(v_components) <> 'array' THEN
    v_components := '[]'::jsonb;
  END IF;

  BEGIN v_min_total := NULLIF(v_best_rule->>'min_total', '')::NUMERIC; EXCEPTION WHEN others THEN v_min_total := NULL; END;
  BEGIN v_max_total := NULLIF(v_best_rule->>'max_total', '')::NUMERIC; EXCEPTION WHEN others THEN v_max_total := NULL; END;

  v_total := 0;
  v_out_breakdown := '[]'::jsonb;

  FOR v_component IN SELECT value FROM jsonb_array_elements(v_components)
  LOOP
    v_component_type := NULLIF(v_component->>'type', '');
    BEGIN v_component_amount := NULLIF(v_component->>'amount', '')::NUMERIC; EXCEPTION WHEN others THEN v_component_amount := NULL; END;
    BEGIN v_component_min := NULLIF(v_component->>'min_value', '')::NUMERIC; EXCEPTION WHEN others THEN v_component_min := NULL; END;
    BEGIN v_component_max := NULLIF(v_component->>'max_value', '')::NUMERIC; EXCEPTION WHEN others THEN v_component_max := NULL; END;

    IF v_component_type IS NULL THEN
      CONTINUE;
    END IF;

    v_component_value := NULL;

    IF v_component_type = 'flat' THEN
      v_component_value := COALESCE(v_component_amount, 0);
    ELSIF v_component_type = 'distance_km' THEN
      v_component_value := COALESCE(v_component_amount, 0) * GREATEST(COALESCE(v_distance_km, 0), 0);
    ELSIF v_component_type = 'distance_km_above' THEN
      DECLARE v_threshold_km NUMERIC := NULL;
      BEGIN v_threshold_km := NULLIF(v_component->>'threshold_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_threshold_km := NULL; END;
      v_component_value := COALESCE(v_component_amount, 0) * GREATEST(GREATEST(COALESCE(v_distance_km, 0), 0) - COALESCE(v_threshold_km, 0), 0);
    ELSIF v_component_type = 'distance_km_band' THEN
      DECLARE
        v_band_min NUMERIC := NULL;
        v_band_max NUMERIC := NULL;
        v_band_km NUMERIC := 0;
        v_dist NUMERIC := GREATEST(COALESCE(v_distance_km, 0), 0);
      BEGIN
        BEGIN v_band_min := NULLIF(v_component->>'min_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_band_min := NULL; END;
        BEGIN v_band_max := NULLIF(v_component->>'max_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_band_max := NULL; END;
        v_band_km := GREATEST(LEAST(v_dist, COALESCE(v_band_max, v_dist)) - COALESCE(v_band_min, 0), 0);
        v_component_value := COALESCE(v_component_amount, 0) * v_band_km;
      END;
    ELSIF v_component_type = 'box_count' THEN
      v_component_value := COALESCE(v_component_amount, 0) * COALESCE(v_box_count, 1);
    ELSIF v_component_type = 'cod_pct' THEN
      v_component_value := CASE
        WHEN GREATEST(COALESCE(v_cod_amount, 0), 0) > 0
          THEN (COALESCE(v_component_amount, 0) / 100) * GREATEST(COALESCE(v_cod_amount, 0), 0)
        ELSE 0
      END;
    ELSIF v_component_type = 'cod_flat' THEN
      v_component_value := CASE WHEN GREATEST(COALESCE(v_cod_amount, 0), 0) > 0 THEN COALESCE(v_component_amount, 0) ELSE 0 END;
    ELSE
      -- Unknown component types are ignored (forward compatible).
      CONTINUE;
    END IF;

    IF v_component_value IS NOT NULL THEN
      -- For COD components: min/max apply only when COD is present; never charge when cod_amount <= 0.
      IF v_component_type LIKE 'cod_%' AND GREATEST(COALESCE(v_cod_amount, 0), 0) <= 0 THEN
        NULL;
      ELSE
        IF v_component_min IS NOT NULL THEN
          v_component_value := GREATEST(v_component_value, v_component_min);
        END IF;
        IF v_component_max IS NOT NULL THEN
          v_component_value := LEAST(v_component_value, v_component_max);
        END IF;
      END IF;
    END IF;

    v_total := v_total + COALESCE(v_component_value, 0);

    v_out_breakdown := v_out_breakdown || jsonb_build_array(
      jsonb_build_object(
        'type', v_component_type,
        'amount', v_component_amount,
        'value', v_component_value
      )
    );
  END LOOP;

  IF v_min_total IS NOT NULL THEN
    v_total := GREATEST(v_total, v_min_total);
  END IF;
  IF v_max_total IS NOT NULL THEN
    v_total := LEAST(v_total, v_max_total);
  END IF;

  v_total := round(v_total, v_decimals);

  RETURN QUERY
  SELECT
    v_currency,
    v_total,
    v_out_breakdown,
    jsonb_build_object(
      'status', 'priced',
      'rule_index', v_best_idx,
      'rule_priority', v_best_priority
    );
END;
$function$;

COMMENT ON FUNCTION public.compute_pricing_quote_v1(JSONB, JSONB) IS
  'Compute a pricing quote using a pricing_policy rule set and an input context (service_type/service_level/zone_id/distance_km/box_count/cod_amount). Returns currency, total, breakdown, debug.';

SELECT pg_advisory_unlock(hashtext('202601220900_agreements_sla_pricing_enhancements_v1'));
COMMIT;
