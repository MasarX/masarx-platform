-- pgTAP: Console V2 plugin deactivate lifecycle readback.
-- Proves api.plugin_deactivate_v1 disables runtime bindings, clears the
-- active plugin pointer, preserves the version as approved, and exposes the
-- same state through registry readback.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

SELECT has_function('public', 'plugin_deactivate_v1', ARRAY['jsonb'], 'public plugin_deactivate_v1(jsonb) exists');
SELECT has_function('api', 'plugin_deactivate_v1', ARRAY['jsonb'], 'api plugin_deactivate_v1(jsonb) exists');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'plugin_status'
       AND lv.value = 'active'
       AND COALESCE(lv.metadata->'next_actions', '[]'::jsonb) ? 'deactivate'
  ),
  'plugin_status.active exposes deactivate as row-driven next action'
);

DO $setup$
DECLARE
  v_org uuid := 'deac71e0-0000-4000-8000-000000000001';
  v_user uuid := 'deac71e0-0000-4000-8000-000000000002';
  v_plugin uuid := 'deac71e0-0000-4000-8000-000000000003';
  v_version uuid := 'deac71e0-0000-4000-8000-000000000004';
  v_binding uuid := 'deac71e0-0000-4000-8000-000000000005';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Plugin Deactivate Org', 'console-v2-plugin-deactivate-org')
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug;

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    'console-v2-plugin-deactivate@example.test',
    'Console V2 Plugin Deactivate Operator',
    'tenant_integrations_approver',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      status = EXCLUDED.status,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id;

  PERFORM public.provision_rbac_roles_from_templates_v1(
    v_org,
    ARRAY['tenant_integrations_approver']::text[],
    v_user
  );

  INSERT INTO public.integration_plugins (
    id,
    organization_id,
    plugin_key,
    name,
    plugin_kind,
    status,
    rollout_tier,
    reusable_within_tenant,
    managed_by,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    v_plugin,
    v_org,
    'console-v2-plugin-deactivate-readback',
    'Console V2 Plugin Deactivate Readback',
    'webhook',
    'active',
    'tenant',
    true,
    'integration_plugin',
    jsonb_build_object('vendor', 'pgTAP Deactivate Vendor'),
    v_user,
    v_user
  )
  ON CONFLICT (id) DO UPDATE
  SET status = 'active',
      active_version_id = NULL,
      metadata = EXCLUDED.metadata,
      updated_by = EXCLUDED.updated_by,
      updated_at = now();

  INSERT INTO public.integration_plugin_versions (
    id,
    plugin_id,
    organization_id,
    version_no,
    status,
    source_type,
    source_payload,
    normalized_contract,
    inbound_config,
    mapping_config,
    workflow_binding,
    outbound_operations,
    auth_bindings,
    validation_summary,
    activated_by,
    activated_at,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    v_version,
    v_plugin,
    v_org,
    1,
    'active',
    'webhook_sample',
    '{"event":{"type":"shipment.created"}}'::jsonb,
    '{"source_type":"webhook_sample","plugin_kind":"webhook"}'::jsonb,
    '{"webhook":{"event_type_path":"event.type"}}'::jsonb,
    '{"version":1,"target":"shipments.create","enabled":true}'::jsonb,
    '{"mode":"attach_existing","template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    v_user,
    now(),
    '{}'::jsonb,
    v_user,
    v_user
  )
  ON CONFLICT (id) DO UPDATE
  SET status = 'active',
      workflow_binding = EXCLUDED.workflow_binding,
      activated_by = EXCLUDED.activated_by,
      activated_at = EXCLUDED.activated_at,
      updated_by = EXCLUDED.updated_by,
      updated_at = now();

  UPDATE public.integration_plugins
     SET status = 'active',
         active_version_id = v_version,
         updated_by = v_user,
         updated_at = now()
   WHERE id = v_plugin;

  INSERT INTO public.integration_plugin_bindings (
    id,
    plugin_version_id,
    organization_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id,
    enabled,
    activation_payload,
    metadata,
    created_by
  )
  VALUES (
    v_binding,
    v_version,
    v_org,
    'tenant',
    v_org,
    'webhook_source',
    NULL,
    NULL,
    true,
    jsonb_build_object('source_identifier', 'console-v2-deactivate-readback'),
    '{}'::jsonb,
    v_user
  )
  ON CONFLICT (id) DO UPDATE
  SET enabled = true,
      plugin_version_id = EXCLUDED.plugin_version_id,
      organization_id = EXCLUDED.organization_id,
      scope_type = EXCLUDED.scope_type,
      scope_id = EXCLUDED.scope_id,
      binding_type = EXCLUDED.binding_type,
      activation_payload = EXCLUDED.activation_payload,
      updated_at = now();

  PERFORM set_config('test.plugin_deactivate_org', v_org::text, true);
  PERFORM set_config('test.plugin_deactivate_user', v_user::text, true);
  PERFORM set_config('test.plugin_deactivate_plugin', v_plugin::text, true);
  PERFORM set_config('test.plugin_deactivate_version', v_version::text, true);
END;
$setup$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.plugin_deactivate_user'), true);
SELECT set_config(
  'request.jwt.claims',
  format('{"sub":"%s","role":"authenticated"}', current_setting('test.plugin_deactivate_user')),
  true
);

SET LOCAL ROLE authenticated;

SELECT ok(
  COALESCE((
    public.user_capability_eval_v1(
      'integration_plugins.activate',
      'tenant',
      current_setting('test.plugin_deactivate_org')::uuid
    )->>'allowed'
  )::boolean, FALSE),
  'deactivate test operator has integration_plugins.activate capability'
);

DO $execute$
DECLARE
  v_result jsonb;
BEGIN
  v_result := api.plugin_deactivate_v1(jsonb_build_object(
    'plugin_id', current_setting('test.plugin_deactivate_plugin'),
    'plugin_version_id', current_setting('test.plugin_deactivate_version'),
    'reason', 'pgTAP deactivate readback proof'
  ));
  PERFORM set_config('test.plugin_deactivate_result', v_result::text, true);
END;
$execute$;

SELECT ok(
  COALESCE((current_setting('test.plugin_deactivate_result')::jsonb->>'ok')::boolean, FALSE),
  'api.plugin_deactivate_v1 returns ok'
);

SELECT is(
  current_setting('test.plugin_deactivate_result')::jsonb->>'status',
  'disabled',
  'deactivate RPC returns disabled plugin status'
);

SELECT is(
  current_setting('test.plugin_deactivate_result')::jsonb->>'version_status',
  'approved',
  'deactivate RPC returns approved version status'
);

RESET ROLE;

SELECT is(
  (SELECT p.status FROM public.integration_plugins p WHERE p.id = current_setting('test.plugin_deactivate_plugin')::uuid),
  'disabled',
  'integration_plugins row is disabled'
);

SELECT ok(
  (SELECT p.active_version_id IS NULL FROM public.integration_plugins p WHERE p.id = current_setting('test.plugin_deactivate_plugin')::uuid),
  'integration_plugins.active_version_id is cleared'
);

SELECT is(
  (SELECT v.status FROM public.integration_plugin_versions v WHERE v.id = current_setting('test.plugin_deactivate_version')::uuid),
  'approved',
  'integration_plugin_versions active version is preserved as approved'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = current_setting('test.plugin_deactivate_version')::uuid
       AND b.enabled IS TRUE
  ),
  'integration_plugin_bindings are disabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.integration_plugin_approval_events e
     WHERE e.plugin_version_id = current_setting('test.plugin_deactivate_version')::uuid
       AND e.action = 'deactivated'
       AND e.reason = 'pgTAP deactivate readback proof'
  ),
  'deactivated approval event is written with reason'
);

SET LOCAL ROLE authenticated;

SELECT ok(
  (
    api.ui_get_resource_v1(
      'integration_plugin_directory',
      current_setting('test.plugin_deactivate_plugin')::uuid
    )->>'status'
  ) = 'disabled',
  'api directory readback shows disabled plugin status'
);

SELECT ok(
  (
    api.ui_get_resource_v1(
      'integration_plugin_directory',
      current_setting('test.plugin_deactivate_plugin')::uuid
    )->>'has_active_version'
  ) = 'false',
  'api directory readback shows no active version'
);

SELECT ok(
  COALESCE((
    api.ui_get_resource_v1(
      'integration_plugin_directory',
      current_setting('test.plugin_deactivate_plugin')::uuid
    )->>'active_binding_count'
  )::int, -1) = 0,
  'api directory readback shows zero active bindings'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        api.ui_list_resource_v1(
          'integration_plugin_bindings',
          jsonb_build_object('plugin_version_id', current_setting('test.plugin_deactivate_version')),
          20,
          0,
          jsonb_build_object('key', 'updated_at', 'direction', 'desc')
        )->'items'
      ) AS item(value)
     WHERE item.value->>'plugin_version_id' = current_setting('test.plugin_deactivate_version')
       AND COALESCE((item.value->>'enabled')::boolean, TRUE) IS FALSE
  ),
  'api binding readback shows disabled runtime binding'
);

SELECT * FROM finish();
ROLLBACK;
