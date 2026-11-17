-- Plan: PLAN-202603-marketplace-network-v1 / Step: S95
-- Marketplace network registry + RLS guardrails.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(33);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_policy'
  ),
  'marketplace_policy settings category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_compliance_policy'
  ),
  'marketplace_compliance_policy settings category is registered'
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
      FROM public.marketplace_registry_entries
     WHERE registry_type = 'materializer'
       AND entry_key = 'manual_bridge'
       AND is_active = TRUE
  ),
  'manual_bridge materializer is seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_request_kinds
     WHERE kind_key = 'driver_shift_market'
       AND is_active = TRUE
  ),
  'driver_shift_market request kind is seeded and active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_request_kinds
     WHERE kind_key = 'capacity_block'
       AND is_active = TRUE
  ),
  'capacity_block request kind is seeded and active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'marketplace_compliance_policy'
  ),
  'marketplace_compliance_policy decision category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'marketplace_request_policy'
  ),
  'marketplace_request_policy decision category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'marketplace_visibility_policy'
  ),
  'marketplace_visibility_policy decision category is registered'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_registry_entries'),
  'RLS is enabled on marketplace_registry_entries'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_request_kinds'),
  'RLS is enabled on marketplace_request_kinds'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_participant_profiles'),
  'RLS is enabled on marketplace_participant_profiles'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_participant_requests'),
  'RLS is enabled on marketplace_participant_requests'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_participant_capabilities'),
  'RLS is enabled on marketplace_participant_capabilities'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_verification_records'),
  'RLS is enabled on marketplace_verification_records'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_availability_windows'),
  'RLS is enabled on marketplace_availability_windows'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_requests'),
  'RLS is enabled on marketplace_requests'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_request_items'),
  'RLS is enabled on marketplace_request_items'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_offers'),
  'RLS is enabled on marketplace_offers'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_awards'),
  'RLS is enabled on marketplace_awards'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_contracts'),
  'RLS is enabled on marketplace_contracts'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_work_packages'),
  'RLS is enabled on marketplace_work_packages'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_disputes'),
  'RLS is enabled on marketplace_disputes'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_reputation_events'),
  'RLS is enabled on marketplace_reputation_events'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_reputation_snapshots'),
  'RLS is enabled on marketplace_reputation_snapshots'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'marketplace_events'),
  'RLS is enabled on marketplace_events'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'marketplace_requests'
       AND policyname = 'marketplace_requests_read_policy'
  ),
  'marketplace_requests read policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'marketplace_participant_requests'
       AND policyname = 'marketplace_participant_requests_read_policy'
  ),
  'marketplace_participant_requests read policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'marketplace_request_create_v1'
  ),
  'marketplace_request_create_v1 exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'marketplace_participant_request_review_apply_v1'
  ),
  'marketplace_participant_request_review_apply_v1 exists'
);

SELECT has_function(
  'public',
  'marketplace_participant_request_get_v1',
  ARRAY['uuid'],
  'marketplace_participant_request_get_v1 exists'
);

SELECT has_function(
  'api',
  'marketplace_participant_request_get_v1',
  ARRAY['uuid'],
  'api marketplace_participant_request_get_v1 wrapper exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'marketplace_work_package_materialize_v1'
  ),
  'marketplace_work_package_materialize_v1 exists'
);

SELECT * FROM finish();

ROLLBACK;
