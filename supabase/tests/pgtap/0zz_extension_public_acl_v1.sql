-- Rollback-only extension ACL and canonical consumer checks; run as NOSUPERUSER postgres.
BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT no_plan();
SELECT ok(NOT rolsuper,'extension consumer verification uses the normal non-superuser identity')
  FROM pg_roles WHERE rolname=current_user;
-- Migration 20261029113000 records the exact unrepairable platform baseline.
-- Require the live ACLs to match that reviewed record before testing that branch.
CREATE TEMP TABLE verified_platform_net_acl AS
WITH expected AS (
  SELECT oid::regclass::text AS object_name, relowner, to_jsonb(relacl) AS acl
  FROM pg_class
  WHERE oid IN ('net._http_response'::regclass, 'net.http_request_queue'::regclass,
                pg_get_serial_sequence('net.http_request_queue', 'id')::regclass)
)
SELECT EXISTS (
  SELECT 1 FROM public.ops_alerts AS alert
  WHERE alert.alert_type = 'platform_pg_net_exposure'
    AND alert.details @> '{"migration":"20261029113000_extension_public_acl_v1","classification":"platform_default"}'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM expected
      WHERE pg_has_role(current_user, relowner, 'USAGE')
        OR NOT (alert.details->'objects' @>
          jsonb_build_array(jsonb_build_object('object', object_name,
            'owner', pg_get_userbyid(relowner), 'acl', acl)))
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute att
      JOIN pg_class c ON c.oid = att.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'net' AND att.attacl IS NOT NULL
    )
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'ui_rpc_executor'::regrole)
    AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role','ui_rpc_executor']) role_name
      WHERE has_schema_privilege(role_name, 'net', 'CREATE')
    )
) AS matches;

SELECT ok((SELECT matches FROM verified_platform_net_acl) OR NOT EXISTS (
  SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid=ANY(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass])
    AND a.grantee=0), 'pg_net queue and response PUBLIC ACLs match the reviewed migration outcome');
SELECT ok((SELECT matches FROM verified_platform_net_acl) OR (
  NOT has_table_privilege('ui_rpc_executor',relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT has_any_column_privilege('ui_rpc_executor',relation,'INSERT,UPDATE,REFERENCES')),
  relation::text || ' executor access matches the reviewed migration outcome')
FROM unnest(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass]) relation;
SELECT ok(NOT has_table_privilege('ui_rpc_executor','cron.job_run_details','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'cron history retains no effective executor writes');
SELECT ok(has_table_privilege('postgres','cron.job_run_details','DELETE'),
  'existing explicit cron maintenance DELETE remains available');
SELECT ok((SELECT matches FROM verified_platform_net_acl)
  OR NOT has_table_privilege(role,relation,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  role || ' writes match the reviewed migration outcome for ' || relation::text)
FROM unnest(ARRAY['anon','authenticated','service_role']) role
CROSS JOIN unnest(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass]) relation;
SELECT ok(c.relowner=e.extowner,c.oid::regclass::text || ' keeps the existing extension owner')
FROM pg_class c JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid
  AND d.deptype='e' AND d.refclassid='pg_extension'::regclass
JOIN pg_extension e ON e.oid=d.refobjid
WHERE c.oid=ANY(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass,'cron.job_run_details'::regclass]);
SELECT ok((SELECT matches FROM verified_platform_net_acl) OR NOT EXISTS (
  SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class
    WHERE oid=pg_get_serial_sequence('net.http_request_queue','id')::regclass)) a WHERE a.grantee=0),
  'request-id sequence PUBLIC ACL matches the reviewed migration outcome');
SELECT ok((SELECT matches FROM verified_platform_net_acl)
  OR NOT has_sequence_privilege('ui_rpc_executor',pg_get_serial_sequence('net.http_request_queue','id'),'USAGE,UPDATE'),
  'executor sequence access matches the reviewed migration outcome');
SELECT ok(has_sequence_privilege(pg_get_userbyid(proowner),
    pg_get_serial_sequence('net.http_request_queue','id'),'USAGE'),
  'canonical dispatcher owner retains nextval')
FROM pg_proc WHERE oid='public.dispatch_api_request_v1(text,text,jsonb,jsonb,integer)'::regprocedure;
CREATE TEMP TABLE extension_worker_role AS
  SELECT COALESCE(NULLIF(current_setting('pg_net.username',TRUE),''),pg_get_userbyid(extowner)) AS name
  FROM pg_extension WHERE extname='pg_net';
SELECT ok(has_table_privilege(name,'net.http_request_queue','SELECT')
  AND has_table_privilege(name,'net.http_request_queue','DELETE')
  AND has_table_privilege(name,'net._http_response','SELECT')
  AND has_table_privilege(name,'net._http_response','INSERT')
  AND has_table_privilege(name,'net._http_response','DELETE'),
  'configured pg_net worker retains queue and response lifecycle privileges') FROM extension_worker_role;
SELECT lives_ok('DELETE FROM net.http_request_queue WHERE FALSE','worker queue DELETE remains executable');
SELECT lives_ok('DELETE FROM net._http_response WHERE FALSE','worker response DELETE remains executable');
SELECT lives_ok('DELETE FROM cron.job_run_details WHERE FALSE','cron maintenance DELETE remains executable');

-- Queued requests stay uncommitted and are rolled back: no actual outbound HTTP is sent.
CREATE FUNCTION pg_temp.check_extension_dispatch_consumers() RETURNS SETOF text LANGUAGE plpgsql AS $consumers$
DECLARE v_method text; v_id bigint; v_error text;
BEGIN
  FOREACH v_method IN ARRAY ARRAY['GET','POST','DELETE','PUT','PATCH'] LOOP
    v_id:=NULL; v_error:=NULL;
    SET LOCAL ROLE service_role;
    BEGIN
      v_id:=public.dispatch_api_request_v1('http://127.0.0.1:9/extension-acl-fixture',v_method,
        '{}'::jsonb,'{}'::jsonb,1);
      PERFORM public.check_async_response(v_id);
    EXCEPTION WHEN OTHERS THEN v_error:=SQLSTATE || ': ' || SQLERRM;
    END;
    RESET ROLE;
    RETURN NEXT ok(v_id IS NOT NULL AND v_error IS NULL,
      'service canonical ' || v_method || ' dispatch and response lookup survive PUBLIC revoke' || COALESCE(': ' || v_error,''));
    RETURN NEXT ok(EXISTS(SELECT 1 FROM net.http_request_queue WHERE id=v_id),
      v_method || ' reaches the real pg_net queue through the definer owner');
  END LOOP;
END;
$consumers$;
SELECT * FROM pg_temp.check_extension_dispatch_consumers();
SELECT finish();
ROLLBACK;
