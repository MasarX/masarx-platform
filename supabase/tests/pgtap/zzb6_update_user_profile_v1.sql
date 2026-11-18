-- pgTAP: public.update_user_profile_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b60d';
  v_ops UUID := '00000000-0000-0000-0000-00000000b6d1';
  v_sender_self UUID := '00000000-0000-0000-0000-00000000b6d2';
  v_other UUID := '00000000-0000-0000-0000-00000000b6d3';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Profile Org', 'b6-prof-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-prof-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Prof Ops', 'ops_admin', 'tenant', NULL),
    (v_sender_self, v_org, 'b6-prof-self-' || left(v_sender_self::text, 8) || '@example.com',
     'B6 Prof Self', 'account_manager', 'tenant', NULL),
    (v_other, v_org, 'b6-prof-other-' || left(v_other::text, 8) || '@example.com',
     'B6 Prof Other', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_prof_org', v_org::text, true);
  PERFORM set_config('test.b6_prof_ops', v_ops::text, true);
  PERFORM set_config('test.b6_prof_self', v_sender_self::text, true);
  PERFORM set_config('test.b6_prof_other', v_other::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (sender self-edit via users.read)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_prof_self'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.update_user_profile_v1(jsonb_build_object(
      'full_name', 'B6 Prof Self Renamed'
    ))->>'ok')::bool
  ),
  'sender_user can update their own profile (self-edit)'
);
RESET ROLE;

-- 2) Denied (sender editing OTHER user requires users.manage which sender_user lacks)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_prof_self'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.update_user_profile_v1(jsonb_build_object(
       'user_id', current_setting('test.b6_prof_other'),
       'full_name', 'attempted by other'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied update_user_profile_v1 against another user (users.manage required)'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'users.profile_update'
       AND resource_id = current_setting('test.b6_prof_self')::uuid
  ),
  'update_user_profile_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.users'::regclass),
  'users has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
