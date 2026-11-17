-- pgTAP: Marketplace network foundation v1

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(32);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_policy'
  ),
  'marketplace_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_request_policy'
  ),
  'marketplace_request_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_visibility_policy'
  ),
  'marketplace_visibility_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_execution_policy'
  ),
  'marketplace_execution_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_settlement_policy'
  ),
  'marketplace_settlement_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_reputation_policy'
  ),
  'marketplace_reputation_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_tracking_display_policy'
  ),
  'marketplace_tracking_display_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_compliance_policy'
  ),
  'marketplace_compliance_policy category is registered'
);

SELECT has_table('public', 'marketplace_participant_requests', 'marketplace_participant_requests table exists');
SELECT has_table('public', 'marketplace_requests', 'marketplace_requests table exists');
SELECT has_table('public', 'marketplace_work_packages', 'marketplace_work_packages table exists');
SELECT has_table('public', 'marketplace_disputes', 'marketplace_disputes table exists');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'marketplace_participant_requests'
       AND c.relrowsecurity = TRUE
  ),
  'marketplace_participant_requests has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'marketplace_requests'
       AND c.relrowsecurity = TRUE
  ),
  'marketplace_requests has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'marketplace_work_packages'
       AND c.relrowsecurity = TRUE
  ),
  'marketplace_work_packages has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_registry_entries
     WHERE registry_type = 'participant_type'
       AND entry_key = 'freelancer_driver'
       AND is_active = TRUE
  ),
  'freelancer_driver participant type is seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_request_kinds
     WHERE kind_key = 'driver_shift_market'
       AND is_active = TRUE
  ),
  'driver_shift_market request kind is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_request_kinds
     WHERE kind_key = 'capacity_block'
       AND is_active = TRUE
  ),
  'capacity_block request kind is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_request_kinds
     WHERE kind_key = 'shipment_batch'
       AND is_active = TRUE
  ),
  'shipment_batch request kind is active'
);

SELECT ok(
  to_regprocedure('public.marketplace_request_kind_catalog_v1(jsonb,boolean)') IS NOT NULL,
  'public.marketplace_request_kind_catalog_v1 exists'
);

SELECT ok(
  to_regprocedure('public.marketplace_participant_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,uuid,uuid,text,boolean)') IS NOT NULL,
  'public.marketplace_participant_request_create_v1 exists'
);

SELECT ok(
  to_regprocedure('public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)') IS NOT NULL,
  'public.marketplace_request_create_v1 exists'
);

SELECT ok(
  to_regprocedure('public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)') IS NOT NULL,
  'public.marketplace_award_offer_v1 exists'
);

SELECT ok(
  to_regprocedure('public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)') IS NOT NULL,
  'public.marketplace_work_package_materialize_v1 exists'
);

SELECT ok(
  to_regprocedure('api.marketplace_request_kind_catalog_v1(jsonb,boolean)') IS NOT NULL,
  'api.marketplace_request_kind_catalog_v1 wrapper exists'
);

SELECT ok(
  to_regprocedure('api.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)') IS NOT NULL,
  'api.marketplace_request_create_v1 wrapper exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS resource
          WHERE resource->>'key' = 'marketplace_requests'
       )
  ),
  'ui_read_registry includes marketplace_requests'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS resource
          WHERE resource->>'key' = 'marketplace_participant_requests'
       )
  ),
  'ui_read_registry includes marketplace_participant_requests'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_navigation'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value#>'{apps,portal,sections}') AS section
          WHERE section->>'id' = 'marketplace'
       )
  ),
  'ui_navigation includes marketplace portal section'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_navigation'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value#>'{apps,mobile,sections}') AS section
          WHERE section->>'id' = 'marketplace'
       )
  ),
  'ui_navigation includes marketplace mobile section'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'commands') AS command
          WHERE command->>'key' = 'marketplace.award'
       )
  ),
  'ui_command_registry includes marketplace.award'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'capabilities') AS capability
          WHERE capability->>'key' = 'marketplace_participant_requests.review'
       )
  ),
  'access_control_policy includes marketplace_participant_requests.review capability'
);

SELECT * FROM finish();

ROLLBACK;
