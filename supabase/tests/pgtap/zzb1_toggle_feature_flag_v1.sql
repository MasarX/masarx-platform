-- pgTAP: public.toggle_feature_flag_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b901';
  v_ops UUID := '00000000-0000-0000-0000-00000000b911';
  v_sender UUID := '00000000-0000-0000-0000-00000000b912';
  v_flag UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Toggle Org', 'b1-tog-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-tog-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Tog Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-tog-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Tog Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.feature_flags (id, name, scope_type, scope_id, enabled, rollout_percentage)
  VALUES (v_flag, 'b1.toggle.flag.' || left(v_flag::text, 8), 'tenant', v_org, FALSE, 0)
  ON CONFLICT (name) DO NOTHING;

  PERFORM set_config('test.b1_tog_ops', v_ops::text, true);
  PERFORM set_config('test.b1_tog_sender', v_sender::text, true);
  PERFORM set_config('test.b1_tog_flag', v_flag::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_tog_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.toggle_feature_flag_v1(jsonb_build_object(
    'feature_flag_id', current_setting('test.b1_tog_flag'),
    'enabled', true
  ))->>'enabled')::bool),
  'ops_admin can toggle_feature_flag_v1 to enabled'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_tog_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.toggle_feature_flag_v1(jsonb_build_object(
       'feature_flag_id', current_setting('test.b1_tog_flag'),
       'enabled', false
     )) $$,
  '42501',
  NULL,
  'non-ops user denied toggle_feature_flag_v1'
);
RESET ROLE;

-- 3) Audit ledger appended (kill_events)
SET LOCAL ROLE postgres;
SELECT ok(
  (SELECT COUNT(*) FROM public.feature_flag_kill_events
    WHERE feature_flag_id = current_setting('test.b1_tog_flag')::uuid
      AND event_type = 'toggled') >= 1,
  'toggle_feature_flag_v1 appends feature_flag_kill_events row (audit ledger)'
);
RESET ROLE;

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.feature_flags', 'update'),
  'authenticated has no direct UPDATE on feature_flags'
);

SELECT * FROM finish();
ROLLBACK;
