-- pgTAP: Console V2 Integrations lower-permission approver lifecycle readback.
-- Proves tenant_integrations_approver can test/approve/activate/toggle
-- integration plugins while remaining denied from draft-authoring submit.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

SELECT ok(
  COALESCE(
    public.resolve_settings_merged('saas_onboarding_policy', 'global', NULL)
      #> '{rbac,template_keys}',
    '[]'::jsonb
  ) ? 'tenant_integrations_approver',
  'onboarding policy provisions tenant_integrations_approver RBAC template'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'user_type'
       AND lv.value = 'tenant_integrations_approver'
       AND lv.status = 'active'
  ),
  'tenant_integrations_approver user type is lookup-backed'
);

SELECT ok(
  (
    SELECT COALESCE(jsonb_agg(lv.value ORDER BY lv.value), '[]'::jsonb)
      FROM public.rbac_role_templates t
      JOIN public.rbac_role_template_permissions tp
        ON tp.role_template_id = t.id
      JOIN public.lookup_values lv
        ON lv.id = tp.permission_id
     WHERE t.key = 'tenant_integrations_approver'
       AND t.is_active IS TRUE
  ) @> '[
    "console_metadata.read",
    "integration_plugins.activate",
    "integration_plugins.approve",
    "integration_plugins.read",
    "integration_plugins.test"
  ]'::jsonb,
  'tenant_integrations_approver RBAC template carries read/test/approve/activate permissions'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.rbac_role_templates t
      JOIN public.rbac_role_template_permissions tp
        ON tp.role_template_id = t.id
      JOIN public.lookup_values lv
        ON lv.id = tp.permission_id
     WHERE t.key = 'tenant_integrations_approver'
       AND lv.value = 'integration_plugins.write'
  ),
  'tenant_integrations_approver RBAC template excludes draft-authoring write'
);

DO $setup$
DECLARE
  v_org UUID := 'ab0271a0-0000-4000-8000-000000000001';
  v_client UUID := 'ab0271a0-0000-4000-8000-000000000002';
  v_sender UUID := 'ab0271a0-0000-4000-8000-000000000003';
  v_approver UUID := 'ab0271a0-0000-4000-8000-000000000004';
  v_operator UUID := 'ab0271a0-0000-4000-8000-000000000009';
  v_draft_plugin UUID := 'ab0271a0-0000-4000-8000-000000000005';
  v_draft_version UUID := 'ab0271a0-0000-4000-8000-000000000006';
  v_lifecycle_plugin UUID := 'ab0271a0-0000-4000-8000-000000000007';
  v_lifecycle_version UUID := 'ab0271a0-0000-4000-8000-000000000008';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Plugin Approver Org', 'console-v2-plugin-approver-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Plugin Approver Client', 'console-v2-plugin-approver-client', 'active')
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
  VALUES (
    v_sender,
    v_client,
    'Console V2 Plugin Approver Sender',
    'Console V2 Plugin Approver Sender',
    false,
    true,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      name = EXCLUDED.name,
      brand_name = EXCLUDED.brand_name;

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
    v_approver,
    v_org,
    'console-v2-plugin-approver@example.test',
    'Console V2 Plugin Approver',
    'tenant_integrations_approver',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET user_type = EXCLUDED.user_type,
      status = EXCLUDED.status,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id;

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
    v_operator,
    v_org,
    'console-v2-plugin-operator@example.test',
    'Console V2 Plugin Operator',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET user_type = EXCLUDED.user_type,
      status = EXCLUDED.status,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id;

  PERFORM public.provision_rbac_roles_from_templates_v1(
    v_org,
    ARRAY['tenant_integrations_approver']::TEXT[],
    v_approver
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
    created_by,
    updated_by
  )
  VALUES
    (
      v_draft_plugin,
      v_org,
      'console-v2-plugin-approver-draft-denied',
      'Console V2 Plugin Approver Draft Denied',
      'webhook',
      'draft',
      'tenant',
      true,
      'integration_plugin',
      v_approver,
      v_approver
    ),
    (
      v_lifecycle_plugin,
      v_org,
      'console-v2-plugin-approver-lifecycle',
      'Console V2 Plugin Approver Lifecycle',
      'webhook',
      'submitted',
      'tenant',
      true,
      'integration_plugin',
      v_approver,
      v_approver
    )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      plugin_kind = EXCLUDED.plugin_kind,
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
    submitted_by,
    submitted_at,
    metadata,
    created_by,
    updated_by
  )
  VALUES
    (
      v_draft_version,
      v_draft_plugin,
      v_org,
      1,
      'draft',
      'webhook_sample',
      '{"event":{"type":"shipment.created"},"shipment":{"tracking_number":"APPROVER-DRAFT-001"}}'::jsonb,
      '{"source_type":"webhook_sample","plugin_kind":"webhook"}'::jsonb,
      '{"webhook":{"event_type_path":"event.type"}}'::jsonb,
      '{"version":1,"target":"shipments.create","enabled":true}'::jsonb,
      '{"mode":"attach_existing","template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      NULL,
      NULL,
      '{}'::jsonb,
      v_approver,
      v_approver
    ),
    (
      v_lifecycle_version,
      v_lifecycle_plugin,
      v_org,
      1,
      'submitted',
      'webhook_sample',
      '{"event":{"type":"shipment.created"},"shipment":{"tracking_number":"APPROVER-LIFE-001","reference":"APPROVER-LIFE-001","recipient":{"external_id":"REC-APPROVER-LIFE","name":"Approver Lifecycle Recipient","phone":"+12025550182","email":"approver.lifecycle@example.test"},"destination":{"line1":"King Fahd Road","city":"Riyadh","country":"SA"}}}'::jsonb,
      '{"source_type":"webhook_sample","plugin_kind":"webhook"}'::jsonb,
      '{"webhook":{"event_type_path":"event.type"}}'::jsonb,
      '{
        "version":1,
        "target":"shipments.create",
        "enabled":true,
        "transforms":{
          "shipment":{"tracking_number":["shipment.tracking_number","tracking_number"],"external_id":["shipment.reference","external_id"],"reference_number":["shipment.reference","reference"]},
          "recipient":{"external_id":["shipment.recipient.external_id"],"name":["Example Entity ntvplorhukthpmnmvgrstqzp"],"phone":["shipment.recipient.phone"],"email":["shipment.recipient.email"]},
          "address":{"line1":["shipment.destination.line1"],"city":["shipment.destination.city"],"country_code":["shipment.destination.country"]}
        },
        "metadata":{"canonical_intent":"shipment.create","mapping_profile":"tenant_integrations_approver_pgtap"}
      }'::jsonb,
      '{"mode":"attach_existing","template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      v_approver,
      now(),
      '{}'::jsonb,
      v_approver,
      v_approver
    )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      workflow_binding = EXCLUDED.workflow_binding,
      mapping_config = EXCLUDED.mapping_config,
      submitted_by = EXCLUDED.submitted_by,
      submitted_at = EXCLUDED.submitted_at,
      updated_by = EXCLUDED.updated_by,
      updated_at = now();

  PERFORM set_config('test.plugin_approver_org', v_org::text, true);
  PERFORM set_config('test.plugin_approver_user', v_approver::text, true);
  PERFORM set_config('test.plugin_operator_user', v_operator::text, true);
  PERFORM set_config('test.plugin_approver_draft_version', v_draft_version::text, true);
  PERFORM set_config('test.plugin_approver_lifecycle_plugin', v_lifecycle_plugin::text, true);
  PERFORM set_config('test.plugin_approver_lifecycle_version', v_lifecycle_version::text, true);
END;
$setup$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_roles r
     WHERE r.organization_id = current_setting('test.plugin_approver_org')::uuid
       AND r.key = 'tenant_integrations_approver'
       AND r.is_active IS TRUE
  ),
  'tenant_integrations_approver materializes as a concrete tenant RBAC role'
);

SELECT ok(
  (
    SELECT COALESCE(jsonb_agg(v.permission_value ORDER BY v.permission_value), '[]'::jsonb)
      FROM public.v_rbac_role_permission_directory v
     WHERE v.organization_id = current_setting('test.plugin_approver_org')::uuid
       AND v.role_key = 'tenant_integrations_approver'
  ) @> '[
    "console_metadata.read",
    "integration_plugins.activate",
    "integration_plugins.approve",
    "integration_plugins.read",
    "integration_plugins.test"
  ]'::jsonb,
  'tenant_integrations_approver concrete tenant role carries read/test/approve/activate permissions'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.v_rbac_role_permission_directory v
     WHERE v.organization_id = current_setting('test.plugin_approver_org')::uuid
       AND v.role_key = 'tenant_integrations_approver'
       AND v.permission_value = 'integration_plugins.write'
  ),
  'tenant_integrations_approver concrete tenant role excludes draft-authoring write'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.plugin_operator_user'), true);
SELECT set_config(
  'request.jwt.claims',
  format('{"sub":"%s","role":"authenticated"}', current_setting('test.plugin_operator_user')),
  true
);

SET LOCAL ROLE authenticated;

SELECT ok(
  COALESCE((
    public.user_capability_eval_for_user_v1(
      current_setting('test.plugin_approver_user')::uuid,
      'integration_plugins.approve',
      'tenant',
      current_setting('test.plugin_approver_org')::uuid
    )->>'allowed'
  )::boolean, FALSE),
  'target-user evaluator lets an operator inspect approver approve capability'
);

SELECT ok(
  NOT COALESCE((
    public.user_capability_eval_for_user_v1(
      current_setting('test.plugin_approver_user')::uuid,
      'integration_plugins.write',
      'tenant',
      current_setting('test.plugin_approver_org')::uuid
    )->>'allowed'
  )::boolean, FALSE),
  'target-user evaluator denies approver draft-authoring write even when inspector can write'
);

SELECT ok(
  NOT COALESCE((
    api.user_capability_eval_for_user_v1(jsonb_build_object(
      'target_user_id', current_setting('test.plugin_approver_user'),
      'capability_key', 'integration_plugins.write',
      'scope_type', 'tenant',
      'scope_id', current_setting('test.plugin_approver_org')
    )) #>> '{eval,allowed}'
  )::boolean, FALSE),
  'api target-user evaluator wrapper preserves approver draft-authoring denial'
);

RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.plugin_approver_user'), true);
SELECT set_config(
  'request.jwt.claims',
  format('{"sub":"%s","role":"authenticated"}', current_setting('test.plugin_approver_user')),
  true
);

SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT bool_and(COALESCE((public.user_capability_eval_v1(capability, 'tenant', current_setting('test.plugin_approver_org')::uuid)->>'allowed')::boolean, FALSE))
      FROM (VALUES
        ('integration_plugins.read'),
        ('integration_plugins.test'),
        ('integration_plugins.approve'),
        ('integration_plugins.activate'),
        ('console_metadata.read')
      ) AS required(capability)
  ),
  'tenant_integrations_approver live capability eval allows read/test/approve/activate'
);

SELECT ok(
  NOT COALESCE((
    public.user_capability_eval_v1(
      'integration_plugins.write',
      'tenant',
      current_setting('test.plugin_approver_org')::uuid
    )->>'allowed'
  )::boolean, FALSE),
  'tenant_integrations_approver live capability eval denies draft-authoring write'
);

SELECT throws_ok(
  format(
    $$ SELECT api.plugin_submit_v1(jsonb_build_object('plugin_version_id', '%s', 'reason', 'approver denied write proof')) $$,
    current_setting('test.plugin_approver_draft_version')
  ),
  '42501',
  NULL,
  'tenant_integrations_approver cannot submit draft versions'
);

SELECT ok(
  (
    api.test_integration_plugin_v1(jsonb_build_object(
      'plugin_version_id', current_setting('test.plugin_approver_lifecycle_version'),
      'payload', '{"event":{"type":"shipment.created"},"shipment":{"tracking_number":"APPROVER-LIFE-001"}}'::jsonb
    ))->>'ok'
  )::boolean,
  'tenant_integrations_approver can run integration plugin test'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.integration_plugin_validation_runs r
     WHERE r.plugin_version_id = current_setting('test.plugin_approver_lifecycle_version')::uuid
       AND r.executed_by = current_setting('test.plugin_approver_user')::uuid
       AND r.run_type = 'test'
       AND r.status = 'succeeded'
  ),
  'plugin test writes validation run readback for approver'
);

SET LOCAL ROLE authenticated;

SELECT ok(
  (
    api.plugin_approve_v1(jsonb_build_object(
      'plugin_version_id', current_setting('test.plugin_approver_lifecycle_version'),
      'decision', 'approved',
      'reason', 'pgTAP tenant approver approval proof'
    ))->>'ok'
  )::boolean,
  'tenant_integrations_approver can approve submitted plugin version'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.integration_plugin_versions v
      JOIN public.integration_plugin_approval_events e
        ON e.plugin_version_id = v.id
     WHERE v.id = current_setting('test.plugin_approver_lifecycle_version')::uuid
       AND v.status = 'approved'
       AND e.action = 'approved'
       AND e.actor_user_id = current_setting('test.plugin_approver_user')::uuid
  ),
  'approve writes version status and approval event readback for approver'
);

SET LOCAL ROLE authenticated;

SELECT ok(
  (
    api.plugin_activate_v1(jsonb_build_object(
      'plugin_version_id', current_setting('test.plugin_approver_lifecycle_version'),
      'scope_type', 'tenant',
      'scope_id', current_setting('test.plugin_approver_org'),
      'reason', 'pgTAP tenant approver activation proof'
    ))->>'ok'
  )::boolean,
  'tenant_integrations_approver can activate approved plugin version'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.integration_plugins p
      JOIN public.integration_plugin_versions v
        ON v.id = p.active_version_id
      JOIN public.integration_plugin_bindings b
        ON b.plugin_version_id = v.id
     WHERE p.id = current_setting('test.plugin_approver_lifecycle_plugin')::uuid
       AND v.id = current_setting('test.plugin_approver_lifecycle_version')::uuid
       AND v.status = 'active'
       AND b.enabled IS TRUE
  ),
  'activation pivots active version and creates enabled runtime binding readback'
);

SET LOCAL ROLE authenticated;

SELECT ok(
  (
    api.plugin_set_binding_v1(jsonb_build_object(
      'plugin_version_id', current_setting('test.plugin_approver_lifecycle_version'),
      'enabled', false,
      'scope_type', 'tenant',
      'scope_id', current_setting('test.plugin_approver_org')
    ))->>'ok'
  )::boolean,
  'tenant_integrations_approver can disable runtime binding'
);

SELECT ok(
  COALESCE((
    api.ui_list_resource_v1(
      'integration_plugin_bindings',
      jsonb_build_object('plugin_version_id', current_setting('test.plugin_approver_lifecycle_version')),
      20,
      0,
      jsonb_build_object('key', 'updated_at', 'direction', 'desc')
    )->>'total'
  )::int, 0) >= 1
  AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        api.ui_list_resource_v1(
          'integration_plugin_bindings',
          jsonb_build_object('plugin_version_id', current_setting('test.plugin_approver_lifecycle_version')),
          20,
          0,
          jsonb_build_object('key', 'updated_at', 'direction', 'desc')
        )->'items'
      ) AS item(value)
     WHERE item.value->>'plugin_version_id' = current_setting('test.plugin_approver_lifecycle_version')
       AND COALESCE((item.value->>'enabled')::boolean, TRUE) IS FALSE
  ),
  'approver can read disabled binding through api.ui_list_resource_v1 without broad write'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
