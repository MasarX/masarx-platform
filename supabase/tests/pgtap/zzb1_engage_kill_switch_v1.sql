-- pgTAP: public.engage_kill_switch_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000ba01';
  v_ops UUID := '00000000-0000-0000-0000-00000000ba11';
  v_sender UUID := '00000000-0000-0000-0000-00000000ba12';
  v_flag UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Engage Org', 'b1-eng-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-eng-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Eng Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-eng-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Eng Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.feature_flags (id, name, scope_type, scope_id, enabled, rollout_percentage)
  VALUES (v_flag, 'b1.engage.flag.' || left(v_flag::text, 8), 'tenant', v_org, TRUE, 50)
  ON CONFLICT (name) DO NOTHING;

  PERFORM set_config('test.b1_eng_ops', v_ops::text, true);
  PERFORM set_config('test.b1_eng_sender', v_sender::text, true);
  PERFORM set_config('test.b1_eng_flag', v_flag::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_eng_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.engage_kill_switch_v1(jsonb_build_object(
    'feature_flag_id', current_setting('test.b1_eng_flag'),
    'reason', 'pgtap kill-switch test'
  ))->>'ok')::bool),
  'ops_admin can engage_kill_switch_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_eng_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.engage_kill_switch_v1(jsonb_build_object(
       'feature_flag_id', current_setting('test.b1_eng_flag'),
       'reason', 'pgtap denied'
     )) $$,
  '42501',
  NULL,
  'non-ops user denied engage_kill_switch_v1'
);
RESET ROLE;

-- 3) Audit ledger captures prior_enabled+prior_rollout
SET LOCAL ROLE postgres;
SELECT ok(
  (SELECT prior_rollout_percentage FROM public.feature_flag_kill_events
    WHERE feature_flag_id = current_setting('test.b1_eng_flag')::uuid
      AND event_type = 'engaged'
    ORDER BY created_at DESC LIMIT 1) = 50,
  'engage_kill_switch_v1 captures prior_rollout_percentage in kill_events'
);
RESET ROLE;

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.feature_flag_kill_events', 'insert'),
  'authenticated cannot bypass RPC to write feature_flag_kill_events'
);

SELECT * FROM finish();
ROLLBACK;
