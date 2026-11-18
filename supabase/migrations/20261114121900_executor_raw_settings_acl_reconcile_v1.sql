-- Keep executor grants aligned with the canonical dependency plan after resolver ACL changes.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $executor_acl$
DECLARE
  difference JSONB;
  cron_acl JSONB;
  difference_query CONSTANT TEXT := $difference$
    WITH expected AS MATERIALIZED (
      SELECT object_kind,object_id,privilege,column_name FROM public.ui_rpc_executor_privilege_plan_v1()
    ), actual AS (
      SELECT 'relation'::text object_kind,c.oid object_id,a.privilege_type privilege,NULL::text column_name
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee='ui_rpc_executor'::regrole
      UNION SELECT 'relation',c.attrelid,a.privilege_type,c.attname::text FROM pg_attribute c
      CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE a.grantee='ui_rpc_executor'::regrole
      UNION SELECT 'function',p.oid,a.privilege_type,NULL FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE a.grantee='ui_rpc_executor'::regrole AND p.proowner<>a.grantee
      UNION SELECT 'schema',n.oid,a.privilege_type,NULL FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee='ui_rpc_executor'::regrole
    ), delta AS (
      SELECT 'missing'::text direction,* FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual) missing
      UNION ALL
      SELECT 'extra',* FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected) extra
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('direction',direction,'kind',object_kind,
      'object',CASE object_kind WHEN 'function' THEN object_id::regprocedure::text
        WHEN 'schema' THEN object_id::regnamespace::text ELSE object_id::regclass::text END,
      'privilege',privilege,'column',column_name) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
    FROM delta;
  $difference$;
BEGIN
  EXECUTE difference_query INTO difference;
  RAISE NOTICE 'Executor ACL difference before raw-settings reconciliation: %',difference;

  IF NOT EXISTS (SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='function' AND object_id='public.resolve_settings(text,text,uuid)'::regprocedure
      AND privilege='EXECUTE') THEN
    REVOKE EXECUTE ON FUNCTION public.resolve_settings(TEXT,TEXT,UUID) FROM ui_rpc_executor;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ui_rpc_executor_privilege_plan_v1()
    WHERE object_kind='function' AND object_id='public.resolve_settings_row(text,text,uuid)'::regprocedure
      AND privilege='EXECUTE') THEN
    REVOKE EXECUTE ON FUNCTION public.resolve_settings_row(TEXT,TEXT,UUID) FROM ui_rpc_executor;
  END IF;

  EXECUTE difference_query INTO difference;
  RAISE NOTICE 'Executor ACL difference after raw-settings reconciliation: %',difference;
  IF difference <> '[]'::jsonb THEN
    RAISE EXCEPTION 'Executor ACLs differ from the canonical dependency plan: %',difference USING ERRCODE='42501';
  END IF;

  -- An owner/grantor diagnosis is independent of pg_net and changes no extension grant.
  SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'migration_role',current_user,
    'owner_authority',pg_has_role(current_user,c.relowner,'USAGE'),
    'delete_grants',jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantable',a.is_grantable) ORDER BY a.grantee)) INTO cron_acl
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid='cron.job_run_details'::regclass AND a.privilege_type='DELETE'
  GROUP BY c.relowner;
  RAISE NOTICE 'Independent cron history DELETE provenance: %',cron_acl;
END;
$executor_acl$;
COMMIT;
