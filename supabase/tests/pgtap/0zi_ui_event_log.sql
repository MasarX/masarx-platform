-- Test Suite: UI event log
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT has_table('public', 'ui_event_log', 'ui_event_log table exists');

SELECT col_type_is('public', 'ui_event_log', 'organization_id', 'uuid', 'organization_id is uuid');
SELECT col_type_is('public', 'ui_event_log', 'user_id', 'uuid', 'user_id is uuid');

SELECT has_function(
  'public',
  'ui_log_event_v1',
  ARRAY['jsonb','text'],
  'ui_log_event_v1 exists'
);

SELECT has_function(
  'public',
  'ui_log_events_v1',
  ARRAY['jsonb','text'],
  'ui_log_events_v1 exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_log_events_v1(jsonb,text)',
    'EXECUTE'
  ),
  'authenticated can execute ui_log_events_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_log_events_v1(jsonb,text)',
    'EXECUTE'
  ),
  'anon cannot execute ui_log_events_v1'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'ui_event_log'),
  'RLS enabled on ui_event_log'
);

SELECT * FROM finish();
ROLLBACK;
