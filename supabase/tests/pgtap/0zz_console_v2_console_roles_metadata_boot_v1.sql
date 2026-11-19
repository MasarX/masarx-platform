-- pgTAP: Console V2 canonical console roles can boot shell metadata.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000baa0';
  v_ops UUID := '00000000-0000-0000-0000-00000000baa1';
  v_account UUID := '00000000-0000-0000-0000-00000000baa2';
  v_client UUID := '00000000-0000-0000-0000-00000000baa3';
  v_sender UUID := '00000000-0000-0000-0000-00000000baa4';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Metadata Boot Roles Org', 'console-v2-metadata-boot-roles')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'metadata-boot-ops@example.com', 'Metadata Boot Ops', 'ops_admin', 'tenant', NULL),
    (v_account, v_org, 'metadata-boot-account@example.com', 'Metadata Boot Account', 'account_manager', 'tenant', NULL),
    (v_client, v_org, 'metadata-boot-client@example.com', 'Metadata Boot Client', 'client_admin', 'tenant', NULL),
    (v_sender, v_org, 'metadata-boot-sender@example.com', 'Metadata Boot Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id,
      updated_at = now();

  PERFORM set_config('test.cv2_metadata_boot_ops', v_ops::text, true);
  PERFORM set_config('test.cv2_metadata_boot_account', v_account::text, true);
  PERFORM set_config('test.cv2_metadata_boot_client', v_client::text, true);
  PERFORM set_config('test.cv2_metadata_boot_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND jsonb_path_exists(sv.value, '$.capabilities[*] ? (@.key == "console_metadata.read")')
  ),
  'access_control_policy declares console_metadata.read capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_path_query_first(sv.value, '$.roles[*] ? (@.key == "ops_admin").capability_keys') caps
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND caps @> '["console_metadata.read"]'::jsonb
  ),
  'ops_admin role includes console_metadata.read'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_metadata_boot_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('console_metadata.read'), 'ops_admin has console_metadata.read');
SELECT ok(jsonb_typeof(api.list_lookup_values_catalog_json_v1(FALSE)) = 'object', 'ops_admin can hydrate lookup catalog');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_metadata_boot_account'), true);
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('console_metadata.read'), 'account_manager has console_metadata.read');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_metadata_boot_client'), true);
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('console_metadata.read'), 'client_admin has console_metadata.read');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_metadata_boot_sender'), true);
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('console_metadata.read'), 'sender_user has console_metadata.read');
SELECT ok(jsonb_typeof(api.list_lookup_values_catalog_json_v1(FALSE)) = 'object', 'sender_user can hydrate lookup catalog');

SELECT * FROM finish();

ROLLBACK;
