-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Quote + promise together (service-only decision API) 
-- Date: 2026-01-22 
-- 
-- Goals: 
--   - Provide a single service-only call that resolves commercial terms via the ladder, 
--     computes shipment promise + pricing quote, and logs provenance/decisions (SSOT). 
--   - Keep behavior policy-driven (settings_versions + resolver); no tenant hardcoding. 

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221030_quote_and_promise_decision_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.quote_and_promise_v1(
  p_policy_context JSONB,
  p_zone_id UUID,
  p_service_type TEXT,
  p_service_level TEXT,
  p_distance_km NUMERIC DEFAULT NULL,
  p_box_count INT DEFAULT NULL,
  p_cod_amount NUMERIC DEFAULT NULL,
  p_now TIMESTAMPTZ DEFAULT NULL,
  p_promised_delivery_date DATE DEFAULT NULL,
  p_resource_type TEXT DEFAULT 'quote_request',
  p_resource_id UUID DEFAULT NULL,
  p_decision_point TEXT DEFAULT 'quote_and_promise_v1',
  p_decision_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_policy_ctx JSONB := COALESCE(p_policy_context, '{}'::jsonb);
  v_org_id UUID := NULL;

  v_branch_id UUID := NULL;
  v_timezone TEXT := NULL;

  v_promise_row RECORD;
  v_pricing_row RECORD;
  v_cod_row RECORD;
  v_settlement_row RECORD;
  v_has_promise_row BOOLEAN := FALSE;
  v_has_pricing_row BOOLEAN := FALSE;
  v_has_cod_row BOOLEAN := FALSE;
  v_has_settlement_row BOOLEAN := FALSE;

  v_promise_policy JSONB := '{}'::jsonb;
  v_pricing_policy JSONB := '{}'::jsonb;
  v_cod_policy JSONB := '{}'::jsonb;
  v_settlement_policy JSONB := '{}'::jsonb;

  v_promise RECORD;
  v_quote RECORD;

  v_promise_settings_resolution_id UUID := NULL;
  v_pricing_settings_resolution_id UUID := NULL;
  v_cod_settings_resolution_id UUID := NULL;
  v_settlement_settings_resolution_id UUID := NULL;

  v_actor_system TEXT := NULLIF(btrim(COALESCE(current_setting('app.actor_system', true), '')), '');
  v_resource_id UUID := COALESCE(p_resource_id, gen_random_uuid());
  v_outcome TEXT := 'computed';
  v_decision_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_policy_ctx) <> 'object' THEN
    RAISE EXCEPTION 'quote_and_promise_v1 expects policy_context as a JSON object'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_policy_ctx->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'quote_and_promise_v1 missing policy_context.organization_id'
      USING ERRCODE = '23514';
  END IF;

  IF p_zone_id IS NULL THEN
    RAISE EXCEPTION 'quote_and_promise_v1 requires zone_id'
      USING ERRCODE = '23514';
  END IF;

  -- Best-effort branch resolution for resource-scope policies; quoting can still proceed when unmapped.
  v_branch_id := public.resolve_branch_id_for_zone(p_zone_id);

  IF v_branch_id IS NOT NULL THEN
    v_policy_ctx := jsonb_set(v_policy_ctx, '{resource_id}', to_jsonb(v_branch_id), TRUE);
  END IF;

  -- Resolve policies via canonical ladder (agreement-as-resolution).
  SELECT * INTO v_promise_row FROM public.resolve_shipment_promise_policy(v_policy_ctx) LIMIT 1;
  v_has_promise_row := FOUND;
  IF v_has_promise_row AND v_promise_row.value IS NOT NULL THEN
    v_promise_policy := v_promise_row.value;
  END IF;

  SELECT * INTO v_pricing_row FROM public.resolve_pricing_policy(v_policy_ctx) LIMIT 1;
  v_has_pricing_row := FOUND;
  IF v_has_pricing_row AND v_pricing_row.value IS NOT NULL THEN
    v_pricing_policy := v_pricing_row.value;
  END IF;

  SELECT * INTO v_cod_row FROM public.resolve_cod_policy(v_policy_ctx) LIMIT 1;
  v_has_cod_row := FOUND;
  IF v_has_cod_row AND v_cod_row.value IS NOT NULL THEN
    v_cod_policy := v_cod_row.value;
  END IF;

  SELECT * INTO v_settlement_row FROM public.resolve_settlement_policy(v_policy_ctx) LIMIT 1;
  v_has_settlement_row := FOUND;
  IF v_has_settlement_row AND v_settlement_row.value IS NOT NULL THEN
    v_settlement_policy := v_settlement_row.value;
  END IF;

  -- Determine effective timezone: branch timezone when enabled + present; otherwise policy timezone (or UTC).
  BEGIN
    IF v_branch_id IS NOT NULL AND COALESCE((v_promise_policy->>'use_branch_timezone')::BOOLEAN, TRUE) THEN
      SELECT b.timezone
        INTO v_timezone
        FROM public.branches b
       WHERE b.id = v_branch_id;
    END IF;
  EXCEPTION
    WHEN others THEN
      v_timezone := NULL;
  END;
  v_timezone := COALESCE(NULLIF(v_timezone, ''), NULLIF(v_promise_policy->>'timezone', ''), 'UTC');

  -- Compute (pure) promise + quote.
  SELECT *
    INTO v_promise
    FROM public.compute_shipment_promise_v2(
      p_now := v_now,
      p_timezone := v_timezone,
      p_context := jsonb_strip_nulls(jsonb_build_object(
        'service_type', NULLIF(p_service_type, ''),
        'service_level', NULLIF(p_service_level, ''),
        'zone_id', p_zone_id
      )),
      p_policy := v_promise_policy,
      p_promised_delivery_date := p_promised_delivery_date
    )
   LIMIT 1;

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      p_context := jsonb_strip_nulls(jsonb_build_object(
        'service_type', NULLIF(p_service_type, ''),
        'service_level', NULLIF(p_service_level, ''),
        'zone_id', p_zone_id,
        'distance_km', p_distance_km,
        'box_count', p_box_count,
        'cod_amount', p_cod_amount
      )),
      p_policy := v_pricing_policy
    )
   LIMIT 1;

  IF v_promise.promised_delivery_date IS NULL AND v_quote.total_amount IS NULL THEN
    v_outcome := 'uncomputable';
  ELSIF v_promise.promised_delivery_date IS NULL OR v_quote.total_amount IS NULL THEN
    v_outcome := 'partial';
  END IF;

  -- Record settings provenance (one row per category when available).
  IF v_has_promise_row AND v_promise_row.settings_id IS NOT NULL THEN
    v_promise_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'shipment_promise_policy',
      p_winning_scope_type := COALESCE(v_promise_row.scope_type, 'global'),
      p_winning_scope_id := v_promise_row.scope_id,
      p_winning_settings_id := v_promise_row.settings_id,
      p_winning_settings_version_id := v_promise_row.settings_version_id,
      p_winning_version := COALESCE(v_promise_row.version, 1),
      p_scope_path := COALESCE(v_promise_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'policy_context', v_policy_ctx,
        'compute_context', jsonb_strip_nulls(jsonb_build_object(
          'service_type', NULLIF(p_service_type, ''),
          'service_level', NULLIF(p_service_level, ''),
          'zone_id', p_zone_id
        )),
        'now', v_now,
        'timezone', v_timezone,
        'promise_debug', v_promise.debug
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_pricing_row AND v_pricing_row.settings_id IS NOT NULL THEN
    v_pricing_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'pricing_policy',
      p_winning_scope_type := COALESCE(v_pricing_row.scope_type, 'global'),
      p_winning_scope_id := v_pricing_row.scope_id,
      p_winning_settings_id := v_pricing_row.settings_id,
      p_winning_settings_version_id := v_pricing_row.settings_version_id,
      p_winning_version := COALESCE(v_pricing_row.version, 1),
      p_scope_path := COALESCE(v_pricing_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'policy_context', v_policy_ctx,
        'compute_context', jsonb_strip_nulls(jsonb_build_object(
          'service_type', NULLIF(p_service_type, ''),
          'service_level', NULLIF(p_service_level, ''),
          'zone_id', p_zone_id,
          'distance_km', p_distance_km,
          'box_count', p_box_count,
          'cod_amount', p_cod_amount
        )),
        'quote_debug', v_quote.debug,
        'quote_breakdown', v_quote.breakdown
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_cod_row AND v_cod_row.settings_id IS NOT NULL THEN
    v_cod_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'cod_policy',
      p_winning_scope_type := COALESCE(v_cod_row.scope_type, 'global'),
      p_winning_scope_id := v_cod_row.scope_id,
      p_winning_settings_id := v_cod_row.settings_id,
      p_winning_settings_version_id := v_cod_row.settings_version_id,
      p_winning_version := COALESCE(v_cod_row.version, 1),
      p_scope_path := COALESCE(v_cod_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'policy_context', v_policy_ctx
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_settlement_row AND v_settlement_row.settings_id IS NOT NULL THEN
    v_settlement_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := COALESCE(v_settlement_row.scope_type, 'global'),
      p_winning_scope_id := v_settlement_row.scope_id,
      p_winning_settings_id := v_settlement_row.settings_id,
      p_winning_settings_version_id := v_settlement_row.settings_version_id,
      p_winning_version := COALESCE(v_settlement_row.version, 1),
      p_scope_path := COALESCE(v_settlement_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'policy_context', v_policy_ctx
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Decision artifact (SSOT): decision_log (single record; references pricing resolution by default).
  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'quote_promise',
    p_resource_type := COALESCE(NULLIF(btrim(p_resource_type), ''), 'quote_request'),
    p_resource_id := v_resource_id,
    p_decision_point := COALESCE(NULLIF(btrim(p_decision_point), ''), 'quote_and_promise_v1'),
    p_decision_outcome := v_outcome,
    p_performed_by_system := COALESCE(v_actor_system, 'quote_and_promise'),
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'policy_context', v_policy_ctx,
      'zone_id', p_zone_id,
      'branch_id', v_branch_id,
      'timezone', v_timezone,
      'service_type', NULLIF(p_service_type, ''),
      'service_level', NULLIF(p_service_level, ''),
      'distance_km', p_distance_km,
      'box_count', p_box_count,
      'cod_amount', p_cod_amount,
      'settings_resolution_ids', jsonb_strip_nulls(jsonb_build_object(
        'shipment_promise_policy', v_promise_settings_resolution_id,
        'pricing_policy', v_pricing_settings_resolution_id,
        'cod_policy', v_cod_settings_resolution_id,
        'settlement_policy', v_settlement_settings_resolution_id
      )),
      'promise_debug', v_promise.debug,
      'quote_debug', v_quote.debug
    )),
    p_decision_reason := p_decision_reason,
    p_settings_resolution_id := COALESCE(v_pricing_settings_resolution_id, v_promise_settings_resolution_id)
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', v_outcome,
    'decision_log_id', v_decision_id,
    'organization_id', v_org_id,
    'resource_type', COALESCE(NULLIF(btrim(p_resource_type), ''), 'quote_request'),
    'resource_id', v_resource_id,
    'zone_id', p_zone_id,
    'branch_id', v_branch_id,
    'timezone', v_timezone,
    'quote', jsonb_build_object(
      'currency', v_quote.currency,
      'total_amount', v_quote.total_amount,
      'breakdown', COALESCE(v_quote.breakdown, '[]'::jsonb),
      'debug', COALESCE(v_quote.debug, '{}'::jsonb)
    ),
    'promise', jsonb_build_object(
      'promised_delivery_date', v_promise.promised_delivery_date,
      'promised_delivery_at', v_promise.promised_delivery_at,
      'promised_window_start_at', v_promise.promised_window_start_at,
      'promised_window_end_at', v_promise.promised_window_end_at,
      'debug', COALESCE(v_promise.debug, '{}'::jsonb)
    ),
    'terms', jsonb_strip_nulls(jsonb_build_object(
      'shipment_promise_policy', CASE WHEN v_has_promise_row AND v_promise_row.settings_id IS NOT NULL THEN jsonb_build_object(
        'settings_id', v_promise_row.settings_id,
        'settings_version_id', v_promise_row.settings_version_id,
        'scope_type', v_promise_row.scope_type,
        'scope_id', v_promise_row.scope_id,
        'version', v_promise_row.version,
        'scope_path', v_promise_row.scope_path
      ) END,
      'pricing_policy', CASE WHEN v_has_pricing_row AND v_pricing_row.settings_id IS NOT NULL THEN jsonb_build_object(
        'settings_id', v_pricing_row.settings_id,
        'settings_version_id', v_pricing_row.settings_version_id,
        'scope_type', v_pricing_row.scope_type,
        'scope_id', v_pricing_row.scope_id,
        'version', v_pricing_row.version,
        'scope_path', v_pricing_row.scope_path
      ) END,
      'cod_policy', CASE WHEN v_has_cod_row AND v_cod_row.settings_id IS NOT NULL THEN jsonb_build_object(
        'settings_id', v_cod_row.settings_id,
        'settings_version_id', v_cod_row.settings_version_id,
        'scope_type', v_cod_row.scope_type,
        'scope_id', v_cod_row.scope_id,
        'version', v_cod_row.version,
        'scope_path', v_cod_row.scope_path
      ) END,
      'settlement_policy', CASE WHEN v_has_settlement_row AND v_settlement_row.settings_id IS NOT NULL THEN jsonb_build_object(
        'settings_id', v_settlement_row.settings_id,
        'settings_version_id', v_settlement_row.settings_version_id,
        'scope_type', v_settlement_row.scope_type,
        'scope_id', v_settlement_row.scope_id,
        'version', v_settlement_row.version,
        'scope_path', v_settlement_row.scope_path
      ) END
    )),
    'settings_resolution_ids', jsonb_strip_nulls(jsonb_build_object(
      'shipment_promise_policy', v_promise_settings_resolution_id,
      'pricing_policy', v_pricing_settings_resolution_id,
      'cod_policy', v_cod_settings_resolution_id,
      'settlement_policy', v_settlement_settings_resolution_id
    ))
  ));
END;
$function$;

COMMENT ON FUNCTION public.quote_and_promise_v1(JSONB, UUID, TEXT, TEXT, NUMERIC, INT, NUMERIC, TIMESTAMPTZ, DATE, TEXT, UUID, TEXT, TEXT) IS
  'Service-only contract: resolve commercial terms via ladder, compute pricing quote + shipment promise, and log provenance (settings_resolution_log) + decision (decision_log). Returns quote + promise + provenance ids.';

REVOKE ALL ON FUNCTION public.quote_and_promise_v1(JSONB, UUID, TEXT, TEXT, NUMERIC, INT, NUMERIC, TIMESTAMPTZ, DATE, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quote_and_promise_v1(JSONB, UUID, TEXT, TEXT, NUMERIC, INT, NUMERIC, TIMESTAMPTZ, DATE, TEXT, UUID, TEXT, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601221030_quote_and_promise_decision_v1'));
COMMIT;
