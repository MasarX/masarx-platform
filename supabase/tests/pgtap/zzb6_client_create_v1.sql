-- pgTAP: public.client_create_v1 contract (allowed/denied/RLS/decision_log)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b701';
  v_ops UUID := '00000000-0000-0000-0000-00000000b711';
  v_sender UUID := '00000000-0000-0000-0000-00000000b712';
  v_uniq TEXT := substr(md5(clock_timestamp()::text), 1, 6);
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Cli Create Org', 'b6-cli-cre-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-cli-cre-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Cli Cre Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-cli-cre-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 Cli Cre Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_cli_cre_org', v_org::text, true);
  PERFORM set_config('test.b6_cli_cre_ops', v_ops::text, true);
  PERFORM set_config('test.b6_cli_cre_sender', v_sender::text, true);
  PERFORM set_config('test.b6_cli_cre_uniq', v_uniq, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin creates a client with required fields
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_cre_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.client_create_v1(jsonb_build_object(
      'name', 'B6 Cre Client ' || current_setting('test.b6_cli_cre_uniq'),
      'slug', 'b6-cre-' || current_setting('test.b6_cli_cre_uniq'),
      'sla_tier', 'standard'
    ))->>'ok')::bool
  ),
  'ops_admin can client_create_v1'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks clients.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_cre_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.client_create_v1(jsonb_build_object(
       'name', 'B6 Denied',
       'slug', 'b6-denied-' || current_setting('test.b6_cli_cre_uniq')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied client_create_v1'
);
RESET ROLE;

-- 3) Decision log audit row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'clients.create'
       AND resource_type = 'client'
       AND organization_id = current_setting('test.b6_cli_cre_org')::uuid
  ),
  'client_create_v1 wrote decision_log row'
);

-- 4) Duplicate slug in the same tenant fails closed before creating another client
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_cli_cre_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.client_create_v1(jsonb_build_object(
       'name', 'B6 Duplicate Client ' || current_setting('test.b6_cli_cre_uniq'),
       'slug', 'b6-cre-' || current_setting('test.b6_cli_cre_uniq'),
       'sla_tier', 'standard'
     )) $$,
  '23505',
  NULL,
  'client_create_v1 rejects duplicate slug in same tenant'
);
RESET ROLE;

-- 5) Duplicate slug attempt does not append another client row
SELECT is(
  (
    SELECT COUNT(*)::integer
      FROM public.clients
     WHERE organization_id = current_setting('test.b6_cli_cre_org')::uuid
       AND slug = 'b6-cre-' || current_setting('test.b6_cli_cre_uniq')
  ),
  1,
  'duplicate client slug attempt leaves one canonical client row'
);

-- 6) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.clients'::regclass),
  'clients has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
