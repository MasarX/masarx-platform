-- pgTAP: public.lookup_definition_create_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b607';
  v_ops UUID := '00000000-0000-0000-0000-00000000b671';
  v_sender UUID := '00000000-0000-0000-0000-00000000b672';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 LD Create Org', 'b6-ld-cre-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-ld-cre-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 LD Cre Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-ld-cre-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 LD Cre Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_ld_cre_org', v_org::text, true);
  PERFORM set_config('test.b6_ld_cre_ops', v_ops::text, true);
  PERFORM set_config('test.b6_ld_cre_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (tenant scope)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ld_cre_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.lookup_definition_create_v1(jsonb_build_object(
      'category', 'b6_ld_cat_' || replace(gen_random_uuid()::text, '-', '_'),
      'scope_type', 'tenant',
      'description', 'pgtap'
    ))->>'ok')::bool
  ),
  'ops_admin can lookup_definition_create_v1 (tenant scope)'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ld_cre_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.lookup_definition_create_v1(jsonb_build_object(
       'category', 'b6_ld_cat_deny',
       'scope_type', 'tenant'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied lookup_definition_create_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'lookup_definitions.create'
       AND organization_id = current_setting('test.b6_ld_cre_org')::uuid
  ),
  'lookup_definition_create_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lookup_definitions'::regclass),
  'lookup_definitions has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
