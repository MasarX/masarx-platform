-- pgTAP: Console V2 onboarding bootstrap must not revive archived webhook
-- source runtime bindings during integration plugin activation.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000c901';
  v_plugin UUID := '00000000-0000-0000-0000-00000000c902';
  v_version UUID := '00000000-0000-0000-0000-00000000c903';
  v_mapping UUID := '00000000-0000-0000-0000-00000000c904';
  v_source UUID := '00000000-0000-0000-0000-00000000c905';
  v_binding UUID := '00000000-0000-0000-0000-00000000c906';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Archived Plugin Binding Guard Org', 'console-v2-archived-plugin-binding-guard')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'console-v2-archived-plugin-binding-guard',
    '{}'::jsonb,
    1,
    'Console V2 archived plugin binding guard pgTAP mapping'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config = EXCLUDED.mapping_config;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    enabled,
    rate_limit_per_hour,
    managed_metadata
  )
  VALUES (
    v_source,
    v_org,
    'console-v2-archived-plugin-binding-guard-source',
    'Console V2 Archived Plugin Binding Guard Source',
    'generic',
    'console-v2-archived-plugin-binding-guard-token',
    v_mapping,
    FALSE,
    240,
    jsonb_build_object(
      'lifecycle', 'archived',
      'archived_at', now(),
      'archive_reason', 'pgTAP archived binding guard'
    )
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config_id = EXCLUDED.mapping_config_id,
         enabled = FALSE,
         managed_metadata = EXCLUDED.managed_metadata;

  INSERT INTO public.integration_plugins (
    id,
    organization_id,
    plugin_key,
    name,
    status
  )
  VALUES (
    v_plugin,
    v_org,
    'console-v2-archived-plugin-binding-guard',
    'Console V2 Archived Plugin Binding Guard',
    'approved'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         status = EXCLUDED.status;

  INSERT INTO public.integration_plugin_versions (
    id,
    plugin_id,
    organization_id,
    version_no,
    status,
    workflow_binding
  )
  VALUES (
    v_version,
    v_plugin,
    v_org,
    1,
    'approved',
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
     SET plugin_id = EXCLUDED.plugin_id,
         organization_id = EXCLUDED.organization_id,
         status = EXCLUDED.status;

  INSERT INTO public.integration_plugin_bindings (
    id,
    plugin_version_id,
    organization_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id,
    enabled
  )
  VALUES (
    v_binding,
    v_version,
    v_org,
    'tenant',
    v_org,
    'webhook_source',
    'webhook_sources',
    v_source,
    FALSE
  )
  ON CONFLICT (id) DO UPDATE
     SET plugin_version_id = EXCLUDED.plugin_version_id,
         organization_id = EXCLUDED.organization_id,
         runtime_resource_id = EXCLUDED.runtime_resource_id,
         enabled = FALSE;

  PERFORM set_config('test.archived_binding_guard_version', v_version::TEXT, TRUE);
  PERFORM set_config('test.archived_binding_guard_source', v_source::TEXT, TRUE);
  PERFORM set_config('test.archived_binding_guard_binding', v_binding::TEXT, TRUE);

  EXECUTE 'RESET ROLE';
END $$;

SELECT lives_ok(
  format(
    $$ SELECT public.integration_plugin_set_binding_runtime_enabled_v1(%L::uuid, TRUE, 'tenant', '00000000-0000-0000-0000-00000000c901'::uuid) $$,
    current_setting('test.archived_binding_guard_version')
  ),
  'runtime enable skips archived webhook source without raising archive mutation error'
);

SELECT is(
  (SELECT enabled FROM public.webhook_sources WHERE id = current_setting('test.archived_binding_guard_source')::uuid),
  FALSE,
  'archived webhook source remains disabled'
);

SELECT is(
  (SELECT enabled FROM public.integration_plugin_bindings WHERE id = current_setting('test.archived_binding_guard_binding')::uuid),
  FALSE,
  'archived webhook source binding remains disabled during enable'
);

SELECT lives_ok(
  format(
    $$ SELECT public.integration_plugin_set_binding_runtime_enabled_v1(%L::uuid, FALSE, 'tenant', '00000000-0000-0000-0000-00000000c901'::uuid) $$,
    current_setting('test.archived_binding_guard_version')
  ),
  'runtime disable also tolerates archived webhook source bindings'
);

SELECT is(
  obj_description('public.integration_plugin_set_binding_runtime_enabled_v1(uuid,boolean,text,uuid)'::regprocedure, 'pg_proc'),
  'Enables/disables integration plugin runtime bindings without reviving archived webhook sources; archived webhook source bindings stay disabled until an explicit restore lifecycle exists.',
  'runtime toggle function documents archived webhook source guard'
);

SELECT * FROM finish();
ROLLBACK;
