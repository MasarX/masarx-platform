-- pgTAP: Browser-safe api/public UI read wrapper parity + friendly lookup labels

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(35);

CREATE TEMP TABLE pg_temp.ui_read_wrapper_specs (
  function_name TEXT PRIMARY KEY,
  arg_types TEXT[] NOT NULL,
  identity_args TEXT NOT NULL,
  expected_call TEXT NOT NULL
);

INSERT INTO pg_temp.ui_read_wrapper_specs (function_name, arg_types, identity_args, expected_call)
VALUES
  (
    'ui_read_registry_v1',
    ARRAY[]::TEXT[],
    '',
    'SELECT public.ui_read_registry_v1();'
  ),
  (
    'ui_list_resource_v1',
    ARRAY['text', 'jsonb', 'integer', 'integer', 'jsonb'],
    'text, jsonb, integer, integer, jsonb',
    'SELECT public.ui_list_resource_v1($1, $2, $3, $4, $5);'
  ),
  (
    'ui_get_resource_v1',
    ARRAY['text', 'uuid'],
    'text, uuid',
    'SELECT public.ui_get_resource_v1($1, $2);'
  ),
  (
    'ui_resource_metrics_v1',
    ARRAY['text', 'jsonb', 'text[]'],
    'text, jsonb, text[]',
    'SELECT public.ui_resource_metrics_v1($1, $2, $3);'
  );

CREATE OR REPLACE FUNCTION pg_temp.test_ui_read_api_wrapper_contracts()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_spec RECORD;
  v_public_signature TEXT;
  v_api_signature TEXT;
  v_api_def TEXT;
  v_api_result TEXT;
  v_public_result TEXT;
  v_operator_id UUID := gen_random_uuid();
  v_org_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_client_slug TEXT := 'ui-read-wrapper-client-' || left(gen_random_uuid()::text, 8);
  v_client_name TEXT := 'UI Read Wrapper Client ' || left(gen_random_uuid()::text, 8);
  v_public_registry JSONB := NULL;
  v_client_resource JSONB := NULL;
  v_org_reference_column JSONB := NULL;
  v_status_lookup_column JSONB := NULL;
  v_public_list JSONB := NULL;
BEGIN
  FOR v_spec IN
    SELECT *
    FROM pg_temp.ui_read_wrapper_specs
    ORDER BY function_name
  LOOP
    v_public_signature := CASE
      WHEN v_spec.identity_args = ''
        THEN format('public.%I()', v_spec.function_name)
      ELSE format('public.%I(%s)', v_spec.function_name, v_spec.identity_args)
    END;
    v_api_signature := CASE
      WHEN v_spec.identity_args = ''
        THEN format('api.%I()', v_spec.function_name)
      ELSE format('api.%I(%s)', v_spec.function_name, v_spec.identity_args)
    END;

    RETURN NEXT has_function(
      'public',
      v_spec.function_name,
      v_spec.arg_types,
      format('public.%s exists', v_spec.function_name)
    );

    RETURN NEXT has_function(
      'api',
      v_spec.function_name,
      v_spec.arg_types,
      format('api.%s exists', v_spec.function_name)
    );

    RETURN NEXT ok(
      has_function_privilege('authenticated', v_api_signature, 'EXECUTE'),
      format('authenticated can execute %s', v_api_signature)
    );

    RETURN NEXT ok(
      NOT has_function_privilege('anon', v_api_signature, 'EXECUTE'),
      format('anon cannot execute %s', v_api_signature)
    );

    SELECT pg_get_function_result(to_regprocedure(v_public_signature))
      INTO v_public_result;
    SELECT pg_get_function_result(to_regprocedure(v_api_signature))
      INTO v_api_result;

    RETURN NEXT is(
      v_api_result,
      v_public_result,
      format('%s keeps the same return type as %s', v_api_signature, v_public_signature)
    );

    SELECT regexp_replace(pg_get_functiondef(to_regprocedure(v_api_signature)), E'[\\n\\r\\t ]+', ' ', 'g')
      INTO v_api_def;

    RETURN NEXT ok(
      v_api_def LIKE '%SET search_path TO ''public'', ''extensions'', ''pg_temp''%'
      AND v_api_def LIKE '%' || v_spec.expected_call || '%',
      format('%s delegates to %s through the browser-safe public/extensions/pg_temp search_path', v_api_signature, v_public_signature)
    );
  END LOOP;

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_org_id,
    'UI Read Wrapper Contract Org',
    'ui-read-wrapper-org-' || left(v_org_id::text, 8)
  );

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    status
  )
  VALUES (
    v_operator_id,
    v_org_id,
    'ui-read-wrapper-' || left(v_operator_id::text, 8) || '@example.com',
    'UI Read Wrapper Operator',
    'ops_admin',
    'tenant',
    'active'
  );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client_id,
    v_org_id,
    v_client_name,
    v_client_slug,
    'active'
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_operator_id::text,
      'role', 'authenticated'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT results_eq(
    $$ SELECT api.ui_read_registry_v1() $$,
    $$ SELECT public.ui_read_registry_v1() $$,
    'api.ui_read_registry_v1 matches public.ui_read_registry_v1 for authenticated browser reads'
  );

  RETURN NEXT results_eq(
    format(
      $sql$
        SELECT api.ui_list_resource_v1(
          'clients',
          jsonb_build_object('slug', %L),
          10,
          0,
          NULL::jsonb
        )
      $sql$,
      v_client_slug
    ),
    format(
      $sql$
        SELECT public.ui_list_resource_v1(
          'clients',
          jsonb_build_object('slug', %L),
          10,
          0,
          NULL::jsonb
        )
      $sql$,
      v_client_slug
    ),
    'api.ui_list_resource_v1 matches public.ui_list_resource_v1 for scoped client reads'
  );

  RETURN NEXT results_eq(
    format(
      $sql$
        SELECT api.ui_get_resource_v1(
          'clients',
          %L::uuid
        )
      $sql$,
      v_client_id::text
    ),
    format(
      $sql$
        SELECT public.ui_get_resource_v1(
          'clients',
          %L::uuid
        )
      $sql$,
      v_client_id::text
    ),
    'api.ui_get_resource_v1 matches public.ui_get_resource_v1 for scoped client detail reads'
  );

  RETURN NEXT results_eq(
    format(
      $sql$
        SELECT api.ui_resource_metrics_v1(
          'clients',
          jsonb_build_object('slug', %L),
          ARRAY['id', 'organization_id', 'name']::text[]
        )
      $sql$,
      v_client_slug
    ),
    format(
      $sql$
        SELECT public.ui_resource_metrics_v1(
          'clients',
          jsonb_build_object('slug', %L),
          ARRAY['id', 'organization_id', 'name']::text[]
        )
      $sql$,
      v_client_slug
    ),
    'api.ui_resource_metrics_v1 matches public.ui_resource_metrics_v1 for scoped client metrics reads'
  );

  v_public_registry := public.ui_read_registry_v1();
  v_public_list := public.ui_list_resource_v1(
    'clients',
    jsonb_build_object('slug', v_client_slug),
    10,
    0,
    NULL::jsonb
  );

  SELECT value
    INTO v_client_resource
    FROM jsonb_array_elements(COALESCE(v_public_registry->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' = 'clients'
   LIMIT 1;

  SELECT value
    INTO v_org_reference_column
    FROM jsonb_array_elements(COALESCE(v_client_resource->'columns', '[]'::jsonb)) AS value
   WHERE value->>'key' = 'organization_id'
   LIMIT 1;

  SELECT value
    INTO v_status_lookup_column
    FROM jsonb_array_elements(COALESCE(v_client_resource->'columns', '[]'::jsonb)) AS value
   WHERE value->>'key' = 'status'
   LIMIT 1;

  RETURN NEXT is(
    v_public_list#>>'{items,0,name}',
    v_client_name,
    'ui_list_resource_v1 returns the friendly client name in the primary payload instead of ID-only data'
  );

  RETURN NEXT is(
    v_org_reference_column#>>'{import,reference,resource}',
    'organizations',
    'clients.organization_id resolves through the organizations lookup resource'
  );

  RETURN NEXT is(
    v_org_reference_column#>>'{import,reference,label_column}',
    'name',
    'clients.organization_id publishes name as the user-friendly lookup label column'
  );

  RETURN NEXT ok(
    v_org_reference_column#>>'{import,reference,label_column}'
      <> v_org_reference_column#>>'{import,reference,id_column}',
    'clients.organization_id lookup label column is not the raw UUID id column'
  );

  RETURN NEXT is(
    v_org_reference_column#>>'{import,reference,display_columns,0}',
    'name',
    'clients.organization_id display columns lead with a friendly organization name'
  );

  RETURN NEXT is(
    v_status_lookup_column#>>'{import,lookup,label_column}',
    'label',
    'clients.status lookup resolves user-facing labels through the canonical label column'
  );

  RETURN NEXT ok(
    COALESCE(v_status_lookup_column#>'{import,lookup,options}', '[]'::jsonb)
      @> '[{"label":"Active","value":"active"}]'::jsonb,
    'clients.status lookup options expose human-friendly labels alongside canonical values'
  );
END;
$function$;

SELECT * FROM pg_temp.test_ui_read_api_wrapper_contracts();

SELECT * FROM finish();

ROLLBACK;
