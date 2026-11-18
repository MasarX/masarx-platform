-- pgTAP: public.service_offering_create_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b601';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b611';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b612';
  v_branch UUID := gen_random_uuid();
  v_level UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 SO Create Org', 'b6-so-create-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org, 'b6-so-create-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B6 SO Create Ops', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org, 'b6-so-create-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B6 SO Create Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, branch_type)
  VALUES (v_branch, v_org, 'b6-so-' || left(v_branch::text, 6), 'B6 SO Branch', 'depot')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.service_levels (id, organization_id, key, name)
  VALUES (v_level, v_org, 'b6-so-' || left(v_level::text, 6), 'B6 SO Level')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_so_create_org', v_org::text, true);
  PERFORM set_config('test.b6_so_create_ops', v_ops_admin::text, true);
  PERFORM set_config('test.b6_so_create_sender', v_sender_user::text, true);
  PERFORM set_config('test.b6_so_create_branch', v_branch::text, true);
  PERFORM set_config('test.b6_so_create_level', v_level::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_so_create_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.service_offering_create_v1(jsonb_build_object(
      'service_level_id', current_setting('test.b6_so_create_level'),
      'branch_id', current_setting('test.b6_so_create_branch')
    ))->>'ok')::bool
  ),
  'ops_admin can service_offering_create_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_so_create_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.service_offering_create_v1(jsonb_build_object(
       'service_level_id', current_setting('test.b6_so_create_level'),
       'branch_id', current_setting('test.b6_so_create_branch')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied service_offering_create_v1'
);
RESET ROLE;

-- 3) Ladder/audit: decision_log row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'service_offerings.create'
       AND resource_type = 'service_offering'
       AND organization_id = current_setting('test.b6_so_create_org')::uuid
  ),
  'service_offering_create_v1 wrote decision_log row (ladder/audit evidence)'
);

-- 4) RLS isolation: service_offerings RLS enabled (write requires agreements.write via policy)
SELECT ok(
  (
    SELECT relrowsecurity FROM pg_class
     WHERE oid = 'public.service_offerings'::regclass
  ),
  'service_offerings has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
