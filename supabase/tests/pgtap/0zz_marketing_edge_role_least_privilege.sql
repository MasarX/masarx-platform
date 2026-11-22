BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

WITH target AS (
  SELECT *, shobj_description(oid, 'pg_authid')::jsonb AS marker
  FROM pg_roles WHERE rolname = 'edge_marketing_role'
)
SELECT ok(NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
  AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls,
  'marketing role cannot log in or exercise privileged role attributes')
FROM target;

WITH target AS (
  SELECT oid, shobj_description(oid, 'pg_authid')::jsonb AS marker
  FROM pg_roles WHERE rolname = 'edge_marketing_role'
)
SELECT ok(
  marker = jsonb_build_object('contract', 'masarx.edge_marketing_role.v1',
    'custodian', custodian.rolname,
    'custody', CASE WHEN custodian.rolsuper THEN 'superuser' ELSE 'createrole' END)
  AND ((custodian.rolsuper AND NOT EXISTS (
    SELECT FROM pg_auth_members m WHERE m.roleid = target.oid AND m.member = custodian.oid
  )) OR (NOT custodian.rolsuper AND custodian.rolcreaterole AND EXISTS (
    SELECT FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.grantor
    WHERE m.roleid = target.oid AND m.member = custodian.oid
      AND g.rolsuper AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
  )))
  AND (SELECT count(*) FROM pg_auth_members WHERE roleid = target.oid)
    = CASE WHEN custodian.rolsuper THEN 1 ELSE 2 END,
  'marketing role has exact creator custody'
)
FROM target JOIN pg_roles custodian ON custodian.rolname = target.marker->>'custodian';

SELECT ok(EXISTS (
  SELECT FROM pg_auth_members m
  JOIN pg_roles target ON target.oid = m.roleid
  JOIN pg_roles grantor ON grantor.oid = m.grantor
  WHERE target.rolname = 'edge_marketing_role' AND m.member = 'authenticator'::regrole
    AND grantor.rolname = shobj_description(target.oid, 'pg_authid')::jsonb->>'custodian'
    AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option
), 'authenticator has SET-only access granted by the custodian');

SELECT ok(NOT pg_has_role('edge_marketing_role', 'service_role', 'MEMBER')
  AND NOT pg_has_role('edge_marketing_role', 'authenticated', 'MEMBER')
  AND NOT pg_has_role('service_role', 'edge_marketing_role', 'MEMBER'),
  'marketing and service roles have no membership in each other and marketing cannot assume authenticated');

SELECT is_empty($$
  SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (has_table_privilege('edge_marketing_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         OR has_any_column_privilege('edge_marketing_role', c.oid, 'SELECT,INSERT,UPDATE'))
$$, 'marketing role has no effective direct data privileges in public');

GRANT edge_marketing_role TO current_user WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE edge_marketing_role;
SELECT set_config('request.jwt.claims', '{"role":"edge_marketing_role"}', true);

DO $$
DECLARE
  lead jsonb;
  probe text;
  refused int := 0;
BEGIN
  lead := api.marketing_lead_request_create_v1(
    'b28-lead@example.test', 'Marketing role fixture', p_turnstile_verified => true
  );
  PERFORM set_config('test.marketing_b28_lead', lead::text, true);
  PERFORM api.marketing_landing_clients_list_v1('en');

  FOREACH probe IN ARRAY ARRAY[
    'SELECT id FROM public.marketing_demo_requests',
    'INSERT INTO public.marketing_demo_requests DEFAULT VALUES',
    'UPDATE public.marketing_demo_requests SET id = id WHERE false',
    'DELETE FROM public.marketing_demo_requests WHERE false',
    'SELECT id FROM public.clients',
    'INSERT INTO public.clients DEFAULT VALUES',
    'UPDATE public.clients SET id = id WHERE false',
    'DELETE FROM public.clients WHERE false',
    'SELECT id FROM public.tasks',
    'INSERT INTO public.tasks DEFAULT VALUES',
    'UPDATE public.tasks SET id = id WHERE false',
    'DELETE FROM public.tasks WHERE false',
    'SELECT api.tenant_signup_policy_v1()',
    'SELECT public.create_task_system_v1(''{}''::jsonb)'
  ] LOOP
    BEGIN
      EXECUTE probe;
    EXCEPTION WHEN insufficient_privilege THEN
      refused := refused + 1;
    END;
  END LOOP;
  PERFORM set_config('test.marketing_b28_refused', refused::text, true);
END;
$$;
RESET ROLE;

SELECT ok((current_setting('test.marketing_b28_lead')::jsonb->>'ok')::boolean
  AND current_setting('test.marketing_b28_lead')::jsonb->>'task_id' IS NOT NULL,
  'marketing role can submit a lead and create its follow-up');
SELECT ok(EXISTS (
  SELECT FROM public.marketing_demo_requests
  WHERE id = (current_setting('test.marketing_b28_lead')::jsonb->>'id')::uuid
    AND email = 'b28-lead@example.test'
), 'the marketing RPC inserted the expected intake row');
SELECT is(current_setting('test.marketing_b28_refused')::int, 14,
  'direct SELECT, INSERT, UPDATE, DELETE and unrelated RPCs fail with SQLSTATE 42501');
SELECT is(current_setting('request.jwt.claims')::jsonb->>'role', 'edge_marketing_role',
  'the follow-up dispatch restores the request role claim');

SELECT finish();
ROLLBACK;
