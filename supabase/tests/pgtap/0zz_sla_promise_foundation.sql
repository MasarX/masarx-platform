-- Plan: PLAN-202601-sla-promise-foundation / Step: S95
-- pgTAP: SLA + promise foundation (policy + branch overrides + handler)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

SELECT has_table('public', 'schema_registry', 'schema_registry exists');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry sr
    WHERE sr.category = 'shipment_promise_policy'
      AND sr.is_active = TRUE
  ),
  'shipment_promise_policy schema_registry row exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'shipment_promise_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'shipment_promise_policy global settings row exists'
);

SELECT has_column('public', 'settings_category_registry', 'resource_scope_rel', 'settings_category_registry.resource_scope_rel exists');
SELECT is(
  (SELECT resource_scope_rel::oid FROM public.settings_category_registry WHERE category = 'shipment_promise_policy'),
  ('public.branches'::regclass)::oid,
  'shipment_promise_policy resource scope validates against branches'
);

SELECT has_column('public', 'shipments', 'branch_id', 'shipments.branch_id exists');
SELECT has_column('public', 'shipments', 'promised_delivery_at', 'shipments.promised_delivery_at exists');
SELECT has_column('public', 'shipments', 'promised_window_start_at', 'shipments.promised_window_start_at exists');
SELECT has_column('public', 'shipments', 'promised_window_end_at', 'shipments.promised_window_end_at exists');
SELECT has_column('public', 'shipments', 'promise_computed_at', 'shipments.promise_computed_at exists');
SELECT has_column('public', 'shipments', 'promise_settings_resolution_id', 'shipments.promise_settings_resolution_id exists');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.operation_handlers oh
    WHERE oh.handler_key = 'promise_assign'
      AND oh.is_active = TRUE
  ),
  'operation_handlers includes promise_assign'
);

CREATE TEMP TABLE tmp_sla_promise_result (
  promised_delivery_date DATE,
  promised_delivery_at TIMESTAMPTZ,
  resolution_id UUID,
  winning_scope_type TEXT,
  has_action BOOLEAN
) ON COMMIT DROP;

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
  v_resp public.workflow_handler_response;
  v_resolution_id UUID;
  v_winning_scope_type TEXT;
  v_has_action BOOLEAN := FALSE;
  v_ship_promised_date DATE;
  v_ship_promised_at TIMESTAMPTZ;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('platform.now_override', '2026-01-21T10:00:00Z', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'SLA Promise Org', 'sla-promise-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'SLA Promise Client', 'sla-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'SLA Promise Sender', 'SLA Promise Sender', TRUE, 'active');

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_org, 'SLA Zone', 'sla-zone-' || left(v_zone::text, 8), TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'sla-branch-' || left(v_branch::text, 8), 'SLA Branch', 'UTC', TRUE);

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
    'pgtap-sla-' || left(v_shipment::text, 8),
    'created',
    v_zone,
    'standard',
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  -- Branch override (resource scope) should win and shorten transit days for "standard".
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
      'service_level_transit_days', jsonb_build_object('standard', 1),
      'delivery_window_start', '09:00',
      'delivery_window_end', '18:00'
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
  VALUES (v_template_id, 'pgtap_sla_promise_' || left(v_template_id::text, 8), 'pgTAP SLA promise workflow', 1, 'active', 'global')
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

  SELECT workflow_handlers.execute_promise_assign_v1(wrs, wr, '{}'::jsonb)
    INTO v_resp
    FROM public.workflow_runs wr
    JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
   WHERE wr.id = v_run_id
   LIMIT 1;

  SELECT s.promise_settings_resolution_id
    INTO v_resolution_id
    FROM public.shipments s
   WHERE s.id = v_shipment
     AND s.client_id = v_client;

  SELECT s.promised_delivery_date, s.promised_delivery_at
    INTO v_ship_promised_date, v_ship_promised_at
    FROM public.shipments s
   WHERE s.id = v_shipment
     AND s.client_id = v_client;

  SELECT srl.winning_scope_type
    INTO v_winning_scope_type
    FROM public.settings_resolution_log srl
   WHERE srl.id = v_resolution_id;

  SELECT EXISTS (
    SELECT 1
    FROM public.shipment_actions sa
    WHERE sa.shipment_id = v_shipment
      AND sa.client_id = v_client
      AND sa.action_type = 'promise_assigned'
  )
    INTO v_has_action;

  INSERT INTO tmp_sla_promise_result (
    promised_delivery_date,
    promised_delivery_at,
    resolution_id,
    winning_scope_type,
    has_action
  )
  VALUES (
    v_ship_promised_date,
    v_ship_promised_at,
    v_resolution_id,
    v_winning_scope_type,
    v_has_action
  );
END $$;

SELECT is(
  (SELECT promised_delivery_date::text FROM tmp_sla_promise_result),
  '2026-01-22',
  'promise_assign uses branch override transit_days=1'
);

SELECT is(
  (SELECT promised_delivery_at::text FROM tmp_sla_promise_result),
  '2026-01-22 18:00:00+00',
  'promise_assign computes promised_delivery_at from window_end'
);

SELECT ok(
  (SELECT resolution_id IS NOT NULL FROM tmp_sla_promise_result),
  'shipments.promise_settings_resolution_id is set'
);

SELECT is(
  (SELECT winning_scope_type FROM tmp_sla_promise_result),
  'resource',
  'settings_resolution_log winning scope is resource'
);

SELECT ok(
  (SELECT has_action FROM tmp_sla_promise_result),
  'promise_assign inserts shipment_actions row'
);

SELECT finish();
ROLLBACK;
