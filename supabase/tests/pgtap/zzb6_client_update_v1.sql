-- pgTAP: public.client_update_v1 contract (allowed/denied/no-op/status-forbidden)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b702';
  v_ops UUID := '00000000-0000-0000-0000-00000000b721';
  v_sender UUID := '00000000-0000-0000-0000-00000000b722';
  v_client UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Cli Update Org', 'b6-cli-upd-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-cli-upd-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Cli Upd Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-cli-upd-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 Cli Upd Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status, sla_tier)
  VALUES (v_client, v_org, 'B6 Upd Client', 'b6-upd-' || left(v_client::text, 8), 'active', 'standard')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_cli_upd_org', v_org::text, true);
  PERFORM set_config('test.b6_cli_upd_ops', v_ops::text, true);
  PERFORM set_config('test.b6_cli_upd_sender', v_sender::text, true);
  PERFORM set_config('test.b6_cli_upd_client', v_client::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin updates editable fields
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.client_update_v1(jsonb_build_object(
      'client_id', current_setting('test.b6_cli_upd_client'),
      'name', 'B6 Upd Client v2',
      'sla_tier', 'premium'
    ))->>'ok')::bool
  ),
  'ops_admin can client_update_v1'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks clients.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_upd_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.client_update_v1(jsonb_build_object(
       'client_id', current_setting('test.b6_cli_upd_client'),
       'name', 'denied'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied client_update_v1'
);
RESET ROLE;

-- 3) Status edit explicitly forbidden (lifecycle SSOT owned by suspend/reactivate)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.client_update_v1(jsonb_build_object(
       'client_id', current_setting('test.b6_cli_upd_client'),
       'status', 'suspended'
     )) $$,
  '42P01',
  NULL,
  'client_update_v1 forbids status mutation (use suspend/reactivate)'
);
RESET ROLE;

-- 4) No-op idempotence: empty patch returns idempotent_no_op=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.client_update_v1(jsonb_build_object(
      'client_id', current_setting('test.b6_cli_upd_client')
    ))->>'idempotent_no_op')::bool
  ),
  'client_update_v1 no-op flagged idempotent_no_op=true'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
