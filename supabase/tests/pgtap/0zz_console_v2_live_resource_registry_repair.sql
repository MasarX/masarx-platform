-- pgTAP: Console V2 live registry/resources work through API-schema calls.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'ed552951-f2c5-45d2-8f9b-87eeb8d56920'::uuid,
  'Console V2 Live Registry Org',
  'console-v2-live-registry-ed552951'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '61edda8b-7164-4d1a-a803-e4ab0f5e9001'::uuid,
  'ed552951-f2c5-45d2-8f9b-87eeb8d56920'::uuid,
  'console-v2-live-registry@example.test',
  'Console V2 Live Registry Super Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT has_function(
  'api',
  'resolve_settings_row_from_policy_context_v1',
  ARRAY['text', 'jsonb'],
  'api.resolve_settings_row_from_policy_context_v1 exists for Console V2 browser clients'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.resolve_settings_row_from_policy_context_v1(text,jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute api.resolve_settings_row_from_policy_context_v1'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'driver_directory',
      'driver_documents',
      'vehicle_directory',
      'hubs',
      'route_plan_directory',
      'wave_catalog',
      'cod_entries',
      'settlement_batches',
      'bank_accounts',
      'billing_invoices',
      'marketing_intake_recent',
      'marketing_intake_metrics_24h'
    ]) AS required(key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') AS item(value)
      WHERE item.value->>'key' = required.key
    )
  ),
  'ui_read_registry contains the Console V2 live resource repair keys'
);

SELECT set_config('request.jwt.claim.sub', '61edda8b-7164-4d1a-a803-e4ab0f5e9001', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '61edda8b-7164-4d1a-a803-e4ab0f5e9001',
    'role', 'authenticated',
    'email', 'console-v2-live-registry@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

DO $probe$
DECLARE
  v_route_plan_settings JSONB;
  v_driver_settings JSONB;
  v_bank_recon_settings JSONB;
  v_resource TEXT;
  v_list JSONB;
BEGIN
  SELECT value
    INTO v_route_plan_settings
    FROM api.resolve_settings_row_from_policy_context_v1('route_plan_thresholds', '{}'::jsonb)
   LIMIT 1;

  IF (v_route_plan_settings->>'fail_count_warn')::INT IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'route_plan_thresholds.fail_count_warn was not resolved through api wrapper';
  END IF;

  IF (v_route_plan_settings->>'wave_promise_window_seconds')::INT IS DISTINCT FROM 7200 THEN
    RAISE EXCEPTION 'route_plan_thresholds.wave_promise_window_seconds was not resolved through api wrapper';
  END IF;

  SELECT value
    INTO v_driver_settings
    FROM api.resolve_settings_row_from_policy_context_v1('driver_kpi_thresholds', '{}'::jsonb)
   LIMIT 1;

  IF (v_driver_settings#>>'{compliance_score_bands,good_min}')::INT IS DISTINCT FROM 90 THEN
    RAISE EXCEPTION 'driver_kpi_thresholds.compliance_score_bands.good_min was not resolved through api wrapper';
  END IF;

  SELECT value
    INTO v_bank_recon_settings
    FROM api.resolve_settings_row_from_policy_context_v1('bank_recon_policy', '{}'::jsonb)
   LIMIT 1;

  IF (v_bank_recon_settings->>'open_items_warn_threshold')::INT IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'bank_recon_policy.open_items_warn_threshold was not resolved through api wrapper';
  END IF;

  IF (v_bank_recon_settings#>>'{match,window_days_before}')::INT IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'bank_recon_policy.match.window_days_before was not resolved through api wrapper';
  END IF;

  IF (v_bank_recon_settings#>>'{match,window_days_after}')::INT IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'bank_recon_policy.match.window_days_after was not resolved through api wrapper';
  END IF;

  IF (v_bank_recon_settings#>>'{match,amount_tolerance}')::NUMERIC IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'bank_recon_policy.match.amount_tolerance was not resolved through api wrapper';
  END IF;

  IF (v_bank_recon_settings#>>'{match,require_unique}')::BOOLEAN IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'bank_recon_policy.match.require_unique was not resolved through api wrapper';
  END IF;

  FOREACH v_resource IN ARRAY ARRAY[
    'driver_directory',
    'route_plan_directory',
    'hubs',
    'wave_catalog',
    'cod_entries',
    'settlement_batches',
    'billing_invoices',
    'bank_accounts',
    'marketing_intake_recent',
    'marketing_intake_metrics_24h'
  ]
  LOOP
    SELECT api.ui_list_resource_v1(v_resource, '{}'::jsonb, 5, 0, NULL::jsonb)
      INTO v_list;
    IF v_list->>'resource' IS DISTINCT FROM v_resource THEN
      RAISE EXCEPTION 'api.ui_list_resource_v1 returned wrong resource for %', v_resource;
    END IF;
  END LOOP;
END;
$probe$;

RESET ROLE;

SELECT pass('authenticated Console V2 settings and resource reads complete without unknown-resource or relation errors');

SELECT * FROM finish();

ROLLBACK;
