BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

CREATE OR REPLACE FUNCTION pg_temp.capture_directory_sqlstate(p_sql TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLSTATE;
END;
$function$;

DO $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_tenant_user UUID := gen_random_uuid();
  v_client_user UUID := gen_random_uuid();
  v_sender_user UUID := gen_random_uuid();
  v_limited_user UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_foreign_branch UUID := gen_random_uuid();
  v_level UUID := gen_random_uuid();
  v_foreign_level UUID := gen_random_uuid();
  v_offering UUID := gen_random_uuid();
  v_foreign_offering UUID := gen_random_uuid();
  v_context RECORD;
  v_resource TEXT;
  v_owned_id UUID;
  v_foreign_id UUID;
  v_list JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Directory JWT org', 'directory-jwt-' || left(v_org::text, 8)),
    (v_foreign_org, 'Directory JWT foreign org', 'directory-jwt-' || left(v_foreign_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Directory JWT client', 'directory-jwt-client-' || left(v_client::text, 8));
  INSERT INTO public.senders (id, client_id, name)
  VALUES (v_sender, v_client, 'Directory JWT sender');

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id
  ) VALUES
    (v_tenant_user, v_org, 'directory-tenant-' || left(v_tenant_user::text, 8) || '@example.com', 'Directory tenant', 'ops_admin', 'active', 'tenant', NULL),
    (v_client_user, v_org, 'directory-client-' || left(v_client_user::text, 8) || '@example.com', 'Directory client', 'ops_admin', 'active', 'client', v_client),
    (v_sender_user, v_org, 'directory-sender-' || left(v_sender_user::text, 8) || '@example.com', 'Directory sender', 'ops_admin', 'active', 'sender', v_sender),
    (v_limited_user, v_org, 'directory-limited-' || left(v_limited_user::text, 8) || '@example.com', 'Directory limited', 'driver', 'active', 'tenant', NULL);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_branch, v_org, 'jwt-' || left(v_branch::text, 8), 'Directory owned branch', 'UTC', TRUE),
    (v_foreign_branch, v_foreign_org, 'jwt-' || left(v_foreign_branch::text, 8), 'Directory foreign branch', 'UTC', TRUE);
  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES
    (v_level, v_org, 'standard', 'Directory owned level', TRUE),
    (v_foreign_level, v_foreign_org, 'standard', 'Directory foreign level', TRUE);
  INSERT INTO public.service_offerings (
    id, service_level_id, branch_id, effective_from, effective_to, priority, is_active
  ) VALUES
    (v_offering, v_level, v_branch, now() - interval '1 hour', now() + interval '1 hour', 0, TRUE),
    (v_foreign_offering, v_foreign_level, v_foreign_branch, now() - interval '1 hour', now() + interval '1 hour', 0, TRUE);

  FOR v_context IN
    SELECT * FROM (VALUES
      (v_tenant_user, 'tenant'::TEXT),
      (v_client_user, 'client'::TEXT),
      (v_sender_user, 'sender'::TEXT)
    ) contexts(user_id, scope_type)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', v_context.user_id::TEXT, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', v_context.user_id::TEXT,
        'role', 'authenticated',
        'organization_id', v_org::TEXT
      )::TEXT,
      TRUE
    );
    EXECUTE 'SET LOCAL ROLE authenticated';

    FOREACH v_resource IN ARRAY ARRAY[
      'service_branch_directory',
      'service_level_directory',
      'service_offering_directory'
    ]
    LOOP
      SELECT CASE v_resource
               WHEN 'service_branch_directory' THEN v_branch
               WHEN 'service_level_directory' THEN v_level
               ELSE v_offering
             END,
             CASE v_resource
               WHEN 'service_branch_directory' THEN v_foreign_branch
               WHEN 'service_level_directory' THEN v_foreign_level
               ELSE v_foreign_offering
             END
        INTO v_owned_id, v_foreign_id;

      v_list := public.ui_list_resource_v1(v_resource, '{}'::jsonb, 200, 0, NULL);
      PERFORM ok(
        v_list->'items' @> jsonb_build_array(jsonb_build_object('id', v_owned_id::TEXT))
        AND NOT (v_list->'items' @> jsonb_build_array(jsonb_build_object('id', v_foreign_id::TEXT))),
        format('%s scope sees owned but not foreign %s rows', v_context.scope_type, v_resource)
      );
    END LOOP;

    EXECUTE 'RESET ROLE';
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_limited_user::TEXT, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_limited_user::TEXT,
      'role', 'authenticated',
      'organization_id', v_org::TEXT
    )::TEXT,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  FOREACH v_resource IN ARRAY ARRAY[
    'public.service_level_directory',
    'public.service_offering_directory',
    'api.service_level_directory',
    'api.service_offering_directory'
  ]
  LOOP
    PERFORM is(
      pg_temp.capture_directory_sqlstate(format('SELECT 1 FROM %s LIMIT 1', v_resource)),
      '42501',
      format('authenticated cannot directly read %s', v_resource)
    );
  END LOOP;

  PERFORM is(
    pg_temp.capture_directory_sqlstate(
      $sql$SELECT public.ui_list_resource_v1('service_level_directory', '{}'::jsonb, 1, 0, NULL)$sql$
    ),
    '42501',
    'governed directory read denies a user without agreements.read'
  );
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM finish();

ROLLBACK;