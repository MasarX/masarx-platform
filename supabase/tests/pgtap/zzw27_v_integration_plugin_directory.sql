-- pgTAP: public.v_integration_plugin_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W27 (paired projection views - INTEGRATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_integration_plugin_directory',
  'public.v_integration_plugin_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_integration_plugin_directory',
  ARRAY[
    'id', 'organization_id', 'plugin_key', 'name', 'description',
    'plugin_kind', 'status', 'rollout_tier', 'reusable_within_tenant',
    'base_plugin_id', 'active_version_id', 'managed_by', 'metadata',
    'created_by', 'updated_by', 'created_at', 'updated_at',
    'vendor', 'version_label', 'active_version_status',
    'version_count', 'latest_version_no', 'latest_version_status',
    'binding_count', 'install_count', 'active_binding_count',
    'has_active_version', 'is_pending_review'
  ],
  'v_integration_plugin_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_integration_plugin_directory', 'SELECT'),
  'service_role has SELECT on v_integration_plugin_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_integration_plugin_directory', 'SELECT'),
  'anon has no SELECT on v_integration_plugin_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_integration_plugin_directory', 'SELECT'),
  'authenticated has SELECT on v_integration_plugin_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'integration_plugins'
       AND c.relkind = 'r'
  ),
  'public.integration_plugins remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a plugin with 2 versions + active binding.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000027e001';
  v_plugin   UUID := '00000000-0000-0000-0000-00000027e002';
  v_v1       UUID := '00000000-0000-0000-0000-00000027e003';
  v_v2       UUID := '00000000-0000-0000-0000-00000027e004';
  v_binding  UUID := '00000000-0000-0000-0000-00000027e005';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W27 Plugin Org', 'w27-plg-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugins (
    id, organization_id, plugin_key, name, plugin_kind, status,
    rollout_tier, metadata
  )
  VALUES (
    v_plugin, v_org,
    'w27-plg-key-main',
    'W27 Plugin', 'webhook', 'active', 'standard',
    jsonb_build_object('vendor', 'W27 Vendor', 'integration', 'logistics')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugin_versions (
    id, plugin_id, organization_id, version_no, status,
    source_type, source_payload
  )
  VALUES
    (v_v1, v_plugin, v_org, 1, 'active', 'manual',
      jsonb_build_object('rev', 1)),
    (v_v2, v_plugin, v_org, 2, 'draft', 'manual',
      jsonb_build_object('rev', 2))
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.integration_plugins
     SET active_version_id = v_v1
   WHERE id = v_plugin;

  INSERT INTO public.integration_plugin_bindings (
    id, plugin_version_id, organization_id, scope_type, scope_id,
    binding_type, enabled
  )
  VALUES (
    v_binding, v_v1, v_org, 'tenant', v_org, 'webhook_source', TRUE
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_integration_plugin_directory
    WHERE id = '00000000-0000-0000-0000-00000027e002'::UUID
      AND vendor = 'W27 Vendor'
      AND version_label = 'v1'
      AND version_count = 2
      AND latest_version_no = 2
      AND latest_version_status = 'draft'
      AND active_version_status = 'active'
      AND binding_count = 1
      AND active_binding_count = 1
      AND install_count = 1
      AND has_active_version = TRUE
      AND is_pending_review = TRUE
  ),
  'v_integration_plugin_directory derives vendor + version_label + version_count + latest_version_no/status + active_version_status + binding/active/install counts + has_active_version + is_pending_review'
);

-- 8) Pre-active plugin projection.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000027e001';
  v_plugin2   UUID := '00000000-0000-0000-0000-00000027e013';
  v_v_pending UUID := '00000000-0000-0000-0000-00000027e014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.integration_plugins (
    id, organization_id, plugin_key, name, plugin_kind, status,
    rollout_tier, metadata
  )
  VALUES (
    v_plugin2, v_org,
    'w27-plg-pending-main',
    'W27 Pending Plugin', 'webhook', 'submitted', 'standard',
    jsonb_build_object('vendor', 'W27 Pending Vendor')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugin_versions (
    id, plugin_id, organization_id, version_no, status,
    source_type, source_payload
  )
  VALUES (
    v_v_pending, v_plugin2, v_org, 1, 'submitted', 'manual',
    jsonb_build_object('rev', 1)
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_integration_plugin_directory
    WHERE id = '00000000-0000-0000-0000-00000027e013'::UUID
      AND has_active_version = FALSE
      AND is_pending_review = TRUE
      AND version_label IS NULL
      AND active_binding_count = 0
  ),
  'v_integration_plugin_directory: pending plugin (no active_version_id) resolves has_active_version=FALSE + is_pending_review=TRUE + version_label=NULL + active_binding_count=0'
);

SELECT * FROM finish();
ROLLBACK;
