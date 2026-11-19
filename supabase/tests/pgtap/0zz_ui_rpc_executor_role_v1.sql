-- Rollback-only executor/RLS contracts. Run on a disposable off-PC database.
BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT no_plan();

SELECT ok(EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ui_rpc_executor'
  AND NOT rolcanlogin AND NOT rolbypassrls AND NOT rolsuper AND NOT rolinherit
  AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication), 'executor cannot log in or bypass RLS');
SELECT is((SELECT count(*) FROM pg_class WHERE relowner='ui_rpc_executor'::regrole),0::bigint,
  'executor owns no relation, including views and partitions');
SELECT is((SELECT count(*) FROM pg_auth_members m WHERE member='ui_rpc_executor'::regrole
  OR (roleid='ui_rpc_executor'::regrole AND (
    COALESCE((to_jsonb(m)->>'inherit_option')::boolean,TRUE)
    OR COALESCE((to_jsonb(m)->>'set_option')::boolean,TRUE)))),0::bigint,
  'executor has no inherited roles or inheriting/SET members; ADMIN-only creator is allowed');
SELECT is((SELECT count(*) FROM pg_proc WHERE proowner='ui_rpc_executor'::regrole
  AND prosecdef AND pronamespace='public'::regnamespace AND proname=ANY(ARRAY[
    'ui_get_resource_v1','ui_list_resource_v1','ui_update_resource_v1','ui_delete_resource_v1',
    'ui_filter_distinct_values_v1','ui_resource_metrics_v1'])),6::bigint,'all six RPCs use the non-bypassing definer owner');
SELECT is((SELECT count(*) FROM pg_proc WHERE proowner='ui_rpc_executor'::regrole),6::bigint,
  'executor owns exactly the six entrypoints and no metadata helper');
SELECT ok(NOT has_schema_privilege('ui_rpc_executor','public','CREATE'),
  'temporary schema CREATE is absent, including inherited PUBLIC privileges');
SELECT ok(EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='public.route_stop_reassignment_events'::regclass
  AND p.polname='ui_rpc_executor_scoped_read' AND p.polcmd='r'
  AND p.polroles=ARRAY['ui_rpc_executor'::regrole::oid] AND p.polwithcheck IS NULL),
  'route reassignment executor policy permits scoped SELECT only');
SELECT ok((SELECT NOT prosecdef AND proowner<>'ui_rpc_executor'::regrole FROM pg_proc
  WHERE oid='public.route_stop_reassignment_event_read_scope_v1(uuid)'::regprocedure)
  AND NOT has_function_privilege('authenticated','public.route_stop_reassignment_event_read_scope_v1(uuid)','EXECUTE'),
  'route reassignment predicate has no definer bypass or browser execute grant');
SELECT ok(NOT has_schema_privilege('ui_rpc_executor','auth','USAGE,CREATE')
  AND (SELECT prosecdef AND proowner<>'ui_rpc_executor'::regrole FROM pg_proc
    WHERE oid='public.ui_rpc_request_is_service_v1()'::regprocedure),
  'executor reads service claims through the narrow definer without auth schema access');
SELECT ok((SELECT pronargs=0
  AND pg_get_userbyid(proowner)='postgres'
  AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
  AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) a
    WHERE a.grantee=0 OR a.grantee IN ('anon'::regrole,'authenticated'::regrole,'service_role'::regrole))
  AND has_function_privilege('ui_rpc_executor','public.ui_rpc_current_user_id_v1()','EXECUTE')
  FROM pg_proc WHERE oid='public.ui_rpc_current_user_id_v1()'::regprocedure),
  'current-user reader is zero-argument, postgres-owned, fixed-path and executor-only');
SELECT ok((SELECT ARRAY(
    SELECT pg_get_userbyid(role_oid)::text FROM (
      SELECT proowner AS role_oid
      UNION
      SELECT a.grantee FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) a
       WHERE a.privilege_type='EXECUTE'
    ) roles ORDER BY 1
  ) = ARRAY['postgres','ui_rpc_executor']
  FROM pg_proc WHERE oid='public.ui_rpc_current_user_id_v1()'::regprocedure),
  'current-user reader effective ACL is exactly postgres and ui_rpc_executor');
-- Reuse the catalog walk until the fixture starts changing registry inputs.
CREATE TEMP TABLE executor_initial_privilege_plan AS
SELECT * FROM public.ui_rpc_executor_privilege_plan_v1();

SELECT ok(NOT EXISTS (SELECT 1 FROM pg_temp.executor_initial_privilege_plan
    WHERE object_kind='schema' AND object_id='auth'::regnamespace),
  'executor privilege plan has no direct auth schema usage');
SELECT ok((SELECT public.ui_filter_tree_sql_v1(
    '{"key":"owner","value":"$current_user"}'::jsonb,
    '[{"key":"owner","column":"owner_id","op":"eq"}]'::jsonb, TRUE)
    LIKE '%public.ui_rpc_current_user_id_v1()%' ),
  'current-user filter compiles through the executor claim reader');
SELECT ok(bool_and(p.prosecdef AND NOT a.prosecdef
    AND has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND has_function_privilege('service_role',p.oid,'EXECUTE')
    AND has_function_privilege('authenticated',a.oid,'EXECUTE')
    AND NOT has_function_privilege('anon',a.oid,'EXECUTE')
    AND 'row_security=on'=ANY(p.proconfig)),
  'six public signatures/grants and invoker API wrappers retain their exposed contract')
FROM (VALUES ('ui_get_resource_v1(text,uuid)'),('ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'),
  ('ui_update_resource_v1(text,text,jsonb)'),('ui_delete_resource_v1(text,text)'),
  ('ui_filter_distinct_values_v1(text,text,text,integer)'),('ui_resource_metrics_v1(text,jsonb,text[])')) signatures(signature)
JOIN pg_proc p ON p.oid=('public.'||signature)::regprocedure
JOIN pg_proc a ON a.oid=('api.'||signature)::regprocedure;

WITH expected AS (SELECT object_kind,object_id,privilege,column_name FROM pg_temp.executor_initial_privilege_plan),
actual AS (
  SELECT 'relation'::text,c.oid,a.privilege_type,NULL::text FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee='ui_rpc_executor'::regrole
  UNION SELECT 'relation',c.attrelid,a.privilege_type,c.attname::text FROM pg_attribute c
    CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE a.grantee='ui_rpc_executor'::regrole
  UNION SELECT 'function',p.oid,a.privilege_type,NULL FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE a.grantee='ui_rpc_executor'::regrole AND p.proowner<>a.grantee
  UNION SELECT 'schema',n.oid,a.privilege_type,NULL FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee='ui_rpc_executor'::regrole
), difference AS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
  UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected))
SELECT is((SELECT count(*) FROM difference),0::bigint,'explicit ACLs equal the registry/dependency privilege plan exactly');

WITH planned_reads AS MATERIALIZED (
  SELECT object_id FROM pg_temp.executor_initial_privilege_plan
  WHERE object_kind='relation' AND privilege='SELECT'
)
SELECT ok(bool_and(EXISTS(SELECT 1 FROM planned_reads p
    WHERE p.object_id=to_regclass(resource->>'read_relation'))
    AND has_table_privilege('ui_rpc_executor',to_regclass(resource->>'read_relation'),'SELECT')),
  'every canonical read relation has its planned executor SELECT grant')
FROM jsonb_array_elements(public.resolve_settings_merged(
  'ui_read_registry',public.get_root_scope_type_key_v1(),NULL)->'resources') resource
WHERE NULLIF(btrim(resource->>'read_relation'),'') IS NOT NULL;
SELECT ok(NOT has_table_privilege('ui_rpc_executor','api.tasks_controls_v1','UPDATE,DELETE'),
  'task read relation does not acquire generic mutation privileges');

-- Approved platform defaults are an exact outcome, never a schema/owner-wide exemption.
CREATE TEMP VIEW executor_pg_net_exposure AS
WITH targets AS (
    SELECT c.oid,c.relowner,c.relnamespace,c.relkind,c.relacl,n.nspname AS schema_name,
      format('%I.%I',n.nspname,c.relname) AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='net' AND c.relkind IN ('r','p','v','m','f','S'))
      OR c.oid=ANY(ARRAY['cron.job_run_details'::regclass,'net.http_request_queue_id_seq'::regclass])
  ), exposure AS (
    SELECT t.object_name,role_name,pg_get_userbyid(t.relowner) AS owner,p.privileges
    FROM targets t CROSS JOIN unnest(ARRAY['anon','authenticated','ui_rpc_executor']) role_name
    CROSS JOIN LATERAL (SELECT ARRAY(SELECT privilege FROM unnest(
      CASE WHEN t.relkind='S' THEN ARRAY['SELECT','UPDATE','USAGE']
        WHEN t.object_name='cron.job_run_details' THEN ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
        ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] END) privilege
      WHERE CASE WHEN t.relkind='S' THEN has_sequence_privilege(role_name,t.oid,privilege)
        ELSE has_table_privilege(role_name,t.oid,privilege)
          OR CASE WHEN privilege IN ('SELECT','INSERT','UPDATE','REFERENCES')
            THEN has_any_column_privilege(role_name,t.oid,privilege) ELSE FALSE END END
      ORDER BY privilege COLLATE "C") AS privileges) p
    WHERE has_schema_privilege(role_name,t.relnamespace,'USAGE') AND cardinality(p.privileges)>0
  ) SELECT COALESCE(jsonb_agg(to_jsonb(exposure) ORDER BY object_name COLLATE "C",role_name COLLATE "C"),'[]'::jsonb) AS value FROM exposure;
CREATE FUNCTION pg_temp.executor_pg_net_unreviewed_grants() RETURNS boolean LANGUAGE sql STABLE AS $provenance$
WITH targets AS (
    SELECT c.oid,c.relowner,c.relnamespace,c.relkind,c.relacl,n.nspname AS schema_name,
      format('%I.%I',n.nspname,c.relname) AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='net' AND c.relkind IN ('r','p','v','m','f','S'))
      OR c.oid=ANY(ARRAY['cron.job_run_details'::regclass,'net.http_request_queue_id_seq'::regclass])
  ) SELECT EXISTS (
    SELECT 1 FROM targets t CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,
      acldefault(CASE WHEN t.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,t.relowner))) a
      CROSS JOIN unnest(ARRAY['anon','authenticated','ui_rpc_executor']) role_name
    WHERE t.schema_name='net' AND CASE WHEN a.grantee=0 THEN TRUE ELSE pg_has_role(role_name,a.grantee,'USAGE') END
      AND NOT (a.grantee=0 AND pg_get_userbyid(a.grantor)='supabase_admin' AND NOT a.is_grantable
        AND a.privilege_type=ANY(CASE WHEN t.relkind='S' THEN ARRAY['SELECT','UPDATE','USAGE']
          ELSE ARRAY['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'] END))
  ) OR EXISTS (
    SELECT 1 FROM targets t JOIN pg_attribute att ON att.attrelid=t.oid
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      CROSS JOIN unnest(ARRAY['anon','authenticated','ui_rpc_executor']) role_name
    WHERE t.schema_name='net' AND CASE WHEN a.grantee=0 THEN TRUE ELSE pg_has_role(role_name,a.grantee,'USAGE') END
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
      CROSS JOIN unnest(ARRAY['anon','authenticated','ui_rpc_executor']) role_name
    WHERE n.nspname='net' AND CASE WHEN a.grantee=0 THEN TRUE ELSE pg_has_role(role_name,a.grantee,'USAGE') END
      AND NOT (pg_get_userbyid(a.grantor)='supabase_admin' AND a.privilege_type='USAGE' AND NOT a.is_grantable
        AND a.grantee=ANY(ARRAY[0,'anon'::regrole::oid,'authenticated'::regrole::oid]))
  ) OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='ui_rpc_executor'::regrole)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','ui_rpc_executor']) role_name
      WHERE has_schema_privilege(role_name,'net','CREATE'))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole);
$provenance$;
CREATE FUNCTION pg_temp.executor_platform_pg_net_defaults_match() RETURNS boolean LANGUAGE sql STABLE AS $platform$
  SELECT value=$platform_defaults$[{"object_name":"net._http_response","role_name":"anon","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net._http_response","role_name":"authenticated","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net._http_response","role_name":"ui_rpc_executor","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue","role_name":"anon","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue","role_name":"authenticated","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue","role_name":"ui_rpc_executor","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue_id_seq","role_name":"anon","owner":"supabase_admin","privileges":["SELECT","UPDATE","USAGE"]},{"object_name":"net.http_request_queue_id_seq","role_name":"authenticated","owner":"supabase_admin","privileges":["SELECT","UPDATE","USAGE"]},{"object_name":"net.http_request_queue_id_seq","role_name":"ui_rpc_executor","owner":"supabase_admin","privileges":["SELECT","UPDATE","USAGE"]}]$platform_defaults$::jsonb
    AND NOT pg_temp.executor_pg_net_unreviewed_grants()
    AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(value) item(object_name text)
      JOIN pg_class c ON c.oid=to_regclass(item.object_name) WHERE pg_has_role(current_user,c.relowner,'USAGE'))
    AND EXISTS(SELECT 1 FROM public.ops_alerts WHERE alert_type='platform_pg_net_exposure'
      AND details->>'migration'='20261029113000_extension_public_acl_v1'
      AND details->>'classification'='platform_default' AND details->'exposure'=value)
  FROM executor_pg_net_exposure;
$platform$;
SELECT ok((SELECT value='[]'::jsonb OR pg_temp.executor_platform_pg_net_defaults_match() FROM executor_pg_net_exposure),
  'remaining pg_net exposure is empty or exactly the recorded platform object/role/privilege set');
SELECT ok(NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member='ui_rpc_executor'::regrole)
  AND NOT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
    WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole)
  AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole)
  AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole),
  'executor has no direct net grants or membership path created by the application');

-- Share the effective-ACL predicate with rollback-owned negative fixtures below.
CREATE TEMP TABLE executor_extension_acl_fixture(id integer);
CREATE FUNCTION pg_temp.executor_relation_privilege_violation(p_relation oid, p_extension boolean, p_default_select boolean)
RETURNS boolean LANGUAGE sql STABLE AS $guard$
  SELECT has_table_privilege('ui_rpc_executor',p_relation,'TRUNCATE,REFERENCES,TRIGGER')
    OR (has_table_privilege('ui_rpc_executor',p_relation,'INSERT') AND NOT EXISTS(
      SELECT 1 FROM pg_temp.executor_initial_privilege_plan p
      WHERE p.object_kind='relation' AND p.object_id=p_relation AND p.privilege='INSERT'))
    OR (has_table_privilege('ui_rpc_executor',p_relation,'SELECT') AND NOT p_default_select AND NOT EXISTS(
      SELECT 1 FROM pg_temp.executor_initial_privilege_plan p
      WHERE p.object_kind='relation' AND p.object_id=p_relation AND p.privilege='SELECT'))
    OR (p_extension AND (has_table_privilege('ui_rpc_executor',p_relation,'INSERT,UPDATE,MAINTAIN')
      OR has_any_column_privilege('ui_rpc_executor',p_relation,'INSERT,UPDATE,REFERENCES')
      OR (has_table_privilege('ui_rpc_executor',p_relation,'DELETE') AND NOT EXISTS (
        -- Suppress only the provider's non-grantable PUBLIC DELETE, including no overlapping grant.
        SELECT 1 FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) acl
        WHERE c.oid=p_relation AND c.oid='cron.job_run_details'::regclass
          AND c.relowner='supabase_admin'::regrole
          AND acl.grantee=0 AND acl.grantor=c.relowner AND acl.privilege_type='DELETE' AND NOT acl.is_grantable
          AND NOT EXISTS (
            SELECT 1 FROM aclexplode(c.relacl) other
            WHERE other.privilege_type='DELETE'
              AND CASE WHEN other.grantee=0 THEN other.grantor<>c.relowner OR other.is_grantable
                ELSE pg_has_role('ui_rpc_executor',other.grantee,'USAGE') END
          )
      ))));
$guard$;

WITH extension_select_defaults(schema_name,relation_name,extension_name) AS (VALUES
  -- PostGIS exposes reference-system and geometry catalog reads to all roles.
  ('public','spatial_ref_sys','postgis'),
  ('public','geography_columns','postgis'),
  ('public','geometry_columns','postgis'),
  -- Supabase installs these diagnostic catalogs with PUBLIC SELECT; their schemas stay private.
  ('cron','job','pg_cron'),
  ('cron','job_run_details','pg_cron'),
  ('extensions','pg_stat_statements','pg_stat_statements'),
  ('extensions','pg_stat_statements_info','pg_stat_statements'),
  ('extensions','pg_all_foreign_keys','pgtap'),
  ('extensions','tap_funky','pgtap')
), violations AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'
      AND d.refclassid='pg_extension'::regclass
    LEFT JOIN pg_extension e ON e.oid=d.refobjid
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
    AND n.nspname !~ '^pg_temp_' AND c.relkind IN ('r','p','v','m','f')
    AND NOT ((SELECT pg_temp.executor_platform_pg_net_defaults_match())
      AND n.nspname='net' AND c.relname IN ('_http_response','http_request_queue'))
    AND pg_temp.executor_relation_privilege_violation(c.oid,e.oid IS NOT NULL,EXISTS(
      SELECT 1 FROM extension_select_defaults allowed WHERE allowed.schema_name=n.nspname
        AND allowed.relation_name=c.relname AND allowed.extension_name=e.extname))
)
SELECT is((SELECT count(*) FROM violations),0::bigint,
  'effective application and extension privileges contain no extra reads or dangerous writes');

SELECT is((SELECT count(*) FROM pg_class c WHERE c.relkind='S'
  AND NOT ((SELECT pg_temp.executor_platform_pg_net_defaults_match()) AND c.oid='net.http_request_queue_id_seq'::regclass)
  AND (EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
      AND d.objid=c.oid AND d.deptype='e' AND d.refclassid='pg_extension'::regclass)
    OR EXISTS(SELECT 1 FROM pg_depend sequence_dep JOIN pg_depend extension_dep
      ON extension_dep.classid='pg_class'::regclass AND extension_dep.objid=sequence_dep.refobjid
        AND extension_dep.deptype='e' AND extension_dep.refclassid='pg_extension'::regclass
      WHERE sequence_dep.classid='pg_class'::regclass AND sequence_dep.objid=c.oid
        AND sequence_dep.refclassid='pg_class'::regclass AND sequence_dep.deptype IN ('a','i')))
  AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('ui_rpc_executor',c.oid,'USAGE,UPDATE') ELSE FALSE END),0::bigint,
  'extension sequences expose no effective executor nextval or setval privileges');

-- Real ACL changes on an owned relation exercise the same predicate with reviewed extension SELECT context.
GRANT SELECT ON executor_extension_acl_fixture TO PUBLIC;
SELECT ok(NOT pg_temp.executor_relation_privilege_violation('executor_extension_acl_fixture'::regclass,TRUE,TRUE),
  'reviewed extension default exempts SELECT alone');
SELECT ok(pg_temp.executor_relation_privilege_violation('executor_extension_acl_fixture'::regclass,TRUE,FALSE),
  'unreviewed extension SELECT remains an unexpected read');
CREATE FUNCTION pg_temp.check_extension_write_regressions() RETURNS SETOF text LANGUAGE plpgsql AS $regressions$
DECLARE v_role text; v_privilege text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['PUBLIC','ui_rpc_executor'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
      EXECUTE format('GRANT %s ON executor_extension_acl_fixture TO %s',v_privilege,v_role);
      RETURN NEXT ok(pg_temp.executor_relation_privilege_violation('executor_extension_acl_fixture'::regclass,TRUE,TRUE),
        v_role || ' extension ' || v_privilege || ' is detected despite reviewed SELECT');
      EXECUTE format('REVOKE %s ON executor_extension_acl_fixture FROM %s',v_privilege,v_role);
    END LOOP;
    FOREACH v_privilege IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
      EXECUTE format('GRANT %s (id) ON executor_extension_acl_fixture TO %s',v_privilege,v_role);
      RETURN NEXT ok(pg_temp.executor_relation_privilege_violation('executor_extension_acl_fixture'::regclass,TRUE,TRUE),
        v_role || ' extension column ' || v_privilege || ' is detected despite reviewed SELECT');
      EXECUTE format('REVOKE %s (id) ON executor_extension_acl_fixture FROM %s',v_privilege,v_role);
    END LOOP;
  END LOOP;
END;
$regressions$;
SELECT * FROM pg_temp.check_extension_write_regressions();
CREATE TEMP SEQUENCE executor_extension_acl_sequence;
SELECT ok(NOT has_sequence_privilege('ui_rpc_executor','executor_extension_acl_sequence','USAGE,UPDATE'),
  'owned sequence fixture starts without executor write privileges');
CREATE FUNCTION pg_temp.check_extension_sequence_regressions() RETURNS SETOF text LANGUAGE plpgsql AS $sequence_regressions$
DECLARE v_role text; v_privilege text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['PUBLIC','ui_rpc_executor'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['USAGE','UPDATE'] LOOP
      EXECUTE format('GRANT %s ON SEQUENCE executor_extension_acl_sequence TO %s',v_privilege,v_role);
      RETURN NEXT ok(has_sequence_privilege('ui_rpc_executor','executor_extension_acl_sequence','USAGE,UPDATE'),
        v_role || ' extension sequence ' || v_privilege || ' is detected');
      EXECUTE format('REVOKE %s ON SEQUENCE executor_extension_acl_sequence FROM %s',v_privilege,v_role);
    END LOOP;
  END LOOP;
END;
$sequence_regressions$;
SELECT * FROM pg_temp.check_extension_sequence_regressions();
DROP SEQUENCE executor_extension_acl_sequence;
DROP TABLE executor_extension_acl_fixture;
SELECT ok(NOT has_function_privilege('authenticated','public.ui_rpc_registry_v1(text,uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.ui_rpc_executor_privilege_plan_v1()','EXECUTE'),
  'registry/ACL metadata helpers remain private');
SELECT ok(NOT has_table_privilege('ui_rpc_executor','public.settings','SELECT')
  AND NOT has_table_privilege('ui_rpc_executor','public.settings_versions','SELECT'),
  'settings remain behind separately owned definer resolvers');
WITH canonical AS (
  SELECT resource->>'key' AS key FROM jsonb_array_elements(public.resolve_settings_merged(
    'ui_read_registry',public.get_root_scope_type_key_v1(),NULL)->'resources') resource
), scoped AS (
  SELECT resource->>'key' AS key FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources','[]'::jsonb)) resource
   WHERE s.category='ui_read_registry' AND (s.scope_type<>public.get_root_scope_type_key_v1() OR s.scope_id IS NOT NULL)
)
SELECT is((SELECT count(*) FROM scoped s WHERE NOT EXISTS(SELECT 1 FROM canonical c WHERE c.key=s.key)),0::bigint,
  'no current scoped-only resource is lost by canonical registry routing');

-- Independent applicability contracts catch later DROP/CREATE and ALTER POLICY drift.
WITH planned AS (SELECT DISTINCT object_id FROM pg_temp.executor_initial_privilege_plan WHERE object_kind='relation')
SELECT is((SELECT count(*) FROM pg_policy p JOIN planned r ON r.object_id=p.polrelid
  WHERE 'authenticated'::regrole::oid=ANY(p.polroles) AND NOT 'ui_rpc_executor'::regrole::oid=ANY(p.polroles)),
  0::bigint,'every authenticated policy on a planned relation includes ui_rpc_executor');
WITH planned AS (SELECT DISTINCT c.oid FROM pg_temp.executor_initial_privilege_plan p JOIN pg_class c ON c.oid=p.object_id
  WHERE p.object_kind='relation' AND c.relkind IN ('r','p'))
SELECT is((SELECT count(*) FROM planned r WHERE NOT EXISTS(SELECT 1 FROM pg_policy p
  WHERE p.polrelid=r.oid AND p.polname='ui_rpc_executor_trusted' AND p.polcmd='*'
    AND p.polroles=ARRAY['ui_rpc_executor'::regrole::oid])),0::bigint,
  'every planned table retains the executor-only trusted policy');
WITH writes AS (SELECT object_id,privilege FROM pg_temp.executor_initial_privilege_plan
  WHERE object_kind='relation' AND privilege IN ('INSERT','UPDATE','DELETE'))
SELECT is((SELECT count(*) FROM writes w JOIN pg_trigger t ON t.tgrelid=w.object_id
  WHERE NOT t.tgisinternal AND t.tgenabled IN ('O','A')
    AND (t.tgtype::int & CASE w.privilege WHEN 'INSERT' THEN 4 WHEN 'UPDATE' THEN 16 ELSE 8 END)<>0
    AND NOT has_function_privilege('ui_rpc_executor',t.tgfoid,'EXECUTE')),0::bigint,
  'all enabled mutation triggers are reachable through the privilege plan');
SELECT ok(has_table_privilege('ui_rpc_executor','public.clients','SELECT')
  AND has_table_privilege('ui_rpc_executor','public.senders','SELECT')
  AND has_function_privilege('ui_rpc_executor','public.workflow_schedule_trigger_next_run_at(jsonb,timestamptz)','EXECUTE'),
  'workflow trigger invoker lookup and nested schedule dependencies are granted');
SELECT ok((SELECT prosecdef AND proowner<>'ui_rpc_executor'::regrole FROM pg_proc
    WHERE oid='public.audit_capture_row_change()'::regprocedure)
  AND NOT has_table_privilege('ui_rpc_executor','public.audit_table_changes','INSERT'),
  'audit writes retain the existing separately owned definer boundary');
SELECT ok(NOT has_table_privilege(role,'public.ui_rpc_executor_rollback_state_v1',
  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  role || ' has no rollback snapshot table privileges')
FROM unnest(ARRAY['service_role','anon','authenticated','ui_rpc_executor']) role;
SELECT ok((SELECT jsonb_array_length(value)=6 FROM public.ui_rpc_executor_rollback_state_v1 WHERE key='entrypoints')
  AND obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class') =
    'ui_rpc_executor_rollback_state_v1:sha256:' || (SELECT
      encode(pg_catalog.sha256(convert_to(COALESCE(jsonb_object_agg(key,value ORDER BY key),'{}'::jsonb)::text,'UTF8')),'hex')
      FROM public.ui_rpc_executor_rollback_state_v1),
  'complete rollback before-images match the owner-controlled SHA-256 seal');
CREATE FUNCTION pg_temp.ui_rpc_modified_snapshot_complete_v1(entry jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO pg_catalog, public, pg_temp AS $$
  SELECT COALESCE((SELECT pg_get_userbyid(p.proowner)=entry->>'owner'
    AND pg_get_functiondef(p.oid)=entry->>'after_definition'
    AND jsonb_typeof(entry->'before_definition')='string'
    AND NULLIF(btrim(entry->>'before_definition'),'') IS NOT NULL
    AND entry->>'before_definition' IS DISTINCT FROM entry->>'after_definition'
    FROM pg_proc p WHERE p.oid=to_regprocedure(entry->>'signature')),FALSE);
$$;
SELECT ok((SELECT jsonb_array_length(value)=2
    AND (SELECT array_agg(to_regprocedure(entry->>'signature')::oid ORDER BY to_regprocedure(entry->>'signature')::oid)
      FROM jsonb_array_elements(value) entry)
      = (SELECT array_agg(signature::oid ORDER BY signature::oid) FROM unnest(ARRAY[
        'public.ui_assert_read_relation_allowed_v1(text,text,text,text)'::regprocedure,
        'public.ui_filter_tree_sql_v1(jsonb,jsonb,boolean)'::regprocedure]) signature)
    AND (SELECT bool_and(pg_temp.ui_rpc_modified_snapshot_complete_v1(entry))
      FROM jsonb_array_elements(value) entry)
  FROM public.ui_rpc_executor_rollback_state_v1 WHERE key='modified_functions'),
  'both modified functions retain sealed complete before/after definitions and original owners');
WITH entries AS (SELECT entry FROM public.ui_rpc_executor_rollback_state_v1,
  LATERAL jsonb_array_elements(value) entry WHERE key='modified_functions'),
malformed AS (SELECT entry->>'signature' AS signature, field, variant,
  CASE variant WHEN 'missing' THEN entry-field
    WHEN 'null' THEN jsonb_set(entry,ARRAY[field],'null'::jsonb)
    WHEN 'empty' THEN jsonb_set(entry,ARRAY[field],'""'::jsonb)
    ELSE jsonb_set(entry,ARRAY[field],'"   "'::jsonb) END AS entry
  FROM entries CROSS JOIN unnest(ARRAY['owner','after_definition','before_definition']) field
  CROSS JOIN (VALUES ('missing'),('null'),('empty'),('blank')) cases(variant))
SELECT ok(NOT pg_temp.ui_rpc_modified_snapshot_complete_v1(entry),
  format('%s rejects %s %s in its rollback snapshot',signature,variant,field))
  FROM malformed;
SELECT ok((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid='public.ui_rpc_executor_rollback_state_v1'::regclass)
  AND EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ui_rpc_executor_rollback_state_v1'
    AND 'service_role'=ANY(roles) AND cmd='ALL')
  AND NOT has_table_privilege('anon','public.ui_rpc_executor_rollback_state_v1','SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated','public.ui_rpc_executor_rollback_state_v1','SELECT,INSERT,UPDATE,DELETE'),
  'rollback table satisfies the existing 003a service-only RLS, policy and effective-grant predicates');
SELECT ok((SELECT bool_and(f->>'owner' IS NOT NULL AND to_regrole(f->>'owner') IS NOT NULL)
  FROM public.ui_rpc_executor_rollback_state_v1 s,
    jsonb_array_elements(CASE WHEN s.key='entrypoints' THEN s.value ELSE '[]'::jsonb END) f WHERE s.key='entrypoints'),
  'all six before-images retain their original existing owner');

-- 202601071235_ui_registry_webhook_response_events retires the old webhook keys.
-- 202608161810_b6_mapping_studio_webhook_policy_binding replaces Routing rules writes with source policies.
SELECT is((SELECT count(*) FROM jsonb_array_elements(public.resolve_settings_merged(
  'ui_read_registry',public.get_root_scope_type_key_v1(),NULL)->'resources') r
  WHERE r->>'key' IN ('webhook_rules','webhook_response_history')),0::bigint,
  'retired webhook_rules and webhook_response_history are not reintroduced as Console resources');
WITH barriers AS (SELECT unnest(ARRAY['public.comms_attempts'::regclass,'public.outbound_calls'::regclass,
  'public.ops_alerts'::regclass,'public.provider_health_logs'::regclass,'public.circuit_breaker_state'::regclass]) AS oid)
SELECT ok(bool_and(c.relrowsecurity AND c.relowner<>'ui_rpc_executor'::regrole
  AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='ui_rpc_executor_trusted'
    AND p.polpermissive AND p.polcmd='*' AND p.polroles=ARRAY['ui_rpc_executor'::regrole::oid]
    AND regexp_replace(pg_get_expr(p.polqual,p.polrelid),'\mpublic\.','','g')='(is_platform_user() OR ui_rpc_request_is_service_v1())'
    AND pg_get_expr(p.polqual,p.polrelid)=pg_get_expr(p.polwithcheck,p.polrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polcmd IN ('*','r')
    AND (0=ANY(p.polroles) OR 'ui_rpc_executor'::regrole::oid=ANY(p.polroles))
    AND p.polname<>'ui_rpc_executor_trusted'
    AND NOT (c.oid='public.ops_alerts'::regclass
      AND p.polname='ops_alerts_executor_tenant_select' AND p.polcmd='r'
      AND p.polroles=ARRAY['ui_rpc_executor'::regrole::oid] AND p.polwithcheck IS NULL))),
  'observability SELECT uses trusted platform/service policy and the executor-only tenant alert policy')
FROM barriers b JOIN pg_class c ON c.oid=b.oid;

DO $clear_claims$ BEGIN
  PERFORM set_config('request.jwt.claims','{}',TRUE);
  PERFORM set_config('request.jwt.claim.role','',TRUE);
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
END; $clear_claims$;
SELECT ok(NOT public.ui_rpc_request_is_service_v1(),
  'administrative SQL session identity cannot turn the executor into a service request');

CREATE TEMP TABLE executor_rows(id UUID PRIMARY KEY, organization_id UUID NOT NULL, name TEXT, amount INT);
ALTER TABLE pg_temp.executor_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY executor_rows_scope ON pg_temp.executor_rows FOR ALL TO authenticated,ui_rpc_executor
  USING(organization_id=public.current_user_org_id()) WITH CHECK(organization_id=public.current_user_org_id());
CREATE TEMP VIEW executor_view WITH(security_invoker=true) AS SELECT * FROM pg_temp.executor_rows;
CREATE TEMP TABLE executor_global(id UUID PRIMARY KEY, name TEXT);
ALTER TABLE pg_temp.executor_global ENABLE ROW LEVEL SECURITY;
CREATE POLICY executor_global_read ON pg_temp.executor_global FOR ALL TO authenticated,ui_rpc_executor USING(TRUE) WITH CHECK(TRUE);
CREATE TEMP TABLE executor_no_rls(id UUID PRIMARY KEY,name TEXT);
CREATE TEMP VIEW executor_no_rls_view WITH(security_invoker=true) AS SELECT * FROM pg_temp.executor_no_rls;
GRANT SELECT,UPDATE,DELETE ON pg_temp.executor_rows,pg_temp.executor_global TO ui_rpc_executor;
GRANT SELECT ON pg_temp.executor_rows,pg_temp.executor_view,pg_temp.executor_no_rls,pg_temp.executor_no_rls_view TO authenticated,ui_rpc_executor;
DO $schema$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ui_rpc_executor',pg_my_temp_schema()::regnamespace);
END; $schema$;

CREATE FUNCTION pg_temp.test_ui_rpc_executor_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID:=gen_random_uuid(); v_other UUID:=gen_random_uuid();
  v_actor UUID:=gen_random_uuid(); v_platform UUID:=gen_random_uuid();
  v_client UUID:=gen_random_uuid(); v_sender UUID:=gen_random_uuid();
  v_own UUID:=gen_random_uuid(); v_foreign UUID:=gen_random_uuid(); v_global UUID:=gen_random_uuid();
  v_policy JSONB; v_global_policy JSONB; v_registry JSONB; v_schema INT; v_resource JSONB; v_bad JSONB;
  v_key TEXT; v_scope TEXT; v_role TEXT:='qa_executor_'||replace(gen_random_uuid()::text,'-','');
  v_api TEXT; v_result JSONB; v_n INT;
BEGIN
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (v_org,'Executor own','executor-'||v_org,'active'),(v_other,'Executor foreign','executor-'||v_other,'active');
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES(v_client,v_org,'Executor client','executor-'||v_client,'active');
  INSERT INTO public.senders(id,client_id,name,status) VALUES(v_sender,v_client,'Executor sender','active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id) VALUES
    (v_actor,v_org,v_actor||'@example.test','Executor tenant','ops_admin','active','tenant',NULL),
    (v_platform,v_org,v_platform||'@example.test','Example Person','super_admin','active','platform',NULL);
  INSERT INTO pg_temp.executor_rows VALUES(v_own,v_org,'Own',10),(v_foreign,v_other,'Foreign',90);
  INSERT INTO pg_temp.executor_global VALUES(v_global,'Global');
  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1('tenant',v_org,FALSE);
  SELECT version INTO v_schema FROM public.schema_registry WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  v_policy:=jsonb_set(v_policy,'{roles}',v_policy->'roles'||jsonb_build_array(jsonb_build_object(
    'key',v_role,'capability_keys',jsonb_build_array('webhooks.read'))));
  v_policy:=jsonb_set(v_policy,'{assignments}',COALESCE(v_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_actor::text,jsonb_build_array(v_role))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',v_org,v_policy,v_schema,'Rollback-only executor capability');
  PERFORM public.upsert_settings_value_v1('access_control_policy','client',v_client,v_policy,v_schema,'Rollback-only executor capability');
  PERFORM public.upsert_settings_value_v1('access_control_policy','sender',v_sender,v_policy,v_schema,'Rollback-only executor capability');
  SELECT policy INTO v_global_policy FROM public.resolve_access_control_policy_v1('global',NULL,FALSE);
  v_global_policy:=jsonb_set(v_global_policy,'{roles}',v_global_policy->'roles'||jsonb_build_array(jsonb_build_object(
    'key',v_role,'capability_keys',jsonb_build_array('webhooks.read'))));
  v_global_policy:=jsonb_set(v_global_policy,'{assignments}',COALESCE(v_global_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_global_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_platform::text,jsonb_build_array(v_role))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','global',NULL,v_global_policy,v_schema,'Rollback-only platform capability');
  SELECT sv.value,sv.schema_version INTO v_registry,v_schema FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_read_registry'
      AND s.scope_type='global' AND s.scope_id IS NULL;
  v_resource:=jsonb_build_object('key','qa_executor_table','relation',format('%I.executor_rows',pg_my_temp_schema()::regnamespace),
    'id_column','id','allow_delete',TRUE,'capability_read','webhooks.read','select',jsonb_build_array('id','name','amount'),
    'columns',jsonb_build_array(jsonb_build_object('key','name','edit_mode','inline')),
    'filters',jsonb_build_array(jsonb_build_object('key','name','column','name','op','eq')),
    'default_sort',jsonb_build_object('column','name','direction','asc'));
  v_registry:=jsonb_set(v_registry,'{resources}',v_registry->'resources'||jsonb_build_array(v_resource,
    v_resource||jsonb_build_object('key','qa_executor_view','relation',format('%I.executor_view',pg_my_temp_schema()::regnamespace)),
    v_resource||jsonb_build_object('key','qa_executor_global','relation',format('%I.executor_global',pg_my_temp_schema()::regnamespace),'scope','global'),
    v_resource||jsonb_build_object('key','qa_executor_no_rls','relation',format('%I.executor_no_rls_view',pg_my_temp_schema()::regnamespace))));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only executor resources');
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',v_org,v_registry,v_schema,
    'Rollback-only executor fixture presentation');
  PERFORM public.upsert_settings_value_v1('ui_read_registry','client',v_client,v_registry,v_schema,
    'Rollback-only executor fixture presentation');
  PERFORM public.upsert_settings_value_v1('ui_read_registry','sender',v_sender,v_registry,v_schema,
    'Rollback-only executor fixture presentation');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  FOREACH v_api IN ARRAY ARRAY['public','api'] LOOP
    FOREACH v_key IN ARRAY ARRAY['qa_executor_table','qa_executor_view'] LOOP
      EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',v_api) INTO v_result USING v_key,v_foreign;
      RETURN NEXT ok(v_result IS NULL,v_api||' '||v_key||' get denies foreign ID');
      EXECUTE format('SELECT %I.ui_list_resource_v1($1,''{}'',20,0,NULL)',v_api) INTO v_result USING v_key;
      RETURN NEXT is(v_result->'items',jsonb_build_array(jsonb_build_object('id',v_own,'name','Own','amount',10)),
        v_api||' '||v_key||' list returns only own row through RLS without mapping');
      EXECUTE format('SELECT %I.ui_filter_distinct_values_v1($1,''name'',NULL,25)',v_api) INTO v_result USING v_key;
      RETURN NEXT is(v_result,'["Own"]'::jsonb,v_api||' '||v_key||' distinct denies foreign value');
      EXECUTE format('SELECT %I.ui_resource_metrics_v1($1,''{}'',NULL)',v_api) INTO v_result USING v_key;
      RETURN NEXT ok((v_result->>'total')::int=1 AND (v_result#>>'{columns,amount,sum}')::int=10,
        v_api||' '||v_key||' metrics exclude foreign count and sum');
      IF v_key='qa_executor_table' THEN
        RETURN NEXT throws_ok(format('SELECT %I.ui_update_resource_v1(%L,%L,''{"name":"leaked"}'')',v_api,v_key,v_foreign),
          '42501','ui_update_resource_v1 resource not available',v_api||' update denies foreign row');
        RETURN NEXT throws_ok(format('SELECT %I.ui_update_resource_v1(%L,%L,''{"name":"absent"}'')',v_api,v_key,gen_random_uuid()),
          '42501','ui_update_resource_v1 resource not available',v_api||' update denies absent row with the same response');
        RETURN NEXT throws_ok(format('SELECT %I.ui_delete_resource_v1(%L,%L)',v_api,v_key,v_foreign),
          'P0001',format('ui_delete_resource_v1 could not find resource %s for id %s',v_key,v_foreign),v_api||' delete denies foreign row');
      ELSE
        RETURN NEXT throws_ok(format('SELECT %I.ui_update_resource_v1(%L,%L,''{"name":"leaked"}'')',v_api,v_key,v_foreign),
          'P0001',format('ui_update_resource_v1 relation not allowed: %s',replace(v_resource->>'relation','executor_rows','executor_view')),v_api||' view update remains denied');
        RETURN NEXT throws_ok(format('SELECT %I.ui_delete_resource_v1(%L,%L)',v_api,v_key,v_foreign),
          'P0001',NULL,v_api||' view delete remains denied');
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEXT throws_ok('SELECT api.ui_list_resource_v1(''qa_executor_no_rls'',''{}'',20,0,NULL)',
    '42501','ui_read_registry resource qa_executor_no_rls requires scope mapping or executor RLS','unmapped view without effective RLS fails closed');
  RETURN NEXT is(api.ui_get_resource_v1('qa_executor_global',v_global)->>'name','Global','tenant can read a global catalog');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_resource_v1(''qa_executor_global'',%L,''{"name":"no"}'')',v_global),
    '42501','ui_read_registry global catalogs require platform mutation','tenant cannot update global catalog');
  RETURN NEXT throws_ok(format('SELECT api.ui_delete_resource_v1(''qa_executor_global'',%L)',v_global),
    '42501','ui_read_registry global catalogs require platform mutation','tenant cannot delete global catalog');

  SET LOCAL ROLE postgres;
  v_bad:=v_resource||jsonb_build_object('scope_columns',jsonb_build_object('tenant','organization_id'));
  v_registry:=jsonb_set(v_registry,'{resources}',(SELECT jsonb_agg(CASE WHEN value->>'key'='qa_executor_table' THEN v_bad ELSE value END)
    FROM jsonb_array_elements(v_registry->'resources')));
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_registry,v_schema,'Rollback-only parent reference mapping');
  UPDATE public.users SET access_scope_type='tenant',access_scope_id=NULL WHERE id=v_actor;
  RETURN NEXT is(public.ui_resource_scope_predicate_v1(v_bad,'pg_temp.executor_rows'::regclass,'tenant',NULL),
    format('%I = %L','organization_id',v_org),'shared predicate explicitly resolves NULL tenant scope through current_user_org_id');
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(api.ui_list_resource_v1('qa_executor_table','{}',20,0,NULL)->>'total','1',
    'tenant NULL access_scope_id falls back to organization_id with a registry scope mapping');
  RETURN NEXT ok(api.ui_get_resource_v1('qa_executor_table',v_foreign) IS NULL,
    'tenant NULL access_scope_id fallback still excludes foreign rows');
  SET LOCAL ROLE postgres;
  FOREACH v_scope IN ARRAY ARRAY['client','sender'] LOOP
    UPDATE public.users SET access_scope_type=v_scope,access_scope_id=CASE WHEN v_scope='client' THEN v_client ELSE v_sender END WHERE id=v_actor;
    SET LOCAL ROLE authenticated;
    RETURN NEXT is(api.ui_get_resource_v1('qa_executor_table',v_own)->>'name','Own',v_scope||' inherits parent tenant reference mapping through ladder');
    RETURN NEXT ok(api.ui_get_resource_v1('qa_executor_table',v_foreign) IS NULL,v_scope||' ladder inheritance excludes another organization');
    SET LOCAL ROLE postgres;
  END LOOP;
  UPDATE public.users SET access_scope_type='tenant',access_scope_id=NULL WHERE id=v_actor;
  v_bad:=v_resource||jsonb_build_object('scope','global','relation',format('%I.executor_global',pg_my_temp_schema()::regnamespace),
    'read_relation',format('%I.executor_global',pg_my_temp_schema()::regnamespace),
    'read_scope_types',jsonb_build_array('global'),'scope_columns','{}'::jsonb,'allow_delete',TRUE);
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',v_org,jsonb_build_object('resources',jsonb_build_array(v_bad)),v_schema,'Rollback-only hostile scoped routing');
  SET LOCAL ROLE authenticated;
  RETURN NEXT ok(api.ui_get_resource_v1('qa_executor_table',v_foreign) IS NULL,'scoped relation/global/mapping overrides cannot replace global security metadata');
  RETURN NEXT is(api.ui_get_resource_v1('qa_executor_table',v_own)->>'name','Own','global routing survives hostile scoped metadata');
  SET LOCAL ROLE postgres;
  PERFORM set_config('request.jwt.claim.sub',v_platform::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_platform,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(api.ui_update_resource_v1('qa_executor_global',v_global::text,'{"name":"Platform"}')->>'name','Platform','platform retains configured global update');
  RETURN NEXT is(api.ui_delete_resource_v1('qa_executor_global',v_global::text)->>'name','Platform','platform retains configured global delete');
  SET LOCAL ROLE postgres;
  SELECT count(*) INTO v_n FROM pg_temp.executor_rows WHERE id=v_foreign AND name='Foreign';
  RETURN NEXT is(v_n,1,'denied table/view mutations left foreign data unchanged');
END;
$test$;
SELECT * FROM pg_temp.test_ui_rpc_executor_v1();
-- Real registry resources retain their existing helper-defined visibility; no scope-column retrofit.
CREATE TEMP TABLE executor_screen_rows(resource_key TEXT, own_id UUID, foreign_id UUID);
GRANT SELECT ON pg_temp.executor_screen_rows TO authenticated;
CREATE TEMP TABLE executor_platform_rows(resource_key TEXT,own_id UUID,foreign_id UUID);
GRANT SELECT ON pg_temp.executor_platform_rows TO authenticated;
CREATE FUNCTION pg_temp.test_executor_screens_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $screens$
DECLARE
  v_org UUID:=gen_random_uuid(); v_other UUID:=gen_random_uuid(); v_partner UUID:=gen_random_uuid();
  v_actor UUID:=gen_random_uuid(); v_supplier UUID:=gen_random_uuid(); v_platform UUID:=gen_random_uuid();
  v_side UUID; v_ids JSONB:='{}'; v_row JSONB; v_rows JSONB:='[]';
  v_plugin UUID; v_version UUID; v_provider UUID; v_auth UUID; v_template UUID; v_step UUID; v_run UUID; v_run_step UUID;
  v_profile UUID; v_request UUID; v_offer UUID; v_award UUID; v_contract UUID; v_work UUID; v_dispute UUID; v_batch UUID; v_participant_request UUID;
  v_alert UUID; v_attempt UUID; v_outbound UUID;
  v_resource JSONB; v_registry JSONB; v_policy JSONB; v_schema INT; v_capabilities JSONB;
  v_role TEXT:='qa_executor_screens_'||replace(gen_random_uuid()::text,'-','');
  v_case RECORD; v_expected INT; v_list JSONB; v_metrics JSONB; v_filter JSONB;
  v_api TEXT; v_id_column TEXT;
  v_workflow_context TEXT:=current_setting('app.workflow_run_id',TRUE);
  v_platform_keys TEXT[]:=ARRAY['comms_attempts','ops_alerts','provider_health_latest','circuit_breaker_dashboard'];
  v_denied UUID:=gen_random_uuid();
  v_keys TEXT[]:=ARRAY['integration_plugins','integration_plugin_versions','provider_auth_configs','workflow_templates',
    'workflow_template_steps','workflow_runs','workflow_run_steps','marketplace_contracts','marketplace_disputes',
    'marketplace_participants','marketplace_requests','marketplace_settlement_batches','marketplace_work_packages',
    'marketplace_participant_requests'];
BEGIN
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (v_org,'Executor screens own','screens-'||v_org,'active'),(v_other,'Executor screens other','screens-'||v_other,'active'),
    (v_partner,'Executor screens supplier','screens-'||v_partner,'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
    VALUES(v_actor,v_org,v_actor||'@example.test','Executor screen reader','ops_admin','active','tenant',NULL),
      (v_platform,v_org,v_platform||'@example.test','Example Person reader','super_admin','active','platform',NULL),
      (v_denied,v_org,v_denied||'@example.test','Executor denied reader','driver','active','tenant',NULL);
  INSERT INTO public.marketplace_participant_profiles(id,organization_id,participant_type_key,display_name,status,listing_status,compliance_state)
    VALUES(v_supplier,v_partner,'provider_tenant','Executor supplier','approved','private','approved');
  INSERT INTO public.rbac_roles(organization_id,key,name) VALUES(v_org,v_role,'Executor screen provider reader');
  INSERT INTO public.rbac_role_permissions(organization_id,role_id,permission_id)
    SELECT v_org,r.id,lv.id FROM public.rbac_roles r
    JOIN public.lookup_definitions ld ON ld.category='rbac_permission'
    JOIN public.lookup_values lv ON lv.lookup_definition_id=ld.id AND lv.value IN ('agreements.read','tasks.read')
    WHERE r.organization_id=v_org AND r.key=v_role;
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id)
    SELECT v_org,v_actor,id FROM public.rbac_roles WHERE organization_id=v_org AND key=v_role;
  FOREACH v_side IN ARRAY ARRAY[v_org,v_other] LOOP
    v_plugin:=gen_random_uuid();v_version:=gen_random_uuid();v_provider:=gen_random_uuid();v_auth:=gen_random_uuid();
    v_template:=gen_random_uuid();v_step:=gen_random_uuid();v_run:=gen_random_uuid();v_run_step:=gen_random_uuid();
    v_profile:=gen_random_uuid();v_request:=gen_random_uuid();v_offer:=gen_random_uuid();v_award:=gen_random_uuid();
    v_contract:=gen_random_uuid();v_work:=gen_random_uuid();v_dispute:=gen_random_uuid();v_batch:=gen_random_uuid();v_participant_request:=gen_random_uuid();
    INSERT INTO public.integration_plugins(id,organization_id,plugin_key,name) VALUES(v_plugin,v_side,'executor-'||v_plugin,'Executor plugin');
    INSERT INTO public.integration_plugin_versions(id,plugin_id,organization_id,version_no) VALUES(v_version,v_plugin,v_side,1);
    INSERT INTO public.providers(id,organization_id,name,provider_type,enabled) VALUES(v_provider,v_side,'Executor provider','http',TRUE);
    v_alert:=gen_random_uuid();v_attempt:=gen_random_uuid();v_outbound:=gen_random_uuid();
    INSERT INTO public.ops_alerts(id,organization_id,alert_type,severity,message)
      VALUES(v_alert,v_side,'executor_contract','warning','Synthetic executor fixture');
    INSERT INTO public.provider_health_logs(organization_id,provider_id,status) VALUES(v_side,v_provider,'healthy');
    INSERT INTO public.circuit_breaker_state(provider_id,operation_name,state) VALUES(v_provider,'executor_contract','closed');
    INSERT INTO public.outbound_calls(id,call_type,target_type,target_id,method,url,status)
      VALUES(v_outbound,'comms_email','provider',v_provider,'POST','https://example.test/executor','completed');
    INSERT INTO public.comms_attempts(id,outbound_call_id,provider_id,attempt_number,status)
      VALUES(v_attempt,v_outbound,v_provider,1,'sent');
    INSERT INTO public.provider_auth_configs(id,provider_id,auth_type,credentials) VALUES(v_auth,v_provider,'api_key','{"api_key":"synthetic-pgtap-only"}');
    INSERT INTO public.workflow_templates(id,name,version,status,scope_type,scope_id) VALUES(v_template,'executor-'||v_template,1,'draft','tenant',v_side);
    INSERT INTO public.workflow_template_steps(id,workflow_template_id,sequence_order,operation_name,transition_condition,handler_key,handler_version)
      VALUES(v_step,v_template,1,'workflow_control','always','workflow_control','v1');
    PERFORM set_config('app.workflow_run_id',v_run::text,TRUE);
    INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,context)
      VALUES(v_run,v_template,1,'manual',jsonb_build_object('organization_id',v_side));
    PERFORM set_config('app.workflow_run_id',v_run::text,TRUE);
    INSERT INTO public.workflow_run_steps(id,workflow_run_id,workflow_template_step_id,sequence_order,operation_name,max_retries,handler_key,handler_version)
      VALUES(v_run_step,v_run,v_step,1,'workflow_control',1,'workflow_control','v1');
    INSERT INTO public.marketplace_participant_profiles(id,organization_id,participant_type_key,display_name,status,listing_status)
      VALUES(v_profile,v_side,'provider_tenant','Executor private profile','pending','private');
    INSERT INTO public.marketplace_participant_requests(id,requested_participant_type_key,requested_organization_id,email,full_name,organization_name)
      VALUES(v_participant_request,'provider_tenant',v_side,v_participant_request||'@example.test','Executor applicant','Executor org');
    INSERT INTO public.marketplace_requests(id,requester_organization_id,request_kind_key,title)
      VALUES(v_request,v_side,'driver_shift_market','Executor private request');
    INSERT INTO public.marketplace_offers(id,request_id,supplier_participant_profile_id,supplier_organization_id)
      VALUES(v_offer,v_request,v_supplier,v_partner);
    INSERT INTO public.marketplace_awards(id,request_id,offer_id,requester_organization_id,supplier_organization_id,supplier_participant_profile_id)
      VALUES(v_award,v_request,v_offer,v_side,v_partner,v_supplier);
    INSERT INTO public.marketplace_contracts(id,award_id,request_id,requester_organization_id,supplier_organization_id,supplier_participant_profile_id)
      VALUES(v_contract,v_award,v_request,v_side,v_partner,v_supplier);
    INSERT INTO public.marketplace_work_packages(id,contract_id,award_id,request_id,requester_organization_id,supplier_organization_id,supplier_participant_profile_id)
      VALUES(v_work,v_contract,v_award,v_request,v_side,v_partner,v_supplier);
    INSERT INTO public.marketplace_disputes(id,request_id,contract_id,opened_by_organization_id,counterparty_organization_id,title)
      VALUES(v_dispute,v_request,v_contract,v_side,v_partner,'Executor dispute');
    INSERT INTO public.settlement_batches(id,organization_id,kind,scope_type,status,subject_type,subject_id)
      VALUES(v_batch,v_side,'cod','driver_shift','open','driver',v_actor);
    v_row:=jsonb_build_object('integration_plugins',v_plugin,'integration_plugin_versions',v_version,'provider_auth_configs',v_auth,
      'workflow_templates',v_template,'workflow_template_steps',v_step,'workflow_runs',v_run,'workflow_run_steps',v_run_step,
      'marketplace_contracts',v_contract,'marketplace_disputes',v_dispute,'marketplace_participants',v_profile,
      'marketplace_requests',v_request,'marketplace_settlement_batches',v_batch,'marketplace_work_packages',v_work,
      'marketplace_participant_requests',v_participant_request,'comms_attempts',v_attempt,'ops_alerts',v_alert,
      'provider_health_latest',v_provider,'circuit_breaker_dashboard',v_provider);
    v_rows:=v_rows||jsonb_build_array(v_row);
  END LOOP;
  PERFORM set_config('app.workflow_run_id',COALESCE(v_workflow_context,''),TRUE);
  -- A malformed local settings reference cannot disclose another tenant's credential.
  PERFORM public.upsert_settings_value_v1('logestechs_v2_account','tenant',v_org,
    jsonb_build_object('auth_config_id',v_rows#>>'{1,provider_auth_configs}'),1,
    'Rollback-only foreign credential reference');
  INSERT INTO pg_temp.executor_screen_rows SELECT key,(v_rows->0->>key)::uuid,(v_rows->1->>key)::uuid FROM unnest(v_keys) key;
  INSERT INTO pg_temp.executor_platform_rows SELECT key,(v_rows->0->>key)::uuid,(v_rows->1->>key)::uuid FROM unnest(v_platform_keys) key;
  SELECT public.resolve_settings_merged('ui_read_registry','global',NULL) INTO v_registry;
  SELECT jsonb_agg(DISTINCT to_jsonb(capability)) INTO v_capabilities FROM (
    SELECT resource->>'capability_read' AS capability FROM jsonb_array_elements(v_registry->'resources') resource
      WHERE resource->>'key'=ANY(v_keys||v_platform_keys)
    UNION ALL SELECT 'tasks.read' UNION ALL SELECT 'provider_auth.read'
    UNION ALL SELECT 'integration_plugins.read' UNION ALL SELECT 'marketplace_participants.read'
    UNION ALL SELECT 'marketplace_participant_requests.read'
    UNION ALL SELECT 'marketplace_disputes.read'
    UNION ALL SELECT 'integrations.read'
  ) capabilities WHERE capability IS NOT NULL;
  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1('tenant',v_org,FALSE);
  SELECT version INTO v_schema FROM public.schema_registry WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  v_policy:=jsonb_set(v_policy,'{roles}',v_policy->'roles'||jsonb_build_array(jsonb_build_object('key',v_role,'capability_keys',v_capabilities)));
  v_policy:=jsonb_set(v_policy,'{assignments}',COALESCE(v_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_actor::text,jsonb_build_array(v_role))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',v_org,v_policy,v_schema,'Rollback-only screen visibility');
  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1('global',NULL,FALSE);
  v_policy:=jsonb_set(v_policy,'{roles}',v_policy->'roles'||jsonb_build_array(jsonb_build_object('key',v_role,'capability_keys',v_capabilities)));
  v_policy:=jsonb_set(v_policy,'{assignments}',COALESCE(v_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_policy#>'{assignments,user_id}','{}')||jsonb_build_object(v_platform::text,jsonb_build_array(v_role))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','global',NULL,v_policy,v_schema,'Rollback-only platform screen visibility');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  FOR v_case IN SELECT * FROM pg_temp.executor_screen_rows ORDER BY resource_key LOOP
    SELECT value INTO STRICT v_resource FROM jsonb_array_elements(v_registry->'resources') WHERE value->>'key'=v_case.resource_key;
    IF v_case.resource_key='provider_auth_configs' THEN
      RETURN NEXT throws_ok(format('SELECT count(*) FROM public.provider_auth_configs WHERE id=%L::uuid',v_case.own_id),
        '42501','permission denied for table provider_auth_configs','raw credential source remains unavailable to the browser');
    ELSE
      EXECUTE format('SELECT count(*) FROM %s WHERE id=$1',to_regclass(v_resource->>'relation')) INTO v_expected USING v_case.own_id;
      RETURN NEXT is(v_expected,1,v_case.resource_key||' existing RLS helper positively authorizes the own fixture');
    END IF;
    RETURN NEXT is(api.ui_get_resource_v1(v_case.resource_key,v_case.own_id)->>'id',v_case.own_id::text,
      v_case.resource_key||' tenant page remains readable without a scope mapping');
    RETURN NEXT ok(api.ui_get_resource_v1(v_case.resource_key,v_case.foreign_id) IS NULL,v_case.resource_key||' foreign private fixture stays hidden');
    v_filter:=jsonb_build_object('id',jsonb_build_array(v_case.own_id,v_case.foreign_id));
    v_list:=api.ui_list_resource_v1(v_case.resource_key,v_filter,20,0,NULL);
    v_metrics:=api.ui_resource_metrics_v1(v_case.resource_key,v_filter,NULL);
    RETURN NEXT ok((v_list->>'total')::int=1 AND jsonb_array_length(v_list->'items')=1
      AND v_list#>>'{items,0,id}'=v_case.own_id::text,v_case.resource_key||' list preserves helper-defined tenant rows');
    RETURN NEXT is((v_metrics->>'total')::int,1,v_case.resource_key||' metrics preserve the same tenant boundary');
  END LOOP;
  SELECT * INTO STRICT v_case FROM pg_temp.executor_screen_rows WHERE resource_key='provider_auth_configs';
  RETURN NEXT results_eq(
    format('SELECT id FROM public.integration_credential_directory_rows_v1() WHERE id IN (%L,%L)',v_case.own_id,v_case.foreign_id),
    format('VALUES (%L::uuid)',v_case.own_id),
    'credential directory helper returns only the authorized tenant metadata');
  SET LOCAL ROLE postgres;
  FOREACH v_api IN ARRAY ARRAY['public','api'] LOOP
    FOREACH v_side IN ARRAY ARRAY[v_actor,v_platform] LOOP
      PERFORM set_config('request.jwt.claim.sub',v_side::text,TRUE);
      PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_side,'role','authenticated')::text,TRUE);
      SET LOCAL ROLE authenticated;
      FOR v_case IN SELECT * FROM pg_temp.executor_platform_rows ORDER BY resource_key LOOP
        SELECT value INTO STRICT v_resource FROM jsonb_array_elements(v_registry->'resources') WHERE value->>'key'=v_case.resource_key;
        v_id_column:=v_resource->>'id_column';
        EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',v_api) INTO v_list USING v_case.resource_key,v_case.own_id;
        RETURN NEXT is(v_list->>v_id_column,
          CASE WHEN v_side=v_platform OR v_case.resource_key='ops_alerts' THEN v_case.own_id::text END,
          v_api||' '||v_case.resource_key||' get respects platform and own-tenant alert visibility');
        EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',v_api) INTO v_list USING v_case.resource_key,v_case.foreign_id;
        RETURN NEXT is(v_list->>v_id_column,CASE WHEN v_side=v_platform THEN v_case.foreign_id::text END,
          v_api||' '||v_case.resource_key||' trusted platform retains cross-organization get');
        v_filter:=jsonb_build_object(v_id_column,jsonb_build_array(v_case.own_id,v_case.foreign_id));
        EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,20,0,NULL)',v_api) INTO v_list USING v_case.resource_key,v_filter;
        EXECUTE format('SELECT %I.ui_resource_metrics_v1($1,$2,NULL)',v_api) INTO v_metrics USING v_case.resource_key,v_filter;
        v_expected:=CASE WHEN v_side=v_platform THEN 2 WHEN v_case.resource_key='ops_alerts' THEN 1 ELSE 0 END;
        RETURN NEXT is((v_list->>'total')::int,v_expected,v_api||' '||v_case.resource_key||' list count respects visibility');
        IF v_side=v_actor AND v_case.resource_key='ops_alerts' THEN
          RETURN NEXT is(v_list#>>'{items,0,id}',v_case.own_id::text,v_api||' ops_alerts list returns the authorized own row');
        END IF;
        RETURN NEXT is(jsonb_array_length(v_list->'items'),v_expected,v_api||' '||v_case.resource_key||' Console row payload matches visibility');
        RETURN NEXT is((v_metrics->>'total')::int,v_expected,v_api||' '||v_case.resource_key||' metrics retain the approved scope boundary');
      END LOOP;
      SET LOCAL ROLE postgres;
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub',v_denied::text,TRUE);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_denied,'role','authenticated')::text,TRUE);
    SET LOCAL ROLE authenticated;
    SELECT own_id INTO STRICT v_alert FROM pg_temp.executor_platform_rows WHERE resource_key='ops_alerts';
    RETURN NEXT throws_ok(format('SELECT %I.ui_get_resource_v1(''ops_alerts'',%L::uuid)',v_api,v_alert),
      '42501',NULL,v_api||' ops_alerts denies an own-tenant actor without alerts.read');
    SELECT own_id INTO STRICT v_auth FROM pg_temp.executor_screen_rows WHERE resource_key='provider_auth_configs';
    RETURN NEXT is((SELECT count(*) FROM public.integration_credential_directory_rows_v1() WHERE id=v_auth),
      0::bigint,v_api||' credential directory helper denies own-tenant metadata without integrations.read');
    SET LOCAL ROLE postgres;
  END LOOP;
END;
$screens$;
SELECT * FROM pg_temp.test_executor_screens_v1();

-- Synthetic invoker INSERT plus nested helper/read; source-registry row is transaction-local.
CREATE TEMP TABLE executor_trigger_target(id UUID PRIMARY KEY,name TEXT);
CREATE TEMP TABLE executor_trigger_log(id UUID PRIMARY KEY,name TEXT);
CREATE SCHEMA executor_path_fixture;
CREATE TABLE executor_path_fixture.executor_trigger_log(id UUID PRIMARY KEY,name TEXT);
CREATE TEMP TABLE executor_search_shadow(id UUID PRIMARY KEY,name TEXT);
CREATE TEMP TABLE executor_implicit_temp(id UUID PRIMARY KEY,name TEXT);
CREATE FUNCTION pg_temp.executor_implicit_temp_write() RETURNS void LANGUAGE plpgsql
SET search_path TO executor_path_fixture AS $implicit$
BEGIN UPDATE executor_implicit_temp SET name='implicit'; END;
$implicit$;
CREATE FUNCTION pg_temp.executor_trigger_helper() RETURNS void LANGUAGE plpgsql
SET search_path TO executor_path_fixture, pg_temp, public AS $helper$
BEGIN
  INSERT INTO executor_trigger_log VALUES(gen_random_uuid(),'trigger')
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name;
END;
$helper$;
CREATE FUNCTION pg_temp.executor_upsert_update() RETURNS trigger LANGUAGE plpgsql AS $upsert$
BEGIN INSERT INTO pg_temp.executor_search_shadow VALUES(gen_random_uuid(),'update'); RETURN NEW; END;
$upsert$;
CREATE TRIGGER executor_upsert_update BEFORE UPDATE ON executor_path_fixture.executor_trigger_log
  FOR EACH ROW EXECUTE FUNCTION pg_temp.executor_upsert_update();
CREATE FUNCTION pg_temp.executor_trigger_write() RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN PERFORM pg_temp.executor_trigger_helper(); PERFORM pg_temp.executor_implicit_temp_write(); RETURN NEW; END;
$trigger$;
CREATE TRIGGER executor_trigger_write BEFORE UPDATE ON pg_temp.executor_trigger_target
  FOR EACH ROW EXECUTE FUNCTION pg_temp.executor_trigger_write();
CREATE TEMP TABLE executor_definer_private(id UUID);
INSERT INTO pg_temp.executor_definer_private VALUES(gen_random_uuid());
CREATE FUNCTION pg_temp.executor_definer_private_fn() RETURNS INT LANGUAGE sql AS 'SELECT 1';
REVOKE ALL ON FUNCTION pg_temp.executor_definer_private_fn() FROM PUBLIC;
CREATE TEMP VIEW executor_definer_inner AS SELECT id,pg_temp.executor_definer_private_fn() AS value FROM pg_temp.executor_definer_private;
CREATE TEMP VIEW executor_definer_view AS SELECT * FROM pg_temp.executor_definer_inner;
CREATE TEMP VIEW executor_invoker_outer WITH(security_invoker=true) AS SELECT * FROM pg_temp.executor_definer_view;
DO $trigger_registry$
DECLARE v_registry JSONB; v_schema INT;
BEGIN
  SELECT sv.value,sv.schema_version INTO v_registry,v_schema FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
  PERFORM public.upsert_settings_value_v1('ui_read_registry',public.get_root_scope_type_key_v1(),NULL,
    jsonb_set(v_registry,'{resources}',v_registry->'resources'||jsonb_build_array(jsonb_build_object(
      'key','qa_executor_trigger','relation',format('%I.executor_trigger_target',pg_my_temp_schema()::regnamespace),
      'select',jsonb_build_array('id','name'),'columns',jsonb_build_array(jsonb_build_object('key','name','edit_mode','inline'))),
      jsonb_build_object('key','qa_executor_definer_boundary','relation',format('%I.executor_invoker_outer',pg_my_temp_schema()::regnamespace),
        'select',jsonb_build_array('id','value'),'scope','global'))),
    v_schema,'Rollback-only invoker trigger graph fixture');
END;
$trigger_registry$;
SELECT ok(EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
  WHERE object_kind='relation' AND object_id='executor_path_fixture.executor_trigger_log'::regclass AND privilege='INSERT'),
  'invoker trigger nested INSERT is included without adding a direct resource insert');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
  WHERE object_kind='relation' AND object_id='pg_temp.executor_trigger_target'::regclass AND privilege='INSERT'),
  'an editable resource does not acquire generic INSERT privileges');
SELECT ok(EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
  WHERE object_kind='relation' AND object_id='executor_path_fixture.executor_trigger_log'::regclass AND privilege='UPDATE'),
  'unqualified ON CONFLICT DO UPDATE resolves the function search_path and includes UPDATE');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
  WHERE object_kind='relation' AND object_id='pg_temp.executor_trigger_log'::regclass),
  'unqualified write resolution does not grant a shadowed relation later in search_path');
SELECT ok(EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
  WHERE object_kind='relation' AND object_id='pg_temp.executor_implicit_temp'::regclass AND privilege='UPDATE'),
  'function search_path preserves implicit temporary-schema relation resolution');
SELECT ok(EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
  WHERE object_kind='relation' AND object_id='pg_temp.executor_search_shadow'::regclass AND privilege='INSERT'),
  'upsert UPDATE follows UPDATE triggers as well as INSERT triggers');
SELECT ok(EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='relation' AND object_id='pg_temp.executor_definer_view'::regclass)
  AND NOT EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='relation' AND object_id='pg_temp.executor_definer_private'::regclass)
  AND NOT EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='relation' AND object_id='pg_temp.executor_definer_inner'::regclass)
  AND EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='function' AND object_id='pg_temp.executor_definer_private_fn()'::regprocedure),
  'definer views stop relation grants but retain querying-user function grants');

CREATE FUNCTION pg_temp.test_executor_definer_view_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $view_test$
DECLARE v_id UUID; v_actor UUID; rec RECORD;
BEGIN
  SELECT id INTO STRICT v_id FROM pg_temp.executor_definer_private;
  SELECT id INTO STRICT v_actor FROM public.users WHERE full_name='Example Person';
  FOR rec IN SELECT * FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='relation' AND object_id IN
      ('pg_temp.executor_invoker_outer'::regclass,'pg_temp.executor_definer_view'::regclass)
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE %s TO ui_rpc_executor',rec.object_id::regclass);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT throws_ok(format('SELECT public.ui_get_resource_v1(%L,%L::uuid)',
    'qa_executor_definer_boundary',v_id),'42501','permission denied for function executor_definer_private_fn',
    'RPC through a definer view requires querying-user EXECUTE on its non-PUBLIC function');
  SET LOCAL ROLE postgres;
  FOR rec IN SELECT * FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='function' AND object_id='pg_temp.executor_definer_private_fn()'::regprocedure
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ui_rpc_executor',rec.object_id::regprocedure);
  END LOOP;
  SET LOCAL ROLE authenticated;
  RETURN NEXT is((public.ui_get_resource_v1('qa_executor_definer_boundary',v_id)->>'value')::int,1,
    'public RPC calls the non-PUBLIC function through the definer view with planned grants');
  RETURN NEXT is((api.ui_get_resource_v1('qa_executor_definer_boundary',v_id)->>'value')::int,1,
    'api RPC calls the non-PUBLIC function through the definer view with planned grants');
  SET LOCAL ROLE postgres;
END;
$view_test$;
SELECT * FROM pg_temp.test_executor_definer_view_v1();

-- PostgreSQL preserves reloption spelling; accept every boolean spelling and case.
CREATE FUNCTION pg_temp.test_executor_reloptions_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $options_test$
DECLARE v_option TEXT; v_actor UUID; v_own UUID; v_foreign UUID;
BEGIN
  SELECT id INTO STRICT v_actor FROM public.users WHERE full_name='Example Person';
  SELECT id INTO STRICT v_own FROM pg_temp.executor_rows WHERE name='Own';
  SELECT id INTO STRICT v_foreign FROM pg_temp.executor_rows WHERE name='Foreign';
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,TRUE);
  FOREACH v_option IN ARRAY ARRAY['true','ON','1','YeS'] LOOP
    EXECUTE format('ALTER VIEW pg_temp.executor_view SET (security_invoker=%L)',v_option);
    SET LOCAL ROLE authenticated;
    RETURN NEXT ok(api.ui_get_resource_v1('qa_executor_view',v_own)->>'name'='Own'
      AND api.ui_get_resource_v1('qa_executor_view',v_foreign) IS NULL,
      v_option || ' retains active invoker-view RLS');
    SET LOCAL ROLE postgres;
    EXECUTE format('ALTER VIEW pg_temp.executor_invoker_outer SET (security_invoker=%L)',v_option);
    RETURN NEXT ok(EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
      WHERE object_kind='relation' AND object_id='pg_temp.executor_definer_view'::regclass),
      v_option || ' retains invoker relation dependency traversal');
  END LOOP;
  ALTER VIEW pg_temp.executor_view SET (security_invoker=false);
  SET LOCAL ROLE authenticated;
  RETURN NEXT throws_ok(format('SELECT api.ui_get_resource_v1(''qa_executor_view'',%L::uuid)',v_own),
    'P0001',format('ui_get_resource_v1 relation not allowed: %I.executor_view',pg_my_temp_schema()::regnamespace),
    'false reloption remains denied through the authenticated API');
  SET LOCAL ROLE postgres;
  ALTER VIEW pg_temp.executor_invoker_outer SET (security_invoker=false);
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='relation' AND object_id='pg_temp.executor_definer_view'::regclass),
    'false preserves the definer relation boundary');
END;
$options_test$;
SELECT * FROM pg_temp.test_executor_reloptions_v1();

SELECT * FROM finish();
ROLLBACK;
