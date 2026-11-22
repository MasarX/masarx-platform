BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL search_path = pg_catalog;

DO $extension_acl$
DECLARE
  response pg_class%ROWTYPE;
  queue pg_class%ROWTYPE;
  request_id pg_class%ROWTYPE;
  cron_history pg_class%ROWTYPE;
  platform_owner oid := to_regrole('supabase_admin');
  executor_role oid := 'ui_rpc_executor'::regrole;
  client_roles oid[] := ARRAY['anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid];
  write_privileges text[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  remaining text;
  worker_role name;
  dispatcher_owner oid;
BEGIN
  -- Read the owner even when the migration role has no USAGE on the schema.
  SELECT c.* INTO STRICT response FROM pg_class c
    WHERE c.relnamespace = 'net'::regnamespace AND c.relname = '_http_response' AND c.relkind = 'r';
  SELECT c.* INTO STRICT queue FROM pg_class c
    WHERE c.relnamespace = 'net'::regnamespace AND c.relname = 'http_request_queue' AND c.relkind = 'r';
  SELECT c.* INTO STRICT request_id FROM pg_class c
    WHERE c.relnamespace = 'net'::regnamespace AND c.relname = 'http_request_queue_id_seq' AND c.relkind = 'S';
  SELECT c.* INTO STRICT cron_history FROM pg_class c
    WHERE c.relnamespace = 'cron'::regnamespace AND c.relname = 'job_run_details' AND c.relkind = 'r';

  BEGIN
    REVOKE ALL ON TABLE net._http_response FROM PUBLIC, ui_rpc_executor;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF response.relowner IS DISTINCT FROM platform_owner OR pg_has_role(current_user, platform_owner, 'USAGE') THEN RAISE; END IF;
    RAISE NOTICE 'net._http_response PUBLIC/executor ACL revoke denied for % (42501, owner supabase_admin): %', current_user, SQLERRM;
  END;

  BEGIN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE net._http_response FROM anon, authenticated, service_role;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF response.relowner IS DISTINCT FROM platform_owner OR pg_has_role(current_user, platform_owner, 'USAGE') THEN RAISE; END IF;
    RAISE NOTICE 'net._http_response client write revoke denied for % (42501, owner supabase_admin): %', current_user, SQLERRM;
  END;

  BEGIN
    REVOKE ALL ON TABLE net.http_request_queue FROM PUBLIC, ui_rpc_executor;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF queue.relowner IS DISTINCT FROM platform_owner OR pg_has_role(current_user, platform_owner, 'USAGE') THEN RAISE; END IF;
    RAISE NOTICE 'net.http_request_queue PUBLIC/executor ACL revoke denied for % (42501, owner supabase_admin): %', current_user, SQLERRM;
  END;

  BEGIN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE net.http_request_queue FROM anon, authenticated, service_role;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF queue.relowner IS DISTINCT FROM platform_owner OR pg_has_role(current_user, platform_owner, 'USAGE') THEN RAISE; END IF;
    RAISE NOTICE 'net.http_request_queue client write revoke denied for % (42501, owner supabase_admin): %', current_user, SQLERRM;
  END;

  BEGIN
    REVOKE ALL ON SEQUENCE net.http_request_queue_id_seq FROM PUBLIC;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF request_id.relowner IS DISTINCT FROM platform_owner OR pg_has_role(current_user, platform_owner, 'USAGE') THEN RAISE; END IF;
    RAISE NOTICE 'net.http_request_queue_id_seq PUBLIC ACL revoke denied for % (42501, owner supabase_admin): %', current_user, SQLERRM;
  END;

  BEGIN
    REVOKE USAGE, UPDATE ON SEQUENCE net.http_request_queue_id_seq FROM ui_rpc_executor;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF request_id.relowner IS DISTINCT FROM platform_owner OR pg_has_role(current_user, platform_owner, 'USAGE') THEN RAISE; END IF;
    RAISE NOTICE 'net.http_request_queue_id_seq executor write revoke denied for % (42501, owner supabase_admin): %', current_user, SQLERRM;
  END;

  BEGIN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE cron.job_run_details FROM PUBLIC, ui_rpc_executor;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF cron_history.relowner IS DISTINCT FROM platform_owner OR pg_has_role(current_user, platform_owner, 'USAGE') THEN RAISE; END IF;
    RAISE NOTICE 'cron.job_run_details PUBLIC/executor write revoke denied for % (42501, owner supabase_admin): %', current_user, SQLERRM;
  END;

  -- PostgreSQL can leave a grant intact with a warning when only some grant options are available.
  SELECT string_agg(DISTINCT c.oid::regclass::text, ', ' ORDER BY c.oid::regclass::text) INTO remaining
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid IN (response.oid, queue.oid, request_id.oid, cron_history.oid)
    AND c.relowner = platform_owner AND acl.grantor = platform_owner
    AND (
      (c.oid IN (response.oid, queue.oid) AND (acl.grantee IN (0, executor_role)
        OR (acl.grantee = ANY(client_roles) AND acl.privilege_type = ANY(write_privileges))))
      OR (c.oid = request_id.oid AND (acl.grantee = 0
        OR (acl.grantee = executor_role AND acl.privilege_type IN ('USAGE', 'UPDATE'))))
      OR (c.oid = cron_history.oid AND acl.grantee IN (0, executor_role)
        AND acl.privilege_type = ANY(write_privileges))
    );
  IF remaining IS NOT NULL THEN
    RAISE NOTICE 'Targeted supabase_admin ACLs remain after revoke by % on %', current_user, remaining;
  END IF;

  SELECT COALESCE(NULLIF(current_setting('pg_net.username', true), ''), pg_get_userbyid(extowner))
    INTO STRICT worker_role FROM pg_extension WHERE extname = 'pg_net';
  SELECT proowner INTO STRICT dispatcher_owner FROM pg_proc
    WHERE oid = 'public.dispatch_api_request_v1(text,text,jsonb,jsonb,integer)'::regprocedure;

  -- Roll back if a required consumer was relying on one of the revoked grants.
  IF NOT has_table_privilege(worker_role, queue.oid, 'SELECT')
    OR NOT has_table_privilege(worker_role, queue.oid, 'DELETE')
    OR NOT has_table_privilege(worker_role, response.oid, 'SELECT')
    OR NOT has_table_privilege(worker_role, response.oid, 'INSERT')
    OR NOT has_table_privilege(worker_role, response.oid, 'DELETE')
    OR NOT has_table_privilege(dispatcher_owner, queue.oid, 'INSERT')
    OR NOT has_column_privilege(dispatcher_owner, queue.oid, 'id', 'SELECT')
    OR NOT has_table_privilege(dispatcher_owner, response.oid, 'SELECT')
    OR NOT has_sequence_privilege(dispatcher_owner, request_id.oid, 'USAGE')
    OR NOT has_table_privilege('postgres', queue.oid, 'DELETE')
    OR NOT has_table_privilege('postgres', response.oid, 'DELETE')
    OR NOT has_table_privilege('postgres', cron_history.oid, 'DELETE') THEN
    RAISE EXCEPTION 'Extension ACL revoke did not preserve dispatcher, pg_net worker or postgres maintenance access';
  END IF;
END;
$extension_acl$;

COMMIT;
