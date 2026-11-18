-- pgTAP: public.client_suspend_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b60e';
  v_ops UUID := '00000000-0000-0000-0000-00000000b6e1';
  v_sender UUID := '00000000-0000-0000-0000-00000000b6e2';
  v_client UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Cli Suspend Org', 'b6-cli-sus-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-cli-sus-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Cli Sus Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-cli-sus-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 Cli Sus Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B6 Cli Sus Client', 'b6-cli-sus-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_cli_sus_org', v_org::text, true);
  PERFORM set_config('test.b6_cli_sus_ops', v_ops::text, true);
  PERFORM set_config('test.b6_cli_sus_sender', v_sender::text, true);
  PERFORM set_config('test.b6_cli_sus_client', v_client::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_sus_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.client_suspend_v1(jsonb_build_object(
      'client_id', current_setting('test.b6_cli_sus_client'),
      'reason', 'pgtap-suspend'
    ))->>'ok')::bool
  ),
  'ops_admin can client_suspend_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_sus_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.client_suspend_v1(jsonb_build_object(
       'client_id', current_setting('test.b6_cli_sus_client')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied client_suspend_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'clients.suspend'
       AND resource_id = current_setting('test.b6_cli_sus_client')::uuid
  ),
  'client_suspend_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.clients'::regclass),
  'clients has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
