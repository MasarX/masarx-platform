-- pgTAP: public.service_offering_toggle_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b604';
  v_ops UUID := '00000000-0000-0000-0000-00000000b641';
  v_sender UUID := '00000000-0000-0000-0000-00000000b642';
  v_branch UUID := gen_random_uuid();
  v_level UUID := gen_random_uuid();
  v_offering UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 SO Toggle Org', 'b6-so-tog-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-so-tog-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 SO Tog Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-so-tog-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 SO Tog Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'b6-sotog-' || left(v_branch::text, 6), 'B6 SO Tog Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, status)
  SELECT id, 'b6-sotog-' || left(v_level::text, 6), 'Fixture service level', 'active'
  FROM public.lookup_definitions
  WHERE category = 'service_level'
  ON CONFLICT (lookup_definition_id, value) DO NOTHING;

  INSERT INTO public.service_levels (id, organization_id, key, name)
  VALUES (v_level, v_org, 'b6-sotog-' || left(v_level::text, 6), 'B6 SO Tog Level')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.service_offerings (id, service_level_id, branch_id, is_active)
  VALUES (v_offering, v_level, v_branch, TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_so_tog_org', v_org::text, true);
  PERFORM set_config('test.b6_so_tog_ops', v_ops::text, true);
  PERFORM set_config('test.b6_so_tog_sender', v_sender::text, true);
  PERFORM set_config('test.b6_so_tog_offering', v_offering::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_so_tog_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.service_offering_toggle_v1(jsonb_build_object(
      'service_offering_id', current_setting('test.b6_so_tog_offering'),
      'is_active', false
    ))->>'ok')::bool
  ),
  'ops_admin can service_offering_toggle_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_so_tog_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.service_offering_toggle_v1(jsonb_build_object(
       'service_offering_id', current_setting('test.b6_so_tog_offering'),
       'is_active', true
     )) $$,
  '42501',
  NULL,
  'non-admin user denied service_offering_toggle_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'service_offerings.toggle'
       AND resource_id = current_setting('test.b6_so_tog_offering')::uuid
  ),
  'service_offering_toggle_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.service_offerings'::regclass),
  'service_offerings has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
