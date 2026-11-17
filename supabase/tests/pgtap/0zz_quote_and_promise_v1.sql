-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Quote + promise together (service-only contract + ladder + provenance)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

SELECT has_function(
  'public',
  'quote_and_promise_v1',
  ARRAY['jsonb','uuid','text','text','numeric','integer','numeric','timestamptz','date','text','uuid','text','text'],
  'quote_and_promise_v1(...) exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.quote_and_promise_v1(jsonb,uuid,text,text,numeric,integer,numeric,timestamptz,date,text,uuid,text,text)',
    'EXECUTE'
  ),
  'service_role can EXECUTE quote_and_promise_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.quote_and_promise_v1(jsonb,uuid,text,text,numeric,integer,numeric,timestamptz,date,text,uuid,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE quote_and_promise_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.quote_and_promise_v1(jsonb,uuid,text,text,numeric,integer,numeric,timestamptz,date,text,uuid,text,text)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE quote_and_promise_v1'
);

-- The local Supabase Postgres runtime crashes on denied execution of this
-- SECURITY DEFINER function under SET LOCAL ROLE authenticated. Keep the
-- permission proof here at the ACL layer so local pgTAP/local:verify stays
-- stable while still failing closed on grant drift.

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();

  v_promise_client_ver UUID;
  v_promise_sender_ver UUID;
  v_pricing_client_ver UUID;
  v_pricing_sender_ver UUID;
  v_cod_sender_ver UUID;
  v_settlement_sender_ver UUID;

  v_resp JSONB;
  v_decision_id UUID;

  v_pricing_res_id UUID;
  v_promise_res_id UUID;
  v_cod_res_id UUID;
  v_settlement_res_id UUID;

  v_policy_ctx JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Quote Promise Org', 'qp-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Quote Promise Client', 'qp-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Quote Promise Sender', 'Quote Promise Sender', TRUE, 'active');

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_org, 'QP Zone', 'qp-zone-' || left(v_zone::text, 8), TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'qp-branch-' || left(v_branch::text, 8), 'QP Branch', 'UTC', TRUE);

  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES (v_branch, v_zone);

  -- Client promise baseline (should be overridden by sender promise).
  SELECT up.settings_version_id
    INTO v_promise_client_ver
    FROM public.upsert_settings_value_v1(
      p_category := 'shipment_promise_policy',
      p_scope_type := 'client',
      p_scope_id := v_client,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'timezone', 'Asia/Riyadh',
        'use_branch_timezone', true,
        'cutoff_time', '18:00',
        'default_service_level', 'standard',
        'default_transit_days', 5,
        'service_level_transit_days', jsonb_build_object('standard', 5),
        'delivery_window_start', '09:00',
        'delivery_window_end', '18:00'
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap quote_and_promise_v1'
    ) AS up
   LIMIT 1;

  -- Sender promise override: zone+day rule with earlier cutoff and faster transit.
  SELECT up.settings_version_id
    INTO v_promise_sender_ver
    FROM public.upsert_settings_value_v1(
      p_category := 'shipment_promise_policy',
      p_scope_type := 'sender',
      p_scope_id := v_sender,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'timezone', 'Asia/Riyadh',
        'use_branch_timezone', true,
        'cutoff_time', '15:00',
        'default_service_level', 'standard',
        'default_transit_days', 2,
        'service_level_transit_days', jsonb_build_object('standard', 2),
        'delivery_window_start', '09:00',
        'delivery_window_end', '18:00',
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 100,
            'is_active', true,
            'match', jsonb_build_object(
              'zone_id', v_zone::text,
              'service_level', 'standard',
              'service_type', 'delivery',
              'day_of_week', 4
            ),
            'cutoff_time', '12:00',
            'transit_days', 1,
            'delivery_window_start', '10:00',
            'delivery_window_end', '20:00'
          )
        )
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap quote_and_promise_v1'
    ) AS up
   LIMIT 1;

  -- Client pricing baseline (should be overridden by sender pricing).
  SELECT up.settings_version_id
    INTO v_pricing_client_ver
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'client',
      p_scope_id := v_client,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 10,
            'is_active', true,
            'match', jsonb_build_object('service_type', 'delivery'),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 30)
            )
          )
        )
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap quote_and_promise_v1'
    ) AS up
   LIMIT 1;

  -- Sender pricing override: flat=10 + per-km=2 + cod_pct=2%.
  SELECT up.settings_version_id
    INTO v_pricing_sender_ver
    FROM public.upsert_settings_value_v1(
      p_category := 'pricing_policy',
      p_scope_type := 'sender',
      p_scope_id := v_sender,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'currency', 'SAR',
        'rounding', jsonb_build_object('decimals', 2),
        'rules', jsonb_build_array(
          jsonb_build_object(
            'priority', 100,
            'is_active', true,
            'match', jsonb_build_object(
              'service_type', 'delivery',
              'service_level', 'standard',
              'zone_id', v_zone::text,
              'distance_km_min', 0,
              'distance_km_max', 50
            ),
            'components', jsonb_build_array(
              jsonb_build_object('type', 'flat', 'amount', 10),
              jsonb_build_object('type', 'distance_km', 'amount', 2),
              jsonb_build_object('type', 'cod_pct', 'amount', 2)
            )
          )
        )
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap quote_and_promise_v1'
    ) AS up
   LIMIT 1;

  -- COD + settlement policies are also resolved and logged (sender scope here).
  SELECT up.settings_version_id
    INTO v_cod_sender_ver
    FROM public.upsert_settings_value_v1(
      p_category := 'cod_policy',
      p_scope_type := 'sender',
      p_scope_id := v_sender,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'currency', 'SAR',
        'allowed_methods', jsonb_build_array('cash'),
        'handover', jsonb_build_object('require_shift_close', true, 'require_evidence', true, 'variance_tolerance_amount', 0),
        'fees', jsonb_build_object('cod_pct', 0, 'flat', 0)
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap quote_and_promise_v1'
    ) AS up
   LIMIT 1;

  SELECT up.settings_version_id
    INTO v_settlement_sender_ver
    FROM public.upsert_settings_value_v1(
      p_category := 'settlement_policy',
      p_scope_type := 'sender',
      p_scope_id := v_sender,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'batch_scopes', jsonb_build_array('driver_shift'),
        'locking', jsonb_build_object('require_manager_approval', true, 'max_variance_amount', 0)
      ),
      p_schema_version := 1,
      p_change_reason := 'pgtap quote_and_promise_v1'
    ) AS up
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE service_role';

  v_policy_ctx := jsonb_build_object(
    'organization_id', v_org,
    'client_id', v_client,
    'sender_id', v_sender
  );

  SELECT public.quote_and_promise_v1(
    p_policy_context := v_policy_ctx,
    p_zone_id := v_zone,
    p_service_type := 'delivery',
    p_service_level := 'standard',
    p_distance_km := 5,
    p_box_count := 1,
    p_cod_amount := 100,
    p_now := '2026-01-22T13:00:00Z'::timestamptz,
    p_promised_delivery_date := NULL,
    p_resource_type := 'quote_request',
    p_resource_id := NULL,
    p_decision_point := 'pgtap_quote_and_promise_v1',
    p_decision_reason := 'pgTAP'
  )
  INTO v_resp;

  v_decision_id := NULLIF(v_resp->>'decision_log_id', '')::UUID;
  v_pricing_res_id := NULLIF(v_resp #>> '{settings_resolution_ids,pricing_policy}', '')::UUID;
  v_promise_res_id := NULLIF(v_resp #>> '{settings_resolution_ids,shipment_promise_policy}', '')::UUID;
  v_cod_res_id := NULLIF(v_resp #>> '{settings_resolution_ids,cod_policy}', '')::UUID;
  v_settlement_res_id := NULLIF(v_resp #>> '{settings_resolution_ids,settlement_policy}', '')::UUID;

  PERFORM is(v_resp->>'status', 'computed', 'quote_and_promise_v1 returns computed status');
  PERFORM ok(v_decision_id IS NOT NULL, 'decision_log_id returned');
  PERFORM is(NULLIF(v_resp->>'branch_id', '')::UUID, v_branch, 'branch resolved from zone via branch_zones');
  PERFORM is(NULLIF(v_resp->>'timezone', ''), 'UTC', 'branch timezone applied when enabled');

  PERFORM is((v_resp #>> '{quote,total_amount}')::NUMERIC, 22::NUMERIC, 'quote total correct (flat + per-km + cod_pct)');
  PERFORM is((v_resp #>> '{quote,debug,rule_index}')::INT, 1, 'quote debug includes rule_index');

  PERFORM is((v_resp #>> '{promise,promised_delivery_date}')::DATE, '2026-01-24'::DATE, 'promise date reflects zone cutoff + transit days');
  PERFORM is((v_resp #>> '{promise,debug,after_cutoff}')::BOOLEAN, TRUE, 'promise debug after_cutoff true');
  PERFORM is((v_resp #>> '{promise,debug,rule_index}')::INT, 1, 'promise debug includes rule_index');

  PERFORM is((v_resp #>> '{terms,pricing_policy,scope_type}'), 'sender', 'pricing terms resolved at sender scope');
  PERFORM is((v_resp #>> '{terms,shipment_promise_policy,scope_type}'), 'sender', 'promise terms resolved at sender scope');

  PERFORM ok(v_pricing_res_id IS NOT NULL, 'pricing settings_resolution_id returned');
  PERFORM ok(v_promise_res_id IS NOT NULL, 'promise settings_resolution_id returned');
  PERFORM ok(v_cod_res_id IS NOT NULL, 'cod settings_resolution_id returned');
  PERFORM ok(v_settlement_res_id IS NOT NULL, 'settlement settings_resolution_id returned');

  PERFORM is(
    (
      SELECT COUNT(*)::INT
      FROM public.settings_resolution_log srl
      WHERE srl.id = v_pricing_res_id
        AND srl.organization_id = v_org
        AND srl.category = 'pricing_policy'
        AND srl.winning_scope_type = 'sender'
    ),
    1,
    'settings_resolution_log row exists for pricing_policy (sender)'
  );

  PERFORM is(
    (
      SELECT COUNT(*)::INT
      FROM public.settings_resolution_log srl
      WHERE srl.id = v_promise_res_id
        AND srl.organization_id = v_org
        AND srl.category = 'shipment_promise_policy'
        AND srl.winning_scope_type = 'sender'
    ),
    1,
    'settings_resolution_log row exists for shipment_promise_policy (sender)'
  );

  PERFORM is(
    (
      SELECT COUNT(*)::INT
      FROM public.settings_resolution_log srl
      WHERE srl.id = v_cod_res_id
        AND srl.organization_id = v_org
        AND srl.category = 'cod_policy'
        AND srl.winning_scope_type = 'sender'
    ),
    1,
    'settings_resolution_log row exists for cod_policy (sender)'
  );

  PERFORM is(
    (
      SELECT COUNT(*)::INT
      FROM public.settings_resolution_log srl
      WHERE srl.id = v_settlement_res_id
        AND srl.organization_id = v_org
        AND srl.category = 'settlement_policy'
        AND srl.winning_scope_type = 'sender'
    ),
    1,
    'settings_resolution_log row exists for settlement_policy (sender)'
  );

  PERFORM is(
    (
      SELECT COUNT(*)::INT
      FROM public.decision_log dl
      WHERE dl.id = v_decision_id
        AND dl.organization_id = v_org
        AND dl.decision_category = 'quote_promise'
    ),
    1,
    'decision_log row exists for quote_promise'
  );
END $$;

SELECT * FROM finish();

ROLLBACK;
