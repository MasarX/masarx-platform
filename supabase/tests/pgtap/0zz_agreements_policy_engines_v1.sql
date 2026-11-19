-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Agreements engines (SLA promise rules + pricing quote components)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT has_function('public', 'compute_shipment_promise_v2', ARRAY['timestamptz','text','jsonb','jsonb','date'], 'compute_shipment_promise_v2 exists');
SELECT has_function('public', 'compute_pricing_quote_v1', ARRAY['jsonb','jsonb'], 'compute_pricing_quote_v1 exists');

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_template_id UUID := gen_random_uuid();
  v_run_id UUID := gen_random_uuid();
  v_step_tmpl UUID := gen_random_uuid();
  v_step UUID := gen_random_uuid();

  v_settings_version UUID;
  v_resolution_id UUID;
  v_winning_scope_type TEXT;
  v_ship_promised_date DATE;
  v_ship_promised_at TIMESTAMPTZ;
  v_rule_index TEXT;
  v_after_cutoff TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  -- 2026-01-21 is Wednesday (dow=3). Cutoff override of 15:00 should push the base_date to 2026-01-22.
  PERFORM set_config('platform.now_override', '2026-01-21T15:30:00Z', true);
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Agreements Engines Org', 'agreements-engines-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Agreements Engines Client', 'agreements-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Agreements Engines Sender', 'Agreements Sender', TRUE, 'active');

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:agreements-policy-engines-fixture-bootstrap'
  );

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_org, 'Agreements Zone', 'agreements-zone-' || left(v_zone::text, 8), TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'agreements-branch-' || left(v_branch::text, 8), 'Agreements Branch', 'UTC', TRUE);

  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES (v_branch, v_zone);

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    zone_id,
    service_level,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'pgtap-agreements-' || left(v_shipment::text, 8),
    'created',
    v_zone,
    'standard',
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  -- Branch override (resource scope) with rule-driven override for this zone+day.
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at)
  VALUES (
    'shipment_promise_policy',
    'resource',
    v_branch,
    1,
    jsonb_build_object(
      'version', 1,
      'enabled', true,
      'timezone', 'UTC',
      'use_branch_timezone', true,
      'cutoff_time', '16:00',
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
            'day_of_week', 3
          ),
          'cutoff_time', '15:00',
          'transit_days', 0,
          'delivery_window_end', '20:00'
        )
      )
    ),
    1,
    now()
  )
  RETURNING id INTO v_settings_version;

  INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES (
    'shipment_promise_policy',
    'resource',
    v_branch,
    v_settings_version,
    (SELECT value FROM public.settings_versions WHERE id = v_settings_version),
    now()
  );

  -- Minimal workflow scaffolding to invoke the handler deterministically.
  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type)
  VALUES (v_template_id, 'pgtap_agreements_' || left(v_template_id::text, 8), 'pgTAP agreements promise workflow', 1, 'active', 'global')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    enabled
  )
  VALUES (
    v_step_tmpl,
    v_template_id,
    1,
    'promise_assign',
    'always',
    'promise_assign',
    'v1',
    jsonb_build_object('pgtap', true),
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.workflow_run_id', v_run_id::text, true);

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_run_id,
    v_template_id,
    1,
    'test',
    'pending',
    jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'shipment_id', v_shipment
    )
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_run_steps (
    id,
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    handler_key,
    handler_version,
    max_retries,
    metadata,
    enqueued_at,
    created_at,
    updated_at
  )
  VALUES (
    v_step,
    v_run_id,
    v_step_tmpl,
    1,
    'pending',
    'promise_assign',
    'promise_assign',
    'v1',
    1,
    jsonb_build_object('pgtap', true),
    now(),
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM workflow_handlers.execute_promise_assign_v1(wrs, wr, '{}'::jsonb)
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
   WHERE wr.id = v_run_id
   LIMIT 1;

  SELECT s.promise_settings_resolution_id,
         s.promised_delivery_date,
         s.promised_delivery_at
    INTO v_resolution_id, v_ship_promised_date, v_ship_promised_at
    FROM public.shipments s
   WHERE s.id = v_shipment
     AND s.client_id = v_client;

  SELECT srl.winning_scope_type,
         srl.inputs #>> '{promise_debug,rule_index}',
         srl.inputs #>> '{promise_debug,after_cutoff}'
    INTO v_winning_scope_type, v_rule_index, v_after_cutoff
    FROM public.settings_resolution_log srl
   WHERE srl.id = v_resolution_id;

  PERFORM is(v_ship_promised_date::text, '2026-01-22', 'promise_assign applies zone+day override transit_days=0 after cutoff');
  PERFORM is(v_ship_promised_at::text, '2026-01-22 20:00:00+00', 'promise_assign applies rule override delivery_window_end=20:00');
  PERFORM ok(v_resolution_id IS NOT NULL, 'shipments.promise_settings_resolution_id is set');
  PERFORM is(v_winning_scope_type, 'resource', 'settings_resolution_log winning scope is resource');
  PERFORM is(v_rule_index, '1', 'promise_debug includes rule_index');
  PERFORM is(v_after_cutoff, 'true', 'promise_debug records after_cutoff=true');
END $$;

DO $$
DECLARE
  v_policy JSONB;
  v_quote RECORD;
BEGIN
  v_policy := jsonb_build_object(
    'version', 1,
    'enabled', true,
    'currency', 'SAR',
    'rounding', jsonb_build_object('decimals', 2),
    'rules', jsonb_build_array(
      jsonb_build_object(
        'priority', 1,
        'is_active', true,
        'match', jsonb_build_object('service_type', 'delivery'),
        'components', jsonb_build_array(
          jsonb_build_object('type', 'flat', 'amount', 10),
          jsonb_build_object('type', 'distance_km_band', 'amount', 2, 'min_km', 5, 'max_km', 10),
          jsonb_build_object('type', 'distance_km_above', 'amount', 1, 'threshold_km', 10),
          jsonb_build_object('type', 'cod_pct', 'amount', 1, 'min_value', 5, 'max_value', 30),
          jsonb_build_object('type', 'cod_flat', 'amount', 3)
        )
      )
    )
  );

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object('service_type', 'delivery', 'distance_km', 12, 'cod_amount', 1000),
      v_policy
    )
   LIMIT 1;

  PERFORM is(v_quote.total_amount::NUMERIC, 35::NUMERIC, 'pricing supports distance bands + distance above + COD pct + COD flat');

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      jsonb_build_object('service_type', 'delivery', 'distance_km', 12, 'cod_amount', 0),
      v_policy
    )
   LIMIT 1;

  PERFORM is(v_quote.total_amount::NUMERIC, 22::NUMERIC, 'COD components do not charge when cod_amount <= 0 (min/max ignored)');
END $$;

SELECT * FROM finish();

ROLLBACK;

