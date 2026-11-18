-- pgTAP: public.client_reactivate_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b60f';
  v_ops UUID := '00000000-0000-0000-0000-00000000b6f1';
  v_sender UUID := '00000000-0000-0000-0000-00000000b6f2';
  v_client UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Cli React Org', 'b6-cli-rea-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-cli-rea-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Cli Rea Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-cli-rea-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 Cli Rea Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status, suspension_reason)
  VALUES (v_client, v_org, 'B6 Cli Rea Client', 'b6-cli-rea-' || left(v_client::text, 8), 'suspended', 'previously suspended')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_cli_rea_org', v_org::text, true);
  PERFORM set_config('test.b6_cli_rea_ops', v_ops::text, true);
  PERFORM set_config('test.b6_cli_rea_sender', v_sender::text, true);
  PERFORM set_config('test.b6_cli_rea_client', v_client::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_rea_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.client_reactivate_v1(jsonb_build_object(
      'client_id', current_setting('test.b6_cli_rea_client')
    ))->>'ok')::bool
  ),
  'ops_admin can client_reactivate_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_rea_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.client_reactivate_v1(jsonb_build_object(
       'client_id', current_setting('test.b6_cli_rea_client')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied client_reactivate_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'clients.reactivate'
       AND resource_id = current_setting('test.b6_cli_rea_client')::uuid
  ),
  'client_reactivate_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.clients'::regclass),
  'clients has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
