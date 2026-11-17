-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S06
-- Marketplace network product-complete registry, navigation, and command guardrails.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(29);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_request_kinds
     WHERE kind_key = 'shipment_batch'
       AND is_active = TRUE
  ),
  'shipment_batch request kind is active'
);

SELECT is(
  (
    SELECT default_materializer_key
      FROM public.marketplace_request_kinds
     WHERE kind_key = 'shipment_batch'
  ),
  'shipment_batch_auto_bridge',
  'shipment_batch uses shipment_batch_auto_bridge by default'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_registry_entries
     WHERE registry_type = 'materializer'
       AND entry_key = 'driver_shift_auto_bridge'
       AND is_active = TRUE
  ),
  'driver_shift_auto_bridge materializer is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_registry_entries
     WHERE registry_type = 'materializer'
       AND entry_key = 'capacity_block_auto_bridge'
       AND is_active = TRUE
  ),
  'capacity_block_auto_bridge materializer is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_registry_entries
     WHERE registry_type = 'materializer'
       AND entry_key = 'shipment_batch_auto_bridge'
       AND is_active = TRUE
  ),
  'shipment_batch_auto_bridge materializer is active'
);

SELECT ok(
  public.resolve_settings_merged('task_type_catalog', 'global', NULL::uuid) @> jsonb_build_object(
    'task_types',
    jsonb_build_array(jsonb_build_object('key', 'marketplace_participant_review'))
  ),
  'task_type_catalog includes marketplace_participant_review'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_registry_entries
     WHERE registry_type = 'settlement_mode'
       AND entry_key = 'auto_recorded_internal'
       AND is_default = TRUE
       AND is_active = TRUE
  ),
  'auto_recorded_internal settlement mode is active and default'
);

SELECT ok(
  public.resolve_settings_merged('settlement_policy', 'global', NULL::uuid) @> jsonb_build_object(
    'batch_scopes',
    jsonb_build_array('marketplace_contract')
  ),
  'settlement_policy allows marketplace_contract batch scope'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'marketplace_participant_requests'
       AND column_name = 'public_status_token'
  ),
  'marketplace_participant_requests has public_status_token column'
);

SELECT has_function(
  'public',
  'marketplace_application_status_by_token_v1',
  ARRAY['text'],
  'browser-safe application status function exists'
);

SELECT has_function(
  'public',
  'marketplace_policy_legacy_default_v1',
  ARRAY['text'],
  'marketplace legacy default helper exists'
);

SELECT has_function(
  'public',
  'reconcile_marketplace_tenant_default_settings_v1',
  ARRAY[]::text[],
  'marketplace tenant default reconcile function exists'
);

SELECT has_function(
  'public',
  'marketplace_request_workspace_v1',
  ARRAY['uuid'],
  'marketplace_request_workspace_v1 exists'
);

SELECT has_function(
  'public',
  'marketplace_provider_workboard_v1',
  ARRAY['boolean'],
  'marketplace_provider_workboard_v1 exists'
);

SELECT has_function(
  'public',
  'marketplace_contract_room_v1',
  ARRAY['uuid'],
  'marketplace_contract_room_v1 exists'
);

SELECT has_function(
  'public',
  'marketplace_dispute_workspace_v1',
  ARRAY['uuid'],
  'marketplace_dispute_workspace_v1 exists'
);

SELECT has_function(
  'public',
  'marketplace_settlement_workspace_v1',
  ARRAY['uuid', 'uuid'],
  'marketplace_settlement_workspace_v1 exists'
);

SELECT has_function(
  'api',
  'marketplace_request_workspace_v1',
  ARRAY['uuid'],
  'api marketplace_request_workspace_v1 wrapper exists'
);

SELECT has_function(
  'api',
  'marketplace_application_status_by_token_v1',
  ARRAY['text'],
  'api marketplace_application_status_by_token_v1 wrapper exists'
);

SELECT ok(
  public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid) @> jsonb_build_object(
    'resources',
    jsonb_build_array(jsonb_build_object('key', 'marketplace_private_pools'))
  ),
  'ui_read_registry includes marketplace_private_pools'
);

SELECT ok(
  public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid) @> jsonb_build_object(
    'resources',
    jsonb_build_array(jsonb_build_object('key', 'marketplace_settlement_batches'))
  ),
  'ui_read_registry includes marketplace_settlement_batches'
);

SELECT ok(
  public.resolve_settings_merged('ui_command_registry', 'global', NULL::uuid) @> jsonb_build_object(
    'commands',
    jsonb_build_array(
      jsonb_build_object('key', 'marketplace.submit_offer'),
      jsonb_build_object('key', 'marketplace.publish_availability')
    )
  ),
  'ui_command_registry includes provider mobile marketplace commands'
);

SELECT ok(
  public.resolve_settings_merged('ui_navigation', 'global', NULL::uuid) #> '{apps,portal,sections}' @> jsonb_build_array(
    jsonb_build_object('id', 'marketplace')
  ),
  'portal navigation includes marketplace section'
);

SELECT ok(
  public.resolve_settings_merged('ui_navigation', 'global', NULL::uuid) #> '{apps,console,sections}' @> jsonb_build_array(
    jsonb_build_object('id', 'marketplace')
  ),
  'console navigation includes marketplace section'
);

SELECT ok(
  public.resolve_settings_merged('ui_navigation', 'global', NULL::uuid) #> '{apps,mobile,sections}' @> jsonb_build_array(
    jsonb_build_object('id', 'marketplace')
  ),
  'mobile navigation includes marketplace section'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('access_control_policy', 'global', NULL::uuid)->'roles', '[]'::jsonb)) AS role
     WHERE role->>'key' = 'driver'
       AND role->'capability_keys' @> jsonb_build_array('marketplace_participants.write', 'marketplace_work_packages.write')
  ),
  'driver role includes provider-facing marketplace execution capabilities'
);

INSERT INTO public.organizations (
  id,
  name,
  slug,
  timezone,
  locale,
  billing_status,
  default_settings
)
VALUES (
  '11111111-2222-4333-8444-555555555555'::uuid,
  'Marketplace Legacy Tenant',
  'marketplace-legacy-tenant',
  'Asia/Riyadh',
  'en',
  'active',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

SELECT public.upsert_settings_value_v1(
  p_category := 'marketplace_request_policy',
  p_scope_type := 'tenant',
  p_scope_id := '11111111-2222-4333-8444-555555555555'::uuid,
  p_value := public.marketplace_policy_legacy_default_v1('marketplace_request_policy'),
  p_schema_version := 1,
  p_change_reason := 'pgTAP legacy marketplace request policy seed'
);

SELECT public.upsert_settings_value_v1(
  p_category := 'marketplace_execution_policy',
  p_scope_type := 'tenant',
  p_scope_id := '11111111-2222-4333-8444-555555555555'::uuid,
  p_value := public.marketplace_policy_legacy_default_v1('marketplace_execution_policy'),
  p_schema_version := 1,
  p_change_reason := 'pgTAP legacy marketplace execution policy seed'
);

SELECT ok(
  COALESCE((public.reconcile_marketplace_tenant_default_settings_v1()->>'updated_count')::int, 0) >= 2,
  'tenant default reconcile updates legacy-equal marketplace settings rows'
);

SELECT ok(
  public.resolve_settings_merged('marketplace_request_policy', 'tenant', '11111111-2222-4333-8444-555555555555'::uuid) @> jsonb_build_object(
    'allowed_request_kinds',
    jsonb_build_array('shipment_batch')
  ),
  'reconciled tenant request policy includes shipment_batch'
);

SELECT ok(
  public.resolve_settings_merged('marketplace_execution_policy', 'tenant', '11111111-2222-4333-8444-555555555555'::uuid) @> jsonb_build_object(
    'work_package',
    jsonb_build_object('auto_materialize', TRUE)
  ),
  'reconciled tenant execution policy enables auto materialize'
);

SELECT * FROM finish();

ROLLBACK;
