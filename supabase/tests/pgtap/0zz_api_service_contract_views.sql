-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Test: Service-only `api.*` contract views exist and are locked down.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT has_view('api', 'settings', 'api.settings view exists');
SELECT ok(has_table_privilege('service_role', 'api.settings', 'SELECT'), 'service_role can SELECT api.settings');
SELECT ok(NOT has_table_privilege('anon', 'api.settings', 'SELECT'), 'anon cannot SELECT api.settings');
SELECT ok(NOT has_table_privilege('authenticated', 'api.settings', 'SELECT'), 'authenticated cannot SELECT api.settings');

SELECT has_view('api', 'mapping_configs', 'api.mapping_configs view exists');
SELECT ok(has_table_privilege('service_role', 'api.mapping_configs', 'SELECT'), 'service_role can SELECT api.mapping_configs');
SELECT ok(NOT has_table_privilege('anon', 'api.mapping_configs', 'SELECT'), 'anon cannot SELECT api.mapping_configs');
SELECT ok(NOT has_table_privilege('authenticated', 'api.mapping_configs', 'SELECT'), 'authenticated cannot SELECT api.mapping_configs');

SELECT has_view('api', 'operation_templates', 'api.operation_templates view exists');
SELECT ok(has_table_privilege('service_role', 'api.operation_templates', 'SELECT'), 'service_role can SELECT api.operation_templates');
SELECT ok(NOT has_table_privilege('anon', 'api.operation_templates', 'SELECT'), 'anon cannot SELECT api.operation_templates');
SELECT ok(NOT has_table_privilege('authenticated', 'api.operation_templates', 'SELECT'), 'authenticated cannot SELECT api.operation_templates');

SELECT * FROM finish();

ROLLBACK;

