-- pgTAP: public.release_kill_switch_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000bb01';
  v_ops UUID := '00000000-0000-0000-0000-00000000bb11';
  v_sender UUID := '00000000-0000-0000-0000-00000000bb12';
  v_flag UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Release Org', 'b1-rel-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-rel-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Rel Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-rel-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Rel Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  -- Start in killed state with prior state recorded
  INSERT INTO public.feature_flags (id, name, scope_type, scope_id, enabled, rollout_percentage)
  VALUES (v_flag, 'b1.release.flag.' || left(v_flag::text, 8), 'tenant', v_org, FALSE, 0)
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO public.feature_flag_kill_events (
    feature_flag_id, organization_id, event_type, reason,
    prior_enabled, prior_rollout_percentage, acted_by
  ) VALUES (
    v_flag, v_org, 'engaged', 'pgtap setup engaged',
    TRUE, 25, v_ops
  );

  PERFORM set_config('test.b1_rel_ops', v_ops::text, true);
  PERFORM set_config('test.b1_rel_sender', v_sender::text, true);
  PERFORM set_config('test.b1_rel_flag', v_flag::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: restore from prior_* (TRUE/25)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_rel_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.release_kill_switch_v1(jsonb_build_object(
    'feature_flag_id', current_setting('test.b1_rel_flag'),
    'reason', 'pgtap restore'
  ))->>'enabled')::bool),
  'release_kill_switch_v1 restores prior_enabled=true from latest engaged event'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_rel_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.release_kill_switch_v1(jsonb_build_object(
       'feature_flag_id', current_setting('test.b1_rel_flag')
     )) $$,
  '42501',
  NULL,
  'non-ops user denied release_kill_switch_v1'
);
RESET ROLE;

-- 3) Audit ledger appended (event_type='released')
SET LOCAL ROLE postgres;
SELECT ok(
  (SELECT COUNT(*) FROM public.feature_flag_kill_events
    WHERE feature_flag_id = current_setting('test.b1_rel_flag')::uuid
      AND event_type = 'released') >= 1,
  'release_kill_switch_v1 appends released event in kill_events ledger'
);
RESET ROLE;

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.feature_flags', 'update'),
  'authenticated has no direct UPDATE on feature_flags'
);

SELECT * FROM finish();
ROLLBACK;
