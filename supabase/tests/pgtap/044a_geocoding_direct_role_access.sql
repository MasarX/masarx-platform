BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(144);

CREATE TEMP TABLE geocoding_direct_roles (role_name text) ON COMMIT DROP;
INSERT INTO geocoding_direct_roles VALUES ('geocoding_manual_role'), ('geocoding_worker_role');

CREATE TEMP TABLE geocoding_role_fixture ON COMMIT DROP AS
SELECT org_number, gen_random_uuid() AS org_id, gen_random_uuid() AS client_id,
       gen_random_uuid() AS address_id, gen_random_uuid() AS user_id, gen_random_uuid() AS row_id
FROM generate_series(1, 2) AS orgs(org_number);

SET LOCAL app.organization_onboarding_source = 'provision_demo_accounts_v1';
INSERT INTO public.organizations (id, name, slug, billing_status)
SELECT org_id, 'Geocoding policy fixture', 'geocoding-policy-' || org_id, 'active'
FROM geocoding_role_fixture;
SET LOCAL app.organization_onboarding_source = '';

INSERT INTO public.clients (id, organization_id, name, slug, status)
SELECT client_id, org_id, 'Geocoding policy fixture', 'geocoding-policy-' || client_id, 'active'
FROM geocoding_role_fixture;

INSERT INTO public.addresses (id, organization_id, client_id, raw_input, city, province, validation_status)
SELECT address_id, org_id, client_id, 'Geocoding policy fixture', 'Riyadh', 'Riyadh', 'pending'
FROM geocoding_role_fixture;

INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT user_id, org_id, user_id || '@example.test', 'Geocoding policy fixture', 'ops_admin', 'active', 'tenant'
FROM geocoding_role_fixture WHERE org_number = 1;

CREATE TEMP TABLE geocoding_role_statements ON COMMIT DROP AS
SELECT org_number, relation_name, operation, statement
FROM geocoding_role_fixture
CROSS JOIN LATERAL (VALUES
  ('geocodes',
    'INSERT INTO public.geocodes (id, organization_id, client_id, address_id, provider_name, coordinates)
     VALUES (%L, %L, %L, %L, ''manual'', ''SRID=4326;POINT(46.7 24.7)'')'),
  ('geocoding_attempts',
    'INSERT INTO public.geocoding_attempts
       (id, organization_id, client_id, address_id, provider_name, attempt_order, attempt_type, status)
     VALUES (%L, %L, %L, %L, ''here_geocoding'', 1, ''primary'', ''queued'')'),
  ('geocoding_alias_audit',
    'INSERT INTO public.geocoding_alias_audit (id, organization_id, client_id, address_id)
     VALUES (%L, %L, %L, %L)')
) AS relations(relation_name, insert_template)
CROSS JOIN LATERAL (VALUES
  ('seed', format(insert_template, row_id, org_id, client_id, address_id)),
  ('insert', format(insert_template, gen_random_uuid(), org_id, client_id, address_id)),
  ('select', format('SELECT id FROM public.%I WHERE id = %L AND organization_id = %L',
    relation_name, row_id, org_id)),
  ('update', format('UPDATE public.%I SET metadata = %L WHERE id = %L AND organization_id = %L',
    relation_name, '{"checked":true}', row_id, org_id)),
  ('delete', format('DELETE FROM public.%I WHERE id = %L AND organization_id = %L',
    relation_name, row_id, org_id))
) AS operations(operation, statement);

-- Execute the statement under the caller while keeping pgTAP under the test runner's role.
CREATE FUNCTION pg_temp.geocoding_role_probe(role_name text, statement text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  prior_role name := current_user;
  affected_rows bigint;
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', role_name);
  EXECUTE statement;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  EXECUTE format('SET LOCAL ROLE %I', prior_role);
  RETURN affected_rows::text;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END;
$$;

SELECT ok(NOT pg_roles.rolcanlogin, role_name || ' requires role activation')
FROM geocoding_direct_roles JOIN pg_roles ON rolname::text = role_name;

SELECT is(pg_temp.geocoding_role_probe(role_name, format('SELECT 1 WHERE current_user::text = %L', role_name)),
          '1', role_name || ' is the effective role during the probe')
FROM geocoding_direct_roles;

SELECT ok(NOT has_schema_privilege(role_name, 'public', 'USAGE'), role_name || ' lacks public schema USAGE')
FROM geocoding_direct_roles;

SELECT ok(NOT has_function_privilege(role_name, 'public.current_user_org_id()', 'EXECUTE'),
          role_name || ' lacks organization helper EXECUTE after the PUBLIC revoke')
FROM geocoding_direct_roles;

SELECT ok(
  has_table_privilege(role_name, relation, 'SELECT') AND
  has_table_privilege(role_name, relation, 'INSERT') = (role_name = 'geocoding_worker_role') AND
  has_table_privilege(role_name, relation, 'UPDATE') = (role_name = 'geocoding_worker_role') AND
  NOT has_table_privilege(role_name, relation, 'DELETE'),
  format('%s retains its table ACL on %s', role_name, relation))
FROM geocoding_direct_roles
CROSS JOIN (VALUES ('public.geocodes'), ('public.geocoding_attempts'), ('public.geocoding_alias_audit')) AS tables(relation);

SELECT ok(pg_has_role('service_role', 'geocoding_worker_role', 'MEMBER'), 'service_role retains worker membership');
SET LOCAL request.jwt.claim.sub = '';
SET LOCAL request.jwt.claim.role = 'service_role';
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

SELECT is(pg_temp.geocoding_role_probe('service_role', 'SELECT public.current_user_org_id()'),
          '1', 'service_role can execute the organization helper');

SELECT is(pg_temp.geocoding_role_probe('service_role', statement), '1',
          format('service_role inserts into %s for organization %s', relation_name, org_number))
FROM geocoding_role_statements WHERE operation = 'seed';

SELECT is(pg_temp.geocoding_role_probe('service_role', statement), '1',
          format('service_role can %s %s for organization %s', operation, relation_name, org_number))
FROM geocoding_role_statements WHERE operation IN ('select', 'update');

SET LOCAL request.jwt.claim.role = 'authenticated';
SELECT set_config('request.jwt.claim.sub', user_id::text, true),
       set_config('request.jwt.claims', jsonb_build_object('sub', user_id, 'role', 'authenticated')::text, true)
FROM geocoding_role_fixture WHERE org_number = 1;

SELECT is(pg_temp.geocoding_role_probe(role_name, statement), '42501: permission denied for schema public',
          format('current %s cannot %s %s for organization %s', role_name, operation, relation_name, org_number))
FROM geocoding_direct_roles CROSS JOIN geocoding_role_statements
WHERE operation <> 'seed';

SELECT is(pg_temp.geocoding_role_probe('authenticated', statement),
          CASE org_number WHEN 1 THEN '1' ELSE '0' END,
          format('authenticated sees only its organization in %s (organization %s)', relation_name, org_number))
FROM geocoding_role_statements WHERE operation = 'select';

-- Reproduce only the helper ACL from before #397 without reopening PUBLIC or the schema.
GRANT EXECUTE ON FUNCTION public.current_user_org_id() TO geocoding_manual_role, geocoding_worker_role;

SELECT ok(has_function_privilege(role_name, 'public.current_user_org_id()', 'EXECUTE'),
          role_name || ' has organization helper EXECUTE in the comparison fixture')
FROM geocoding_direct_roles;

SELECT is(pg_temp.geocoding_role_probe(role_name, statement), '42501: permission denied for schema public',
          format('helper EXECUTE alone leaves %s denied %s on %s for organization %s',
                 role_name, operation, relation_name, org_number))
FROM geocoding_direct_roles CROSS JOIN geocoding_role_statements
WHERE operation <> 'seed';

REVOKE EXECUTE ON FUNCTION public.current_user_org_id() FROM geocoding_manual_role, geocoding_worker_role;

SET LOCAL request.jwt.claim.sub = '';
SET LOCAL request.jwt.claim.role = 'service_role';
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

SELECT is(pg_temp.geocoding_role_probe('service_role', statement), '1',
          format('service_role can delete from %s for organization %s', relation_name, org_number))
FROM geocoding_role_statements WHERE operation = 'delete';

SELECT * FROM finish();
ROLLBACK;
