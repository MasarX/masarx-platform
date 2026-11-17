-- Preserve extension ownership and verify effective exposure before requiring repair authority.
-- Only the literal approved Supabase pg_net defaults may remain unrepairable, with one canonical warning alert.
BEGIN;
DO $extension_acl$
DECLARE
  v_relation record;
  v_worker name;
  v_dispatch_owner name;
  v_before jsonb;
  v_sequence regclass;
  v_can_repair boolean := TRUE;
  v_exposure jsonb;
  v_state jsonb;
  v_alert_id uuid;
  v_unreviewed boolean;
  v_platform_defaults CONSTANT jsonb := $platform_defaults$
[{"object_name":"net._http_response","role_name":"anon","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net._http_response","role_name":"authenticated","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net._http_response","role_name":"ui_rpc_executor","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue","role_name":"anon","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue","role_name":"authenticated","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue","role_name":"ui_rpc_executor","owner":"supabase_admin","privileges":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},{"object_name":"net.http_request_queue_id_seq","role_name":"anon","owner":"supabase_admin","privileges":["SELECT","UPDATE","USAGE"]},{"object_name":"net.http_request_queue_id_seq","role_name":"authenticated","owner":"supabase_admin","privileges":["SELECT","UPDATE","USAGE"]},{"object_name":"net.http_request_queue_id_seq","role_name":"ui_rpc_executor","owner":"supabase_admin","privileges":["SELECT","UPDATE","USAGE"]}]
$platform_defaults$;
  v_exposure_query CONSTANT text := $exposure$
WITH targets AS (
    SELECT c.oid,c.relowner,c.relnamespace,c.relkind,c.relacl,n.nspname AS schema_name,
      format('%I.%I',n.nspname,c.relname) AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='net' AND c.relkind IN ('r','p','v','m','f','S'))
      OR c.oid=ANY(ARRAY['cron.job_run_details'::regclass,$1::regclass])
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
$exposure$;
  v_provenance_query CONSTANT text := $provenance$
WITH targets AS (
    SELECT c.oid,c.relowner,c.relnamespace,c.relkind,c.relacl,n.nspname AS schema_name,
      format('%I.%I',n.nspname,c.relname) AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='net' AND c.relkind IN ('r','p','v','m','f','S'))
      OR c.oid=ANY(ARRAY['cron.job_run_details'::regclass,$1::regclass])
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
BEGIN
  -- Verify catalog identities and complete repair authority before any mutation.
  FOR v_relation IN
    SELECT c.oid,c.relowner,n.nspname,c.relname,e.extname
    FROM (VALUES ('net','_http_response','pg_net'),('net','http_request_queue','pg_net'),
      ('cron','job_run_details','pg_cron')) expected(schema_name,relation_name,extension_name)
    LEFT JOIN pg_namespace n ON n.nspname=expected.schema_name
    LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=expected.relation_name AND c.relkind='r'
    LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid
      AND d.deptype='e' AND d.refclassid='pg_extension'::regclass
    LEFT JOIN pg_extension e ON e.oid=d.refobjid AND e.extname=expected.extension_name
  LOOP
    IF v_relation.oid IS NULL OR v_relation.extname IS NULL THEN
      RAISE EXCEPTION 'extension ACL repair requires the expected pg_net/pg_cron relations' USING ERRCODE='42501';
    END IF;
    v_can_repair := v_can_repair AND pg_has_role(current_user,v_relation.relowner,'USAGE');
  END LOOP;

  v_sequence:=pg_get_serial_sequence('net.http_request_queue','id')::regclass;
  IF v_sequence IS NULL THEN
    RAISE EXCEPTION 'extension ACL repair requires the request-id sequence' USING ERRCODE='42501';
  END IF;
  -- Grant options cannot revoke another grantor's ACL; complete repair needs the existing owner.
  v_can_repair := v_can_repair AND pg_has_role(current_user,
    (SELECT relowner FROM pg_class WHERE oid=v_sequence),'USAGE');

  -- PUBLIC rights are included in each role's effective ACL; namespace USAGE determines direct reachability.
  EXECUTE v_exposure_query INTO v_exposure USING v_sequence;
  SELECT jsonb_agg(jsonb_build_object('object',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),
    'schema',n.nspname,'schema_owner',pg_get_userbyid(n.nspowner),'acl',c.relacl)) INTO v_state
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid=ANY(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass,
      'cron.job_run_details'::regclass,v_sequence]);
  RAISE NOTICE 'extension ACL bootstrap state: repair_authority=%, exposure=%, objects=%',v_can_repair,v_exposure,v_state;
  -- Remove only grants made by this migration identity to our executor, never platform PUBLIC grants.
  FOR v_relation IN
    SELECT format('REVOKE ALL ON SCHEMA %I FROM ui_rpc_executor',n.nspname) AS command
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
      WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole AND a.grantor=current_user::regrole
    UNION
    SELECT format('REVOKE ALL ON %s %s FROM ui_rpc_executor',CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,c.oid::regclass)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname='net' AND c.relkind IN ('r','p','v','m','f','S')
        AND a.grantee='ui_rpc_executor'::regrole AND a.grantor=current_user::regrole
    UNION
    SELECT format('REVOKE %s (%I) ON TABLE %s FROM ui_rpc_executor',a.privilege_type,att.attname,c.oid::regclass)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute att ON att.attrelid=c.oid
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole AND a.grantor=current_user::regrole
    UNION
    SELECT format('REVOKE ALL ON FUNCTION %s FROM ui_rpc_executor',p.oid::regprocedure)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE n.nspname='net' AND a.grantee='ui_rpc_executor'::regrole AND a.grantor=current_user::regrole
  LOOP
    EXECUTE v_relation.command;
  END LOOP;
  IF NOT v_can_repair THEN
    EXECUTE v_exposure_query INTO v_exposure USING v_sequence;
    EXECUTE v_provenance_query INTO v_unreviewed USING v_sequence;
    IF v_unreviewed THEN
      RAISE EXCEPTION 'extension ACL exposure has application-created or unreviewed grant provenance'
        USING ERRCODE='42501';
    END IF;
    IF v_exposure='[]'::jsonb THEN
      RAISE NOTICE 'extension ACL repair is a safe no-op: no effective browser/executor exposure';
      RETURN;
    END IF;
    IF v_exposure<>v_platform_defaults OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(v_exposure) item(object_name text)
        JOIN pg_class c ON c.oid=to_regclass(item.object_name)
      WHERE pg_has_role(current_user,c.relowner,'USAGE')
    ) THEN
      RAISE EXCEPTION 'extension ACL exposure remains and postgres lacks repair authority: %',v_exposure
        USING ERRCODE='42501',HINT='Unreviewed or repairable exposure requires the existing object owner; the literal platform-default exception cannot grow.';
    END IF;
    INSERT INTO public.ops_alerts(organization_id,alert_type,severity,message,details)
    VALUES(public.marketplace_system_org_id_v1(),'platform_pg_net_exposure','warning',
      'Supabase-owned pg_net PUBLIC defaults require owner remediation',
      jsonb_build_object('migration','20261029113000_extension_public_acl_v1','classification','platform_default',
        'exposure',v_exposure,'objects',v_state,'migration_role',current_user))
    RETURNING id INTO v_alert_id;
    RAISE WARNING 'platform_default pg_net exposure requires owner remediation: alert_id=%, exposure=%',v_alert_id,v_exposure;
    RETURN;
  END IF;

  SELECT pg_get_userbyid(p.proowner) INTO v_dispatch_owner FROM pg_proc p
    WHERE p.oid='public.dispatch_api_request_v1(text,text,jsonb,jsonb,integer)'::regprocedure AND p.prosecdef;
  SELECT COALESCE(NULLIF(current_setting('pg_net.username',TRUE),''),pg_get_userbyid(e.extowner))
    INTO v_worker FROM pg_extension e WHERE e.extname='pg_net';
  IF v_dispatch_owner IS NULL OR to_regrole(v_worker) IS NULL OR EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=ANY(ARRAY[
      'public.call_api(text,text,jsonb,jsonb,integer)'::regprocedure,
      'public.call_api_wait(text,text,jsonb,jsonb,integer,integer)'::regprocedure,
      'public.check_async_response(bigint)'::regprocedure])
      AND (NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>v_dispatch_owner)
  ) THEN
    RAISE EXCEPTION 'extension ACL repair consumer ownership changed; review the consumer grant plan';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('relation',c.oid,'owner',c.relowner,'grantor',a.grantor,
    'grantee',a.grantee,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO v_before
  FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid=ANY(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass,
    'cron.job_run_details'::regclass,v_sequence]) AND a.grantee<>ALL(ARRAY[0,'anon'::regrole::oid,'authenticated'::regrole::oid,'ui_rpc_executor'::regrole::oid]);

  -- The configured pg_net worker consumes queues, records responses and removes expired responses.
  EXECUTE format('GRANT SELECT, DELETE ON net.http_request_queue TO %I',v_worker);
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON net._http_response TO %I',v_worker);
  -- Canonical definer dispatch inserts requests and RETURNING id; response readers share its verified owner.
  EXECUTE format('GRANT INSERT ON net.http_request_queue TO %I',v_dispatch_owner);
  EXECUTE format('GRANT SELECT (id) ON net.http_request_queue TO %I',v_dispatch_owner);
  EXECUTE format('GRANT SELECT ON net._http_response TO %I',v_dispatch_owner);
  -- Only the dispatcher needs nextval; PUBLIC setval/nextval can corrupt queue identity.
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I',v_sequence,v_dispatch_owner);
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC,anon,authenticated,ui_rpc_executor',v_sequence);
  REVOKE ALL ON net._http_response, net.http_request_queue FROM PUBLIC,anon,authenticated,ui_rpc_executor;
  REVOKE DELETE ON cron.job_run_details FROM PUBLIC,anon,authenticated,ui_rpc_executor;

  IF has_sequence_privilege('ui_rpc_executor',v_sequence,'USAGE,UPDATE') OR EXISTS (
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid=v_sequence AND a.grantee=0
  ) OR EXISTS (
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE (c.oid=ANY(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass])
      OR (c.oid='cron.job_run_details'::regclass AND a.privilege_type<>'SELECT')) AND a.grantee=0
  ) OR EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY['net._http_response'::regclass,
      'net.http_request_queue'::regclass,'cron.job_run_details'::regclass])
      AND (has_table_privilege('ui_rpc_executor',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege('ui_rpc_executor',c.oid,'INSERT,UPDATE,REFERENCES'))
  ) THEN
    RAISE EXCEPTION 'extension ACL repair postcondition failed: PUBLIC/executor privileges remain' USING ERRCODE='42501';
  END IF;
  IF NOT has_sequence_privilege(v_dispatch_owner,v_sequence,'USAGE')
    OR NOT has_table_privilege(v_worker,'net.http_request_queue','SELECT')
    OR NOT has_table_privilege(v_worker,'net.http_request_queue','DELETE')
    OR NOT has_table_privilege(v_worker,'net._http_response','SELECT')
    OR NOT has_table_privilege(v_worker,'net._http_response','INSERT')
    OR NOT has_table_privilege(v_worker,'net._http_response','DELETE')
    OR NOT has_table_privilege(v_dispatch_owner,'net.http_request_queue','INSERT')
    OR NOT has_column_privilege(v_dispatch_owner,'net.http_request_queue','id','SELECT')
    OR NOT has_table_privilege(v_dispatch_owner,'net._http_response','SELECT') THEN
    RAISE EXCEPTION 'extension ACL repair consumer grants did not take effect' USING ERRCODE='42501';
  END IF;
  EXECUTE v_exposure_query INTO v_exposure USING v_sequence;
  IF v_exposure<>'[]'::jsonb THEN
    RAISE EXCEPTION 'extension ACL repair left effective browser/executor exposure: %',v_exposure
      USING ERRCODE='42501',HINT='The object owner must also reconcile explicit column and inherited grants.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_before) old(relation oid,owner oid,grantor oid,grantee oid,privilege text,grantable boolean)
    JOIN pg_class c ON c.oid=old.relation
    WHERE c.relowner<>old.owner OR NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a
      WHERE a.grantor=old.grantor AND a.grantee=old.grantee AND a.privilege_type=old.privilege
        AND a.is_grantable=old.grantable)
  ) THEN
    RAISE EXCEPTION 'extension ACL repair changed an existing owner or non-PUBLIC grant';
  END IF;
END;
$extension_acl$;
COMMIT;
