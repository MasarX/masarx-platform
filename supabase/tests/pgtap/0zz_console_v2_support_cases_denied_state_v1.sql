-- pgTAP: Console V2 Support Cases lower-permission denied-state guard.
-- Proves billing-only first-tenant users cannot read Support queue resources
-- or execute Support write RPCs through the browser/API schema path.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000bc01';
  v_client UUID := '00000000-0000-0000-0000-00000000bc02';
  v_user UUID := '00000000-0000-0000-0000-00000000bc03';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Support Denied Org', 'console-v2-support-denied-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console V2 Support Denied Client', 'console-v2-support-denied-' || left(v_client::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'console-v2-support-denied-' || left(v_user::text, 8) || '@example.com',
    'Console V2 Support Denied Billing Viewer',
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

  PERFORM set_config('test.cv2_support_denied_org', v_org::text, true);
  PERFORM set_config('test.cv2_support_denied_client', v_client::text, true);
  PERFORM set_config('test.cv2_support_denied_user', v_user::text, true);

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

SELECT is(
  (
    SELECT jsonb_path_query_first(sv.value, '$.apps.console.sections[*].items[*] ? (@.href == "/support/cases").capability') #>> '{}'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'support.read',
  'Support cases navigation is gated by support.read'
);

SELECT is(
  (
    SELECT jsonb_path_query_first(sv.value, '$.resources[*] ? (@.key == "support_cases").capability_read') #>> '{}'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'support.read',
  'support_cases registry read is gated by support.read'
);

SELECT is(
  (
    SELECT jsonb_path_query_first(sv.value, '$.resources[*] ? (@.key == "support_case_directory").capability_read') #>> '{}'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ),
  'support.read',
  'support_case_directory registry read is gated by support.read'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) entry
    WHERE s.category = 'ui_read_registry'
      AND entry->>'key' = ANY (ARRAY[
        'support_cases',
        'support_case_directory',
        'support_messages',
        'support_message_directory',
        'support_case_events',
        'support_users'
      ])
      AND COALESCE(entry->>'capability_read', '') <> 'support.read'
  ),
  'all scoped support registry rows are gated by support.read'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_support_denied_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(public.user_has_capability_v1('billing.read'), 'billing_viewer has billing.read');
SELECT ok(public.user_has_capability_v1('console_metadata.read'), 'billing_viewer has console_metadata.read');
SELECT isnt(public.user_has_capability_v1('support.read'), TRUE, 'billing_viewer lacks support.read');
SELECT isnt(public.user_has_capability_v1('support.write'), TRUE, 'billing_viewer lacks support.write');
SELECT isnt(public.user_has_resource_capability_v1('support_cases', 'read'), TRUE, 'billing_viewer lacks support_cases read');
SELECT isnt(public.user_has_resource_capability_v1('support_case_directory', 'read'), TRUE, 'billing_viewer lacks support_case_directory read');

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('support_cases', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'billing_viewer cannot list support_cases through API read registry'
);

SELECT throws_ok(
  $$ SELECT api.ui_list_resource_v1('support_case_directory', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  '42501',
  NULL,
  'billing_viewer cannot list support_case_directory through API read registry'
);

SELECT throws_ok(
  $$ SELECT api.create_support_case_v1(jsonb_build_object(
       'client_id', current_setting('test.cv2_support_denied_client'),
       'subject', 'Denied support create',
       'priority', 'medium',
       'channel', 'in_app'
     )) $$,
  '42501',
  NULL,
  'billing_viewer cannot create support cases through API write RPC'
);

SELECT throws_ok(
  $$ SELECT api.bulk_resolve_support_cases_v1(jsonb_build_object(
       'support_case_ids', jsonb_build_array(gen_random_uuid()::text),
       'resolution', 'resolved'
     )) $$,
  '42501',
  NULL,
  'billing_viewer cannot bulk resolve support cases through API write RPC'
);

SELECT * FROM finish();

ROLLBACK;
