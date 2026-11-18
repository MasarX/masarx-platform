BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry sr,
           jsonb_array_elements_text(COALESCE(sr.examples->0->'domain_denylist', '[]'::jsonb)) AS host(value)
     WHERE sr.category = 'integration_plugin_egress_policy'
       AND sr.version = 1
       AND host.value = 'example.com'
  ),
  'integration_plugin_egress_policy schema example denies example.com'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry sr,
           jsonb_array_elements_text(COALESCE(sr.examples->0->'domain_denylist', '[]'::jsonb)) AS host(value)
     WHERE sr.category = 'integration_plugin_egress_policy'
       AND sr.version = 1
       AND host.value = '.invalid'
  ),
  'integration_plugin_egress_policy schema example denies invalid TLD placeholders'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s,
           jsonb_array_elements_text(COALESCE(s.cached_value->'domain_denylist', '[]'::jsonb)) AS host(value)
     WHERE s.category = 'integration_plugin_egress_policy'
       AND s.scope_type = public.get_root_scope_type_key_v1()
       AND s.scope_id IS NULL
       AND host.value = 'example.com'
  ),
  'global integration_plugin_egress_policy setting denies example.com'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s,
           jsonb_array_elements_text(COALESCE(s.cached_value->'domain_denylist', '[]'::jsonb)) AS host(value)
     WHERE s.category = 'integration_plugin_egress_policy'
       AND s.scope_type = public.get_root_scope_type_key_v1()
       AND s.scope_id IS NULL
       AND host.value = '.test'
  ),
  'global integration_plugin_egress_policy setting denies test TLD placeholders'
);

SELECT has_function(
  'public',
  'integration_plugin_egress_policy_preview_v1',
  ARRAY['uuid'],
  'public Plugin Studio egress policy preview resolver exists'
);

SELECT has_function(
  'api',
  'integration_plugin_egress_policy_preview_v1',
  ARRAY['uuid'],
  'api Plugin Studio egress policy preview resolver exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.integration_plugin_egress_policy_preview_v1(uuid)',
    'EXECUTE'
  ),
  'authenticated can execute api Plugin Studio egress policy preview resolver'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.integration_plugin_egress_policy_preview_v1(uuid)',
    'EXECUTE'
  ),
  'anon cannot execute api Plugin Studio egress policy preview resolver'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_egress_policy_preview_v1(uuid)'::regprocedure)
    LIKE '%integration_plugin_resolve_policy_v1%'
  AND pg_get_functiondef('public.integration_plugin_egress_policy_preview_v1(uuid)'::regprocedure)
    LIKE '%integration_plugin_egress_policy%',
  'Plugin Studio egress preview resolver reuses existing integration-plugin policy resolver'
);

SELECT ok(
  position(
    'public.integration_plugin_egress_policy_preview_v1(p_organization_id)'
    IN pg_get_functiondef('api.integration_plugin_egress_policy_preview_v1(uuid)'::regprocedure)
  ) > 0,
  'api Plugin Studio egress policy preview resolver delegates to public resolver'
);

SELECT finish();

ROLLBACK;
