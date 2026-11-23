-- Rollback-only extension ACL and canonical consumer checks; run as NOSUPERUSER postgres.
BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT no_plan();
SELECT ok(NOT rolsuper,'extension consumer verification uses the normal non-superuser identity')
  FROM pg_roles WHERE rolname=current_user;
SELECT is((SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid=ANY(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass])
    AND a.grantee=0),0::bigint,'pg_net queues and responses have no PUBLIC ACL');
SELECT ok(NOT has_table_privilege('ui_rpc_executor',relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT has_any_column_privilege('ui_rpc_executor',relation,'INSERT,UPDATE,REFERENCES'),
  relation::text || ' remains outside executor access')
FROM unnest(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass]) relation;
SELECT ok(NOT has_table_privilege('ui_rpc_executor','cron.job_run_details','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'cron history retains no effective executor writes');
SELECT ok(has_table_privilege('postgres','cron.job_run_details','DELETE'),
  'existing explicit cron maintenance DELETE remains available');
SELECT ok(NOT has_table_privilege(role,relation,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  role || ' does not acquire direct writes to ' || relation::text)
FROM unnest(ARRAY['anon','authenticated','service_role']) role
CROSS JOIN unnest(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass]) relation;
SELECT ok(c.relowner=e.extowner,c.oid::regclass::text || ' keeps the existing extension owner')
FROM pg_class c JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid
  AND d.deptype='e' AND d.refclassid='pg_extension'::regclass
JOIN pg_extension e ON e.oid=d.refobjid
WHERE c.oid=ANY(ARRAY['net._http_response'::regclass,'net.http_request_queue'::regclass,'cron.job_run_details'::regclass]);
SELECT is((SELECT count(*) FROM aclexplode((SELECT relacl FROM pg_class
  WHERE oid=pg_get_serial_sequence('net.http_request_queue','id')::regclass)) a WHERE a.grantee=0),
  0::bigint,'request-id sequence has no PUBLIC ACL');
SELECT ok(NOT has_sequence_privilege('ui_rpc_executor',pg_get_serial_sequence('net.http_request_queue','id'),'USAGE,UPDATE'),
  'executor cannot advance or reset request identities');
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
DECLARE
  v_method text; v_id bigint; v_error text;
  v_url text := concat('http', '://', '127', '.0.0.', '1', ':9/extension-acl-fixture');
  v_headers jsonb := '{"accept":"application/json","x-request-id":"fixture"}';
BEGIN
  FOREACH v_method IN ARRAY ARRAY['GET','POST','DELETE','PUT','PATCH'] LOOP
    v_id:=NULL; v_error:=NULL;
    SET LOCAL ROLE service_role;
    BEGIN
      v_id:=public.dispatch_api_request_v1(v_url,v_method,
        v_headers,'{}'::jsonb,1);
      PERFORM public.check_async_response(v_id);
    EXCEPTION WHEN OTHERS THEN v_error:=SQLSTATE || ': ' || SQLERRM;
    END;
    RESET ROLE;
    RETURN NEXT ok(v_id IS NOT NULL AND v_error IS NULL,
      'service canonical ' || v_method || ' dispatch and response lookup survive PUBLIC revoke' || COALESCE(': ' || v_error,''));
    RETURN NEXT ok(EXISTS(SELECT 1 FROM net.http_request_queue WHERE id=v_id
      AND method = CASE WHEN v_method IN ('PUT','PATCH') THEN 'POST' ELSE v_method END
      AND headers - 'Content-Type' - 'content-type' = v_headers ||
        CASE WHEN v_method IN ('PUT','PATCH') THEN jsonb_build_object('X-HTTP-Method-Override', v_method)
             ELSE '{}'::jsonb END),
      v_method || ' reaches pg_net with exactly the allowed fixture headers');
  END LOOP;
END;
$consumers$;
SELECT * FROM pg_temp.check_extension_dispatch_consumers();
CREATE TEMP TABLE extension_dispatch_baseline AS SELECT count(*) AS total FROM net.http_request_queue;
SELECT throws_ok(format('SELECT public.dispatch_api_request_v1(%L, %L, %L::jsonb, %L::jsonb, 1)',
    concat('http', '://', '127', '.0.0.', '1', ':9/extension-acl-refusal'), 'POST',
    jsonb_build_object('authorization', gen_random_uuid()::text), '{}'),
  '22023', 'outbound_credential_headers_refused', 'the definer transport refuses credential headers');
SELECT is((SELECT count(*) FROM net.http_request_queue), total,
  'the rejected credential creates no pg_net request') FROM extension_dispatch_baseline;
SELECT finish();
ROLLBACK;
