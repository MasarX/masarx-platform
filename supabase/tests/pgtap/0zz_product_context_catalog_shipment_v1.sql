BEGIN;
SELECT plan(28);

SELECT has_function(
  'public', 'service_level_create_v1', ARRAY['jsonb'],
  'canonical service-level create RPC exists'
);
SELECT has_function(
  'public', 'service_offering_create_v1', ARRAY['jsonb'],
  'canonical service-offering create RPC exists'
);
SELECT has_function(
  'public', 'resolve_service_offering_context_v1', ARRAY['uuid', 'uuid'],
  'canonical service-offering resolver exists'
);
SELECT has_function(
  'api', 'service_level_create_v1', ARRAY['jsonb'],
  'api service-level create wrapper exists'
);
SELECT has_function(
  'api', 'service_offering_create_v1', ARRAY['jsonb'],
  'api service-offering create wrapper exists'
);

SELECT has_view('public', 'service_level_directory', 'public service-level directory exists');
SELECT has_view('public', 'service_offering_directory', 'public service-offering directory exists');
SELECT has_view('api', 'service_level_directory', 'api service-level directory exists');
SELECT has_view('api', 'service_offering_directory', 'api service-offering directory exists');

SELECT ok(
  COALESCE((SELECT reloptions @> ARRAY['security_invoker=true']
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'api' AND c.relname = 'service_level_directory'), FALSE),
  'api service-level directory is security invoker'
);
SELECT ok(
  COALESCE((SELECT reloptions @> ARRAY['security_invoker=true']
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'api' AND c.relname = 'service_offering_directory'), FALSE),
  'api service-offering directory is security invoker'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.service_level_create_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api service-level create wrapper'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.service_offering_create_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api service-offering create wrapper'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.service_level_create_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api service-level create wrapper'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'public.shipments'::regclass
       AND tgname = 'trg_00_shipments_apply_service_offering_context_v1'
       AND NOT tgisinternal
  ),
  'shipment offering-context trigger is installed'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.resolve_service_offering_context_v1(uuid,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot execute the internal offering resolver'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_service_offering_context_v1(uuid,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute the internal offering resolver'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.resolve_service_offering_context_v1(uuid,uuid)',
    'EXECUTE'
  ),
  'service role can execute the internal offering resolver'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts
     WHERE table_schema = 'public'
       AND table_name = 'service_levels'
       AND column_name = 'key'
       AND lookup_category = 'service_level'
       AND allow_inactive IS FALSE
  ),
  'service-level catalog keys use the active canonical lookup contract'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger apply_trigger
     WHERE apply_trigger.tgrelid = 'public.shipments'::regclass
       AND apply_trigger.tgname = 'trg_00_shipments_apply_service_offering_context_v1'
       AND apply_trigger.tgname < ALL (
         SELECT lookup_trigger.tgname
           FROM pg_trigger lookup_trigger
          WHERE lookup_trigger.tgrelid = 'public.shipments'::regclass
            AND lookup_trigger.tgfoid = 'public.enforce_lookup_column_contracts()'::regprocedure
       )
  ),
  'shipment product context is assigned before canonical lookup validation'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'public.service_levels'::regclass
       AND tgfoid = 'public.enforce_lookup_column_contracts()'::regprocedure
       AND NOT tgisinternal
  ),
  'service-level catalog lookup enforcement trigger is installed'
);

CREATE OR REPLACE FUNCTION pg_temp.capture_sqlstate(p_sql TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION
  WHEN others THEN
    RETURN SQLSTATE;
END;
$function$;

DO $fixture$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_active_branch UUID := gen_random_uuid();
  v_inactive_branch UUID := gen_random_uuid();
  v_definition UUID;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'B5 catalog tenant', 'b5-catalog-' || substr(v_org::text, 1, 8)),
    (v_foreign_org, 'B5 foreign tenant', 'b5-foreign-' || substr(v_foreign_org::text, 1, 8));

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES
    (v_active_branch, v_org, 'b5-active', 'B5 active branch', TRUE),
    (v_inactive_branch, v_org, 'b5-inactive', 'B5 inactive branch', FALSE);

  SELECT id INTO v_definition
    FROM public.lookup_definitions
   WHERE category = 'service_level';

  INSERT INTO public.lookup_values (
    lookup_definition_id, value, label, status, retired_at, effective_from
  ) VALUES
    (v_definition, 'b5_retired', 'B5 retired', 'archived', public.workflow_now(), now()),
    (v_definition, 'example_active_level', 'Example Active Level', 'active', NULL, now())
  ON CONFLICT (lookup_definition_id, value)
  DO UPDATE SET status = EXCLUDED.status, retired_at = EXCLUDED.retired_at, effective_from = EXCLUDED.effective_from;

  PERFORM set_config('test.b5_catalog_org', v_org::text, true);
  PERFORM set_config('test.b5_catalog_foreign_org', v_foreign_org::text, true);
  PERFORM set_config('test.b5_catalog_active_branch', v_active_branch::text, true);
  PERFORM set_config('test.b5_catalog_inactive_branch', v_inactive_branch::text, true);
END;
$fixture$;

SELECT lives_ok(
  format(
    'INSERT INTO public.service_levels (id, organization_id, key, name) VALUES (%L::uuid, %L::uuid, %L, %L)',
    gen_random_uuid(),
    current_setting('test.b5_catalog_org'),
    'example_active_level',
    'Example Active Level'
  ),
  'active canonical service-level key can be added to the tenant catalog'
);

SELECT is(
  pg_temp.capture_sqlstate(format(
    'INSERT INTO public.service_levels (organization_id, key, name) VALUES (%L::uuid, %L, %L)',
    current_setting('test.b5_catalog_org'),
    'b5_invalid',
    'B5 invalid'
  )),
  '23514',
  'unregistered service-level key is rejected'
);
SELECT is(
  pg_temp.capture_sqlstate(format(
    'INSERT INTO public.service_levels (organization_id, key, name) VALUES (%L::uuid, %L, %L)',
    current_setting('test.b5_catalog_org'),
    'b5_retired',
    'B5 retired'
  )),
  '23514',
  'retired service-level key is rejected'
);

SELECT set_config(
  'test.b5_catalog_level',
  (
    SELECT id::text
      FROM public.service_levels
     WHERE organization_id = current_setting('test.b5_catalog_org')::uuid
       AND key = 'standard'
     LIMIT 1
  ),
  true
);

SELECT lives_ok(
  format(
    'INSERT INTO public.service_offerings (id, service_level_id, branch_id, is_active) VALUES (%L::uuid, %L::uuid, %L::uuid, TRUE)',
    gen_random_uuid(),
    current_setting('test.b5_catalog_level'),
    current_setting('test.b5_catalog_active_branch')
  ),
  'active offering can bind an active canonical level to an active branch'
);

SELECT is(
  pg_temp.capture_sqlstate(format(
    'INSERT INTO public.service_offerings (service_level_id, branch_id, is_active) VALUES (%L::uuid, %L::uuid, TRUE)',
    current_setting('test.b5_catalog_level'),
    current_setting('test.b5_catalog_inactive_branch')
  )),
  '23514',
  'active offering cannot bind an inactive branch'
);

SELECT set_config(
  'test.b5_catalog_offering',
  (
    SELECT id::text
      FROM public.service_offerings
     WHERE service_level_id = current_setting('test.b5_catalog_level')::uuid
       AND branch_id = current_setting('test.b5_catalog_active_branch')::uuid
     LIMIT 1
  ),
  true
);

SELECT is(
  public.resolve_service_offering_context_v1(
    current_setting('test.b5_catalog_org')::uuid,
    current_setting('test.b5_catalog_offering')::uuid
  )->>'service_level_key',
  'standard',
  'internal resolver returns the own-tenant canonical service level'
);
SELECT is(
  pg_temp.capture_sqlstate(format(
    'SELECT public.resolve_service_offering_context_v1(%L::uuid, %L::uuid)',
    current_setting('test.b5_catalog_foreign_org'),
    current_setting('test.b5_catalog_offering')
  )),
  '23503',
  'internal resolver denies foreign-tenant offering context'
);

SELECT * FROM finish();
ROLLBACK;
