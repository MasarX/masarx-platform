BEGIN;
SET LOCAL search_path TO pg_catalog, public, extensions, pgtap, pg_temp;

SELECT plan(7);

CREATE TEMP VIEW public_execute_functions AS
SELECT p.oid AS function_oid
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'api')
  AND p.prokind <> 'p'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend AS d
    WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid
      AND d.objsubid = 0
      AND d.refclassid = 'pg_extension'::regclass
      AND d.deptype = 'e'
  )
  AND EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  );

SELECT is(
  (SELECT count(*) FROM pg_temp.public_execute_functions),
  0::bigint,
  'Application functions in public and api have no PUBLIC EXECUTE grant'
);

CREATE FUNCTION public.public_execute_guard_fixture_v1()
RETURNS integer LANGUAGE sql AS 'SELECT 1';

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_temp.public_execute_functions
    WHERE function_oid = 'public.public_execute_guard_fixture_v1()'::regprocedure
  ),
  'PUBLIC EXECUTE guard detects the default grant on an invoker function'
);

REVOKE EXECUTE ON FUNCTION public.public_execute_guard_fixture_v1() FROM PUBLIC;

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_temp.public_execute_functions
    WHERE function_oid = 'public.public_execute_guard_fixture_v1()'::regprocedure
  ),
  'PUBLIC EXECUTE guard accepts the same function after exact-signature revocation'
);

-- Read the applied statement so the regression checks the migration's exact overloads.
CREATE TEMP VIEW public_execute_closure_targets AS
SELECT signature, to_regprocedure(signature)::oid AS function_oid
FROM supabase_migrations.schema_migrations AS migration
CROSS JOIN LATERAL unnest(migration.statements) AS recorded(statement)
CROSS JOIN LATERAL regexp_matches(
  recorded.statement,
  '(?s)REVOKE EXECUTE ON FUNCTION[[:space:]]+(.*?)[[:space:]]+FROM PUBLIC[[:space:]]*;?[[:space:]]*$'
) AS parsed(parts)
CROSS JOIN LATERAL regexp_split_to_table(parsed.parts[1], ',[[:blank:]]*[\r\n]+[[:space:]]*') AS target(signature)
WHERE migration.name = 'revoke_public_function_execute';

SELECT is(
  (SELECT count(DISTINCT function_oid) FROM pg_temp.public_execute_closure_targets),
  454::bigint,
  'The PUBLIC EXECUTE closure targets resolve to the full replayed signature inventory'
);

-- The UI executor test separately requires all retained executor grants to match its privilege plan.
-- The loss allowlist covers database roles that had broader access through PUBLIC than their role contracts require.
CREATE TEMP VIEW public_execute_preservation_roles AS
  WITH allowed_loss_roles (role_name) AS (
    VALUES
      ('authenticator'),
      ('dashboard_user'),
      ('edge_api_caller_role'),
      ('edge_api_gateway_role'),
      ('edge_label_renderer_role'),
      ('edge_marketing_role'),
      ('edge_renderer_gateway_role'),
      ('edge_webhook_role'),
      ('geocoding_manual_role'),
      ('geocoding_worker_role'),
      ('label_renderer_role'),
      ('pg_checkpoint'),
      ('pg_create_subscription'),
      ('pg_database_owner'),
      ('pg_execute_server_program'),
      ('pg_maintain'),
      ('pg_monitor'),
      ('pg_read_all_data'),
      ('pg_read_all_settings'),
      ('pg_read_all_stats'),
      ('pg_read_server_files'),
      ('pg_signal_backend'),
      ('pg_stat_scan_tables'),
      ('pg_use_reserved_connections'),
      ('pg_write_all_data'),
      ('pg_write_server_files'),
      ('pgbouncer'),
      ('supabase_auth_admin'),
      ('supabase_etl_admin'),
      ('supabase_functions_admin'),
      ('supabase_read_only_user'),
      ('supabase_realtime_admin'),
      ('supabase_replication_admin'),
      ('supabase_storage_admin'),
      ('ui_rpc_executor')
  ), later_created_roles (role_name) AS (
    SELECT (parse_ident(parsed.parts[1]))[1]::name
    FROM supabase_migrations.schema_migrations AS migration
    CROSS JOIN LATERAL unnest(migration.statements) AS recorded(statement)
    CROSS JOIN LATERAL regexp_matches(
      recorded.statement,
      '\mCREATE[[:space:]]+ROLE[[:space:]]+("(?:[^"]|"")+"|[[:alpha:]_][[:alnum:]_$]*)',
      'gi'
    ) AS parsed(parts)
    WHERE migration.version > (
      SELECT version
      FROM supabase_migrations.schema_migrations
      WHERE name = 'revoke_public_function_execute'
    )
  )
  SELECT r.oid, r.rolname
  FROM pg_roles AS r
  WHERE NOT EXISTS (
    SELECT 1 FROM allowed_loss_roles AS allowed WHERE allowed.role_name = r.rolname::text
  )
    AND NOT EXISTS (
      SELECT 1 FROM later_created_roles AS later WHERE later.role_name = r.rolname
    );

DO $fixture$
DECLARE
  role_name text := 'pgtap_045b_later_' || replace(gen_random_uuid()::text, '-', '');
  role_statement text := format('DO $role$ BEGIN CREATE ROLE %I NOLOGIN; END; $role$;', role_name);
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
  SELECT (max(version)::bigint + 1)::text, role_name, ARRAY[role_statement]
  FROM supabase_migrations.schema_migrations;

  EXECUTE role_statement;
  PERFORM set_config('pgtap.public_execute_later_role', role_name, true);
END;
$fixture$;

SELECT is_empty(
  $$
  SELECT r.rolname, target.signature
  FROM pg_temp.public_execute_preservation_roles AS r
  CROSS JOIN pg_temp.public_execute_closure_targets AS target
  WHERE NOT has_function_privilege(r.oid, target.function_oid, 'EXECUTE')
  ORDER BY r.rolname, target.signature
  $$,
  'Effective EXECUTE on the closure targets is preserved for roles in scope at the closure'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_roles AS r
    WHERE r.rolname = current_setting('pgtap.public_execute_later_role')::name
      AND NOT EXISTS (
        SELECT 1 FROM pg_temp.public_execute_preservation_roles AS checked WHERE checked.oid = r.oid
      )
  ),
  'The preservation check excludes a role created in a later migration'
);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_temp.public_execute_preservation_roles WHERE rolname = 'anon'),
  'The preservation check includes anon, a role that existed at the closure and is outside the loss allowlist'
);

SELECT finish();
ROLLBACK;
