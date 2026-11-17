-- Test: QA SSOT schema + RLS coverage

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

CREATE TEMP TABLE _qa_tables AS
SELECT unnest(ARRAY[
  'qa_runs',
  'qa_run_steps',
  'qa_cases',
  'qa_case_results',
  'qa_artifacts',
  'qa_quarantines',
  'qa_access_roles'
]) AS table_name;

SELECT plan(42);

SELECT has_table('qa', table_name, format('qa.%s exists', table_name))
FROM _qa_tables;

SELECT ok(
  COALESCE(c.relrowsecurity, false),
  format('RLS enabled on qa.%s', t.table_name)
)
FROM _qa_tables t
LEFT JOIN pg_namespace n ON n.nspname = 'qa'
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'qa'
      AND p.tablename = t.table_name
      AND p.policyname = format('%s_read', t.table_name)
  ),
  format('qa.%s has read policy', t.table_name)
)
FROM _qa_tables t;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'qa'
      AND p.tablename = t.table_name
      AND p.policyname = format('%s_service', t.table_name)
  ),
  format('qa.%s has service policy', t.table_name)
)
FROM _qa_tables t;

SELECT ok(
  has_schema_privilege('authenticated', 'qa', 'USAGE'),
  'authenticated has USAGE on schema qa'
);

SELECT ok(
  has_schema_privilege('service_role', 'qa', 'USAGE'),
  'service_role has USAGE on schema qa'
);

SELECT has_function('qa', 'qa_start_run', ARRAY['text','text','text','text','text','jsonb','uuid'], 'qa_start_run exists');
SELECT has_function('qa', 'qa_finish_run', ARRAY['uuid','text','jsonb','text'], 'qa_finish_run exists');
SELECT has_function('qa', 'qa_start_step', ARRAY['uuid','text','jsonb'], 'qa_start_step exists');
SELECT has_function('qa', 'qa_finish_step', ARRAY['uuid','text','jsonb','text'], 'qa_finish_step exists');
SELECT has_function('qa', 'qa_record_case_results', ARRAY['uuid','text','jsonb'], 'qa_record_case_results exists');
SELECT has_function('qa', 'qa_can_read', ARRAY[]::text[], 'qa_can_read exists');
SELECT has_function('qa', 'qa_is_service_role', ARRAY[]::text[], 'qa_is_service_role exists');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM qa.qa_cases
    WHERE suite_key = 'qa:smoke'
      AND case_key = 'qa_schema_exists'
  ),
  'qa:smoke qa_schema_exists seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM qa.qa_cases
    WHERE suite_key = 'qa:smoke'
      AND case_key = 'qa_views_exist'
  ),
  'qa:smoke qa_views_exist seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM qa.qa_cases
    WHERE suite_key = 'qa:smoke'
      AND case_key = 'qa_access_roles_seeded'
  ),
  'qa:smoke qa_access_roles_seeded seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM qa.qa_cases
    WHERE suite_key = 'qa:smoke'
      AND case_key = 'qa_service_role_ok'
  ),
  'qa:smoke qa_service_role_ok seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM qa.qa_cases
    WHERE suite_key = 'qa:smoke'
      AND case_key = 'qa_can_read_ok'
  ),
  'qa:smoke qa_can_read_ok seeded'
);

SELECT finish();

ROLLBACK;
