-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S95
-- Test Suite: Label designer v1 foundations (field catalog + drafts/publish surface)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(21);

-- ---------------------------------------------------------------------------
-- label_field_catalog (settings category)
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'label_field_catalog'
      AND is_active = TRUE
  ),
  'label_field_catalog has an active schema_registry entry'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'label_field_catalog'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'label_field_catalog has a global settings row'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_versions
    WHERE category = 'label_field_catalog'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND approved_at IS NOT NULL
      AND effective_until IS NULL
  ),
  'label_field_catalog has a current approved global settings_versions row'
);

SELECT ok(
  public.resolve_settings('label_field_catalog', 'global', NULL) IS NOT NULL,
  'resolve_settings returns label_field_catalog (global)'
);

-- ---------------------------------------------------------------------------
-- shipment_label_payload_v bindings (raw fields)
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shipment_label_payload_v'
      AND column_name = 'destination_sa_short_code'
  ),
  'shipment_label_payload_v exposes destination_sa_short_code'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shipment_label_payload_v'
      AND column_name = 'zone_name'
  ),
  'shipment_label_payload_v exposes zone_name'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shipment_label_payload_v'
      AND column_name = 'zone_slug'
  ),
  'shipment_label_payload_v exposes zone_slug'
);

-- ---------------------------------------------------------------------------
-- label_design_drafts (user-facing; RLS)
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.label_design_drafts'::regclass),
  'label_design_drafts has RLS enabled'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.label_design_drafts', 'select'),
  'authenticated has SELECT privilege on label_design_drafts'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'label_design_drafts'
      AND policyname = 'label_design_drafts_select'
  ),
  'label_design_drafts has an authenticated SELECT policy'
);

-- ---------------------------------------------------------------------------
-- Publish/validate RPCs exist and are security definer
-- ---------------------------------------------------------------------------
SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'label_designer_publish_label_design_draft'
    LIMIT 1
  ),
  'label_designer_publish_label_design_draft is SECURITY DEFINER'
);

SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'label_designer_validate_label_design_draft'
    LIMIT 1
  ),
  'label_designer_validate_label_design_draft is SECURITY DEFINER'
);

-- ---------------------------------------------------------------------------
-- Safe read APIs + privilege hardening (no direct resolve_settings_merged)
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.resolve_settings_merged(text,text,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE resolve_settings_merged'
);

SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'label_designer_get_field_catalog'
    LIMIT 1
  ),
  'label_designer_get_field_catalog is SECURITY DEFINER'
);

SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'label_designer_get_effective_label_design'
    LIMIT 1
  ),
  'label_designer_get_effective_label_design is SECURITY DEFINER'
);

SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'label_designer_get_sample_payload'
    LIMIT 1
  ),
  'label_designer_get_sample_payload is SECURITY DEFINER'
);

SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'label_designer_whoami'
    LIMIT 1
  ),
  'label_designer_whoami is SECURITY DEFINER'
);

-- ---------------------------------------------------------------------------  
-- Storage: authenticated designer assets policy exists
-- ---------------------------------------------------------------------------  
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'label_designer_assets_insert'
  ),
  'storage.objects has label_designer_assets_insert policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'label_designer_assets_update'
  ),
  'storage.objects has label_designer_assets_update policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'label_designer_assets_delete'
  ),
  'storage.objects has label_designer_assets_delete policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'objects_authenticated_restrict_labels'
  ),
  'storage.objects has objects_authenticated_restrict_labels policy'
);

SELECT * FROM finish();

ROLLBACK;
