-- pgTAP: Console V2 Billing Viewer boots with narrow metadata access.
-- Proves the read-only Billing persona can load shell metadata and Billing,
-- while Reference Data, Settings, and Billing mutations remain denied.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b701';
  v_client UUID := '00000000-0000-0000-0000-00000000b702';
  v_user UUID := '00000000-0000-0000-0000-00000000b703';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Billing Viewer Org', 'console-v2-billing-viewer-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console V2 Billing Viewer Client', 'console-v2-billing-viewer-' || left(v_client::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'console-v2-billing-viewer-' || left(v_user::text, 8) || '@example.com',
    'Console V2 Billing Viewer',
    'billing_viewer',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id;

  PERFORM set_config('test.cv2_billing_viewer_org', v_org::text, true);
  PERFORM set_config('test.cv2_billing_viewer_client', v_client::text, true);
  PERFORM set_config('test.cv2_billing_viewer_user', v_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'user_type'
      AND lv.value = 'billing_viewer'
      AND lv.status = 'active'
  ),
  'billing_viewer user_type lookup is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND jsonb_path_exists(sv.value, '$.roles[*] ? (@.key == "billing_viewer")')
  ),
  'global access_control_policy includes billing_viewer role'
);

SELECT is(
  (
    SELECT array_agg(cap ORDER BY ord)
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_path_query_first(sv.value, '$.roles[*] ? (@.key == "billing_viewer").capability_keys') caps
    CROSS JOIN LATERAL jsonb_array_elements_text(caps) WITH ORDINALITY AS cap_rows(cap, ord)
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  ARRAY['billing.read', 'console_metadata.read']::text[],
  'billing_viewer role grants only billing read plus console metadata'
);

SELECT isnt(
  (
    SELECT array_agg(cap ORDER BY ord)
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_path_query_first(sv.value, '$.roles[*] ? (@.key == "billing_viewer").capability_keys') caps
    CROSS JOIN LATERAL jsonb_array_elements_text(caps) WITH ORDINALITY AS cap_rows(cap, ord)
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ) && ARRAY['lookups.read', 'settings.read', 'settings_category_registry.read', 'billing.write', 'invoices.send', 'invoices.refund']::text[],
  TRUE,
  'billing_viewer role does not carry broad metadata or mutation capabilities'
);

SELECT is(
  (
    SELECT jsonb_path_query_first(sv.value, '$.resources[*] ? (@.key == "settings_category_registry").capability_read') #>> '{}'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'console_metadata.read',
  'settings category metadata resource is gated by console_metadata.read'
);

SELECT is(
  (
    SELECT jsonb_path_query_first(sv.value, '$.resources[*] ? (@.key == "lookup_values").capability_read') #>> '{}'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'lookups.read',
  'lookup_values resource remains gated by Reference Data capability'
);

SELECT is(
  (
    SELECT jsonb_path_query_first(sv.value, '$.apps.console.sections[*].items[*] ? (@.href == "/platform/planning-os").capability') #>> '{}'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'audit_log.read',
  'Planning OS navigation is gated by audit_log.read'
);

SELECT is(
  (
    SELECT jsonb_path_query_first(sv.value, '$.apps.console.sections[*].items[*] ? (@.href == "/platform/commands").capability') #>> '{}'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'audit_log.read',
  'Commands navigation is gated by audit_log.read'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_billing_viewer_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(public.user_has_capability_v1('billing.read'), 'billing_viewer has billing.read');
SELECT ok(public.user_has_capability_v1('console_metadata.read'), 'billing_viewer has console_metadata.read');
SELECT isnt(public.user_has_capability_v1('billing.write'), TRUE, 'billing_viewer lacks billing.write');
SELECT isnt(public.user_has_capability_v1('invoices.send'), TRUE, 'billing_viewer lacks invoices.send');
SELECT isnt(public.user_has_capability_v1('invoices.refund'), TRUE, 'billing_viewer lacks invoices.refund');
SELECT isnt(public.user_has_capability_v1('settings.read'), TRUE, 'billing_viewer lacks settings.read');
SELECT isnt(public.user_has_capability_v1('access_policy.read'), TRUE, 'billing_viewer lacks access_policy.read');
SELECT isnt(public.user_has_capability_v1('access_policy.approve'), TRUE, 'billing_viewer lacks access_policy.approve');
SELECT isnt(public.user_has_capability_v1('access_policy.request'), TRUE, 'billing_viewer lacks access_policy.request');
SELECT isnt(public.user_has_resource_capability_v1('lookup_values', 'read'), TRUE, 'billing_viewer lacks lookup_values read');

SELECT ok(
  jsonb_typeof(api.list_lookup_values_catalog_json_v1(FALSE)) = 'object',
  'billing_viewer can hydrate lookup catalog through console_metadata.read'
);

SELECT ok(
  jsonb_typeof(api.ui_list_resource_v1('settings_category_registry', '{}'::jsonb, 5, 0, NULL::jsonb)->'items') = 'array',
  'billing_viewer can hydrate settings category metadata for shell boot'
);

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('lookup_values', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'billing_viewer cannot open Reference Data lookup values resource'
);

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('rbac_roles', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'billing_viewer cannot open Access Control role resources'
);

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('rbac_user_role_assignments', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'billing_viewer cannot open Access Control assignment resources'
);

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('rbac_role_templates', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'billing_viewer cannot open Access Control template resources'
);

SELECT * FROM finish();

ROLLBACK;
