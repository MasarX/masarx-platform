-- pgTAP: public.service_level_create_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b605';
  v_ops UUID := '00000000-0000-0000-0000-00000000b651';
  v_sender UUID := '00000000-0000-0000-0000-00000000b652';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 SL Create Org', 'b6-sl-create-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-sl-cre-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 SL Cre Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-sl-cre-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 SL Cre Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_sl_cre_org', v_org::text, true);
  PERFORM set_config('test.b6_sl_cre_ops', v_ops::text, true);
  PERFORM set_config('test.b6_sl_cre_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sl_cre_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.service_level_create_v1(jsonb_build_object(
      'key', 'b6-sl-cre-' || gen_random_uuid()::text,
      'name', 'B6 SL Cre New'
    ))->>'ok')::bool
  ),
  'ops_admin can service_level_create_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sl_cre_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.service_level_create_v1(jsonb_build_object(
       'key', 'b6-sl-cre-deny',
       'name', 'B6 SL Cre Deny'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied service_level_create_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'service_levels.create'
       AND organization_id = current_setting('test.b6_sl_cre_org')::uuid
  ),
  'service_level_create_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.service_levels'::regclass),
  'service_levels has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
