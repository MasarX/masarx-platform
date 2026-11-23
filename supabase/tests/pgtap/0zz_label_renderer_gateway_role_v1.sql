BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT ok(EXISTS (
  SELECT FROM pg_roles r WHERE r.rolname = 'edge_renderer_gateway_role'
    AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid)
    AND NOT pg_has_role('authenticator', r.oid, 'MEMBER')
), 'the gateway role cannot log in, inherit, or be assumed by the Data API');

SELECT ok(NOT EXISTS (
  SELECT FROM pg_namespace n WHERE n.nspname IN ('public', 'api')
    AND has_schema_privilege('edge_renderer_gateway_role', n.oid, 'USAGE, CREATE')
), 'the gateway role has no application schema privileges');

SELECT ok(NOT EXISTS (
  SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname IN ('public', 'api') AND acl.grantee = 'edge_renderer_gateway_role'::regrole
), 'the gateway role has no direct public or api relation grants');

SELECT ok(NOT EXISTS (
  SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname IN ('public', 'api') AND acl.grantee = 'edge_renderer_gateway_role'::regrole
), 'the gateway role has no direct public or api column grants');

SELECT ok(NOT EXISTS (
  SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN pg_roles r
  WHERE n.nspname IN ('public', 'api')
    AND r.rolname = 'edge_renderer_gateway_role'
    AND ((has_schema_privilege(r.oid, n.oid, 'USAGE') AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
      OR EXISTS (SELECT FROM aclexplode(p.proacl) a WHERE a.grantee = r.oid AND a.privilege_type = 'EXECUTE'))
), 'the gateway role has no public or api routine grants or callable routines');

SELECT * FROM finish();
ROLLBACK;
