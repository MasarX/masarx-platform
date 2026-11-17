-- Test Suite: api integration plugin studio RPC contract wrappers
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT has_function(
  'api',
  'assert_capability_v1',
  ARRAY['text', 'text', 'uuid'],
  'api.assert_capability_v1 wrapper exists'
);

SELECT has_function(
  'api',
  'integration_plugin_generate_draft_v1',
  ARRAY['text', 'text', 'text', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'jsonb', 'uuid', 'text', 'text', 'uuid', 'jsonb'],
  'api.integration_plugin_generate_draft_v1 wrapper exists'
);

SELECT has_function(
  'api',
  'integration_plugin_validate_v1',
  ARRAY['uuid', 'jsonb', 'boolean'],
  'api.integration_plugin_validate_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.assert_capability_v1(text,text,uuid)', 'EXECUTE'),
  'authenticated can execute api.assert_capability_v1'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.integration_plugin_generate_draft_v1(text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,text,uuid,jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute api.integration_plugin_generate_draft_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.integration_plugin_validate_v1(uuid,jsonb,boolean)', 'EXECUTE'),
  'authenticated can execute api.integration_plugin_validate_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.assert_capability_v1(text,text,uuid)', 'EXECUTE'),
  'anon cannot execute api.assert_capability_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.integration_plugin_generate_draft_v1(text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,text,uuid,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute api.integration_plugin_generate_draft_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.integration_plugin_validate_v1(uuid,jsonb,boolean)', 'EXECUTE'),
  'anon cannot execute api.integration_plugin_validate_v1'
);

SELECT * FROM finish();
ROLLBACK;
