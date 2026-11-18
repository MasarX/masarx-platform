-- pgTAP: public.mapping_config_promote_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b612';
  v_ops UUID := '00000000-0000-0000-0000-00000000b721';
  v_sender UUID := '00000000-0000-0000-0000-00000000b722';
  v_mapping UUID := gen_random_uuid();
  v_global_mapping UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Mapping Org', 'b6-map-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-map-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Map Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-map-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 Map Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version)
  VALUES (v_mapping, v_org, 'webhook_inbound', 'b6-map-key-' || left(v_mapping::text, 8),
          jsonb_build_object('rules', '[]'::jsonb), 1)
  ON CONFLICT (mapping_type, mapping_key) DO NOTHING;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version)
  VALUES (v_global_mapping, NULL, 'webhook_inbound', 'b6-map-global-key-' || left(v_global_mapping::text, 8),
          jsonb_build_object('rules', '[]'::jsonb), 1)
  ON CONFLICT (mapping_type, mapping_key) DO NOTHING;

  PERFORM set_config('test.b6_map_org', v_org::text, true);
  PERFORM set_config('test.b6_map_ops', v_ops::text, true);
  PERFORM set_config('test.b6_map_sender', v_sender::text, true);
  PERFORM set_config('test.b6_map_id', v_mapping::text, true);
  PERFORM set_config('test.b6_map_global_id', v_global_mapping::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_map_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.mapping_config_promote_v1(jsonb_build_object(
      'mapping_config_id', current_setting('test.b6_map_id'),
      'notes', 'pgtap-promote'
    ))->>'ok')::bool
  ),
  'ops_admin can mapping_config_promote_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_map_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.mapping_config_promote_v1(jsonb_build_object(
       'mapping_config_id', current_setting('test.b6_map_id')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied mapping_config_promote_v1'
);
RESET ROLE;

-- 3) Global/shared mapping configs stay service-managed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_map_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.mapping_config_promote_v1(jsonb_build_object(
       'mapping_config_id', current_setting('test.b6_map_global_id')
     )) $$,
  '42501',
  NULL,
  'global/shared mapping_config denied mapping_config_promote_v1'
);
RESET ROLE;

-- 4) Ladder/audit: revision row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.mapping_config_revisions
     WHERE mapping_config_id = current_setting('test.b6_map_id')::uuid
       AND revision = 1
  ),
  'mapping_config_promote_v1 appended revision row'
);

-- 5) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.mapping_config_revisions', 'select'),
  'authenticated has no SELECT on mapping_config_revisions (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
