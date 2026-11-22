-- Catalog-only ACL and custody checks. Hosted function tests cover intake execution.
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
  SELECT roleid::regrole
  FROM pg_auth_members
  WHERE member = 'edge_marketing_role'::regrole
$$, 'marketing role is not a member of any role');

SELECT is_empty($$
  WITH application_relations AS MATERIALIZED (
    SELECT c.oid, n.nspname, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'api') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT EXISTS (
        SELECT FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  )
  SELECT nspname, relname, NULL::name AS column_name, privilege
  FROM application_relations
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)
  WHERE has_table_privilege('edge_marketing_role', oid, privilege)
    AND NOT has_table_privilege('public', oid, privilege)
  UNION ALL
  SELECT r.nspname, r.relname, a.attname, privilege
  FROM application_relations r JOIN pg_attribute a ON a.attrelid = r.oid
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p(privilege)
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('edge_marketing_role', r.oid, a.attnum, privilege)
    AND NOT has_column_privilege('public', r.oid, a.attnum, privilege)
$$, 'marketing role has no application table or column privileges beyond PUBLIC');

SELECT ok(bool_and(has_function_privilege('edge_marketing_role', signature, 'EXECUTE')),
  'marketing role can execute all four intake functions')
FROM (VALUES
  ('api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'),
  ('public.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'),
  ('api.marketing_landing_clients_list_v1(text)'),
  ('public.marketing_landing_clients_list_v1(text)')
) AS intake(signature);

SELECT is_empty($$
  SELECT p.oid::regprocedure
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'api')
    AND p.oid NOT IN (
      'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'::regprocedure,
      'public.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'::regprocedure,
      'api.marketing_landing_clients_list_v1(text)'::regprocedure,
      'public.marketing_landing_clients_list_v1(text)'::regprocedure
    )
    AND NOT EXISTS (
      SELECT FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    )
    AND has_function_privilege('edge_marketing_role', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
$$, 'marketing role has no other application function execution privileges beyond PUBLIC');

SELECT results_eq($$
  WITH direct_grants AS (
    SELECT 'relation' AS kind, c.oid AS object_id, a.*
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    UNION ALL
    SELECT 'column', c.attrelid, a.*
    FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
    UNION ALL
    SELECT 'routine', p.oid, a.*
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    UNION ALL
    SELECT 'schema', n.oid, a.*
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
  )
  SELECT kind, object_id, privilege_type, is_grantable
  FROM direct_grants
  WHERE grantee = 'edge_marketing_role'::regrole
  ORDER BY 1, 2, 3, 4
$$, $$
  SELECT * FROM (VALUES
    ('schema', 'api'::regnamespace::oid, 'USAGE', false),
    ('schema', 'public'::regnamespace::oid, 'USAGE', false),
    ('routine', 'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'::regprocedure::oid, 'EXECUTE', false),
    ('routine', 'public.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'::regprocedure::oid, 'EXECUTE', false),
    ('routine', 'api.marketing_landing_clients_list_v1(text)'::regprocedure::oid, 'EXECUTE', false),
    ('routine', 'public.marketing_landing_clients_list_v1(text)'::regprocedure::oid, 'EXECUTE', false)
  ) AS expected(kind, object_id, privilege_type, is_grantable)
  ORDER BY 1, 2, 3, 4
$$, 'marketing role has exactly two direct schema grants and four direct function grants');

SELECT finish();
ROLLBACK;
