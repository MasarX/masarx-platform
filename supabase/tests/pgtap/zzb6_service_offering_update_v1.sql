-- pgTAP: public.service_offering_update_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b602';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b621';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b622';
  v_branch UUID := gen_random_uuid();
  v_level UUID := gen_random_uuid();
  v_offering UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 SO Update Org', 'b6-so-update-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops_admin, v_org, 'b6-so-upd-ops-' || left(v_ops_admin::text, 8) || '@example.com',
     'B6 SO Upd Ops', 'ops_admin', 'tenant', NULL),
    (v_sender_user, v_org, 'b6-so-upd-sender-' || left(v_sender_user::text, 8) || '@example.com',
     'B6 SO Upd Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'b6-soupd-' || left(v_branch::text, 6), 'B6 SO Upd Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, status)
  SELECT id, 'b6-soupd-' || left(v_level::text, 6), 'Fixture service level', 'active'
  FROM public.lookup_definitions
  WHERE category = 'service_level'
  ON CONFLICT (lookup_definition_id, value) DO NOTHING;

  INSERT INTO public.service_levels (id, organization_id, key, name)
  VALUES (v_level, v_org, 'b6-soupd-' || left(v_level::text, 6), 'B6 SO Upd Level')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.service_offerings (id, service_level_id, branch_id, priority, is_active)
  VALUES (v_offering, v_level, v_branch, 0, TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_so_upd_org', v_org::text, true);
  PERFORM set_config('test.b6_so_upd_ops', v_ops_admin::text, true);
  PERFORM set_config('test.b6_so_upd_sender', v_sender_user::text, true);
  PERFORM set_config('test.b6_so_upd_offering', v_offering::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_so_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.service_offering_update_v1(jsonb_build_object(
      'service_offering_id', current_setting('test.b6_so_upd_offering'),
      'priority', 5
    ))->>'ok')::bool
  ),
  'ops_admin can service_offering_update_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_so_upd_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.service_offering_update_v1(jsonb_build_object(
       'service_offering_id', current_setting('test.b6_so_upd_offering'),
       'priority', 9
     )) $$,
  '42501',
  NULL,
  'non-admin user denied service_offering_update_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'service_offerings.update'
       AND resource_id = current_setting('test.b6_so_upd_offering')::uuid
  ),
  'service_offering_update_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.service_offerings'::regclass),
  'service_offerings has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
