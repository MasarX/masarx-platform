-- pgTAP: public.set_rollout_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000bc01';
  v_ops UUID := '00000000-0000-0000-0000-00000000bc11';
  v_sender UUID := '00000000-0000-0000-0000-00000000bc12';
  v_flag UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Rollout Org', 'b1-rol-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-rol-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Rol Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-rol-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Rol Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.feature_flags (id, name, scope_type, scope_id, enabled, rollout_percentage)
  VALUES (v_flag, 'b1.rollout.flag.' || left(v_flag::text, 8), 'tenant', v_org, TRUE, 10)
  ON CONFLICT (name) DO NOTHING;

  PERFORM set_config('test.b1_rol_ops', v_ops::text, true);
  PERFORM set_config('test.b1_rol_sender', v_sender::text, true);
  PERFORM set_config('test.b1_rol_flag', v_flag::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_rol_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.set_rollout_v1(jsonb_build_object(
    'feature_flag_id', current_setting('test.b1_rol_flag'),
    'rollout_percentage', 75
  ))->>'rollout_percentage')::int = 75),
  'ops_admin can set_rollout_v1 to 75%'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_rol_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.set_rollout_v1(jsonb_build_object(
       'feature_flag_id', current_setting('test.b1_rol_flag'),
       'rollout_percentage', 30
     )) $$,
  '42501',
  NULL,
  'non-ops user denied set_rollout_v1'
);
RESET ROLE;

-- 3) Validation: out-of-range fails
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_rol_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.set_rollout_v1(jsonb_build_object(
       'feature_flag_id', current_setting('test.b1_rol_flag'),
       'rollout_percentage', 150
     )) $$,
  '22023',
  NULL,
  'set_rollout_v1 rejects rollout_percentage > 100 (22023)'
);
RESET ROLE;

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.feature_flags', 'update'),
  'authenticated has no direct UPDATE on feature_flags'
);

SELECT * FROM finish();
ROLLBACK;
